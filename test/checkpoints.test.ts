import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Semantic validation on actual core trackers, immutable native snapshots and receiver publication. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient, createAssuranceWorkspaceContext, evaluateAssuranceGate, recordAssuranceVerdict, type AssuranceDocument, type AssuranceGateVerdict } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { attachCheckpoint, checkpointClaims, CheckpointRefusal, createSemanticCheckpoint, inspectCheckpoints, loadCheckpointReceipt, parseCheckpointPolicy, parseCheckpointRequest, parseCheckpointRequirement, updateCheckpointPolicy, CHECKPOINT_POLICY_FILE, type CheckpointRequest } from "../index.ts";
import { assertCheckpointPublication, readCheckpointPolicy } from "../engine/checkpoints.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { decodeCommit, encodeCommit, encodeRecord, effectiveChangeId, readCommit, writeCommit, type Commit, type Signature } from "../engine/model.ts";
import { Repository } from "../engine/repo.ts";
import { createSeries, exportSeriesBundle } from "../engine/series.ts";
import { exportBundle } from "../engine/bundle.ts";
import { startRepositoryServer } from "../engine/serve.ts";
import { signChange, verifyChangeSignature } from "../engine/signatures.ts";
import { LeasedFileTransport, LeasedHttpTransport } from "./helpers/publication-consumers.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { installPackedExtension } from "../scripts/pm-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const evaluatedAt = "2026-10-23T00:00:00.000Z";
afterEach(() => { for (const dir of owned.splice(0)) dir.cleanup(); });
/** Allocate a disposable real directory. */
function temp() { const dir = makeTempDir(); owned.push(dir); return dir.root; }
/** Produce a real core assurance result, without mocking any SDK behavior. */
async function receipt(treeId: string, pmRoot: string, at = evaluatedAt): Promise<AssuranceGateVerdict> {
  const document: AssuranceDocument = { version: 1,
    measurements: [{ id: "population", source: { kind: "items" } }],
    assertions: [{ id: "ready", measurement_id: "population", owner_item_id: "fixture", scope: { kind: "all" }, floor: 1, enforcement: "block",
      negative_control: { cases: [{ observed: 1, expected: "pass" }, { observed: 0, expected: "fail" }] } }],
    gates: [{ id: "quality", assertion_ids: ["ready"], triggers: ["ci"] }] };
  const context = await createAssuranceWorkspaceContext(pmRoot, { tree_id: treeId, resolve_tree: false, strict_read: true });
  return { ...await evaluateAssuranceGate("quality", document, context, { trigger: "ci" }), evaluated_at: at };
}
/** Initialize a no-Git SDK tracker and native record scope with a declared policy dependency. */
async function fixture() {
  const root = temp(); const pmRoot = join(root, ".agents/pm");
  const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
  await client.init("checkpoint", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Native checkpoint", author: "fixture" })).item;
  const path = `.agents/pm/tasks/${item.id}.toon`;
  writeFileSync(join(root, "policy.json"), '{"revision":1}');
  const repo = Repository.init(root, "main", { recordPaths: ["**/*.toon", "**/*.json"], recordPolicy: {} });
  repo.stage([path, "policy.json"]); const id = repo.commit({ message: "base", author }, new Date(1));
  const commit = readCommit(repo.objects, id);
  const request: CheckpointRequest = { id: "validation", scope: [{ path, fields: ["status", "acceptance_criteria"] }], dependencies: [{ path: "policy.json" }], gateId: "quality", assertionId: "ready", receipt: { treeId: commit.tree, evaluatedAt } };
  const verdict = await receipt(commit.tree, pmRoot); await recordAssuranceVerdict(pmRoot, verdict, { author: "fixture" });
  const claim = createSemanticCheckpoint(repo.objects, id, commit, request, verdict);
  const carried: Commit = { ...commit, checkpoints: attachCheckpoint(commit, claim) };
  return { root, pmRoot, client, item, path, repo, id, commit, request, verdict, claim, carried };
}
/** Replace one native record entry, retaining the original logical file identity. */
function revised(repo: Repository, commit: Commit, path: string, document: Record<string, string | number | null>): Commit {
  const entries = flattenTree(repo.objects, commit.tree); const previous = entries.get(path)!;
  entries.set(path, { ...previous, id: repo.objects.write("record", encodeRecord(document)) });
  return { ...commit, tree: buildTree(repo.objects, entries) };
}

test("reattaching a wider scope cannot reuse the original tree and evaluatedAt receipt", async () => {
  const { repo, id, commit, request, verdict, path, pmRoot } = await fixture();
  const first = repo.checkpoint(id, request, verdict, author, new Date(2))!;
  const attached = readCommit(repo.objects, first);
  const original = checkpointClaims(attached)[0];
  const widened = { ...request, scope: [{ path, fields: ["status", "acceptance_criteria", "title"] }] };
  const before = repo.operations.read();
  assert.throws(() => repo.checkpoint("HEAD", widened, verdict, author, new Date(3)), error =>
    error instanceof CheckpointRefusal && error.code === "checkpoint_evidence_refused" && /later.*exact replacement scope/.test(error.remedy));
  assert.equal(repo.resolve("HEAD"), first);
  assert.deepEqual(repo.operations.read(), before);
  assert.deepEqual(checkpointClaims(readCommit(repo.objects, first)), [original]);
  assert.equal(inspectCheckpoints(repo.objects, first, attached, [widened]).rows[0].status, "requirement_changed");
  updateCheckpointPolicy(repo.objects, repo.controlDirectory, [widened]);
  assert.throws(() => assertCheckpointPublication(repo.objects, repo.controlDirectory, new Map([[first, attached]]), [first]), { code: "checkpoint_publication_refused" });

  const freshRequest = { ...widened, receipt: { treeId: commit.tree, evaluatedAt: "2026-10-23T00:00:01.000Z" } };
  const freshVerdict = await receipt(commit.tree, pmRoot, freshRequest.receipt.evaluatedAt);
  await recordAssuranceVerdict(pmRoot, freshVerdict, { author: "fixture" });
  const fresh = createSemanticCheckpoint(repo.objects, first, attached, freshRequest, await loadCheckpointReceipt(pmRoot, freshRequest));
  assert.notEqual(fresh.fingerprint, original.fingerprint);
  assert.notEqual(fresh.evidenceDigest, original.evidenceDigest);
  for (const invalid of [
    { ...fresh, receipt: { ...fresh.receipt, treeId: "a".repeat(64) } },
    { ...fresh, receipt: { ...fresh.receipt, evaluatedAt } },
    { ...fresh, receipt: { ...fresh.receipt, evaluatedAt: "2026-10-22T00:00:00.000Z" } },
    { ...fresh, fingerprint: original.fingerprint },
    { ...fresh, evidenceDigest: original.evidenceDigest },
  ]) assert.throws(() => attachCheckpoint(attached, invalid), { code: "checkpoint_evidence_refused" });
  const renewed = repo.checkpoint("HEAD", freshRequest, freshVerdict, author, new Date(4))!;
  const renewedCommit = readCommit(repo.objects, renewed);
  assert.equal(inspectCheckpoints(repo.objects, renewed, renewedCommit, [widened]).ok, true);
  assertCheckpointPublication(repo.objects, repo.controlDirectory, new Map([[renewed, renewedCommit]]), [renewed]);
});

test("identical normalized checkpoint attachment preserves commit, signature and operation log", async () => {
  const { repo, id, request, verdict, path } = await fixture();
  repo.checkpoint(id, request, verdict, author, new Date(2));
  const keys = generateKeyPairSync("ed25519");
  const signed = repo.sign("HEAD", keys.privateKey, author, new Date(3))!;
  const commit = readCommit(repo.objects, signed);
  const before = repo.operations.read();
  const equivalent = { ...request, scope: [{ path, fields: ["acceptance_criteria", "status"] }] };
  assert.equal(repo.checkpoint("HEAD", equivalent, verdict, author, new Date(4)), signed);
  assert.deepEqual(readCommit(repo.objects, repo.resolve("HEAD")), commit);
  assert.deepEqual(repo.operations.read(), before);
  assert.ok(commit.attestation);
});

test("selected copiedFrom provenance invalidates whole-file and field claims on scope and dependencies", async () => {
  const { repo, id, commit, request, path, pmRoot } = await fixture();
  for (const dependency of [false, true]) for (const fields of [undefined, [dependency ? "revision" : "status"]]) {
    const selected = dependency ? "policy.json" : path;
    const selection = { path: selected, ...(fields === undefined ? {} : { fields }) };
    const capture = { ...request, ...(dependency ? { dependencies: [selection] } : { scope: [selection] }) };
    const entries = flattenTree(repo.objects, commit.tree);
    const entry = entries.get(selected)!;
    for (const initial of [undefined, "c".repeat(32)]) {
      entries.set(selected, { ...entry, copiedFrom: initial });
      const baseline = { ...commit, tree: buildTree(repo.objects, entries) };
      const currentRequest = { ...capture, receipt: { ...request.receipt, treeId: baseline.tree } };
      const currentVerdict = await receipt(baseline.tree, pmRoot);
      const claim = createSemanticCheckpoint(repo.objects, id, baseline, currentRequest, currentVerdict);
      const carried = { ...baseline, checkpoints: attachCheckpoint(baseline, claim) };
      assert.equal(inspectCheckpoints(repo.objects, id, carried, [capture]).ok, true);
      for (const copiedFrom of initial === undefined ? ["c".repeat(32)] : ["d".repeat(32), undefined]) {
        entries.set(selected, { ...entry, copiedFrom });
        const changed = { ...carried, tree: buildTree(repo.objects, entries) };
        const after = flattenTree(repo.objects, changed.tree).get(selected)!;
        assert.equal(after.id, entry.id);
        assert.equal(after.mode, entry.mode);
        assert.equal(after.fileId, entry.fileId);
        assert.equal(inspectCheckpoints(repo.objects, id, changed, [capture]).rows[0].status, "scope_changed");
        const changedId = writeCommit(repo.objects, changed);
        assert.throws(() => assertCheckpointPublication(repo.objects, repo.controlDirectory, new Map([[changedId, changed]]), [changedId]), { code: "checkpoint_publication_refused" });
      }
    }
  }
});

test("irrelevant record fields and descriptions retain claims; relevant fields, policy and identities invalidate them", async () => {
  const { repo, id, request, carried, path, claim, pmRoot } = await fixture();
  assert.equal(inspectCheckpoints(repo.objects, id, carried).ok, true);
  const irrelevant = revised(repo, carried, path, { status: "open", title: "New title", comments: "unrelated" });
  assert.equal(inspectCheckpoints(repo.objects, id, irrelevant).ok, true);
  for (const changed of [revised(repo, carried, path, { status: "closed" }), revised(repo, carried, path, { status: "open", acceptance_criteria: null }),
    revised(repo, carried, "policy.json", { revision: 2 }), { ...carried, changeId: "e".repeat(64) }]) {
    assert.equal(inspectCheckpoints(repo.objects, id, changed).rows[0].status, "scope_changed");
  }
  const entries = flattenTree(repo.objects, carried.tree); const entry = entries.get(path)!;
  for (const altered of [{ id: entry.id, mode: entry.mode }, { ...entry, fileId: "b".repeat(32) }, { ...entry, mode: "100755" as const }]) {
    entries.set(path, altered);
    assert.equal(inspectCheckpoints(repo.objects, id, { ...carried, tree: buildTree(repo.objects, entries) }).ok, false);
  }
  entries.delete(path);
  assert.equal(inspectCheckpoints(repo.objects, id, { ...carried, tree: buildTree(repo.objects, entries) }).ok, false);
  const missingTree = buildTree(repo.objects, entries); const missingVerdict = await receipt(missingTree, pmRoot);
  assert.throws(() => createSemanticCheckpoint(repo.objects, id, { ...carried, tree: missingTree }, { ...request, receipt: { ...request.receipt, treeId: missingTree } }, missingVerdict), { code: "checkpoint_scope_unavailable" });
  const required = { ...parseCheckpointRequirement(request), scope: [{ path }] };
  assert.equal(inspectCheckpoints(repo.objects, id, carried, [required]).rows[0].status, "requirement_changed");
  assert.equal(inspectCheckpoints(repo.objects, id, { ...carried, checkpoints: undefined }, [required]).rows[0].status, "missing");
  const another = { ...claim, id: "another" };
  const multiple = { ...carried, checkpoints: attachCheckpoint(carried, another) };
  assert.equal(checkpointClaims({ ...multiple, checkpoints: attachCheckpoint(multiple, claim) }).length, 2);
  assert.equal(inspectCheckpoints(repo.objects, id, multiple, [], 1).omitted, 1);
  assert.equal(inspectCheckpoints(repo.objects, id, carried, [parseCheckpointRequirement(request)]).ok, true);
  assert.throws(() => inspectCheckpoints(repo.objects, id, carried, [request, request]), { code: "invalid_checkpoint_policy" });
  for (const limit of [0, 101, NaN, 1.5]) assert.throws(() => inspectCheckpoints(repo.objects, id, carried, [], limit), { code: "invalid_checkpoint_limit" });
});

test("canonical requests reject malformed selectors, labels and receipt identities", async () => {
  const { request } = await fixture();
  assert.deepEqual(parseCheckpointRequest(request).scope[0].fields, ["acceptance_criteria", "status"]);
  assert.deepEqual(parseCheckpointRequirement({ ...request, scope: [{ path: "z" }, { path: "a", fields: ["z", "a"] }] }).scope.map(row => row.path), ["a", "z"]);
  for (const raw of [null, [], "bad", { ...request, id: "" }, { ...request, id: "private prose" },
    { ...request, scope: null }, { ...request, scope: [] }, { ...request, scope: Array(101).fill({ path: "x" }) },
    ...["", "/file", "../file", "a/./b", "a\\b", "a//b", "*.toon", "a\n"].map(path => ({ ...request, scope: [{ path }] })),
    { ...request, scope: [{ path: "a" }, { path: "a" }] }, { ...request, scope: [{ path: "a", extra: true }] },
    ...[null, [], [""], ["x", "x"], [1], Array(101).fill("x")].map(fields => ({ ...request, scope: [{ path: "a", fields }] })),
    { ...request, receipt: null }, { ...request, receipt: { treeId: "bad", evaluatedAt } },
    { ...request, receipt: { ...request.receipt, evaluatedAt: "bad" } }, { ...request, receipt: { ...request.receipt, evaluatedAt: "2026-02-31T00:00:00.000Z" } }, { ...request, receipt: { ...request.receipt, evaluatedAt: "2026-99-99T00:00:00.000Z" } }]) {
    assert.throws(() => parseCheckpointRequest(raw), error => error instanceof CheckpointRefusal && error.code === "invalid_checkpoint" && !!error.remedy);
  }
  for (const policy of [null, Array(33).fill(request), [request, request]]) assert.throws(() => parseCheckpointPolicy(policy), { code: "invalid_checkpoint_policy" });
});

test("checkpoint headers roundtrip, reject duplicates and refuse malformed or excessive evidence", async () => {
  const { commit, carried, claim } = await fixture();
  assert.deepEqual(decodeCommit(encodeCommit(carried)), carried);
  assert.throws(() => encodeCommit({ ...carried, checkpoints: "x\ny" }), { code: "invalid_checkpoint_header" });
  const text = encodeCommit(carried).toString();
  assert.throws(() => decodeCommit(Buffer.from(text.replace("checkpoints ", `checkpoints ${carried.checkpoints}\ncheckpoints `))), { code: "malformed_object" });
  const invalid = [null, [], Array(33).fill(claim), [claim, claim], [{ ...claim, version: 2 }], [{ ...claim, changeId: "bad" }], [{ ...claim, fingerprint: "bad" }], [{ ...claim, evidenceDigest: "bad" }]];
  for (const checkpoints of ["!", "x".repeat(262145), Buffer.from("invalid JSON").toString("base64"), ...invalid.map(raw => Buffer.from(JSON.stringify(raw)).toString("base64"))]) {
    assert.throws(() => checkpointClaims({ ...commit, checkpoints }), { code: "malformed_checkpoint" });
  }
  assert.deepEqual(checkpointClaims(commit), []);
  let full = commit;
  for (let index = 0; index < 32; index++) full = { ...full, checkpoints: attachCheckpoint(full, { ...claim, id: `claim-${index}` }) };
  assert.throws(() => attachCheckpoint(full, { ...claim, id: "overflow" }), { code: "malformed_checkpoint" });
});

test("core receipts must match the exact native tree and an accepted nonempty assertion", async () => {
  const { repo, id, commit, request, verdict, pmRoot } = await fixture();
  assert.deepEqual(await loadCheckpointReceipt(pmRoot, request), verdict);
  for (const invalid of [{ ...verdict, tree_id: "a".repeat(64) }, { ...verdict, gate_id: "other" }, { ...verdict, evaluated_at: "other" },
    { ...verdict, dry_run: true }, { ...verdict, assertions_total: 2 }, { ...verdict, assertions: [], assertions_total: 0 },
    { ...verdict, assertions: [verdict.assertions[0], verdict.assertions[0]], assertions_total: 2 },
    ...[{ verdict: "fail" as const }, { negative_control_proven: false }, { population_size: 0 }, { population_size: NaN }].map(row => ({ ...verdict, assertions: [{ ...verdict.assertions[0], ...row }] }))]) {
    assert.throws(() => createSemanticCheckpoint(repo.objects, id, commit, request, invalid), { code: "checkpoint_evidence_refused" });
  }
  assert.throws(() => createSemanticCheckpoint(repo.objects, id, commit, { ...request, receipt: { ...request.receipt, treeId: "b".repeat(64) } }, verdict), { code: "checkpoint_evidence_refused" });
  await assert.rejects(loadCheckpointReceipt(pmRoot, { ...request, receipt: { ...request.receipt, evaluatedAt: "2026-10-24T00:00:00.000Z" } }), { code: "checkpoint_evidence_unavailable" });
  await recordAssuranceVerdict(pmRoot, verdict, { author: "fixture" });
  await assert.rejects(loadCheckpointReceipt(pmRoot, request), { code: "checkpoint_evidence_unavailable" });
  writeFileSync(join(pmRoot, "history/_workspace.jsonl"), "broken\n");
  await assert.rejects(loadCheckpointReceipt(pmRoot, request), { code: "checkpoint_evidence_unavailable" });
});

test("unresolved selected units and opaque field selections refuse instead of appearing valid", async () => {
  const { repo, id, commit, carried, request, path, verdict } = await fixture();
  const entries = flattenTree(repo.objects, commit.tree); const entry = entries.get(path)!;
  const conflict = repo.objects.write("blob", Buffer.from("conflict reference"));
  entries.set(path, { ...entry, conflicts: [conflict] });
  const conflicted = { ...carried, tree: buildTree(repo.objects, entries) };
  assert.throws(() => inspectCheckpoints(repo.objects, id, conflicted), { code: "checkpoint_conflict" });
  const whole = { ...request, scope: [{ path }] };
  assert.equal(createSemanticCheckpoint(repo.objects, id, commit, whole, verdict).version, 1);
  entries.set(path, { ...entry, id: repo.objects.write("blob", Buffer.from("opaque")) });
  assert.throws(() => inspectCheckpoints(repo.objects, id, { ...carried, tree: buildTree(repo.objects, entries) }), { code: "checkpoint_scope_unavailable" });
});

test("native attachment and descendant rewrites preserve scoped evidence and undo; signatures bind checkpoint claims", async () => {
  const { repo, id, request, verdict, commit, carried } = await fixture();
  const first = repo.checkpoint(id, request, verdict, author, new Date(2))!;
  assert.equal(effectiveChangeId(first, readCommit(repo.objects, first)), effectiveChangeId(id, commit));
  repo.describe("HEAD", "irrelevant description", author, new Date(3));
  assert.equal(inspectCheckpoints(repo.objects, repo.refs.resolveHead()!, readCommit(repo.objects, repo.refs.resolveHead()!)).ok, true);
  writeFileSync(join(repo.root, "unrelated.txt"), "hello"); repo.stage(["unrelated.txt"]);
  repo.commit({ message: "child", author }, new Date(4));
  const parent = readCommit(repo.objects, repo.refs.resolveHead()!).parents[0];
  repo.checkpoint(parent, request, verdict, author, new Date(5));
  assert.ok(readCommit(repo.objects, readCommit(repo.objects, repo.refs.resolveHead()!).parents[0]).checkpoints);
  repo.undo(null, new Date(6));
  const unreachable = writeCommit(repo.objects, { ...commit, message: "unreachable" });
  assert.throws(() => repo.checkpoint(unreachable, request, verdict, author, new Date(7)), { code: "unreachable_revision" });
  const keys = generateKeyPairSync("ed25519");
  const signed = { ...carried, attestation: signChange(id, carried, keys.privateKey) };
  assert.equal(verifyChangeSignature(id, { ...signed, checkpoints: attachCheckpoint(carried, { ...checkpointClaims(carried)[0], id: "changed" }) }, { version: 1, keys: [], revocations: [] }, 0).status, "tampered");
});

for (const mode of ["push", "publish", "http"] as const) test(`receiver ${mode} refuses replay, removal and narrowing atomically under its current policy`, async () => {
  const { repo, id, carried, request, path } = await fixture();
  const receiver = Repository.init(temp());
  const ref = "refs/heads/main";
  updateCheckpointPolicy(receiver.objects, receiver.controlDirectory, [request]);
  const local = new LeasedFileTransport("receiver", receiver.root);
  const server = mode === "http" ? await startRepositoryServer({ root: receiver.root, host: "127.0.0.1", port: 0, unauthenticatedWrites: true }) : null;
  const wire = server === null ? local : new LeasedHttpTransport(`http://${server.host}:${server.port}`);
  try {
    for (const changed of [revised(repo, carried, path, { status: "closed" }), { ...carried, checkpoints: undefined },
      { ...carried, checkpoints: attachCheckpoint(commitWithoutClaims(carried), { ...checkpointClaims(carried)[0], scope: [{ path, fields: ["title"] }] }) }]) {
      const next = writeCommit(repo.objects, changed);
      repo.refs.compareAndSwap("refs/heads/export", repo.refs.read("refs/heads/export"), next);
      const bundle = exportBundle(repo.objects, repo.refs, ["refs/heads/export"]);
      const transport = mode === "http" ? wire : local;
      const updates = [{ ref, expected: null, next }];
      if (mode === "publish") {
        // Deliver actual objects separately; publication must not trust upload receipts as validation.
        for (const entry of repo.objects.inventory()) await transport.uploadObjects([{ id: entry.id, ...entry.object }]);
        await assert.rejects(transport.publish(updates, true, new Date()), { code: "checkpoint_publication_refused" });
      } else await assert.rejects(transport.push(bundle, updates, true, new Date()), { code: "checkpoint_publication_refused" });
      assert.equal(receiver.refs.read(ref), null); assert.equal(receiver.operations.read().length, 0);
    }
    // Policy is receiver-owned and reloaded even through an already-open server.
    updateCheckpointPolicy(receiver.objects, receiver.controlDirectory, []);
    const next = writeCommit(repo.objects, carried);
    repo.refs.compareAndSwap("refs/heads/export", repo.refs.read("refs/heads/export"), next);
    if (mode !== "http") {
      const result = await local.push(exportBundle(repo.objects, repo.refs, ["refs/heads/export"]), [{ ref, expected: null, next }], true, new Date());
      assert.equal(result.updated.length, 1);
    }
    assertCheckpointPublication(repo.objects, receiver.controlDirectory, new Map([[id, carried]]), [id, id]);
  } finally { await server?.close(); }
});
/** Explicit absence prevents a helper from accidentally carrying the prior named claim. */
function commitWithoutClaims(commit: Commit): Commit { return { ...commit, checkpoints: undefined }; }

test("receiver administration fails closed on malformed and unreadable policy", async () => {
  const { repo } = await fixture();
  assert.deepEqual(readCheckpointPolicy(repo.controlDirectory), []);
  assert.throws(() => assertCheckpointPublication(repo.objects, repo.controlDirectory, new Map(), ["a".repeat(64)]), { code: "checkpoint_scope_unavailable" });
  writeFileSync(join(repo.controlDirectory, CHECKPOINT_POLICY_FILE), "broken");
  assert.throws(() => readCheckpointPolicy(repo.controlDirectory), { code: "invalid_checkpoint_policy" });
  const control = temp(); mkdirSync(join(control, CHECKPOINT_POLICY_FILE));
  assert.throws(() => readCheckpointPolicy(control), { code: "invalid_checkpoint_policy" });
});

test("CLI harness delegates verified receipt attachment, policy and compact inspection to the SDK", async () => {
  const { repo, root, pmRoot, request } = await fixture();
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const input = join(root, "request.json"); writeFileSync(input, JSON.stringify(request));
  const context = { pmRoot, repoRoot: root };
  assert.equal((await harness.runCommand({ ...context, command: "vcs checkpoint attach", args: ["HEAD"], options: { input } })).handled, true);
  assert.equal((await harness.runCommand({ ...context, command: "vcs checkpoint inspect", args: ["HEAD"] })).handled, true);
  writeFileSync(input, JSON.stringify([request]));
  assert.equal((await harness.runCommand({ ...context, command: "vcs checkpoint policy", options: { input } })).handled, true);
  assert.equal(readCheckpointPolicy(repo.controlDirectory).length, 1);
  for (const options of [{}, { input: "missing.json" }]) assert.match((await harness.runCommand({ ...context, command: "vcs checkpoint policy", options })).errorMessage!, /Semantic checkpoint refused/);
  writeFileSync(input, "invalid JSON");
  assert.match((await harness.runCommand({ ...context, command: "vcs checkpoint policy", options: { input } })).errorMessage!, /Semantic checkpoint refused/);
  writeFileSync(input, " ".repeat(262145));
  assert.match((await harness.runCommand({ ...context, command: "vcs checkpoint policy", options: { input } })).errorMessage!, /Semantic checkpoint refused/);
});

test("installed CLI attaches and inspects JSON and TOON in a non-git tracker with no Git executable", async () => {
  const { root, request, repo, path } = await fixture(); const bins = temp();
  const input = join(root, "checkpoint.json"); writeFileSync(input, JSON.stringify(request));
  installPackedExtension(root);
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...testEnvironment(), ...discardChildCoverage(), PATH: bins, GIT_CEILING_DIRECTORIES: dirname(root), PM_AUTHOR: "fixture" };
  const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const attached = JSON.parse(run(["vcs", "checkpoint", "attach", "HEAD", "--input", "checkpoint.json", "--json"])) as { ok: boolean };
  assert.equal(attached.ok, true);
  const json = run(["vcs", "checkpoint", "inspect", "HEAD", "--limit", "1", "--json"]);
  assert.equal((JSON.parse(json) as { ok: boolean }).ok, true);
  assert.ok(Buffer.byteLength(json) < 1000);
  const toon = run(["vcs", "checkpoint", "inspect", "HEAD"]);
  assert.match(toon, /valid/); assert.ok(Buffer.byteLength(toon) < 1000);
  const head = repo.resolve("HEAD"); const operations = repo.operations.read();
  run(["vcs", "checkpoint", "attach", "HEAD", "--input", "checkpoint.json", "--json"]);
  assert.equal(repo.resolve("HEAD"), head);
  assert.deepEqual(repo.operations.read(), operations);
  writeFileSync(input, JSON.stringify({ ...request, scope: [{ path, fields: ["status", "acceptance_criteria", "title"] }] }));
  assert.throws(() => run(["vcs", "checkpoint", "attach", "HEAD", "--input", "checkpoint.json", "--json"]), /attached claim is immutable/);
  assert.equal(repo.resolve("HEAD"), head);
  assert.equal(existsSync(join(root, ".git")), false);
});


