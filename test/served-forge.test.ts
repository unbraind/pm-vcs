/** Real-process forge acceptance, authorization, field convergence and receiver lease fences. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { cloneFrom } from "../engine/sync.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { FileTransport } from "../engine/transport.ts";
import { exportBundle, importBundleObjects, parseBundle } from "../engine/bundle.ts";
import { createSeries, exportSeriesBundle } from "../engine/series.ts";
import { decodeRecord, encodeRecord, readCommit, readSeries, readTree, writeCommit, writeSeries, writeTree, type RecordDocument } from "../engine/model.ts";
import { mergeServedReview, parseForgeRequest, serveForge } from "../engine/forge.ts";
import { collectGarbage } from "../engine/gc.ts";
import { isAncestor } from "../engine/merge.ts";
import { PublicationLeaseError, type FileLease } from "../engine/publication-leases.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { DEFAULT_SERVE_LIMITS, DENIED_BODY } from "../engine/http-protocol.ts";
import { startRepositoryServer, TokenGrants } from "../engine/serve.ts";
import { writeFragmented } from "../engine/fragments.ts";
import { createSandbox } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";

const author = { name: "Agent", email: "agent@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const principal = { principal: "agent-a", breakLeases: false };
const otherPrincipal = { principal: "agent-b", breakLeases: false };

/** Build stable native commits with real working files. */
function commit(repository: Repository, text: string): string {
  writeFileSync(join(repository.root, "asset"), text);
  repository.stage(["asset"]);
  return repository.commit({ message: "fixture change\n", author }, new Date());
}

/** Start the actual serve command in a separate process and wait for its bound socket. */
async function serverProcess(root: string) {
  const auth = join(root, "grants.json");
  writeFileSync(auth, JSON.stringify([
    { token: "token-a", repository: "tenant-a", access: "write", principal: "agent-a" },
    { token: "token-reviewer", repository: "tenant-a", access: "write", principal: "agent-b" },
    { token: "token-reader", repository: "tenant-a", access: "read", principal: "reader" },
    { token: "token-b", repository: "tenant-b", access: "write", principal: "agent-b" },
  ]));
  const worker = spawn(process.execPath, [join(packageRoot, "test/helpers/serve-worker.ts"), root, "127.0.0.1:0", auth], { cwd: packageRoot, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((ready, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("serve readiness timeout")), 30_000);
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`serve exited ${code}`)));
    worker.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /SERVE-READY (\d+)/.exec(text);
      if (match !== null) { clearTimeout(timeout); ready(Number(match[1])); }
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  return { origin, wire: new HttpTransport(`${origin}/tenant-a`, { token: "token-a" }),
    async close() {
      const exited = new Promise<void>((resolveExit, reject) => {
        worker.once("exit", () => resolveExit());
        setTimeout(() => reject(new Error("serve did not stop")), 10_000).unref();
      });
      worker.kill("SIGTERM"); await exited;
    } };
}

/** Prepare a proposed change and its receiver without using external services. */
function fixture() {
  const directory = makeTempDir();
  const sender = Repository.init(join(directory.root, "sender"));
  const base = commit(sender, "base");
  const tip = commit(sender, "changed");
  const id = createSeries(sender.objects, base, tip, { description: "proposal", author });
  const receiver = Repository.init(join(directory.root, "tenant-a"));
  const foreign = Repository.init(join(directory.root, "tenant-b"));
  commit(foreign, "foreign");
  return { directory, sender, receiver, foreign, base, tip, id, fileId: sender.readIndex()[0]!.fileId! };
}

/** Publish through the actual socket after explicit acquisition of the required branch fence. */
async function propose(wire: HttpTransport, source: ReturnType<typeof fixture>) {
  const lease = await wire.lease({ action: "acquire", fileId: source.fileId, refs: ["refs/heads/main"], ttlMs: 60_000 });
  const request = { action: "publish" as const, kind: "series" as const, name: "proposal", expected: null,
    series: source.id, branch: "refs/heads/main", bundle: exportSeriesBundle(source.sender.objects, source.id).toString("base64"), proofs: [lease!] };
  return { result: await wire.forge(request), request, lease: lease! };
}

