import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
import { exportBundle } from "../engine/bundle.ts";
import { FileTransport } from "../engine/transport.ts";
import { acquirePublicationLeases } from "./helpers/publication-consumers.ts";
/** GC retention, fail-closed preflight and real process interruption/publication. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { collectGarbage } from "../engine/gc.ts";
import { destructionBoundary, inspectDestructions } from "../engine/destruction.ts";
import { Repository } from "../engine/repo.ts";
import { PublicationLeases } from "../engine/publication-leases.ts";
import { readFragmentRange, writeFragmented } from "../engine/fragments.ts";
import { writeSeries, type Signature } from "../engine/model.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

const directories: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
afterEach(() => { destructionBoundary.visit=()=>{};for (const directory of directories.splice(0)) directory.cleanup(); });

/** Initialize an actual PM project and VCS repository for every retention owner. */
async function fresh() {
  const directory = makeTempDir(); directories.push(directory);
  const sdk = new PmClient({ cwd: directory.root, pmRoot: join(directory.root, ".agents/pm"), noExtensions: true });
  await sdk.init("gc", { defaults: true, author: "fixture" });
  return Repository.init(directory.root);
}

test("interrupted GC supersedes its obsolete set when a candidate becomes reachable",async()=>{
 const repo=await fresh();const live=repo.objects.write("blob",Buffer.from("newly referenced candidate"));const dead=repo.objects.write("blob",Buffer.from("still collectible"));let old="";
 destructionBoundary.visit=(step,path)=>{if(step==="intent-persisted"&&path.startsWith(join(repo.controlDirectory,"destruction"))){old=(JSON.parse(readFileSync(path,"utf8")) as {id:string}).id;throw new Error("interrupt GC before deletion");}};
 assert.throws(()=>collectGarbage(repo,true),/interrupt GC before deletion/u);destructionBoundary.visit=()=>{};assert.ok(old);
 repo.refs.compareAndSwap("refs/metadata/retained",null,live);const result=collectGarbage(repo,true);assert.equal(repo.objects.has(live),true);assert.equal(repo.objects.has(dead),false);assert.equal(result.removed,1);assert.notEqual(result.destruction!.id,old);
 const previous=inspectDestructions(repo.controlDirectory).receipts.find(receipt=>receipt.id===old);assert.ok(previous);assert.equal(previous.status,"superseded");assert.match(JSON.stringify(previous),/reachability_changed/u);assert.equal(collectGarbage(repo,true).removed,0);
});

/** Commit unique native file content so unrelated writes produce distinct immutable objects. */
function commit(repo: Repository, text: string) {
  writeFileSync(join(repo.root, "asset"), text); repo.stage([]);
  return repo.commit({ message: text, author }, new Date());
}

/** Start one preloaded worker with IPC and bounded lifetime, surfacing its real failures. */
function worker(action: string, root: string, remote = "") {
  const child = fork(join(packageRoot, "test/helpers/gc-worker.ts"), [action, root, remote], { env: { ...testEnvironment(), ...discardChildCoverage() }, stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 90_000, execArgv: [] });
  let errors = ""; child.stderr?.on("data", data => { errors += String(data); });
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal, errors }));
  const message = () => Promise.race([once(child, "message").then(([value]) => value), closed.then(result => { throw new Error(JSON.stringify(result)); })]);
  return { child, closed, message };
}

test("dry run and apply retain all ref namespaces, both oplog sides, staged content, series and fragment pages", async () => {
  const repo = await fresh(); const before = commit(repo, "before"); const after = commit(repo, "after");
  repo.reset(before, "hard", new Date());
  repo.refs.compareAndSwap("refs/remotes/elsewhere/main", null, after);
  const fragmented = writeFragmented(repo.objects, Buffer.from("fragment".repeat(40)), 8);
  const series = writeSeries(repo.objects, { base: before, patches: [{ commit: after }], description: "retained", author });
  repo.refs.compareAndSwap("refs/series/review", null, series);
  writeFileSync(join(repo.root, "staged"), "staged content"); repo.stage(["staged"]);
  repo.objects.pinUploads([fragmented.manifestId]);
  // Every physical fragment is an upload pin, including disconnected sessions.
  repo.objects.pinUploads(repo.objects.inventory().map(entry => entry.id));
  const garbage = repo.objects.write("blob", Buffer.from("unreachable"));
  const dry = collectGarbage(repo); assert.equal(dry.applied, false); assert.deepEqual(dry.candidates, [garbage]); assert.ok(repo.objects.has(garbage));
  const applied = collectGarbage(repo, true); assert.equal(applied.removed, 1); assert.equal(repo.objects.has(garbage), false);
  repo.undo(null, new Date()); assert.equal(repo.refs.resolveHead(), after);
  assert.equal(collectGarbage(repo, true).removed, 1, "discarded staged content becomes collectible after undo");
  assert.equal(collectGarbage(repo, true).removed, 0);
});

