/** Recorded disagreements remain live data through ordinary work, transfer, bounded history and explicit resolution. */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { inspectRepresentations } from "../engine/representations.ts";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { startRepositoryServer } from "../engine/serve.ts";
import { Repository } from "../engine/repo.ts";
import { decodeRecord, decodeTree, encodeRecord, encodeTree, readCommit, writeCommit } from "../engine/model.ts";
import { decodeConflict, encodeConflict, fieldSide, readConflict, resolvePayload, summarizeConflicts, carryConflicts, type ConflictUnit } from "../engine/conflicts.ts";
import { mergeTrees } from "../engine/rewrite.ts";
import { buildTree, decodeIndex, encodeIndex, flattenTree } from "../engine/worktree.ts";
import { inspectClosure } from "../engine/closure.ts";
import { collectGarbage } from "../engine/gc.ts";
import { cloneFrom, fetchFrom } from "../engine/sync.ts";
import { exportBundle, importBundle } from "../engine/bundle.ts";
import { hashObject, ObjectStore, type ObjectId, type ObjectType } from "../engine/objects.ts";
import { traceFile } from "../engine/attribution.ts";
import { installPackedExtension, pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";
import { assertArrivalsAllowed } from "../engine/lifecycle.ts";
import { LeasedFileTransport, leasedPushTo } from "./helpers/publication-consumers.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

const temps: ReturnType<typeof makeTempDir>[] = [];
const author = { name: "fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
const now = new Date(1000);
afterEach(() => { for (const dir of temps.splice(0)) dir.cleanup(); });
/** Allocate one owned disposable scenario. */
function temp() { const dir = makeTempDir(); temps.push(dir); return dir.root; }
/** Initialize a real tracker, never an SDK double. */
async function fixture() {
  const parent = temp(); const root = join(parent, "repo"); mkdirSync(root);
  const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("conflict", { defaults: true, author: "fixture" });
  const repo = Repository.init(root, "main", { recordPaths: ["**/*.toon"], recordPolicy: { fields: { updated_at: "timestamp" } } });
  repo.stage([]); repo.commit({ message: "tracker baseline", author }, now);
  return { repo, client, parent, root };
}
/** Stage real bytes and record a native commit. */
function commit(repo: Repository, path: string, text: string | Buffer) {
  mkdirSync(dirname(join(repo.root, path)), { recursive: true }); writeFileSync(join(repo.root, path), text);
  repo.stage([path]); return repo.commit({ message: "fixture edit", author }, now);
}
/** Produce one field or multiple hunk disagreements through real branch edits. */
async function divergent(text = false) {
  const state = await fixture(); const { repo } = state;
  const path = text ? "text.txt" : "item.toon";
  const values = text ? ["a\nbase\nc\nbase2\ne\n", "a\nours\nc\nours2\ne\n", "a\ntheirs\nc\ntheirs2\ne\n"]
    : [JSON.stringify({ status: "open", x: 0, y: 0 }), JSON.stringify({ status: "in_progress", x: 1, y: 0 }), JSON.stringify({ status: "blocked", x: 0, y: 2 })];
  commit(repo, path, values[0]); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); commit(repo, path, values[2]);
  repo.switchTo("main", now); commit(repo, path, values[1]);
  return { ...state, path };
}
/** Record the disagreement and return its concrete tree/index entry. */
function record(repo: Repository, path: string) {
  const report = repo.merge("other", { message: "record disagreement", author, recordConflicts: true }, now);
  assert.equal(report.kind, "merged"); assert.equal(report.clean, false);
  assert.equal(repo.readMergeState(), null); assert.equal(repo.status().clean, true);
  const entry = repo.readIndex().find((entry) => entry.path === path)!;
  assert.ok(entry.conflicts?.length); return { report, entry };
}

/** Capture published state so refusal tests detect partial index, disk or operation updates. */
function publishedState(repo: Repository, path: string) {
  const leaf = join(repo.root, path);
  return { head: repo.resolve("HEAD"), index: readFileSync(join(repo.controlDirectory, "index")),
    content: existsSync(leaf) ? readFileSync(leaf) : null, mode: existsSync(leaf) ? statSync(leaf).mode : null,
    merge: repo.readMergeState(), operations: repo.operations.read() };
}

test("real PM worktrees: two PM_AUTHOR identities keep working, a third resolves exactly one status unit", async () => {
  const { repo, client, parent, root } = await fixture();
  const item = (await client.create({ type: "Task", title: "Shared work", author: "fixture" })).item.id;
  repo.stage([]); repo.commit({ message: "baseline", author }, now);
  repo.linkInstance("agent-a", join(parent, "agent-a")); repo.linkInstance("agent-b", join(parent, "agent-b"));
  const a = Repository.open(join(parent, "agent-a")); const b = Repository.open(join(parent, "agent-b"));
  const pm = (repository: Repository, identity: string, args: string[]) => execFileSync(join(packageRoot, "node_modules/.bin/pm"), ["--no-extensions", "--json", ...args],
    { cwd: repository.root, env: { ...withoutPmContext(process.env), ...discardChildCoverage(), PM_AUTHOR: identity }, encoding: "utf8" });
  pm(a, "agent-a", ["update", item, "--status", "in_progress", "--description", "Independent description"]);
  a.stage([]); a.commit({ message: "agent a", author: { ...author, name: "agent-a" } }, now);
  pm(b, "agent-b", ["update", item, "--status", "blocked", "--blocked-reason", "Review pending", "--priority", "1"]);
  b.stage([]); b.commit({ message: "agent b", author: { ...author, name: "agent-b" } }, now);
  a.merge("agent-b", { message: "agents merge", author, recordConflicts: true }, now);
  const conflicts = a.status().conflicts!; assert.equal(conflicts.length, 1); assert.equal(conflicts[0].unit, "status"); assert.equal(conflicts[0].item, item);
  const path = conflicts[0].path;
  assert.ok(!readFileSync(join(a.root, path), "utf8").includes("<<<<<<<"));
  const mergedItem = JSON.parse(pm(a, "agent-a", ["get", item]));
  assert.match(JSON.stringify(mergedItem), /Independent description/); assert.match(JSON.stringify(mergedItem), /"priority":1/);
  commit(a, "after-a.txt", "agent a continues");
  b.merge("agent-a", { message: "receive merge", author, recordConflicts: true }, now);
  commit(b, "after-b.txt", "agent b continues");
  a.merge("agent-b", { message: "receive work", author, recordConflicts: true }, now);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const pmRoot = join(a.root, ".agents/pm");
  for (const command of ["vcs status", "vcs show", "vcs log", "vcs items"]) {
    const result = await harness.runCommand({ command, pmRoot }); assert.equal(result.errorMessage, undefined);
    assert.match(JSON.stringify(result.result), /"unit":"status"/);
  }
  const resolution = await harness.runCommand({ command: "vcs resolve", args: [path], options: { field: "status", take: "theirs" }, global: { author: "agent-c" }, pmRoot });
  assert.equal(resolution.errorMessage, undefined); assert.equal(a.status().conflicts, undefined);
  assert.equal(JSON.parse(pm(a, "agent-c", ["get", item])).item.status, "blocked");
  assert.equal(readFileSync(join(a.root, "after-a.txt"), "utf8"), "agent a continues");
  assert.equal(readFileSync(join(a.root, "after-b.txt"), "utf8"), "agent b continues");
  assert.deepEqual(a.verify().missing, []); assert.deepEqual(a.verify().corrupt, []);
  assert.match(pm(a, "agent-c", ["list", "--status", "all"]), new RegExp(item));
  assert.equal(root, repo.root);
});

test("field objects preserve all alternatives, nonoverlapping edits and unresolved metadata across stage and sparse checkout", async () => {
  const { repo, path, parent } = await divergent(); const { entry, report } = record(repo, path);
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, path), "utf8")), { status: "in_progress", x: 1, y: 2 });
  const receiver = Repository.init(temp()); importBundle(receiver.objects, receiver.refs, exportBundle(repo.objects, repo.refs, []));
  assert.deepEqual(receiver.verify().missing, []);
  const unit = readConflict(repo.objects, entry.conflicts![0]); assert.equal(unit.kind, "field");
  for (const [side, expected] of [["base", "open"], ["ours", "in_progress"], ["theirs", "blocked"]] as const) {
    assert.equal(decodeRecord(repo.objects.readTyped(unit[side], "record")).value, expected);
  }
  commit(repo, path, JSON.stringify({ status: "in_progress", x: 5, y: 2 }));
  assert.equal(repo.status().conflicts?.length, 1);
  repo.linkInstance("sparse", join(parent, "sparse"), { include: ["*.txt"] });
  const sparse = Repository.open(join(parent, "sparse"));
  commit(sparse, "next.txt", "continue"); assert.equal(sparse.status().conflicts?.length, 1);
  repo.switchTo("sparse", now); assert.equal(repo.readIndex().find((e) => e.path === path)?.conflicts?.length, 1);
  repo.resolveConflicts(path, { field: "status", value: "closed" }, { message: "resolution", author }, now);
  assert.equal(repo.status().conflicts, undefined); assert.equal(JSON.parse(readFileSync(join(repo.root, path), "utf8")).x, 5);
  assert.equal(summarizeConflicts(repo.objects, readCommit(repo.objects, report.head).tree).length, 1);
});

