import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { FileTransport } from "../engine/transport.ts";
/** Real shallow and blob-filtered repositories with verified range-demand hydration. */
import { fork } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { HttpTransport } from "../engine/http-transport.ts";
import { fetchPromisedBlob } from "../engine/partial-fetch-worker.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../engine/repo.ts";
import { cloneFrom, fetchFrom } from "../engine/sync.ts";
import { collectGarbage } from "../engine/gc.ts";
import { reachable } from "../engine/merge.ts";
import { exportPartialBundle, importBundleObjects, parseBundle, serializeBundle } from "../engine/bundle.ts";
import { historyOptions, readPartialState } from "../engine/partial.ts";
import { ObjectStore as BuiltObjectStore } from "../dist/engine/objects.js";
import { readCommit, decodeManifest, type Signature } from "../engine/model.ts";
import { readFragmentRange, writeFragmented } from "../engine/fragments.ts";
import { decodeFetchRequest, encodeFetchRequest } from "../engine/http-protocol.ts";
import { acquirePublicationLeases, grantRemoteLeases, leasedPushTo } from "./helpers/publication-consumers.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const directories: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
afterEach(() => { for (const directory of directories.splice(0)) directory.cleanup(); });
/** Allocate isolated destinations without changing tracker or source paths. */
function root() { const directory = makeTempDir(); directories.push(directory); return join(directory.root, "repo"); }
/** Build real PM-owned history with unique payloads in each generation. */
async function source() {
  const path = root(); mkdirSync(path);
  const sdk = new PmClient({ cwd: path, pmRoot: join(path, ".agents/pm"), noExtensions: true }); await sdk.init("partial", { defaults: true, author: "fixture" });
  const repo = Repository.init(path); const commits: string[] = [];
  for (const text of ["one", "two", "three"]) {
    writeFileSync(join(path, "asset"), text); repo.stage(["asset"]); commits.push(repo.commit({ message: text, author }, new Date()));
  }
  return { repo, commits };
}

test("depth one keeps original tip identity and GC preserves shallow boundaries; depth two then full fetch deepen", async () => {
  const { repo, commits } = await source(); const path = root();
  await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { depth: 1 });
  const clone = Repository.open(path); assert.equal(clone.refs.resolveHead(), commits[2]);
  assert.equal(clone.objects.has(commits[0]), false); assert.equal(clone.objects.has(commits[1]), false);
  assert.equal(clone.log("HEAD").length, 1); assert.equal(clone.verify().missing.length, 0);
  assert.equal(collectGarbage(clone, true).removed, 0);
  const instancePath = root(); clone.linkInstance("reader", instancePath, { include: ["asset"] });
  await fetchFrom(Repository.open(instancePath), "origin", new Date(), undefined, { depth: 2 });
  assert.equal(clone.log("HEAD").length, 2); assert.ok(!clone.objects.has(commits[0]));
  await fetchFrom(clone, "origin", new Date()); assert.equal(clone.log("HEAD").length, 3); assert.equal(clone.objects.partialState(), null);
  assert.equal(readCommit(clone.objects, commits[2]).parents[0], commits[1]);
});

test("history walks read the partial-clone state once per walk, not once per commit", async () => {
  const { repo, commits } = await source(); const path = root();
  await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { depth: 2 });
  const clone = Repository.open(path); const store = clone.objects;
  const read = store.partialState.bind(store); let calls = 0;
  store.partialState = () => { calls += 1; return read(); };
  assert.equal(clone.log("HEAD").length, 2); assert.equal(calls, 1, "log re-read partial.json per commit");
  calls = 0; assert.deepEqual([...reachable(store, commits[2])].sort(), [commits[1], commits[2]].sort());
  assert.equal(calls, 1, "reachable re-read partial.json per commit");
});