test("linked-instance CLI policy is hub-owned and inspection sees the shared requirements", async () => {
  const { repo, request } = await fixture();
  const root = join(temp(), "linked");
  repo.linkInstance("checkpoint-view", root, { include: ["**"] });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const input = join(root, "requirements.json"); writeFileSync(input, JSON.stringify([request]));
  const context = { pmRoot: join(root, ".agents/pm") };
  const set = await harness.runCommand({ ...context, command: "vcs checkpoint policy", options: { input } });
  assert.equal(set.errorMessage, undefined);
  assert.equal(readCheckpointPolicy(repo.controlDirectory).length, 1);
  const result = await harness.runCommand({ ...context, command: "vcs checkpoint inspect", args: ["HEAD"], options: { limit: "1" } });
  assert.equal(result.errorMessage, undefined);
  assert.equal((result.result as { ok: boolean }).ok, false);
});

for (const relevant of [false, true]) test(`native rebase ${relevant ? "invalidates relevant" : "retains irrelevant"} record edits in a checkpointed change`, async () => {
  const { repo, client, item, path, pmRoot, request } = await fixture();
  repo.createBranch("feature", "HEAD", new Date(2)); repo.switchTo("feature", new Date(3));
  writeFileSync(join(repo.root, "feature.txt"), "feature"); repo.stage(["feature.txt"]);
  const feature = repo.commit({ message: "feature", author }, new Date(4));
  const treeId = readCommit(repo.objects, feature).tree;
  const capture = { ...request, receipt: { ...request.receipt, treeId } };
  repo.checkpoint(feature, capture, await receipt(treeId, pmRoot), author, new Date(5));
  repo.switchTo("main", new Date(6));
  await client.update(item.id, relevant ? { status: "in_progress", author: "fixture" } : { title: "An irrelevant presentation edit", author: "fixture" });
  repo.stage([path]); repo.commit({ message: "main", author }, new Date(7));
  repo.rebase("feature", "main", author, new Date(8));
  const id = repo.resolve("feature"); const commit = readCommit(repo.objects, id);
  assert.ok(commit.checkpoints);
  assert.equal(inspectCheckpoints(repo.objects, id, commit, [request]).ok, !relevant);
});