test("hunk objects store no markers, retain independent work, shift ranges and resolve all hunks", async () => {
  const { repo, path } = await divergent(true); const { entry } = record(repo, path);
  assert.equal(entry.conflicts!.length, 2);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "a\nours\nc\nours2\ne\n");
  commit(repo, path, "prefix\na\nours\nc\nours2\ne\nsuffix\n");
  const shifted = repo.readIndex().find((e) => e.path === path)!;
  assert.equal(summarizeConflicts(repo.objects, readCommit(repo.objects, repo.resolve("HEAD")).tree)[0].unit, "hunk:3-3");
  assert.equal(shifted.conflicts!.length, 2);
  repo.resolveConflicts(path, { take: "theirs" }, { message: "take hunks", author }, now);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "prefix\na\ntheirs\nc\ntheirs2\ne\nsuffix\n");
  assert.deepEqual(repo.verify().corrupt, []);
});

test("bundle, push/fetch, shallow partial history and GC retain conflicted changes", async () => {
  const { repo, path } = await divergent(true); const { entry, report } = record(repo, path);
  const destination = Repository.init(temp());
  importBundle(destination.objects, destination.refs, exportBundle(repo.objects, repo.refs, []));
  assert.equal(summarizeConflicts(destination.objects, readCommit(destination.objects, report.head).tree).length, 2);
  const clonedRoot = join(temp(), "clone"); await cloneFrom(repo.root, clonedRoot, now, "origin", repo.root, undefined, { depth: 1, filter: "blob:none" });
  const clone = Repository.open(clonedRoot); assert.equal(clone.log("HEAD").length, 1); assert.equal(clone.status().conflicts?.length, 2);
  assert.deepEqual(clone.verify().missing, []); assert.equal(collectGarbage(clone, true).removed, 0);
  clone.resolveConflicts(path, { take: "base" }, { message: "base", author }, now);
  assert.equal(readFileSync(join(clone.root, path), "utf8"), "a\nbase\nc\nbase2\ne\n");
  const remoteRoot = join(temp(), "remote"); await cloneFrom(repo.root, remoteRoot, now);
  repo.remotes.add("publish", remoteRoot);
  commit(repo, "next", "continue");
  const wire = new LeasedFileTransport(remoteRoot, repo.root);
  await leasedPushTo(repo, "publish", ["main"], false, now, wire);
  const remote = Repository.open(remoteRoot); assert.deepEqual(remote.verify().corrupt, []);
  assert.equal(summarizeConflicts(remote.objects, readCommit(remote.objects, remote.resolve("main")).tree).length, 2);
  await fetchFrom(clone, "origin", now); assert.deepEqual(clone.verify().missing, []);
  const unit = readConflict(repo.objects, entry.conflicts![0]);
  repo.resolveConflicts(path, { take: "ours" }, { author, message: "resolve before collection" }, now);
  assert.ok(collectGarbage(repo, true).retained > 0); assert.ok(repo.objects.has(unit.theirs));
});

test("legacy fail-on-conflict remains isolated and conflicting mode flags refuse before mutation", async () => {
  const { repo, path } = await divergent(true); const head = repo.resolve("HEAD");
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const pmRoot = join(repo.root, ".agents/pm");
  const invalid = await harness.runCommand({ command: "vcs merge", args: ["other"], options: { recordConflicts: true, failOnConflict: true }, pmRoot });
  assert.ok(invalid.errorMessage); assert.equal(repo.resolve("HEAD"), head); assert.equal(repo.readMergeState(), null);
  const stopped = await harness.runCommand({ command: "vcs merge", args: ["other"], options: { failOnConflict: true }, pmRoot });
  assert.ok(stopped.errorMessage); assert.equal(repo.resolve("HEAD"), head); assert.ok(repo.readMergeState());
  assert.match(readFileSync(join(repo.root, path), "utf8"), /<<<<<<< ours/); repo.mergeAbort(now);
  const recorded = await harness.runCommand({ command: "vcs merge", args: ["other"], options: { recordConflicts: true }, pmRoot });
  assert.equal(recorded.errorMessage, undefined); assert.equal((recorded.result as { ok: boolean }).ok, true);
});