test("blob:none omits historical payloads, checkout hydrates only its demand, and reads verify/cache missing historical blobs", async () => {
  const { repo, commits } = await source(); const bundle = parseBundle(exportPartialBundle(repo.objects, repo.refs, ["refs/heads/main"], { filter: "blob:none" }));
  assert.ok(bundle.header.promised!.length > 0); assert.ok(bundle.lines.every(line => line.type !== "blob"));
  const path = root(); await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { filter: "blob:none" });
  const clone = Repository.open(path); assert.equal(readFileSync(join(path, "asset"), "utf8"), "three");
  const historical = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "one")!.id;
  assert.ok(!clone.objects.has(historical)); const inventory = clone.objects.inventory().length;
  collectGarbage(clone); assert.equal(clone.objects.inventory().length, inventory, "dry run fetched promised data");
  assert.equal(clone.objects.read(historical).payload.toString(), "one"); assert.ok(clone.objects.has(historical));
  assert.equal(clone.log("HEAD").length, commits.length);
  const absent = "f".repeat(64); assert.throws(() => clone.objects.read(absent), /No object/);
  clone.remotes.add("alternate", repo.root);
  await assert.rejects(fetchFrom(clone, "alternate", new Date(), undefined, { filter: "blob:none" }), /promisor/);
  await fetchFrom(clone, "origin", new Date());
  assert.equal(clone.objects.partialState(), null);
  await fetchFrom(clone, "alternate", new Date(), undefined, { filter: "blob:none" });
  // A filtered fetch that finds every payload present records no promisor at all;
  // a genuinely missing one attributes to the remote that just served it.
  assert.equal(clone.objects.partialState(), null);
  const other = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "two")!.id;
  rmSync(join(clone.controlDirectory, "objects", other.slice(0, 2), other.slice(2)));
  await fetchFrom(clone, "alternate", new Date(), undefined, { filter: "blob:none" });
  assert.equal(clone.objects.partialState()!.remote, "alternate");
  assert.equal(clone.objects.read(other).payload.toString(), "two");
  const second = root(); await cloneFrom(clone.root, second, new Date()); assert.equal(readFileSync(join(second, "asset"), "utf8"), "three");
});

test("shallow clone can commit and push to its full source, collect and reclone without losing bytes", async () => {
  const { repo } = await source(); const path = root(); await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { depth: 1, filter: "blob:none" });
  const clone = Repository.open(path); writeFileSync(join(path, "asset"), "pushed"); clone.stage(["asset"]); clone.commit({ message: "pushed", author }, new Date());
  // The full receiver already holds all omitted ancestors; publication still verifies complete closure.
  await grantRemoteLeases(clone); await leasedPushTo(clone, "origin", [], false, new Date());
  collectGarbage(repo, true); const second = root(); await cloneFrom(repo.root, second, new Date());
  assert.equal(readFileSync(join(second, "asset"), "utf8"), "pushed");
});

test("fragment manifests remain available and range reads fetch exactly the blobs in the selected range", async () => {
  const { repo } = await source();
  writeFileSync(join(repo.root, "large"), Buffer.alloc(3 * 1024 * 1024, 97)); repo.stage(["large"]); const previous = repo.commit({ message: "large", author }, new Date());
  const native = repo.readIndex().find(entry => entry.path === "large")!;
  const fragmented = writeFragmented(repo.objects, Buffer.concat([Buffer.alloc(1024 * 1024, 97), Buffer.alloc(1024 * 1024, 99), Buffer.alloc(1024 * 1024, 100)]), 1024 * 1024, native.fileId);
  const manifestId = fragmented.manifestId;
  repo.writeIndex(repo.readIndex().map(entry => entry.path === "large" ? { ...entry, id: manifestId } : entry));
  repo.commit({ message: "fragmented", author }, new Date());
  writeFileSync(join(repo.root, "large"), Buffer.alloc(3 * 1024 * 1024, 98)); repo.stage(["large"]); repo.commit({ message: "large edit", author }, new Date());
  const path = root(); await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { filter: "blob:none" });
  const clone = Repository.open(path); assert.ok(clone.objects.has(previous));
  const manifest = decodeManifest(clone.objects.read(manifestId).payload); assert.ok(manifest.fragments.length > 0);
  const fragment = manifest.fragments[0].id; assert.ok(!clone.objects.has(fragment));
  const heldBefore = clone.objects.inventory().length;
  assert.deepEqual(readFragmentRange(clone.objects, manifestId, 0, 4), Buffer.from("aaaa")); assert.ok(clone.objects.has(fragment));
  assert.equal(clone.objects.inventory().length, heldBefore + 1);
  assert.ok(manifest.fragments.slice(1).every(entry => !clone.objects.has(entry.id)));
});