test("GC follows manifest pages and protects sparse private and retired instance indexes and logs", async () => {
  const hub = await fresh(); const tip = commit(hub, "hub");
  const directory = makeTempDir(); directories.push(directory); const root = join(directory.root, "instance");
  hub.linkInstance("sparse", root, { include: ["other"] });
  const instance = Repository.open(root);
  writeFileSync(join(root, "staged"), "private staged"); instance.stage(["staged"]);
  const staged = instance.readIndex().find(entry => entry.path === "staged")!.id;
  const manifest = writeFragmented(hub.objects, Buffer.from("bounded pages".repeat(2000)), 16);
  // A series-free custom ref is still a retention root.
  hub.refs.compareAndSwap("refs/metadata/fragments", null, manifest.manifestId);
  const garbage = hub.objects.write("blob", Buffer.from("garbage"));
  hub.unlinkInstance("sparse");
  assert.equal(collectGarbage(instance, true).removed, 1);
  assert.ok(instance.objects.has(staged)); assert.ok(hub.objects.has(tip)); assert.ok(!hub.objects.has(garbage));
});

for (const ref of ["refs/metadata/checkpoint.tmp", "refs/remotes/archive.tmp/main"]) {
  test(`GC retains valid tmp refs through ${ref}`, async () => {
    const repo = await fresh(); const content = Buffer.from("reachable chunked checkpoint".repeat(20));
    const stored = writeFragmented(repo.objects, content, 32);
    repo.refs.compareAndSwap(ref, null, stored.manifestId);
    assert.equal(repo.refs.read(ref), stored.manifestId);
    assert.ok(repo.refs.list("refs/").some(entry => entry.name === ref));
    const garbage = repo.objects.write("blob", Buffer.from("unreachable fixture bytes"));
    assert.deepEqual(collectGarbage(repo).candidates, [garbage]);
    assert.equal(collectGarbage(repo, true).removed, 1);
    assert.equal(repo.refs.read(ref), stored.manifestId);
    assert.deepEqual(readFragmentRange(repo.objects, stored.manifestId, 0, content.length), content);
  });
}

for (const contents of ["partial ref bytes", ""]) test(`GC refuses a corrupt tmp-named ref before deletion: ${JSON.stringify(contents)}`, async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("held garbage"));
  const target = join(repo.controlDirectory, "refs/heads/broken.tmp");
  writeFileSync(target, contents);
  assert.throws(() => collectGarbage(repo, true), { code: "unsafe_gc_roots", message: "Collection root .pmvcs/refs/heads/broken.tmp is not an object address." });
  assert.ok(repo.objects.has(garbage));
});

test("active leases retain even unpublished unattached payloads, expired and released leases permit collection", async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("lease payload"));
  const leases = new PublicationLeases(repo.objects, repo.controlDirectory);
  const fileId = "a".repeat(32); const held = leases.change({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60_000 })!;
  assert.equal(collectGarbage(repo, true).activeLeases, 1); assert.ok(repo.objects.has(garbage));
  leases.change({ action: "release", fileId, token: held.token });
  assert.equal(collectGarbage(repo, true).removed, 1);
});

for (const bad of ["{", '{"refs":null}\n', '{"refs":[{"before":"bad","after":null}]}\n', '{"refs":[],"head":{"before":4,"after":"x"}}\n']) {
  test(`torn or invalid oplog refuses every deletion: ${bad}`, async () => {
    const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("garbage"));
    writeFileSync(join(repo.controlDirectory, "oplog.jsonl"), bad);
    assert.throws(() => collectGarbage(repo, true), /operation log/); assert.ok(repo.objects.has(garbage));
  });
}