test("served forge concurrent reviewers preserve disjoint fields and record deterministic same-field outcomes", async () => {
  const source = fixture(); const server = await serverProcess(source.directory.root);
  try {
    const { result, lease } = await propose(server.wire, source);
    const reviewer = new HttpTransport(`${server.origin}/tenant-a`, { token: "token-reviewer" });
    const expected = result.revision as string;
    const writes = await Promise.all([
      server.wire.forge({ action: "publish", kind: "review", name: "proposal", expected, fields: { status: "approved", reviewer: "agent-a" } }),
      reviewer.forge({ action: "publish", kind: "review", name: "proposal", expected, fields: { comments: ["checked"], reviewers: ["agent-b"] } }),
    ]);
    assert.ok(writes.every(write => (write.outcome as RecordDocument).clean === true));
    const read = await server.wire.forge({ action: "fetch", kind: "review", name: "proposal" });
    assert.deepEqual(read.document, { series: source.id, status: "approved", reviewer: "agent-a", comments: ["checked"], reviewers: ["agent-b"] });
    const base = read.revision as string;
    await Promise.all([
      server.wire.forge({ action: "publish", kind: "review", name: "proposal", expected: base, fields: { verdict: "pass" } }),
      reviewer.forge({ action: "publish", kind: "review", name: "proposal", expected: base, fields: { verdict: "fail" } }),
    ]);
    const resolved = await reviewer.forge({ action: "fetch", kind: "review", name: "proposal" });
    assert.equal((resolved.document as RecordDocument).verdict, "fail");
    const outcome = resolved.outcome as RecordDocument;
    assert.equal(outcome.clean, false);
    assert.deepEqual(outcome.resolutions, [{ field: "verdict", base: null, values: ["fail", "pass"], chosen: "fail", rule: "canonical-min" }]);
    assert.ok(["agent-a", "agent-b"].includes(outcome.principal as string));
    const target = Repository.init(join(source.directory.root, "fetched-review"));
    importBundleObjects(target.objects, Buffer.from(resolved.bundle as string, "base64"));
    const records = readTree(target.objects, readCommit(target.objects, resolved.revision as string).tree);
    assert.deepEqual(decodeRecord(target.objects.readTyped(records.find(entry => entry.name === "outcome.json")!.id, "record")), outcome);
    const state = { series: source.id, status: "pending" };
    const left = { ...state, verdict: "pass", comments: ["left"] };
    const right = { ...state, verdict: "fail", comments: ["right"] };
    assert.deepEqual(mergeServedReview(state, left, right), mergeServedReview(state, right, left));
    const catalog = await server.wire.forge({ action: "list", kind: "series" });
    assert.deepEqual(catalog.entries, [{ name: "proposal", id: source.id }]);
    const reviews = await server.wire.forge({ action: "list", kind: "review" });
    assert.equal((reviews.entries as RecordDocument[]).length, 1);
    // GC traverses native refs and parent history; no forge-only retention exception is needed.
    await server.wire.lease({ action: "release", fileId: source.fileId, token: lease.token });
    collectGarbage(source.receiver, true);
    source.receiver.objects.read(resolved.revision as string);
    source.receiver.objects.read(expected);
  } finally { await server.close(); source.directory.cleanup(); }
});