test("verify rejects missing sides, corrupt conflict schemas, digest corruption and wrong side kinds", async () => {
  const { repo, path } = await divergent(); const { entry } = record(repo, path);
  const unit = readConflict(repo.objects, entry.conflicts![0]);
  const commitFor = (conflict: ObjectId) => writeCommit(repo.objects, { tree: buildTree(repo.objects, new Map([[path, { ...entry, conflicts: [conflict] }]])), parents: [], author, committer: author, message: "malformed fixture" });
  const missing = "f".repeat(64); const absent = repo.objects.write("conflict", encodeConflict({ ...unit, theirs: missing }));
  assert.ok(inspectClosure(repo.objects, [commitFor(absent)]).missing.some((message) => message.includes(missing)));
  for (const commit of [commitFor(absent), commitFor(missing)]) {
    assert.ok(inspectClosure(repo.objects, [commit], [], [], false, [], undefined, { shallow: [commit], promised: [missing] }).missing.length > 0);
  }
  const wrong = repo.objects.write("blob", Buffer.from("wrong kind"));
  const wrongSide = repo.objects.write("conflict", encodeConflict({ ...unit, theirs: wrong }));
  assert.ok(inspectClosure(repo.objects, [commitFor(wrongSide)]).corrupt.some((s) => s.includes("object_type_mismatch")));
  const wrongEnvelope = repo.objects.write("record", encodeRecord({ unrelated: "field" }));
  const wrongField = repo.objects.write("conflict", encodeConflict({ ...unit, theirs: wrongEnvelope }));
  assert.ok(inspectClosure(repo.objects, [commitFor(wrongField)]).corrupt.some((s) => s.includes("malformed_conflict_side")));
  const malformed = repo.objects.write("conflict", Buffer.from('{"kind":"invalid"}'));
  assert.ok(inspectClosure(repo.objects, [commitFor(malformed)]).corrupt.some((s) => s.includes("malformed_conflict")));
  const bytes = repo.objects.readTyped(entry.conflicts![0], "conflict");
  const physical = [...repo.objects.walkInventory()].find((o) => o.id === entry.conflicts![0])!.path;
  writeFileSync(physical, "damaged"); assert.ok(repo.verify().corrupt.length);
  assert.equal(decodeConflict(bytes).kind, "field");
});

test("FileId obliteration removes conflict units and all alternatives and prevents their resurrection", async () => {
  const { repo } = await fixture(); const path = "secret.txt";
  const words = ["unique-base-payload-7c99281b", "unique-ours-payload-874cb327", "unique-theirs-payload-395b96d2"];
  commit(repo, path, `before\n${words[0]}\nafter\n`); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); commit(repo, path, `before\n${words[2]}\nafter\n`);
  repo.switchTo("main", now); commit(repo, path, `before\n${words[1]}\nafter\n`);
  const { entry } = record(repo, path); const unit = readConflict(repo.objects, entry.conflicts![0]);
  repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  const receipt = repo.obliterate(path, "erase-fixture", "fixture-cleanup", now);
  for (const id of [entry.conflicts![0], unit.base, unit.ours, unit.theirs]) assert.ok(receipt.removed.includes(id));
  assert.deepEqual(repo.verify().corrupt, []); assert.deepEqual(repo.verify().missing, []);
  assert.equal(repo.status().conflicts, undefined);
  const denied = repo.objects.denials();
  const arrival = (payload: Buffer, type: "tree" | "conflict" = "conflict") => ({ id: hashObject(type, payload), payload, type });
  assert.throws(() => assertArrivalsAllowed(denied, [arrival(encodeConflict({ ...unit, kind: "text", start: 7, end: 8 }))], true), /denied alternatives/);
  const wrong = encodeTree([{ name: path, mode: "100644", id: entry.id, fileId: "f".repeat(32), conflicts: entry.conflicts }]);
  assert.throws(() => assertArrivalsAllowed(denied, [arrival(wrong, "tree")], true), /Conflict denial/);
  const valid = encodeTree([{ name: path, mode: "100644", id: entry.id, fileId: entry.fileId, conflicts: entry.conflicts }]);
  assert.doesNotThrow(() => assertArrivalsAllowed(denied, [arrival(valid, "tree")], true));
  const surviving = repo.objects.write("blob", Buffer.from("brand new alternative"), "e".repeat(32));
  const novel = arrival(encodeConflict({ kind: "text", start: 0, end: 0, base: surviving, ours: surviving, theirs: surviving }));
  assert.throws(() => assertArrivalsAllowed(denied, [novel], false), /provenance/);
  assert.doesNotThrow(() => assertArrivalsAllowed(denied, [novel], true));
  const receiver = Repository.init(temp()); importBundle(receiver.objects, receiver.refs, exportBundle(repo.objects, repo.refs, []));
  assert.deepEqual(receiver.verify().missing, []); assert.deepEqual(receiver.verify().corrupt, []);
});