test("bad upload roots, refs, instance roots and lease layout fail before unlink", async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("garbage"));
  for (const [file, text] of [["upload-roots.json", "null"], ["unlinked-instances.json", '["/absolute"]']]) {
    const path = join(repo.controlDirectory, file); writeFileSync(path, text);
    assert.throws(() => collectGarbage(repo, true)); rmSync(path);
  }
  const refs = join(repo.controlDirectory, "refs"); mkdirSync(refs, { recursive: true });
  writeFileSync(join(refs, "bad"), "bad"); assert.throws(() => collectGarbage(repo, true)); rmSync(join(refs, "bad"));
  symlinkSync(join(repo.controlDirectory, "HEAD"), join(refs, "bad"));
  assert.throws(() => collectGarbage(repo, true), { code: "unsafe_gc_roots", message: "Collection cannot follow a ref link: .pmvcs/refs/bad." }); rmSync(join(refs, "bad"));
  mkdirSync(join(repo.controlDirectory, "leases")); writeFileSync(join(repo.controlDirectory, "leases/bad"), "{}");
  assert.throws(() => collectGarbage(repo, true)); assert.ok(repo.objects.has(garbage));
});

test("real process upload survives GC before publication and reclones with identical bytes", async () => {
  const source = await fresh(); const tip = commit(source, "independent process payload"); const remote = await fresh();
  const upload = worker("upload", source.root, remote.root);
  assert.deepEqual(await upload.message(), { uploaded: true });
  const unrelated = remote.objects.write("blob", Buffer.from("unrelated old object"));
  assert.equal(collectGarbage(remote, true).removed, 1); assert.ok(!remote.objects.has(unrelated));
  upload.child.send({ publish: true }); assert.deepEqual(await upload.message(), { published: true });
  assert.deepEqual(await upload.closed, { code: 0, signal: null, errors: "" });
  assert.equal(remote.refs.resolveHead(), tip);
  const destination = makeTempDir(); directories.push(destination);
  const clone = worker("clone", join(destination.root, "clone"), remote.root);
  assert.deepEqual(await clone.message(), { cloned: true }); assert.equal((await clone.closed).code, 0);
  assert.equal(readFileSync(join(destination.root, "clone/asset"), "utf8"), "independent process payload");
});

test("SIGKILL midway through sweep retains history and restart replans after explicit lock recovery", async () => {
  const repo = await fresh(); const tip = commit(repo, "survivor");
  repo.objects.write("blob", Buffer.from("garbage1")); repo.objects.write("blob", Buffer.from("garbage2"));
  const sweep = worker("crash", repo.root); assert.deepEqual(await sweep.message(), { deleted: true });
  sweep.child.kill("SIGKILL"); assert.equal((await sweep.closed).signal, "SIGKILL");
  repo.objects.recoverWriterLock(); const result = collectGarbage(repo, true);
  assert.equal(result.removed, 1); assert.ok(repo.objects.has(tip)); assert.equal(repo.verify().missing.length, 0);
});