test("invalid bounds, omission lists, partial imports and malformed wire options fail closed", async () => {
  for (const options of [{ depth: 0 }, { depth: NaN }, { depth: 1.5 }, { filter: "bad" }]) assert.throws(() => historyOptions(options as { depth?: number; filter?: "blob:none" }));
  assert.equal(decodeFetchRequest({ refs: [], haves: [], options: null }), null);
  assert.deepEqual(decodeFetchRequest(JSON.parse(encodeFetchRequest([], [], { depth: 2 }))), { refs: [], haves: [], options: { depth: 2 } });
  const { repo } = await source(); const bundle = exportPartialBundle(repo.objects, repo.refs, ["refs/heads/main"], { depth: 1 });
  assert.throws(() => importBundleObjects(repo.objects, bundle), /explicitly bounded/);
  assert.throws(() => exportPartialBundle(repo.objects, repo.refs, ["refs/heads/absent"], { depth: 1 }));
  repo.createBranch("alias", "HEAD", new Date());
  assert.equal(Object.keys(parseBundle(exportPartialBundle(repo.objects, repo.refs, [], { depth: 2 })).header.refs).length, 2);
  for (const value of ['null', '[]', '{"remote":"origin","shallow":["bad"],"promised":[]}']) {
    writeFileSync(join(repo.controlDirectory, "partial.json"), value); assert.throws(() => readPartialState(repo.controlDirectory));
  }
  rmSync(join(repo.controlDirectory, "partial.json"));
});

test("HTTP bounded transfer and isolated demand reads verify only the requested historical payload", async () => {
  const { repo } = await source();
  const child = fork(join(packageRoot, "test/helpers/partial-server.ts"), [dirname(repo.root)], { execArgv: [], env: { ...process.env, ...discardChildCoverage() }, stdio: ["ignore", "ignore", "inherit", "ipc"], timeout: 180_000 });
  const closed = once(child, "close");
  try {
    const [{ port }] = await once(child, "message");
    const url = `http://127.0.0.1:${port}/repo`;
    const wire = new HttpTransport(url);
    const bounded = parseBundle(await wire.fetch(["refs/heads/main"], [], { depth: 1, filter: "blob:none" }));
    assert.equal(bounded.header.shallow!.length, 1);
    const path = root(); await cloneFrom(url, path, new Date(), "origin", repo.root, undefined, { depth: 2, filter: "blob:none" });
    const clone = Repository.open(path);
    assert.equal(readFileSync(join(path, "asset"), "utf8"), "three");
    const historical = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "two")!.id;
    assert.ok(!clone.objects.has(historical));
    assert.equal(clone.objects.read(historical).payload.toString(), "two");
    assert.ok((await fetchPromisedBlob(url, null, historical)).length > 0);
    rmSync(join(clone.controlDirectory, "objects", historical.slice(0, 2), historical.slice(2)));
    assert.equal(new BuiltObjectStore(join(clone.controlDirectory, "objects")).read(historical).payload.toString(), "two");
    await assert.rejects(fetchPromisedBlob(url, null, repo.refs.resolveHead()!), /requested blob/);
    child.send({ close: true }); await closed;
    const omitted = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "one")!.id;
    const state = clone.objects.partialState()!;
    writeFileSync(join(clone.controlDirectory, "partial.json"), JSON.stringify({ ...state, promised: [...state.promised, omitted] }));
    assert.throws(() => clone.objects.read(omitted), /promisor/);
  } finally { child.kill(); await closed; }
});

test("file URL promisor rejects wrong-kind or corrupt promised data and preserves held corruption", async () => {
  const { repo } = await source(); const path = root(); await cloneFrom(pathToFileURL(repo.root).href, path, new Date(), "origin", repo.root, undefined, { filter: "blob:none" });
  const clone = Repository.open(path); const state = clone.objects.partialState()!;
  clone.remotes.remove("origin"); clone.remotes.add("origin", pathToFileURL(repo.root).href);
  const historical = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "one")!.id;
  assert.equal(clone.objects.read(historical).payload.toString(), "one");
  const commit = repo.refs.resolveHead()!;
  // A forged promise cannot turn a commit into a blob or overwrite an existing object.
  const alien = repo.objects.write("tree", Buffer.alloc(0));
  writeFileSync(join(clone.controlDirectory, "partial.json"), JSON.stringify({ ...state, promised: [...state.promised, alien] }));
  assert.throws(() => clone.objects.read(alien), /wrong type/);
  assert.ok(clone.objects.has(commit));
});