test("conflict schemas, tree/index versions and absence envelopes fail closed on malformed inputs", async () => {
  const { repo } = await fixture();
  const base = fieldSide(repo.objects, undefined); const ours = fieldSide(repo.objects, null); const theirs = fieldSide(repo.objects, false);
  assert.deepEqual(decodeRecord(repo.objects.readTyped(base, "record")), {});
  assert.deepEqual(decodeRecord(repo.objects.readTyped(ours, "record")), { value: null });
  const unit: ConflictUnit = { kind: "field", field: "status", base, ours, theirs };
  const valid = encodeConflict(unit); assert.deepEqual(decodeConflict(valid), unit);
  for (const value of ["{", "null", "[]", "0", JSON.stringify({ ...unit, base: 1 }), JSON.stringify({ ...unit, theirs: "bad" }),
    JSON.stringify({ ...unit, kind: "bad" }), JSON.stringify({ ...unit, field: 1 }),
    JSON.stringify({ ...unit, extra: true }), JSON.stringify({ kind: "text", base, ours, theirs, start: -1, end: 1 }),
    JSON.stringify({ kind: "text", base, ours, theirs, start: 1, end: 0 }), JSON.stringify({ kind: "text", base, ours, theirs, start: 0.5, end: 1 }),
    JSON.stringify({ kind: "text", base, ours, theirs, start: 0, end: 1.5 })]) {
    assert.throws(() => decodeConflict(Buffer.from(value)), /Conflict/);
  }
  const id = repo.objects.write("conflict", valid);
  const entry = { name: "f", mode: "100644" as const, id: ours, conflicts: [id] };
  assert.deepEqual(decodeTree(encodeTree([entry])), [entry]);
  assert.ok(encodeTree([entry]).toString().startsWith("pm-vcs-tree 3"));
  const two = { ...entry, name: "plain", conflicts: undefined, fileId: "b".repeat(32) };
  assert.equal(decodeTree(encodeTree([entry, two]))[1].conflicts, undefined);
  for (const conflicts of [[], [id, id], ["bad"], "bad", [null]]) {
    assert.throws(() => encodeTree([{ ...entry, conflicts: conflicts as string[] }]), /conflict/);
    assert.throws(() => decodeTree(Buffer.from(`pm-vcs-tree 3\n${JSON.stringify(["100644", ours, null, null, "f", conflicts])}`)), /conflict/);
    assert.throws(() => decodeIndex(`pm-vcs-index 5\n${JSON.stringify(["100644", ours, "f", null, null, null, false, conflicts])}`), /conflict/);
  }
  assert.throws(() => encodeTree([{ ...entry, mode: "40000" }]), /conflict/);
  assert.throws(() => decodeTree(Buffer.from(`pm-vcs-tree 3\n${JSON.stringify(["40000", ours, null, null, "f", [id]])}`)), /conflict/);
  const indexed = [{ path: "f", mode: "100644" as const, id: ours, conflicts: [id] }, { path: "plain", mode: "100644" as const, id: theirs }];
  assert.deepEqual(decodeIndex(encodeIndex(indexed)), indexed);
  assert.ok(encodeIndex(indexed).startsWith("pm-vcs-index 5"));
  assert.equal(carryConflicts(repo.objects, undefined, ours, theirs), undefined);
  assert.deepEqual(carryConflicts(repo.objects, [id], ours, ours), [id]);
  const address = { id: ours, fileId: "a".repeat(32), conflicts: [id] };
  for (const take of ["base", "ours", "theirs"] as const) {
    const resolved = resolvePayload(repo.objects, address, { take });
    assert.deepEqual(decodeRecord(repo.objects.readTyped(resolved.id, "record")), take === "base" ? { value: null } : { status: take === "ours" ? null : false, value: null });
  }
});

test("resolution rejects absent selections, dirty state, out-of-view paths and incompatible units", async () => {
  const { repo, path, parent } = await divergent(); const { entry } = record(repo, path);
  assert.throws(() => Repository.init(temp()).resolveConflicts("x", { take: "ours" }, { author, message: "resolve" }, now), /HEAD has no commit yet/);
  assert.throws(() => resolvePayload(repo.objects, entry, { field: "missing", take: "ours" }), /No recorded/);
  assert.throws(() => resolvePayload(repo.objects, { id: entry.id }, { take: "ours" }), /No recorded/);
  assert.throws(() => repo.resolveConflicts("missing", { take: "ours" }, { author, message: "resolve" }, now), /tracked path/);
  repo.linkInstance("hidden", join(parent, "hidden"), { include: ["*.txt"] });
  assert.throws(() => Repository.open(join(parent, "hidden")).resolveConflicts(path, { take: "ours" }, { author, message: "resolve" }, now), /visible/);
  writeFileSync(join(repo.root, path), JSON.stringify({ status: "open" }));
  assert.throws(() => repo.resolveConflicts(path, { take: "ours" }, { author, message: "resolve" }, now), /Commit staged/);
  const scalar = fieldSide(repo.objects, "x"); const blob = repo.objects.write("blob", Buffer.from("one\ntwo"));
  const textUnit = repo.objects.write("conflict", encodeConflict({ kind: "text", start: 0, end: 1, base: blob, ours: blob, theirs: blob }));
  const fieldUnit = repo.objects.write("conflict", encodeConflict({ kind: "field", field: "f", base: scalar, ours: scalar, theirs: scalar }));
  assert.throws(() => resolvePayload(repo.objects, { id: scalar, conflicts: [textUnit] }, { take: "ours" }), /record requires field/);
  assert.throws(() => resolvePayload(repo.objects, { id: blob, conflicts: [fieldUnit] }, { take: "ours" }), /Text requires/);
  for (const conflicts of [[fieldUnit, textUnit], [textUnit, fieldUnit]]) assert.throws(() => resolvePayload(repo.objects, { id: blob, conflicts }, { take: "ours" }), /Text requires/);
  assert.throws(() => resolvePayload(repo.objects, { id: textUnit, conflicts: [fieldUnit] }, { take: "ours" }), /record or text/);
  assert.throws(() => resolvePayload(repo.objects, { id: blob, conflicts: [textUnit] }, { value: 5 }), /must be strings/);
  assert.equal(repo.objects.readTyped(resolvePayload(repo.objects, { id: blob, conflicts: [textUnit] }, { value: "new" }).id, "blob").toString(), "new\ntwo");
  assert.equal(resolvePayload(repo.objects, { id: scalar, conflicts: [fieldUnit, textUnit] }, { field: "f", value: "new" }).conflicts?.length, 1);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  for (const options of [{}, { take: "invalid" }, { take: "ours", value: "x" }]) {
    const result = await harness.runCommand({ command: "vcs resolve", args: [path], options, pmRoot: join(repo.root, ".agents/pm") });
    assert.ok(result.errorMessage);
  }
});

test("CLI values, unfiltered unit selection and structural recording refusal have explicit outcomes", async () => {
  for (const value of ["done", '"closed"']) {
    const { repo, path } = await divergent(); record(repo, path);
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
    const result = await harness.runCommand({ command: "vcs resolve", args: [path], options: { value }, pmRoot: join(repo.root, ".agents/pm") });
    assert.equal(result.errorMessage, undefined); assert.equal(repo.status().conflicts, undefined);
  }
  const { repo, path } = await divergent();
  rmSync(join(repo.root, path)); repo.stage([path]); repo.commit({ message: "delete vs edit", author }, now);
  assert.throws(() => repo.merge("other", { message: "structural", author, recordConflicts: true }, now), /structural conflicts/);
  assert.equal(repo.readMergeState(), null);
});