test("extension GC is a dry run unless --apply is explicit", async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("garbage"));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8"));
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  const dry = await harness.runCommand({ command: "vcs gc", pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(dry.errorMessage, undefined); assert.ok(repo.objects.has(garbage));
  const applied = await harness.runCommand({ command: "vcs gc", options: { apply: true }, pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(applied.errorMessage, undefined); assert.ok(!repo.objects.has(garbage));
});

test("oplog-only displaced history remains readable and undoable after collection", async () => {
  const repo = await fresh(); const before = commit(repo, "old"); const after = commit(repo, "displaced");
  repo.reset(before, "mixed", new Date());
  assert.deepEqual(collectGarbage(repo, true).candidates, []);
  assert.ok(repo.objects.has(after));
  repo.undo(null, new Date()); assert.equal(repo.refs.resolveHead(), after);
});

test("collection retains detached HEAD transitions and pending merge roots without trimming the log", async () => {
  const repo = await fresh(); const tip = commit(repo, "base");
  repo.switchTo(tip, new Date()); repo.switchTo("main", new Date());
  writeFileSync(join(repo.controlDirectory, "MERGE_STATE"), JSON.stringify({ ours: tip, theirs: tip, bases: [tip] }));
  writeFileSync(join(repo.controlDirectory, "refs/heads/unused.tmp.lock"), "broken temporary ref");
  writeFileSync(join(repo.controlDirectory, "refs/heads/unused.lock"), "live marker");
  assert.equal(collectGarbage(repo).candidates.length, 0);
  const logs = readFileSync(join(repo.controlDirectory, "oplog.jsonl"), "utf8");
  collectGarbage(repo, true); assert.equal(readFileSync(join(repo.controlDirectory, "oplog.jsonl"), "utf8"), logs);
});

test("missing, unbound or corrupt instance metadata refuses deletion", async () => {
  const hub = await fresh(); commit(hub, "base");
  const destination = makeTempDir(); directories.push(destination); const root = join(destination.root, "instance");
  hub.linkInstance("instance", root); const garbage = hub.objects.write("blob", Buffer.from("garbage"));
  rmSync(join(root, ".pmvcs/format")); assert.throws(() => collectGarbage(hub, true)); assert.ok(hub.objects.has(garbage));
  rmSync(join(hub.controlDirectory, "instances.json"));
  for (const retired of [null, [4], [""], ["../foreign"]]) {
    writeFileSync(join(hub.controlDirectory, "unlinked-instances.json"), JSON.stringify(retired)); assert.throws(() => collectGarbage(hub, true));
  }
});

test("symlinked root directories or logs and corrupt lease audits refuse collection", async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("garbage"));
  const refs = join(repo.controlDirectory, "refs"); rmSync(refs, { recursive: true }); symlinkSync(repo.controlDirectory, refs, "dir"); assert.throws(() => collectGarbage(repo)); rmSync(refs);
  const log = join(repo.controlDirectory, "oplog.jsonl"); symlinkSync(join(repo.controlDirectory, "HEAD"), log); assert.throws(() => collectGarbage(repo)); rmSync(log);
  writeFileSync(log, "\n\n"); assert.equal(collectGarbage(repo).candidates[0], garbage);
  const leases = join(repo.controlDirectory, "leases"); symlinkSync(repo.controlDirectory, leases, "dir"); assert.throws(() => collectGarbage(repo)); rmSync(leases);
  mkdirSync(leases); writeFileSync(join(leases, `${"b".repeat(32)}.jsonl`), "bad"); assert.throws(() => collectGarbage(repo));
});

test("dangling links at collection roots fail closed", async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("garbage"));
  const control = repo.controlDirectory;
  const log = join(control, "oplog.jsonl");
  symlinkSync(join(control, "absent-target"), log, "file");
  assert.throws(() => collectGarbage(repo, true), /real operation log/); assert.ok(repo.objects.has(garbage));
  rmSync(log);
  const leases = join(control, "leases");
  symlinkSync(join(control, "absent-target"), leases, "dir");
  assert.throws(() => collectGarbage(repo, true), /real lease directory/); assert.ok(repo.objects.has(garbage));
  rmSync(leases);
  const refs = join(control, "refs"); rmSync(refs, { recursive: true }); symlinkSync(join(control, "absent-target"), refs, "dir");
  assert.throws(() => collectGarbage(repo, true), { code: "unsafe_gc_roots", message: "Collection cannot follow a ref directory link: .pmvcs/refs." }); assert.ok(repo.objects.has(garbage));
  rmSync(refs);
  mkdirSync(join(control, "refs", "heads"), { recursive: true });
  assert.deepEqual(collectGarbage(repo, true).candidates, [garbage]);
});