test("real served process denies every cross-tenant object ref series and review operation without an existence oracle", async () => {
  const source = fixture(); const server = await serverProcess(source.directory.root);
  try {
    const { request, result } = await propose(server.wire, source);
    const series = await server.wire.forge({ action: "fetch", kind: "series", name: "proposal" });
    const review = await server.wire.forge({ action: "fetch", kind: "review", name: "proposal" });
    // Copy the catalogs into tenant B with the authorized tenant B principal as a positive control.
    const b = new HttpTransport(`${server.origin}/tenant-b`, { token: "token-b" });
    const lease = await b.lease({ action: "acquire", fileId: source.fileId, refs: ["refs/heads/main"], ttlMs: 60_000 });
    const publishedB = await b.forge({ ...request, proofs: [lease!] });
    const object = source.sender.objects.read(source.tip);
    const update = { ref: "refs/heads/main", expected: null, next: source.tip };
    const operations: Array<{ kind: string; operation: string; endpoint: string; body: object }> = [];
    for (const operation of ["read", "write", "copy", "list", "update"]) {
      operations.push({ kind: "object", operation, endpoint: operation === "list" ? "objects/missing" : ["write", "copy", "update"].includes(operation) ? "objects/upload" : "objects/fetch", body: ["write", "copy", "update"].includes(operation) ? { session: "attack", objects: [{ id: source.tip, type: object.type, payload: object.payload.toString("base64") }] } : { ids: [source.tip] } });
      operations.push({ kind: "ref", operation, endpoint: operation === "list" ? "advertise" : operation === "read" ? "fetch" : operation === "update" ? "publish" : "push", body: operation === "read" ? { refs: [update.ref], haves: [] } : { bundle: exportBundle(source.sender.objects, source.sender.refs, []).toString("base64"), updates: [update], now: 1, force: true, session: "attack" } });
      for (const kind of ["series", "review"] as const) {
        const action = operation === "list" ? "list" : operation === "read" ? "fetch" : "publish";
        operations.push({ kind, operation, endpoint: action === "publish" ? "forge/write" : "forge/read", body: kind === "series" ? { ...request, action, expected: operation === "update" ? source.id : null } : { action, kind, name: "proposal", expected: publishedB.revision, fields: review.document } });
      }
    }
    /** Read full denial bytes and duration, retaining no credentials in assertions. */
    const denied = async (repository: string, endpoint: string, body: object) => {
      const start = performance.now();
      const answer = await fetch(`${server.origin}/${repository}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token-a" }, body: JSON.stringify(body) });
      const bytes = Buffer.from(await answer.arrayBuffer());
      return { status: answer.status, type: answer.headers.get("content-type"), bytes, elapsed: performance.now() - start };
    };
    for (const operation of operations) {
      const existing = await denied("tenant-b", operation.endpoint, operation.body);
      const absent = await denied("tenant-absent", operation.endpoint, operation.body);
      const label = `${operation.kind} ${operation.operation}`;
      assert.equal(existing.status, 404, label); assert.equal(existing.type, "application/json", label);
      assert.ok(existing.bytes.equals(DENIED_BODY), label); assert.deepEqual(existing.bytes, absent.bytes, label);
      assert.equal(existing.status, absent.status, label); assert.equal(existing.type, absent.type, label);
      const times: number[][] = [[existing.elapsed], [absent.elapsed]];
      for (let sample = 0; sample < 8; sample++) for (const [index, tenant] of ["tenant-b", "tenant-absent"].entries()) times[index]!.push((await denied(tenant, operation.endpoint, operation.body)).elapsed);
      const medians = times.map(values => values.sort((a, b) => a - b)[4]!);
      assert.ok(Math.max(...medians) <= Math.min(...medians) * 4 + 10, label + ": existing and absent tenants must stay in the same HTTP timing class");
    }
    const reader = new HttpTransport(`${server.origin}/tenant-a`, { token: "token-reader" });
    await assert.rejects(reader.forge({ action: "publish", kind: "review", name: "proposal", expected: result.revision as string, fields: { verdict: "attacker" } }), { code: "forbidden" });
    await assert.rejects(reader.forge(request), { code: "forbidden" });
    const smuggled = await fetch(`${server.origin}/tenant-a/forge/read`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token-reader" }, body: JSON.stringify(request) });
    assert.equal(smuggled.status, 400);
    assert.equal(source.receiver.refs.read("refs/heads/main"), null);
    assert.equal(source.foreign.refs.read("refs/forge-series/proposal"), source.id);
    assert.equal((await server.wire.forge({ action: "fetch", kind: "series", name: "proposal" })).bundle, series.bundle);
    // A source address alone is no cross-tenant copy capability inside an authorized destination.
    await assert.rejects(server.wire.fetchObjects([source.foreign.resolve("main")]), { code: "object_not_found" });
  } finally { await server.close(); source.directory.cleanup(); }
});

test("real served forge and ref publication reject missing expired foreign and out-of-branch leases with typed reasons", async () => {
  const source = fixture(); const server = await serverProcess(source.directory.root);
  try {
    const bundle = exportSeriesBundle(source.sender.objects, source.id);
    const request = { action: "publish" as const, kind: "series" as const, name: "proposal", expected: null, series: source.id, branch: "refs/heads/main", bundle: bundle.toString("base64"), proofs: [] as FileLease[] };
    const updates = [{ ref: "refs/heads/main", expected: null, next: source.tip }];
    /** Count stored objects: once the bundle closure is imported, a refused publication must add none. */
    const storedObjects = () => readdirSync(join(source.receiver.controlDirectory, "objects"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length;
    let closureImported = false;
    /** Both kinds of publication must retain the same typed receiver reason and leave all roots unchanged. */
    const refuse = async (reason: string, proofs: FileLease[]) => {
      const predicate = (error: unknown) => { assert.ok(error instanceof PublicationLeaseError); assert.equal(error.reason, reason); assert.equal(error.fileId, source.fileId); return true; };
      const before = storedObjects();
      await assert.rejects(server.wire.forge({ ...request, proofs }), predicate);
      await assert.rejects(server.wire.push(bundle, updates, true, new Date(0), proofs), predicate);
      // The lease check precedes the review write, so no orphaned review record, tree or commit remains.
      if (closureImported) assert.equal(storedObjects(), before, `a ${reason} refusal stored objects`);
      closureImported = true;
      assert.equal(source.receiver.refs.read("refs/forge-series/proposal"), null);
      assert.equal(source.receiver.refs.read("refs/heads/main"), null);
    };
    await refuse("missing", []);
    const short = await server.wire.lease({ action: "acquire", fileId: source.fileId, refs: [updates[0]!.ref], ttlMs: 1 });
    await new Promise(resolve => { setTimeout(resolve, 15); }); await refuse("expired", [short!]);
    const reviewer = new HttpTransport(`${server.origin}/tenant-a`, { token: "token-reviewer" });
    const foreign = await reviewer.lease({ action: "acquire", fileId: source.fileId, refs: [updates[0]!.ref], ttlMs: 60_000 });
    await refuse("wrong_principal", [foreign!]);
    await reviewer.lease({ action: "release", fileId: source.fileId, token: foreign!.token });
    const wrongScope = await server.wire.lease({ action: "acquire", fileId: source.fileId, refs: ["refs/heads/other"], ttlMs: 60_000 });
    await refuse("out_of_scope", [wrongScope!]);
    await server.wire.lease({ action: "release", fileId: source.fileId, token: wrongScope!.token });
    const valid = await server.wire.lease({ action: "acquire", fileId: source.fileId, refs: [updates[0]!.ref], ttlMs: 60_000 });
    await server.wire.forge({ ...request, proofs: [valid!] });
    await server.wire.publish(updates, false, new Date(), [valid!]);
    assert.equal(source.receiver.resolve("main"), source.tip);
  } finally { await server.close(); source.directory.cleanup(); }
});

test("installed pm vcs commands propose fetch apply rederive review and land through a real served process", { timeout: 180_000 }, async () => {
  const sandbox = createSandbox({ mergeInstall: false, commitFence: false });
  const source = fixture(); const server = await serverProcess(source.directory.root);
  try {
    const sender = Repository.init(sandbox.root);
    const base = commit(sender, "base");
    const remote = `${server.origin}/tenant-a`; sender.remotes.add("origin", remote);
    // Install compiled bytes in a real scratch tracker's project extension layout.
    const extensionRoot = join(sandbox.pmRoot, "extensions/pm-vcs"); mkdirSync(extensionRoot, { recursive: true });
    for (const name of ["manifest.json", "package.json"]) cpSync(join(packageRoot, name), join(extensionRoot, name));
    cpSync(join(packageRoot, "dist"), join(extensionRoot, "dist"), { recursive: true });
    symlinkSync(join(packageRoot, "node_modules"), join(extensionRoot, "node_modules"), "junction");
    /** Invoke the repository-pinned host and real extension; all requests use the real HTTP process. */
    const cli = (args: string[]) => {
      const result = spawnSync(process.execPath, [pmExecutable, "vcs", ...args, "--json"], { cwd: sandbox.root, env: { ...withoutPmContext(process.env), PM_VCS_TOKEN: "token-a" }, encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout) as RecordDocument;
    };
    const fileId = sender.readIndex()[0]!.fileId!;
    cli(["lease", "acquire", fileId, "origin", "--refs", "refs/heads/main", "--ttl-ms", "60000"]);
    cli(["push", "origin"]);
    const cloneRoot = join(source.directory.root, "clone");
    await cloneFrom(remote, cloneRoot, new Date(), "origin", source.directory.root, new HttpTransport(remote, { token: "token-a" }));
    commit(sender, "changed");
    const id = cli(["series", "create", base, "HEAD", "--description", "agent proposal"]).id as string;
    const publication = cli(["series", "push", "cli-proposal", id, "--branch", "refs/heads/main"]);
    assert.deepEqual(cli(["series", "list"]).entries, [{ name: "cli-proposal", id }]);
    cli(["series", "fetch", "cli-proposal"]);
    const fetched = cli(["review", "fetch", "cli-proposal"]);
    assert.equal(fetched.revision, publication.revision);
    cli(["review", "list"]);
    const review = cli(["review", "update", "cli-proposal", "--base", fetched.revision as string, "--fields", '{"status":"approved","comments":["ready"]}']);
    assert.equal((review.document as RecordDocument).status, "approved");
    // A second clone starts at the original base and imports the served native series.
    const clone = Repository.open(cloneRoot);
    assert.equal(clone.objects.has(id), false, "the independent served clone has no proposal before fetching");
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
    const previousToken = process.env.PM_VCS_TOKEN;
    process.env.PM_VCS_TOKEN = "token-a";
    try {
      for (const command of ["vcs series fetch", "vcs review fetch"]) {
        const fetchedClone = await harness.runCommand({ command, args: ["cli-proposal"], pmRoot: clone.root }); assert.equal(fetchedClone.errorMessage, undefined);
      }
      const applied = await harness.runCommand({ command: "vcs series apply", args: [id], pmRoot: clone.root }); assert.equal(applied.errorMessage, undefined);
      assert.equal(readFileSync(join(clone.root, "asset"), "utf8"), "changed");
      const original = readSeries(sender.objects, id);
      assert.equal(clone.refs.resolveHead(), original.patches.at(-1)!.commit);
      assert.equal(createSeries(clone.objects, original.base, clone.resolve("HEAD"), { description: original.description, author: original.author }), id, "rederive from the applied branch must retain the exact proposal identity");
      const rederived = await harness.runCommand({ command: "vcs series rederive", args: [id], pmRoot: clone.root }); assert.equal(rederived.errorMessage, undefined); assert.equal((rederived.result as RecordDocument).id, id);
    } finally { if (previousToken === undefined) delete process.env.PM_VCS_TOKEN; else process.env.PM_VCS_TOKEN = previousToken; }
    assert.ok(sender.objects.readTyped(id, "series").equals(clone.objects.readTyped(id, "series")));
    cli(["push", "origin"]); assert.equal(source.receiver.resolve("main"), sender.resolve("main"));
  } finally { await server.close(); source.directory.cleanup(); sandbox.cleanup(); }
});

test("forge envelopes reject malformed operations names revisions scopes and review patches before catalog access", () => {
  const id = "a".repeat(64);
  for (const value of [
    {}, { action: "delete", kind: "series" }, { action: "list", kind: "unknown" },
    { action: "fetch", kind: "series" }, { action: "fetch", kind: "review", name: "../secret" },
    { action: "publish", kind: "series", name: "proposal", expected: undefined },
    { action: "publish", kind: "series", name: "proposal", expected: "bad" },
    ...[{ series: 1 }, { series: "bad" }, { branch: 1 }, { branch: "refs/tags/tag" }, { branch: "refs/heads/../escape" }, { bundle: 1 }, { proofs: 1 }].map(change => ({ action: "publish", kind: "series", name: "proposal", expected: id, series: id, branch: "refs/heads/main", ...change })),
    ...[undefined, null, [], { series: id }, { unknown: "field" }, { status: "invalid" }, { status: 7 }].map(fields => ({ action: "publish", kind: "review", name: "proposal", expected: id, fields })),
  ]) assert.throws(() => parseForgeRequest(value));
  assert.deepEqual(parseForgeRequest({ action: "list", kind: "review", name: "ignored" }), { action: "list", kind: "review" });
  assert.deepEqual(parseForgeRequest({ action: "fetch", kind: "series", name: "proposal" }), { action: "fetch", kind: "series", name: "proposal" });
  assert.deepEqual(parseForgeRequest({ action: "publish", kind: "review", name: "proposal", expected: null, fields: {} }).fields, {});
});

test("native forge CAS updates reset review state and reject foreign or stale review bases", async () => {
  const source = fixture();
  try {
    const wire = new FileTransport("receiver", source.receiver.root);
    const lease = await wire.lease({ action: "acquire", fileId: source.fileId, refs: ["refs/heads/main"], ttlMs: 60_000 }, principal);
    const request = { action: "publish" as const, kind: "series" as const, name: "proposal", expected: null,
      series: source.id, branch: "refs/heads/main", bundle: exportSeriesBundle(source.sender.objects, source.id).toString("base64"), proofs: [lease!] };
    const published = await wire.forge(request, principal);
    const base = published.revision as string;
    await assert.rejects(wire.forge(request, principal), { code: "publication_race" });
    for (const kind of ["series", "review"] as const) await assert.rejects(wire.forge({ action: "fetch", kind, name: "missing" }), { code: `missing_${kind}` });
    await assert.rejects(wire.forge({ action: "publish", kind: "review", name: "missing", expected: base, fields: {} }), { code: "missing_review" });
    for (const expected of [null, source.tip]) await assert.rejects(wire.forge({ action: "publish", kind: "review", name: "proposal", expected, fields: {} }), { code: "invalid_review_base" });
    const reviewed = await wire.forge({ action: "publish", kind: "review", name: "proposal", expected: base, fields: { status: "approved" } }, otherPrincipal);
    assert.equal((reviewed.document as RecordDocument).status, "approved");
    const nextTip = commit(source.sender, "revision two");
    const nextId = createSeries(source.sender.objects, source.base, nextTip, { description: "revision two", author });
    const update = await wire.forge({ ...request, expected: source.id, series: nextId, bundle: exportSeriesBundle(source.sender.objects, nextId).toString("base64") }, principal);
    const reset = await wire.forge({ action: "fetch", kind: "review", name: "proposal" });
    assert.deepEqual(reset.document, { series: nextId, status: "pending" });
    await assert.rejects(wire.forge({ action: "publish", kind: "review", name: "proposal", expected: base, fields: { status: "approved" } }), { code: "stale_review_series" });
    assert.equal(readCommit(source.receiver.objects, update.revision as string).parents[0], reviewed.revision);
    // Pre-uploaded verified objects can be published without an inline bundle.
    const read = await wire.forge({ action: "fetch", kind: "series", name: "proposal" });
    assert.equal(read.id, nextId);
    await wire.forge({ ...request, name: "preuploaded", bundle: undefined }, principal);
    const empty = writeSeries(source.sender.objects, { base: source.base, patches: [], description: "empty", author });
    source.receiver.objects.accept([{ id: empty, type: "series", payload: source.sender.objects.readTyped(empty, "series") }], false);
    await assert.rejects(wire.forge({ ...request, name: "empty", series: empty, bundle: undefined }, principal), { code: "empty_series" });
    // Malformed native history cannot be interpreted as a review document.
    const malformed = writeCommit(source.receiver.objects, { tree: writeTree(source.receiver.objects, []), parents: [update.revision as string], author, committer: author, message: "malformed" });
    source.receiver.refs.compareAndSwap("refs/forge-review/proposal", update.revision as string, malformed);
    await assert.rejects(wire.forge({ action: "fetch", kind: "review", name: "proposal" }), { code: "invalid_review" });
    await wire.lease({ action: "release", fileId: source.fileId, token: lease!.token }, principal);
    collectGarbage(source.receiver, true);
    source.receiver.objects.read(base); source.receiver.objects.read(source.id);
  } finally { source.directory.cleanup(); }
});

test("series bundles include fragment closure and rederive identical binary proposal bytes in a fresh served store", async () => {
  const source = fixture(); const server = await serverProcess(source.directory.root);
  try {
    const binary = writeFragmented(source.sender.objects, Buffer.from("binary payload spanning fragments"), 4);
    const tree = writeTree(source.sender.objects, [{ name: "binary", mode: "100644", id: binary.manifestId }]);
    const tip = writeCommit(source.sender.objects, { tree, parents: [source.tip], author, committer: author, message: "binary" });
    const id = createSeries(source.sender.objects, source.base, tip, { description: "binary", author });
    const lease = await server.wire.lease({ action: "acquire", fileId: source.fileId, refs: ["refs/heads/main"], ttlMs: 60_000 });
    await server.wire.forge({ action: "publish", kind: "series", name: "binary", series: id, expected: null, branch: "refs/heads/main", proofs: [lease!], bundle: exportSeriesBundle(source.sender.objects, id).toString("base64") });
    const fetched = await server.wire.forge({ action: "fetch", kind: "series", name: "binary" });
    const target = Repository.init(join(source.directory.root, "binary-clone"));
    const bundle = Buffer.from(fetched.bundle as string, "base64");
    importBundleObjects(target.objects, bundle);
    assert.ok(parseBundle(bundle).lines.some(line => line.id === binary.manifestId));
    assert.equal(createSeries(target.objects, source.base, tip, { description: "binary", author }), id);
    assert.ok(target.objects.readTyped(id, "series").equals(source.sender.objects.readTyped(id, "series")));
  } finally { await server.close(); source.directory.cleanup(); }
});

test("extension forge command defaults explicit remotes and refusal paths use real native repositories", async () => {
  const source = fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  try {
    source.sender.remotes.add("origin", source.receiver.root);
    source.sender.remotes.add("named", source.receiver.root);
    /** Exercise source handlers as well as the compiled installed CLI with the same SDK contract. */
    const run = async (command: string, args: string[], options: Record<string, unknown> = {}) => {
      const result = await harness.runCommand({ command, args, options, pmRoot: source.sender.root });
      assert.equal(result.errorMessage, undefined, result.errorMessage ?? "command refused"); return result.result as RecordDocument;
    };
    const created = await run("vcs series create", [source.base, source.tip], { description: "command proposal" });
    const id = created.id as string;
    await run("vcs lease", ["acquire", source.fileId, "named"], { refs: "refs/heads/main", ttlMs: "60000" });
    await run("vcs lease", ["renew", source.fileId], { fence: (await new FileTransport("receiver", source.receiver.root).lease({ action: "inspect", fileId: source.fileId }))!.token, ttlMs: "60000" });
    const publication = await run("vcs series push", ["commands", id, "named"], { branch: "refs/heads/main" });
    const updated = await run("vcs series push", ["commands", id, "named"], { branch: "refs/heads/main", expected: id });
    await run("vcs series push", ["default", id], { branch: "refs/heads/main" });
    assert.equal(updated.id, id);
    assert.notEqual(updated.revision, publication.revision);
    for (const kind of ["series", "review"]) {
      await run(`vcs ${kind} list`, ["named"]); await run(`vcs ${kind} list`, []);
      await run(`vcs ${kind} fetch`, ["commands", "named"]); await run(`vcs ${kind} fetch`, ["commands"]);
    }
    await run("vcs review update", ["commands", "named"], { base: updated.revision, fields: '{"comments":["tested"]}' });
    const fetched = await run("vcs review fetch", ["commands"]);
    await run("vcs review update", ["commands"], { base: fetched.revision, fields: '{"status":"approved"}' });
    // Applying on another HEAD uses native replay while retaining the original series for rederivation.
    await run("vcs series apply", [id]);
    const noDescription = await harness.runCommand({ command: "vcs series create", args: [source.base, source.tip], pmRoot: source.sender.root });
    assert.match(noDescription.errorMessage!, /--description/);
    const empty = writeSeries(source.sender.objects, { base: source.base, patches: [], description: "empty", author });
    const refusedEmpty = await harness.runCommand({ command: "vcs series apply", args: [empty], pmRoot: source.sender.root });
    assert.match(refusedEmpty.errorMessage!, /no patches/);
    const mid = commit(source.sender, "middle"); const tip = commit(source.sender, "tip");
    const partial = writeSeries(source.sender.objects, { base: source.base, patches: [{ commit: source.tip }, { commit: tip }], description: "skipped middle", author });
    assert.notEqual(mid, tip);
    const mismatch = await harness.runCommand({ command: "vcs series rederive", args: [partial], pmRoot: source.sender.root });
    assert.match(mismatch.errorMessage!, /bytes differ/);
    const missingBase = await harness.runCommand({ command: "vcs review update", args: ["commands"], options: { fields: "{}" }, pmRoot: source.sender.root });
    assert.match(missingBase.errorMessage!, /--base/);
    const absentFields = await harness.runCommand({ command: "vcs review update", args: ["commands"], pmRoot: source.sender.root });
    assert.match(absentFields.errorMessage!, /--fields/);
  } finally { source.directory.cleanup(); }
});

test("forge fetch validates remote roots before catalog CAS", async t => {
  const source = fixture(); const server = await serverProcess(source.directory.root);
  const sandbox = createSandbox({ mergeInstall: false, commitFence: false });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  let answer: RecordDocument = {};
  const responder = createServer(async (request, response) => {
    request.resume(); response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.endsWith("/advertise") === true
      ? await new FileTransport("fixture", source.sender.root).advertise() : answer));
  });
  try {
    await propose(server.wire, source);
    await new Promise<void>(resolve => { responder.listen(0, "127.0.0.1", resolve); });
    const address = responder.address(); assert.ok(address !== null && typeof address !== "string");
    const repository = Repository.init(sandbox.root);
    repository.remotes.add("origin", `http://127.0.0.1:${address.port}/tenant-a`);
    for (const kind of ["series", "review"] as const) {
      const valid = await server.wire.forge({ action: "fetch", kind, name: "proposal" });
      importBundleObjects(repository.objects, Buffer.from(valid.bundle as string, "base64"));
      const field = kind === "series" ? "id" : "revision";
      const ref = `refs/forge-${kind}/proposal`;
      const before = valid[field] as string;
      const command = `vcs ${kind} fetch`;
      const handler = harness.activation.commands.handlers.find(entry => entry.command === command)!;
      /** Call the real registered handler directly so the SDK dispatcher cannot flatten the typed error. */
      const run = async (name: string) => handler.run({ command, args: [name], options: {}, global: {}, pm_root: sandbox.pmRoot, source_workspace_root: sandbox.root });
      const cases = [
        { name: "non-string id", id: 17, code: "invalid_object_id" },
        { name: "syntactically invalid id", id: "invalid", code: "invalid_object_id" },
        { name: "valid id absent from bundle", id: "f".repeat(64), code: "object_not_found" },
        { name: "object of wrong kind", id: kind === "series" ? source.tip : source.id, code: "object_type_mismatch" },
        ...(kind === "review" ? [{ name: "commit missing review records", id: source.tip, code: "invalid_review" }] : []),
      ];
      for (const [index, scenario] of cases.entries()) await t.test(`${kind} fetch refuses ${scenario.name} and preserves the ref`, async () => {
        const name = `proposal-${index}`;
        const ref = `refs/forge-${kind}/${name}`;
        repository.refs.compareAndSwap(ref, null, before);
        const operations = repository.operations.read();
        assert.equal(repository.objects.has("f".repeat(64)), false);
        answer = { ...valid, [field]: scenario.id };
        await assert.rejects(() => run(name), (error: unknown) => {
          assert.ok(error instanceof ObjectStoreError); assert.equal(error.code, scenario.code); return true;
        });
        assert.equal(repository.refs.read(ref), before);
        assert.deepEqual(repository.operations.read(), operations);
      });
      answer = valid;
      repository.refs.compareAndSwap(ref, null, before);
      await run("proposal");
      assert.equal(repository.refs.read(ref), before);
    }
  } finally {
    responder.closeAllConnections();
    await new Promise<void>(resolve => { responder.close(() => resolve()); });
    await server.close(); sandbox.cleanup(); source.directory.cleanup();
  }
});

test("forge publication obeys receiver object bounds and refuses read operations on its write endpoint", async () => {
  const source = fixture();
  const server = await startRepositoryServer({ root: source.directory.root, host: "127.0.0.1", port: 0,
    grants: new TokenGrants([{ token: "bounded", repository: "tenant-a", access: "write" }]), limits: { ...DEFAULT_SERVE_LIMITS, maxUploadObjects: 1 } });
  try {
    const url = `http://127.0.0.1:${server.port}/tenant-a`;
    const wire = new HttpTransport(url, { token: "bounded" });
    await assert.rejects(wire.forge({ action: "publish", kind: "series", name: "bounded", expected: null, series: source.id, branch: "refs/heads/main", bundle: exportSeriesBundle(source.sender.objects, source.id).toString("base64") }), { code: "limit_exceeded" });
    const wrongEndpoint = await fetch(`${url}/forge/write`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bounded" }, body: JSON.stringify({ action: "fetch", kind: "series", name: "bounded" }) });
    assert.equal(wrongEndpoint.status, 400);
    assert.equal(source.receiver.refs.read("refs/forge-series/bounded"), null);
    assert.equal(source.receiver.objects.has(source.id), false);
  } finally { await server.close(); source.directory.cleanup(); }
});

test("file forge publication from a linked instance uses the shared receiver lease authority", async () => {
  const source = fixture();
  try {
    importBundleObjects(source.receiver.objects, exportSeriesBundle(source.sender.objects, source.id));
    source.receiver.refs.compareAndSwap("refs/heads/main", null, source.base);
    source.receiver.materialize(readCommit(source.receiver.objects, source.base).tree);
    const root = join(source.directory.root, "linked");
    source.receiver.linkInstance("linked", root);
    const wire = new FileTransport("linked", root);
    const lease = await wire.lease({ action: "acquire", fileId: source.fileId, refs: ["refs/heads/main"], ttlMs: 60_000 });
    const published = await wire.forge({ action: "publish", kind: "series", name: "linked", expected: null, series: source.id, branch: "refs/heads/main", proofs: [lease!] });
    assert.equal(published.id, source.id);
    assert.equal(source.receiver.refs.read("refs/forge-series/linked"), source.id);
    const review = await wire.forge({ action: "fetch", kind: "review", name: "linked" });
    assert.equal((review.document as RecordDocument).series, source.id);
  } finally { source.directory.cleanup(); }
});

test("series apply never fast-forwards through an undeclared merge parent", async () => {
  const directory = makeTempDir();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  try {
    const repository = Repository.init(join(directory.root, "merge-series"));
    const store = repository.objects;
    const base = commit(repository, "base");
    const declaredTree = commit(repository, "declared"), sideTree = commit(repository, "side"), tipTree = commit(repository, "tip");
    // base <- declared <- merge -> side -> base: the series declares only `declared` and `merge`.
    const declared = writeCommit(store, { ...readCommit(store, declaredTree), parents: [base] });
    const side = writeCommit(store, { ...readCommit(store, sideTree), parents: [base] });
    const merge = writeCommit(store, { ...readCommit(store, tipTree), parents: [declared, side] });
    repository.reset(base, "hard", new Date());
    const series = writeSeries(store, { base, patches: [{ commit: declared }, { commit: merge }], description: "merge proposal", author });
    const applied = await harness.runCommand({ command: "vcs series apply", args: [series], pmRoot: repository.root });
    assert.equal(applied.errorMessage, undefined, applied.errorMessage ?? "series apply refused");
    const head = (applied.result as RecordDocument).commit as string;
    assert.notEqual(head, merge);
    assert.equal(isAncestor(store, side, head), false, "the undeclared merge parent entered the applied history");
    assert.equal(readTree(store, readCommit(store, head).tree).length > 0, true);
  } finally { directory.cleanup(); }
});