test("ordinary text edits preserve adjacent insertions and replacement ranges when a later agent resolves", async () => {
  for (const [edited, expected] of [
    ["a\ninsert\nours\nc\nours2\ne\n", "a\ninsert\ntheirs\nc\ntheirs2\ne\n"],
    ["a\nours\ninsert\nc\nours2\ne\n", "a\ntheirs\ninsert\nc\ntheirs2\ne\n"],
    ["a\nreplacement\nc\nours2\ne", "a\ntheirs\nc\ntheirs2\ne"],
    ["a\nc\nours2\ne\n", "a\ntheirs\nc\ntheirs2\ne\n"],
  ]) {
    const { repo, path } = await divergent(true); record(repo, path); commit(repo, path, edited);
    repo.resolveConflicts(path, { take: "theirs" }, { message: "resolve after edit", author }, now);
    assert.equal(readFileSync(join(repo.root, path), "utf8"), expected);
  }
});

test("collapsed text hunks refuse every recorded side without changing published state", async () => {
  const { repo, path } = await divergent(true); record(repo, path); commit(repo, path, "");
  const entry = repo.readIndex().find((entry) => entry.path === path)!;
  assert.deepEqual(entry.conflicts!.map((id) => readConflict(repo.objects, id)).map((unit) =>
    unit.kind === "text" ? [unit.start, unit.end] : null), [[0, 0], [0, 0]]);
  const before = publishedState(repo, path);
  for (const take of ["ours", "theirs", "base"] as const) {
    assert.throws(() => repo.resolveConflicts(path, { take }, { message: "ambiguous hunks", author }, now),
      { code: "ambiguous_resolution" });
    assert.deepEqual(publishedState(repo, path), before);
  }
  repo.resolveConflicts(path, { value: "consolidated\n" }, { message: "explicit region", author }, now);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "consolidated\n");
  assert.equal(repo.status().conflicts, undefined); assert.deepEqual(repo.verify().corrupt, []);
});

test("three sibling text contenders preserve unequal alternatives and refuse overlapping side resolution", async () => {
  const { repo } = await fixture(); const path = "contenders.txt";
  commit(repo, path, "header\nbase\nmiddle\nbase2\nfooter\n");
  repo.createBranch("other", "HEAD", now); repo.createBranch("third", "HEAD", now);
  commit(repo, path, "header\nours\nmiddle\nours2\nfooter\n");
  repo.switchTo("other", now); commit(repo, path, "header\none\ntwo\nmiddle\ntheirs2\nfooter\n");
  repo.switchTo("third", now); commit(repo, path, "header\nthree\nmiddle\nbase2\nfooter\n");
  repo.switchTo("main", now); record(repo, path);
  repo.merge("third", { message: "third contender", author, recordConflicts: true }, now);
  const entry = repo.readIndex().find((entry) => entry.path === path)!;
  const units = entry.conflicts!.map((id) => readConflict(repo.objects, id));
  assert.equal(units.length, 3);
  assert.deepEqual(units.filter((unit) => unit.kind === "text" && unit.start === 1).map((unit) =>
    repo.objects.readTyped(unit.theirs, "blob").toString()).sort(), ["one\ntwo", "three"]);
  const before = publishedState(repo, path);
  for (const take of ["ours", "theirs", "base"] as const) {
    assert.throws(() => repo.resolveConflicts(path, { take }, { message: "choose side", author }, now),
      { code: "ambiguous_resolution" });
    assert.deepEqual(publishedState(repo, path), before);
  }
  repo.resolveConflicts(path, { value: "chosen" }, { message: "consolidate contenders", author }, now);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "header\nchosen\nmiddle\nchosen\nfooter\n");
  assert.equal(repo.status().conflicts, undefined);
  for (const unit of units) for (const side of ["base", "ours", "theirs"] as const) assert.ok(repo.objects.has(unit[side]));
  assert.deepEqual(repo.verify().missing, []); assert.deepEqual(repo.verify().corrupt, []);
});