for (const fault of ["address", "file-link", "directory-link", "root-link"] as const) test(`GC refusal reports only repository-relative ref paths for ${fault}`, async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("retained on refusal"));
  const refs = join(repo.controlDirectory, "refs");
  const target = join(refs, "heads", "nested.tmp");
  let message: string;
  if (fault === "root-link") {
    rmSync(refs, { recursive: true }); symlinkSync(repo.controlDirectory, refs, "dir");
    message = "Collection cannot follow a ref directory link: .pmvcs/refs.";
  } else {
    if (fault === "address") writeFileSync(target, "truncated legacy or legal ref");
    else symlinkSync(fault === "file-link" ? join(repo.controlDirectory, "HEAD") : repo.controlDirectory, target, fault === "file-link" ? "file" : "dir");
    message = fault === "address" ? "Collection root .pmvcs/refs/heads/nested.tmp is not an object address."
      : "Collection cannot follow a ref link: .pmvcs/refs/heads/nested.tmp.";
  }
  assert.throws(() => collectGarbage(repo, true), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && error.code === "unsafe_gc_roots");
    assert.equal(error.message, message); assert.ok(!error.message.includes(repo.root)); return true;
  });
  assert.ok(repo.objects.has(garbage));
});

test("a hidden instance registry fails closed before any sweep can delete staged work", async () => {
  const hub = await fresh(); commit(hub, "base");
  const destination = makeTempDir(); directories.push(destination); const root = join(destination.root, "instance");
  hub.linkInstance("writer", root);
  const instance = Repository.open(root);
  writeFileSync(join(root, "staged"), "instance-staged-payload");
  instance.stage([]);
  const staged = instance.readIndex().map((entry) => entry.id);
  assert.ok(staged.length > 0);
  assert.ok(!collectGarbage(hub).candidates.includes(staged[0]!));
  rmSync(join(hub.controlDirectory, "instances.json"));
  assert.throws(() => collectGarbage(hub), /shared instance registry/);
  assert.throws(() => collectGarbage(hub, true), /shared instance registry/);
  assert.throws(() => collectGarbage(instance, true), /shared instance registry/);
  assert.ok(hub.objects.has(staged[0]!));
});

test("expired lease does not retain unreachable payloads", async () => {
  const repo = await fresh(); const garbage = repo.objects.write("blob", Buffer.from("garbage"));
  const leases = new PublicationLeases(repo.objects, repo.controlDirectory);
  leases.change({ action: "acquire", fileId: "c".repeat(32), refs: ["refs/heads/main"], ttlMs: 1 });
  await new Promise(resolve => { setTimeout(resolve, 5); });
  const result = collectGarbage(repo, true); assert.equal(result.activeLeases, 0); assert.deepEqual(result.candidates, [garbage]);
});

test("terminal erasure audits remain roots and pending authorized cleanup prevents GC", async () => {
  const repo = await fresh();
  writeFileSync(join(repo.root, "asset"), "erasure-sample-marker-8493056217"); repo.stage([]); repo.commit({ message: "prepare erasure", author }, new Date());
  repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  repo.obliterate("asset", "erase-fixture", "fixture-cleanup", new Date());
  const denial = repo.objects.denials()[0]; assert.ok(denial);
  repo.objects.pinUploads(denial.tombstone.objects);
  collectGarbage(repo, true); assert.ok(repo.objects.has(denial.id)); assert.deepEqual(repo.objects.uploadRoots(), []);
  repo.objects.recordDenials([{ ...denial, pending: true }]);
  assert.throws(() => collectGarbage(repo), /authorized erasure/);
});

test("foreign retired instance cannot supply roots for a different store", async () => {
  const hub = await fresh(); const foreign = await fresh();
  writeFileSync(join(hub.controlDirectory, "unlinked-instances.json"), JSON.stringify([relative(hub.root, foreign.root).split(sep).join("/")]));
  assert.throws(() => collectGarbage(hub), /no longer bound/);
});

test("GC and a full push execute concurrently in different processes and preserve the published closure", async () => {
  const source = await fresh(); const tip = commit(source, "race survivor"); const remote = await fresh();
  const wire = new FileTransport(remote.root, remote.root);
  const bundle = exportBundle(source.objects, source.refs, ["refs/heads/main"]);
  const updates = [{ ref: "refs/heads/main", expected: null, next: tip }];
  const proofs = await acquirePublicationLeases(wire, updates, bundle);
  const sweep = worker("hold-gc", remote.root);
  assert.deepEqual(await sweep.message(), { locked: true });
  await wire.push(bundle, updates, false, new Date(), proofs);
  assert.equal((await sweep.closed).code, 0);
  assert.equal(remote.refs.resolveHead(), tip); assert.equal(remote.verify().missing.length, 0);
});