for (const http of [false, true]) test(`native ${http ? "HTTP" : "file"} forge series publication cannot bypass changed checkpoint scope`, async () => {
  const { repo, id, carried, request, path } = await fixture();
  const changed = revised(repo, { ...carried, parents: [id] }, path, { status: "closed" });
  const next = writeCommit(repo.objects, changed);
  const series = createSeries(repo.objects, id, next, { description: "checkpoint proposal", author });
  const receiver = Repository.init(temp()); updateCheckpointPolicy(receiver.objects, receiver.controlDirectory, [request]);
  const server = http ? await startRepositoryServer({ root: receiver.root, host: "127.0.0.1", port: 0, unauthenticatedWrites: true }) : null;
  const wire = server === null ? new LeasedFileTransport("receiver", receiver.root) : new LeasedHttpTransport(`http://${server.host}:${server.port}`);
  try {
    await assert.rejects(wire.forge!({ action: "publish", kind: "series", name: "proposal", expected: null, branch: "refs/heads/main", series,
      bundle: exportSeriesBundle(repo.objects, series).toString("base64"), proofs: [] }), { code: "checkpoint_publication_refused" });
    assert.deepEqual(receiver.refs.list("refs/forge-series/"), []);
    assert.deepEqual(receiver.refs.list("refs/forge-review/"), []);
    assert.deepEqual(receiver.operations.read(), []);
  } finally { await server?.close(); }
});