test("explicit text values replace each overlapping region once and preserve its surrounding lines", async () => {
  for (const ending of ["", "\n"]) {
    const { repo } = await fixture(); const path = "partial-overlap.txt";
    commit(repo, path, `header\nb1\nb2\nmiddle\nb3\nb4${ending}`); repo.createBranch("other", "HEAD", now);
    repo.switchTo("other", now); commit(repo, path, `header\nt1\nt2\nmiddle\nt3\nt4${ending}`);
    repo.switchTo("main", now); commit(repo, path, `header\no1\no2\nmiddle\no3\no4${ending}`);
    record(repo, path); commit(repo, path, `header\no1\njoined\no4${ending}`);
    const units = repo.readIndex().find((entry) => entry.path === path)!.conflicts!.map((id) => readConflict(repo.objects, id));
    assert.deepEqual(units.map((unit) => unit.kind === "text" ? [unit.start, unit.end] : null).sort(), [[1, 3], [2, 4]]);
    const before = publishedState(repo, path);
    assert.throws(() => repo.resolveConflicts(path, { take: "theirs" }, { message: "partial overlap", author }, now),
      { code: "ambiguous_resolution" });
    assert.deepEqual(publishedState(repo, path), before);
    repo.resolveConflicts(path, { value: `one\ntwo\nthree${ending}` }, { message: "replace union", author }, now);
    assert.equal(readFileSync(join(repo.root, path), "utf8"), `header\none\ntwo\nthree${ending}`);
    assert.equal(repo.status().conflicts, undefined); assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("disjoint text hunks keep unequal side lengths and final-newline choices", async () => {
  const { repo } = await fixture(); const path = "disjoint.txt";
  commit(repo, path, "header\nbase\nmiddle\nbase2\nlast\n"); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); commit(repo, path, "header\none\ntwo\nmiddle\ntail");
  repo.switchTo("main", now); commit(repo, path, "header\nours\nmiddle\nours2\nours3\n");
  record(repo, path);
  repo.resolveConflicts(path, { take: "theirs" }, { message: "resolve disjoint lengths", author }, now);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "header\none\ntwo\nmiddle\ntail");
  assert.equal(repo.status().conflicts, undefined); assert.deepEqual(repo.verify().corrupt, []);
});

test("ordinary truncation preserves projection EOF when an inherited hunk becomes final", async () => {
  for (const ending of ["", "\n"]) {
    const { repo, path } = await divergent(true); record(repo, path);
    commit(repo, path, `a\nours\nc\nours2${ending}`);
    const units = repo.readIndex().find((entry) => entry.path === path)!.conflicts!.map((id) => readConflict(repo.objects, id));
    assert.ok(units.every((unit) => unit.kind === "text" && unit.endings === undefined));
    repo.resolveConflicts(path, { take: "theirs" }, { message: "resolve new final hunk", author }, now);
    assert.equal(readFileSync(join(repo.root, path), "utf8"), `a\ntheirs\nc\ntheirs2${ending}`);
    assert.equal(repo.status().conflicts, undefined); assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("structural delete/edit and mode disagreements refuse inherited field/text units through real branches", async (t) => {
  for (const text of [false, true]) for (const inherited of [false, true]) {
    for (const kind of ["incoming-delete", "local-delete", "mode"] as const) {
      await t.test(`${text ? "text" : "field"}/${inherited ? "inherited" : "clean"}/${kind}`, async () => {
        const { repo, path } = await divergent(text);
        const base = readCommit(repo.objects, repo.resolve("HEAD")).parents[0];
        if (inherited) record(repo, path);
        repo.createBranch("structural", base, now); repo.switchTo("structural", now);
        if (kind === "mode") chmodSync(join(repo.root, path), 0o755);
        else rmSync(join(repo.root, path));
        repo.stage([path]); repo.commit({ message: "structural contender", author }, now);
        if (kind !== "local-delete") repo.switchTo("main", now);
        const before = publishedState(repo, path);
        assert.throws(() => repo.merge(kind === "local-delete" ? "main" : "structural",
          { message: "refuse unsupported dispute", author, recordConflicts: true }, now),
        { code: "unsupported_recorded_conflict" }, `${text}/${inherited}/${kind}`);
        assert.deepEqual(publishedState(repo, path), before);
        assert.deepEqual(repo.verify().missing, []); assert.deepEqual(repo.verify().corrupt, []);
      });
    }
  }
});

test("items conflict summaries reuse each root tree already read for linked file attribution", async (t) => {
  const { repo, client, path } = await divergent(true); record(repo, path);
  const item = (await client.create({ type: "Task", title: "Track conflicts", author: "fixture" })).item.id;
  await client.files(item, { add: [path], author: "fixture" });
  repo.stage([]); repo.commit({ message: "link conflict file", author }, now);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const trees = new Set(repo.allReachable().map((id) => readCommit(repo.objects, id).tree));
  const reads = new Map<ObjectId, number>(); const original = ObjectStore.prototype.readTyped;
  t.mock.method(ObjectStore.prototype, "readTyped", function (this: ObjectStore, id: ObjectId, type: ObjectType) {
    if (type === "tree" && trees.has(id)) reads.set(id, (reads.get(id) ?? 0) + 1);
    return original.call(this, id, type);
  });
  const result = await harness.runCommand({ command: "vcs items", pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(result.errorMessage, undefined);
  assert.ok((result.result as { items: string[] }).items.includes(item));
  assert.equal((result.result as { conflicts: unknown[] }).conflicts.length, 4);
  assert.equal(reads.size, trees.size);
  for (const count of reads.values()) assert.equal(count, 1, "one root-tree decode per immutable snapshot");
});


test("packed CLI prints one unit per TOON/JSON row and Bun reads the same conflicted change", async () => {
  const { repo } = await divergent(true);
  const coverage = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = "";
  try { installPackedExtension(repo.root); } finally {
    if (coverage === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = coverage;
  }
  repo.stage([]); repo.commit({ message: "install consumer extension", author }, now);
  const pm = (args: string[], executable = process.execPath) => execFileSync(executable, [pmExecutable, ...args], {
    cwd: repo.root, env: { ...withoutPmContext(process.env), ...discardChildCoverage(), PM_AUTHOR: "consumer-agent" }, encoding: "utf8", timeout: 120_000,
  });
  const merge = JSON.parse(pm(["--json", "vcs", "merge", "other", "--record-conflicts"]));
  assert.equal(merge.ok, true); assert.equal(merge.merge.kind, "merged");
  for (const command of ["status", "show", "log", "items"]) {
    const toon = pm(["vcs", command]); assert.match(toon, /hunk:/); assert.ok(!toon.includes("<<<<<<<"));
    const json = JSON.parse(pm(["--json", "vcs", command])); assert.match(JSON.stringify(json), /hunk:/);
  }
  const bun = pm(["--json", "vcs", "status"], "bun"); assert.equal(JSON.parse(bun).status.conflicts.length, 2);
  assert.equal(JSON.parse(pm(["--json", "vcs", "resolve", "text.txt", "--take", "ours"])).ok, true);
  assert.equal(JSON.parse(pm(["--json", "vcs", "verify"])).ok, true);
});

test("resolution of the unchanged ours projection still attributes a native file change", async () => {
  const { repo, path } = await divergent(); const { entry } = record(repo, path);
  const id = repo.resolveConflicts(path, { take: "ours" }, { message: "choose unchanged projection", author, committer: { ...author, name: "resolver" } }, now);
  assert.equal(repo.readIndex().find((e) => e.path === path)!.id, entry.id);
  assert.ok(traceFile(repo.objects, [id], entry.fileId!).some((trace) => trace.commit === id));
});


test("served repositories accept conflicted changes over real HTTP push and fetch", async () => {
  const { repo, parent, path } = await divergent(); record(repo, path);
  const server = await startRepositoryServer({ root: parent, host: "127.0.0.1", port: 0, grants: null, unauthenticatedWrites: true });
  try {
    const url = `http://127.0.0.1:${server.port}/repo`;
    const consumerRoot = join(temp(), "consumer"); await cloneFrom(url, consumerRoot, now);
    const readerRoot = join(temp(), "reader"); await cloneFrom(url, readerRoot, now);
    const consumer = Repository.open(consumerRoot); assert.equal(consumer.status().conflicts?.length, 1);
    commit(consumer, "continue.txt", "more work despite a recorded disagreement");
    await leasedPushTo(consumer, "origin", ["main"], false, now);
    const reader = Repository.open(readerRoot); await fetchFrom(reader, "origin", now);
    const remoteTip = reader.refs.read("refs/remotes/origin/main")!;
    assert.equal(summarizeConflicts(reader.objects, readCommit(reader.objects, remoteTip).tree).length, 1);
    assert.deepEqual(reader.verify().missing, []); assert.deepEqual(repo.verify().corrupt, []);
  } finally { await server.close(); }
});


test("a staged unit-only resolution is visible even when the readable payload does not change", async () => {
  const { repo, path } = await divergent(); const { entry } = record(repo, path);
  repo.writeIndex(repo.readIndex().map(({ conflicts: _conflicts, ...current }) => current));
  assert.ok(repo.status().staged.some((change) => change.path === path));
  repo.commit({ message: "explicit staged resolution", author }, now);
  assert.equal(repo.readIndex().find((current) => current.path === path)!.id, entry.id);
  assert.equal(repo.status().conflicts, undefined);
});


test("final hunk resolution preserves each side's newline and empty-deletion state", async () => {
  for (const [take, expected] of [["base", "base"], ["ours", "ours"], ["theirs", "theirs\n"]] as const) {
    const { repo } = await fixture();
    commit(repo, "last.txt", "base"); repo.createBranch("other", "HEAD", now);
    repo.switchTo("other", now); commit(repo, "last.txt", "theirs\n");
    repo.switchTo("main", now); commit(repo, "last.txt", "ours");
    record(repo, "last.txt"); assert.equal(readFileSync(join(repo.root, "last.txt"), "utf8"), "ours");
    repo.resolveConflicts("last.txt", { take }, { author, message: "select EOF state" }, now);
    assert.equal(readFileSync(join(repo.root, "last.txt"), "utf8"), expected);
  }
  const { repo } = await fixture();
  commit(repo, "last.txt", "stable\nbase\n"); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); commit(repo, "last.txt", "stable\ntheirs");
  repo.switchTo("main", now); commit(repo, "last.txt", "stable\n");
  const merged = record(repo, "last.txt").report.head; repo.resolveConflicts("last.txt", { take: "ours" }, { author, message: "retain empty side" }, now);
  assert.equal(readFileSync(join(repo.root, "last.txt"), "utf8"), "stable\n");
  repo.reset(merged, "hard", now);
  repo.resolveConflicts("last.txt", { value: "replacement\n" }, { author, message: "explicit EOF value" }, now);
  assert.equal(readFileSync(join(repo.root, "last.txt"), "utf8"), "stable\nreplacement\n");
  const blob = repo.objects.write("blob", Buffer.from("one\ntwo\n"));
  const final = repo.objects.write("conflict", encodeConflict({ kind: "text", start: 1, end: 2, base: blob, ours: blob, theirs: blob }));
  assert.equal(repo.objects.readTyped(resolvePayload(repo.objects, { id: blob, conflicts: [final] }, { value: "new" }).id, "blob").toString(), "one\nnew");
  const id = "a".repeat(64);
  for (const endings of [null, "bad", {}, { base: true, ours: false, theirs: 1 }, { base: true, ours: false, theirs: true, extra: false }]) {
    assert.throws(() => decodeConflict(Buffer.from(JSON.stringify({ kind: "text", start: 0, end: 1, base: id, ours: id, theirs: id, endings }))), /newline alternatives/);
  }
});


test("a native PM resolution refuses values its working format cannot preserve before moving HEAD", async () => {
  const { repo, client } = await fixture();
  const item = (await client.create({ type: "Task", title: "Native resolution", author: "fixture" })).item.id;
  repo.stage([]); repo.commit({ message: "native baseline", author }, now); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); await client.update(item, { body: "theirs", author: "agent-b" }); repo.stage([]); repo.commit({ message: "their body", author }, now);
  repo.switchTo("main", now); await client.update(item, { body: "ours", author: "agent-a" }); repo.stage([]); repo.commit({ message: "our body", author }, now);
  repo.merge("other", { author, message: "body conflict", recordConflicts: true }, now);
  const path = repo.status().conflicts![0].path; const head = repo.resolve("HEAD");
  assert.throws(() => repo.resolveConflicts(path, { field: "body", value: 42 }, { author, message: "invalid body" }, now), /round-trip/);
  assert.equal(repo.resolve("HEAD"), head); assert.equal((await client.get(item)).item.id, item);
  repo.resolveConflicts(path, { field: "body", value: "resolved" }, { author, message: "valid body" }, now);
  assert.equal((await client.get(item)).item.body, "resolved"); assert.deepEqual(repo.verify().corrupt, []);
});


test("repeated field contenders retain every alternative and require an explicit value for ambiguous sides", async () => {
  const { repo, path } = await divergent();
  const base = readCommit(repo.objects, repo.resolve("HEAD")).parents[0]; repo.createBranch("third", base, now);
  repo.switchTo("third", now); commit(repo, path, JSON.stringify({ status: "closed", x: 0, y: 0 })); repo.switchTo("main", now);
  record(repo, path);
  repo.createBranch("reverse", "third", now); repo.switchTo("reverse", now);
  repo.merge("main", { author, message: "inherit their units", recordConflicts: true }, now);
  assert.equal(repo.status().conflicts?.length, 2);
  repo.resolveConflicts(path, { field: "status", value: "closed" }, { author, message: "reverse explicit choice" }, now);
  repo.switchTo("main", now); repo.merge("third", { author, message: "third contender", recordConflicts: true }, now);
  const head = repo.resolve("HEAD"); assert.equal(repo.status().conflicts?.length, 2);
  assert.throws(() => repo.resolveConflicts(path, { field: "status", take: "theirs" }, { author, message: "ambiguous sides" }, now), /choose --value explicitly/);
  assert.equal(repo.resolve("HEAD"), head); assert.deepEqual(repo.verify().corrupt, []);
  repo.resolveConflicts(path, { field: "status", take: "ours" }, { author, message: "agreed ours" }, now);
  assert.equal(repo.status().conflicts, undefined);
  repo.reset(head, "hard", now); repo.resolveConflicts(path, { field: "status", value: "closed" }, { author, message: "explicit choice" }, now);
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, path), "utf8")), { status: "closed", x: 1, y: 2 });
});


test("merging a metadata-only resolution carries it through independent record edits", async () => {
  const { repo, path } = await divergent(); record(repo, path);
  repo.createBranch("resolution", "HEAD", now); repo.switchTo("resolution", now);
  repo.resolveConflicts(path, { take: "ours" }, { author, message: "choose ours" }, now);
  repo.switchTo("main", now); commit(repo, path, JSON.stringify({ status: "in_progress", x: 5, y: 2 }));
  repo.createBranch("reverse-resolution", "resolution", now); repo.switchTo("reverse-resolution", now);
  repo.merge("main", { author, message: "reverse carry", recordConflicts: true }, now); assert.equal(repo.status().conflicts, undefined);
  repo.switchTo("main", now);
  const merge = repo.merge("resolution", { author, message: "carry resolution", recordConflicts: true }, now);
  assert.equal(merge.clean, true); assert.equal(repo.status().conflicts, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, path), "utf8")), { status: "in_progress", x: 5, y: 2 });
});