/** A real filesystem peer exposing only its pre-scale transport capability set. */
class CompleteHistoryPeer extends FileTransport {
  /** Preserve the actual repository advertisement while accurately withholding the new opt-in feature. */
  async advertise() {
    const advertisement = await super.advertise();
    return { ...advertisement, capabilities: advertisement.capabilities.filter(capability => capability !== "partial-history") };
  }
}

test("a complete-history-only peer refuses depth before any clone ref or directory survives", async () => {
  const { repo } = await source(); const destination = root();
  await assert.rejects(cloneFrom(repo.root, destination, new Date(), "origin", repo.root, new CompleteHistoryPeer(repo.root, repo.root), { depth: 1 }), /does not support bounded history/);
  assert.equal(existsSync(destination), false);
});

test("clone and fetch command flags apply depth and blob filters through the real extension loader", async () => {
  const { repo } = await source(); const workspace = root(); mkdirSync(workspace);
  const client = new PmClient({ cwd: workspace, pmRoot: workspace, noExtensions: true }); await client.init("commands", { defaults: true, author: "fixture" });
  type Capabilities = NonNullable<NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"]>;
  const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as { capabilities: Capabilities };
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  for (const options of [{ depth: "1" }, { filter: "blob:none" }, { depth: "1", filter: "blob:none" }]) {
    const destination = root();
    const result = await harness.runCommand({ command: "vcs clone", args: [repo.root, destination], options, pmRoot: workspace });
    assert.equal(result.errorMessage, undefined, String(result.errorMessage));
    const cloned = Repository.open(destination); assert.equal(readFileSync(join(destination, "asset"), "utf8"), "three");
    assert.equal(cloned.log("HEAD").length, options.depth === undefined ? 3 : 1);
    const fetched = await harness.runCommand({ command: "vcs fetch", args: ["origin"], options: { depth: "2" }, pmRoot: destination });
    assert.equal(fetched.errorMessage, undefined, String(fetched.errorMessage));
  }
});

test("GC retains arrived ancestors behind stale shallow metadata after an interrupted fetch", async () => {
  const { repo, commits } = await source(); const path = root();
  await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { depth: 1 });
  const clone = Repository.open(path);
  // Actual immutable arrivals can precede the durable omission-policy refresh.
  clone.objects.accept(repo.objects.inventory().map(entry => ({ id: entry.id, ...entry.object })), false);
  assert.ok(clone.objects.partialState()!.shallow.includes(commits[2]));
  const garbage = clone.objects.write("blob", Buffer.from("unrelated garbage"));
  assert.deepEqual(collectGarbage(clone, true).candidates, [garbage]);
  assert.ok(clone.objects.has(commits[0])); assert.ok(clone.objects.has(commits[1]));
  await fetchFrom(clone, "origin", new Date()); assert.equal(clone.log("HEAD").length, 3);
});

test("unchanged tags deepen their isolated history without reporting a tag conflict", async () => {
  const { repo, commits } = await source();
  repo.refs.compareAndSwap("refs/tags/archive", null, commits[1]);
  repo.refs.compareAndSwap("refs/heads/main", commits[2], null);
  const destination = root(); mkdirSync(destination);
  const clone = Repository.init(destination); clone.remotes.add("origin", repo.root);
  await fetchFrom(clone, "origin", new Date(), undefined, { depth: 1 });
  assert.ok(!clone.objects.has(commits[0]));
  const report = await fetchFrom(clone, "origin", new Date(), undefined, { depth: 2 });
  assert.deepEqual(report.conflictingTags, []);
  assert.ok(clone.objects.has(commits[0]));
  assert.equal(clone.objects.partialState(), null);
  assert.equal(clone.refs.read("refs/tags/archive"), commits[1]);
});

test("a completing fetch clears partial mode and later unchanged fetches transfer nothing", async () => {
  const { repo, commits } = await source(); const path = root();
  await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { depth: 1 });
  const clone = Repository.open(path);
  assert.notEqual(clone.objects.partialState(), null);
  await fetchFrom(clone, "origin", new Date());
  assert.equal(clone.objects.partialState(), null);
  assert.equal(clone.log("HEAD").length, 3);
  assert.ok(clone.objects.has(commits[0]));
  const repeat = await fetchFrom(clone, "origin", new Date());
  assert.equal(repeat.upToDate, true);
  assert.deepEqual(repeat.updated, []);
  assert.deepEqual(repeat.added, []);
});