test("moves and copies retain unresolved units with stable file identity and independent resolution", async () => {
  const { repo, path } = await divergent(); const { entry } = record(repo, path);
  renameSync(join(repo.root, path), join(repo.root, "moved.toon")); repo.stage([]); repo.commit({ author, message: "move unresolved record" }, now);
  const moved = repo.readIndex().find((current) => current.path === "moved.toon")!;
  assert.equal(moved.fileId, entry.fileId); assert.equal(repo.status().conflicts?.length, 1);
  copyFileSync(join(repo.root, "moved.toon"), join(repo.root, "copy.toon")); repo.stage([]); repo.commit({ author, message: "copy unresolved record" }, now);
  const copy = repo.readIndex().find((current) => current.path === "copy.toon")!;
  assert.equal(copy.copiedFrom, entry.fileId); assert.notEqual(copy.fileId, entry.fileId); assert.equal(repo.status().conflicts?.length, 2);
  repo.resolveConflicts("moved.toon", { take: "ours" }, { author, message: "resolve moved file" }, now);
  assert.equal(repo.status().conflicts?.length, 1); assert.equal(repo.status().conflicts![0].path, "copy.toon");
  const blob = repo.objects.write("blob", Buffer.from("explicit kind transition"));
  assert.throws(() => carryConflicts(repo.objects, copy.conflicts, copy.id, blob), /not a record/);
  assert.deepEqual(repo.verify().missing, []); assert.deepEqual(repo.verify().corrupt, []);
});