test("hydrated promises leave the omission list and a completing fetch drops it", async () => {
  const { repo } = await source(); const path = root();
  await cloneFrom(repo.root, path, new Date(), "origin", repo.root, undefined, { filter: "blob:none" });
  const clone = Repository.open(path);
  const blob = (text: string) => repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === text)!.id;
  const historical = blob("one"); const other = blob("two");
  clone.objects.read(historical);
  await fetchFrom(clone, "origin", new Date(), undefined, { filter: "blob:none" });
  const state = clone.objects.partialState()!;
  assert.ok(!state.promised.includes(historical));
  assert.ok(state.promised.includes(other));
  await fetchFrom(clone, "origin", new Date());
  assert.equal(clone.objects.partialState(), null);
  assert.ok(clone.objects.has(historical));
});

test("a linked instance promisor hydrates through the hub's shared store", async () => {
  const { repo } = await source();
  const instancePath = root();
  repo.linkInstance("reader", instancePath);
  const clonePath = root();
  await cloneFrom(instancePath, clonePath, new Date(), "origin", instancePath, undefined, { filter: "blob:none" });
  const clone = Repository.open(clonePath);
  const historical = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "one")!.id;
  assert.ok(!clone.objects.has(historical));
  assert.equal(clone.objects.read(historical).payload.toString(), "one");
});

test("a filtered clone of a filtered clone preserves the source's promises across processes", async () => {
  const { repo } = await source();
  const firstPath = root();
  await cloneFrom(repo.root, firstPath, new Date(), "origin", repo.root, undefined, { filter: "blob:none" });
  const first = Repository.open(firstPath);
  const historical = repo.objects.inventory().find(entry => entry.object.type === "blob" && entry.object.payload.toString() === "two")!.id;
  assert.ok(!first.objects.has(historical));
  assert.ok(first.objects.partialState()!.promised.includes(historical));
  const direct = parseBundle(exportPartialBundle(first.objects, first.refs, ["refs/heads/main"], { filter: "blob:none" }));
  assert.ok(direct.header.promised!.includes(historical));
  assert.ok(direct.lines.every(line => line.type !== "blob"));
  const child = fork(join(packageRoot, "test/helpers/partial-server.ts"), [dirname(firstPath)], { execArgv: [], env: { ...process.env, ...discardChildCoverage() }, stdio: ["ignore", "ignore", "inherit", "ipc"], timeout: 180_000 });
  const closed = once(child, "close");
  try {
    const [{ port }] = await once(child, "message");
    const url = `http://127.0.0.1:${port}/repo`;
    const secondPath = root();
    await cloneFrom(url, secondPath, new Date(), "origin", firstPath, undefined, { filter: "blob:none" });
    const second = Repository.open(secondPath);
    assert.ok(!second.objects.has(historical));
    assert.ok(second.objects.partialState()!.promised.includes(historical));
    assert.equal(readFileSync(join(secondPath, "asset"), "utf8"), "three");
    assert.equal(second.objects.read(historical).payload.toString(), "two");
  } finally { child.kill(); await closed; }
});

test("ordinary imports and receiver publication require complete closure in a shallow repository", async () => {
  const { repo, commits } = await source(); const destination = root();
  await cloneFrom(repo.root, destination, new Date(), "origin", repo.root, undefined, { depth: 1 });
  const clone = Repository.open(destination); const tip = commits[2];
  const archive = serializeBundle(clone.objects, { refs: { "refs/heads/main": tip }, prerequisites: [], objects: [] });
  assert.throws(() => importBundleObjects(clone.objects, archive), /History closure is invalid/);
  const receiver = new FileTransport(clone.root, clone.root);
  await assert.rejects(receiver.publish([{ ref: "refs/heads/main", expected: tip, next: tip }], false, new Date()), /History closure is invalid/);
  assert.equal(clone.refs.resolveHead(), tip);
  await fetchFrom(clone, "origin", new Date());
  assert.doesNotThrow(() => importBundleObjects(clone.objects, archive));
  const updates = [{ ref: "refs/heads/main", expected: tip, next: tip }];
  const proofs = await acquirePublicationLeases(receiver, updates);
  await receiver.publish(updates, false, new Date(), proofs);
});