test("structured field selectors preserve empty names and whitespace exactly", async () => {
  const { repo } = await fixture(); const path = "names.toon";
  const names = ["", " status ", "__proto__", "constructor"];
  const values = (value: string) => JSON.stringify(Object.fromEntries(names.map((name) => [name, value])));
  commit(repo, path, values("base")); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); commit(repo, path, values("theirs"));
  repo.switchTo("main", now); commit(repo, path, values("ours")); record(repo, path);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  for (const field of names) {
    const result = await harness.runCommand({ command: "vcs resolve", args: [path], options: { field, take: "theirs" }, pmRoot: join(repo.root, ".agents/pm") });
    assert.equal(result.errorMessage, undefined);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, path), "utf8")), JSON.parse(values("theirs")));
  assert.equal(repo.status().conflicts, undefined);
});


test("existing conflict units survive idempotent merges, independent descendants and restore", async () => {
  const { repo, path } = await divergent(); const { report } = record(repo, path);
  const tree = readCommit(repo.objects, report.head).tree;
  const identical = mergeTrees({ store: repo.objects, config: repo.config, committer: author, recordConflicts: true }, null, tree, tree);
  assert.equal(identical.tree, tree); assert.equal(summarizeConflicts(repo.objects, identical.tree).length, 1);
  repo.createBranch("descendant", "HEAD", now); repo.switchTo("descendant", now);
  commit(repo, path, JSON.stringify({ status: "in_progress", x: 1, y: 7 }));
  repo.switchTo("main", now); commit(repo, path, JSON.stringify({ status: "in_progress", x: 5, y: 2 }));
  repo.merge("descendant", { author, message: "independent descendants", recordConflicts: true }, now);
  assert.equal(repo.status().conflicts?.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(repo.root, path), "utf8")), { status: "in_progress", x: 5, y: 7 });
  repo.resolveConflicts(path, { take: "ours" }, { author, message: "resolved" }, now);
  repo.restore([path], report.head); assert.equal(repo.readIndex().find((entry) => entry.path === path)!.conflicts?.length, 1);
  repo.commit({ author, message: "restore conflicted snapshot" }, now);
  assert.equal(repo.status().conflicts?.length, 1); assert.deepEqual(repo.verify().corrupt, []);
});


test("owned writer PID bytes cannot masquerade as zlib, while raw matches and foreign wrappers still refuse erasure", async () => {
  for (const [pid, selection] of [[80007123, "ordinary"], [80007123, "raw"], [80007123, "base64"], [80007, "ordinary"]] as const) {
    assert.throws(() => inspectRepresentations(Buffer.from(String(pid)), () => false), /zlib data/);
    const { repo } = await fixture();
    const secret = selection === "ordinary" ? Buffer.from("owned-pid-erasure-fixture-96273184") : Buffer.from(String(pid), selection === "raw" ? "utf8" : "base64");
    commit(repo, "secret", secret); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
    const descriptor = Object.getOwnPropertyDescriptor(process, "pid")!;
    Object.defineProperty(process, "pid", { configurable: true, value: pid });
    try {
      if (selection !== "ordinary") {
        assert.throws(() => repo.obliterate("secret", "erase-fixture", "incident", now), /Control metadata retains selected payload/);
        assert.deepEqual(readFileSync(join(repo.root, "secret")), secret); assert.equal(repo.objects.denials().length, 0);
      } else {
        repo.objects.withWriteLock(() => {
          const lock = join(repo.controlDirectory, "objects.lock"); const owner = readFileSync(lock);
          writeFileSync(lock, deflateSync(secret));
          try { assert.throws(() => repo.obliterate("secret", "erase-fixture", "incident", now), /Control metadata retains selected payload/); }
          finally { writeFileSync(lock, owner); }
        });
        writeFileSync(join(repo.controlDirectory, "dirty.json"), String(pid));
        assert.throws(() => repo.obliterate("secret", "erase-fixture", "incident", now), /zlib data/);
        rmSync(join(repo.controlDirectory, "dirty.json"));
        repo.obliterate("secret", "erase-fixture", "incident", now);
        assert.deepEqual(repo.verify().corrupt, []); assert.equal(repo.objects.denials().length, 1);
      }
    } finally { Object.defineProperty(process, "pid", descriptor); }
  }
});


test("preexisting units cannot mask an unrecorded structural disagreement on the same path", async () => {
  const { repo, path } = await divergent(); const { report } = record(repo, path);
  const base = readCommit(repo.objects, report.head).parents[0]; const baseCommit = readCommit(repo.objects, base);
  for (const kind of ["mode", "identity", "kind"] as const) {
    const files = flattenTree(repo.objects, baseCommit.tree); const entry = files.get(path)!;
    files.set(path, { ...entry, ...(kind === "mode" ? { mode: "100755" as const }
      : kind === "identity" ? { fileId: entry.fileId === "a".repeat(32) ? "b".repeat(32) : "a".repeat(32) }
      : { id: repo.objects.write("blob", Buffer.from("different payload kind")) }) });
    const commit = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [base], author, committer: author, message: kind });
    repo.createBranch(kind, commit, now);
    assert.throws(() => repo.merge(kind, { author, message: "refuse unrecorded structure", recordConflicts: true }, now), /structural conflicts/);
    assert.equal(repo.resolve("HEAD"), report.head); assert.equal(repo.readMergeState(), null); assert.equal(repo.status().conflicts?.length, 1);
  }
});
