/** Immutable attribution through ordinary PM records, branch merges, renames and bounded histories. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { encodeConflict, fieldSide, readConflict } from "../engine/conflicts.ts";
import { annotatePath, type AnnotationRow } from "../engine/annotate.ts";
import { manifestFragments } from "../engine/manifest-pages.ts";
import { Repository } from "../engine/repo.ts";
import { effectiveChangeId, encodeManifest, encodeRecord, readCommit, writeCommit, type Signature } from "../engine/model.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { type ObjectId } from "../engine/objects.ts";
import { cloneFrom } from "../engine/sync.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { installPackedExtension, pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
const now = new Date(1000);
afterEach(() => { for (const dir of owned.splice(0)) dir.cleanup(); });
/** Allocate a real filesystem repository. */
function temp() { const dir = makeTempDir(); owned.push(dir); return dir.root; }
/** Commit actual working bytes, optionally with Phase 6 item links. */
function edit(repo: Repository, path: string, text: string, identity = author, items?: readonly string[]) {
  writeFileSync(join(repo.root, path), text); repo.stage([path]);
  return repo.commit({ message: "attribution fixture", author: identity, items }, now);
}
/** Stable expected change identity. */
function change(repo: Repository, id: ObjectId) { return effectiveChangeId(id, readCommit(repo.objects, id)); }


test("text annotation follows actual setters, groups adjacent lines, handles empty files and selects immutable revisions", async () => {
  const repo = Repository.init(temp());
  const first = edit(repo, "text.txt", "one\ntwo\nthree\n");
  const next = edit(repo, "text.txt", "one\nchanged\nthree\nfour\n", { ...author, name: "agent-b" });
  const rows = annotatePath(repo.objects, next, "text.txt", true);
  assert.deepEqual(rows.map((row) => [row.start, row.changeId, row.author]), [[1, change(repo, first), "fixture"], [2, change(repo, next), "agent-b"], [3, change(repo, first), "fixture"], [4, change(repo, next), "agent-b"]]);
  assert.equal(annotatePath(repo.objects, first, "text.txt").length, 1);
  assert.equal(annotatePath(repo.objects, first, "text.txt")[0].end, 3);
  edit(repo, "empty.txt", ""); assert.deepEqual(annotatePath(repo.objects, repo.resolve("HEAD"), "empty.txt"), []);
  assert.throws(() => annotatePath(repo.objects, next, "absent"), /No file at absent/);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs annotate", args: ["./text.txt"], options: { at: first, full: true }, pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(result.errorMessage, undefined); assert.equal((result.result as { annotations: unknown[] }).annotations.length, 3);
  const current = await harness.runCommand({ command: "vcs annotate", args: ["text.txt"], pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(current.errorMessage, undefined);
  const latest = (current.result as { annotations: { text: string; changeId: string }[] }).annotations;
  assert.ok(latest.some((row) => row.text === "changed" && row.changeId === change(repo, next)));
});

test("manifest text annotation preserves setters through blob transitions renames and selected CLI revisions", async () => {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("manifestannotation", { defaults: true, author: "fixture" });
  const repo = Repository.init(root); const path = "large.txt"; const moved = "renamed.txt";
  const first = edit(repo, path, "shared\nbefore\n");
  const large = edit(repo, path, `shared\n${"x".repeat(1_048_576)}\nbefore\n`);
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "manifest");
  renameSync(join(root, path), join(root, moved));
  const changed = edit(repo, moved, `shared\n${"x".repeat(1_048_576)}\nafter\n`, { ...author, name: "editor" });
  const rows = annotatePath(repo.objects, changed, moved, true);
  assert.deepEqual(rows.map(row => row.changeId), [change(repo, first), change(repo, large), change(repo, changed)]);
  assert.deepEqual(rows.map(row => row.text), ["shared", "x".repeat(1_048_576), "after"]);
  const grouped = annotatePath(repo.objects, large, path);
  assert.deepEqual(grouped.map(row => [row.start, row.end, row.changeId]), [[1, 1, change(repo, first)], [2, 2, change(repo, large)], [3, 3, change(repo, first)]]);
  const small = edit(repo, moved, "shared\nafter\n");
  assert.equal(repo.objects.read(repo.readIndex()[0].id).type, "blob");
  assert.deepEqual(annotatePath(repo.objects, small, moved, true).map(row => row.changeId), [change(repo, first), change(repo, changed)]);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs annotate", args: [path], options: { at: large, full: true }, pmRoot: join(root, ".agents/pm") });
  assert.equal(result.errorMessage, undefined, String(result.errorMessage));
  assert.deepEqual((result.result as { annotations: AnnotationRow[] }).annotations.map(row => row.changeId), [change(repo, first), change(repo, large), change(repo, first)]);
  assert.equal(existsSync(join(root, ".git")), false);
  assert.equal(readFileSync(join(root, moved), "utf8"), "shared\nafter\n");
  const manifest = flattenTree(repo.objects, readCommit(repo.objects, large).tree).get(path)!.id;
  const fragment = [...manifestFragments(repo.objects, manifest)][0].fragment.id;
  const location = join(repo.controlDirectory, "objects", fragment.slice(0, 2), fragment.slice(2));
  const compressed = readFileSync(location);
  rmSync(location); assert.throws(() => annotatePath(repo.objects, large, path), { code: "object_not_found" });
  writeFileSync(location, "corrupt fragment"); assert.throws(() => annotatePath(repo.objects, large, path), { code: "corrupt_object" });
  writeFileSync(location, compressed);
});

test("fragmented PM history retains recorded agent provenance during annotation", async () => {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("manifesthistory", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Large immutable history", author: "fixture" })).item.id;
  await client.update(item, { description: "x".repeat(1_048_576), author: "fixture" });
  execFileSync(process.execPath, [pmExecutable, "--no-extensions", "--json", "update", item, "--description", "Captured provenance"],
    { cwd: root, env: { ...withoutPmContext(process.env), ...discardChildCoverage(), PM_AUTHOR: "fixture", CODEX_CI: "1", CODEX_MODEL: "fixture-model", PM_AGENT_MODEL: "fixture-model", PM_AGENT_PROBES: "0" } });
  const repo = Repository.init(root, "main", { recordPaths: ["**/*.toon"], recordPolicy: {} });
  repo.stage([]); const snapshot = repo.commit({ message: "fragmented tracker history", author }, now);
  const history = flattenTree(repo.objects, readCommit(repo.objects, snapshot).tree).get(`.agents/pm/history/${item}.jsonl`)!;
  assert.equal(repo.objects.read(history.id).type, "manifest");
  edit(repo, "text.txt", "first\nretained\n", author, [item]);
  const tip = edit(repo, "text.txt", "second\nretained\n", author, [item]);
  await client.update(item, { title: "Changed mutable tracker", author: "other" });
  const rows = annotatePath(repo.objects, tip, "text.txt", true);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.agentHarness === "codex" && row.agentModel === "fixture-model" && row.items.includes(item)));
  assert.equal(existsSync(join(root, ".git")), false);
  const fragment = [...manifestFragments(repo.objects, history.id)][0].fragment.id;
  const location = join(repo.controlDirectory, "objects", fragment.slice(0, 2), fragment.slice(2));
  const compressed = readFileSync(location);
  for (const fault of ["missing", "corrupt"]) {
    if (fault === "missing") rmSync(location); else writeFileSync(location, "corrupt history fragment");
    assert.ok(annotatePath(repo.objects, tip, "text.txt", true).every(row => row.agentHarness === undefined && row.agentModel === undefined));
  }
  rmSync(location); mkdirSync(location);
  assert.throws(() => annotatePath(repo.objects, tip, "text.txt"), { code: "EISDIR" });
  rmSync(location, { recursive: true }); writeFileSync(location, compressed);
});

test("structured annotation attributes scalar leaves and list entries across insertion, reorder, duplicates and punctuation", () => {
  const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
  const first = edit(repo, "item.toon", JSON.stringify({ status: "open", tags: ["a", "b", "a"], nested: { "a/b~": false }, "": null }));
  const next = edit(repo, "item.toon", JSON.stringify({ status: "done", tags: ["prefix", "a", "b", "a"], nested: { "a/b~": true }, "": null }));
  const rows = annotatePath(repo.objects, next, "item.toon");
  const byUnit = new Map(rows.map((row) => [row.unit, row]));
  assert.equal(byUnit.get("/status")!.changeId, change(repo, next));
  assert.equal(byUnit.get("/tags/0")!.changeId, change(repo, next));
  for (const key of ["/tags/1", "/tags/2", "/tags/3", "/"]) assert.equal(byUnit.get(key)!.changeId, change(repo, first));
  assert.equal(byUnit.get("/nested/a~1b~0")!.value, true);
  assert.equal(byUnit.get("/nested/a~1b~0")!.changeId, change(repo, next));
  edit(repo, "item.toon", JSON.stringify({ status: "done", tags: ["a", "a", "b"], nested: { "a/b~": true }, "": null }));
  assert.equal(annotatePath(repo.objects, repo.resolve("HEAD"), "item.toon").filter((row) => row.field === "tags").length, 3);
});

test("stable file identities retain rename, copy and rewritten-history attribution without following replacement identities", () => {
  const repo = Repository.init(temp());
  const first = edit(repo, "old.txt", "original\nretained\n");
  renameSync(join(repo.root, "old.txt"), join(repo.root, "moved.txt")); repo.stage([]); repo.commit({ message: "rename", author }, now);
  const moved = repo.resolve("HEAD");
  assert.equal(annotatePath(repo.objects, moved, "moved.txt")[0].changeId, change(repo, first));
  copyFileSync(join(repo.root, "moved.txt"), join(repo.root, "copy.txt")); repo.stage([]); repo.commit({ message: "copy", author }, now);
  const copied = edit(repo, "copy.txt", "modified\nretained\n");
  const rows = annotatePath(repo.objects, copied, "copy.txt", true);
  assert.equal(rows[0].changeId, change(repo, copied)); assert.equal(rows[1].changeId, change(repo, first));
  repo.describe(first, "rewritten message", author, now);
  assert.deepEqual(annotatePath(repo.objects, repo.resolve("HEAD"), "copy.txt", true).map((row) => row.changeId), rows.map((row) => row.changeId));
  // A new FileId at the same path must not borrow the deleted file's origin.
  const tree = flattenTree(repo.objects, readCommit(repo.objects, repo.resolve("HEAD")).tree);
  const entry = tree.get("moved.txt")!;
  tree.set("moved.txt", { ...entry, fileId: "f".repeat(32) });
  const replacement = writeCommit(repo.objects, { tree: buildTree(repo.objects, tree), parents: [repo.resolve("HEAD")], author, committer: author, message: "replacement identity" });
  assert.equal(annotatePath(repo.objects, replacement, "moved.txt")[0].changeId, replacement);
});

test("merge attribution follows the parent that supplied a unit and unresolved fields report every available side origin", () => {
  const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
  const first = edit(repo, "item.toon", '{"status":"base","left":0,"right":0}');
  repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); const theirs = edit(repo, "item.toon", '{"status":"theirs","left":0,"right":2}', { ...author, name: "agent-b" });
  repo.switchTo("main", now); const ours = edit(repo, "item.toon", '{"status":"ours","left":1,"right":0}', { ...author, name: "agent-a" });
  const merged = repo.merge("other", { message: "record conflict", author, recordConflicts: true }, now).head;
  const rows = annotatePath(repo.objects, merged, "item.toon"); const status = rows.find((row) => row.field === "status")!;
  assert.equal(rows.find((row) => row.field === "left")!.changeId, change(repo, ours));
  assert.equal(rows.find((row) => row.field === "right")!.changeId, change(repo, theirs));
  assert.deepEqual(status.alternatives!.map((side) => [side.side, side.origins.map((origin) => origin.changeId)]), [["base", [change(repo, first)]], ["ours", [change(repo, ours)]], ["theirs", [change(repo, theirs)]]]);
});

test("text conflicts preserve base, ours and theirs provenance while unrelated lines keep their setter", () => {
  const repo = Repository.init(temp()); const first = edit(repo, "text.txt", "header\nbase\ntail\n");
  repo.createBranch("other", "HEAD", now); repo.switchTo("other", now); const theirs = edit(repo, "text.txt", "header\ntheirs\ntail\n");
  repo.switchTo("main", now); const ours = edit(repo, "text.txt", "header\nours\ntail\n");
  const merged = repo.merge("other", { message: "record", author, recordConflicts: true }, now).head;
  const rows = annotatePath(repo.objects, merged, "text.txt", true);
  assert.equal(rows[0].changeId, change(repo, first)); assert.equal(rows[2].changeId, change(repo, first));
  assert.deepEqual(rows[1].alternatives!.map((side) => side.origins[0].changeId), [change(repo, first), change(repo, ours), change(repo, theirs)]);
});

test("native PM snapshots supply item links and recorded harness/model provenance without mutable tracker reads", async () => {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("attribution", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Native attribution", author: "fixture" })).item;
  const path = `.agents/pm/tasks/${item.id}.toon`;
  execFileSync(join(packageRoot, "node_modules/.bin/pm"), ["--no-extensions", "--json", "update", item.id, "--description", "Captured provenance"],
    { cwd: root, env: { ...withoutPmContext(process.env), ...discardChildCoverage(), PM_AUTHOR: "fixture", CODEX_CI: "1", CODEX_MODEL: "fixture-model", PM_AGENT_MODEL: "fixture-model", PM_AGENT_PROBES: "0" } });
  const repo = Repository.init(root, "main", { recordPaths: ["**/*.toon"], recordPolicy: {} });
  repo.stage([]); const snapshot = repo.commit({ message: "native item", author, items: [item.id] }, now);
  const before = readFileSync(join(root, path), "utf8");
  const rows = annotatePath(repo.objects, snapshot, path);
  for (const row of rows) { assert.equal(row.items[0], item.id); assert.equal(row.agentHarness, "codex"); assert.equal(row.agentModel, "fixture-model"); }
  await client.update(item.id, { title: "Today's different title", author: "other-agent" });
  assert.equal(annotatePath(repo.objects, snapshot, path).find((row) => row.field === "title")!.value, "Native attribution");
  assert.notEqual(readFileSync(join(root, path), "utf8"), before);
});

test("2000-change history reads selected ancestry metadata once and never reads unrelated payloads or refs", () => {
  const repo = Repository.init(temp());
  const first = edit(repo, "selected.txt", "one\ntwo\n");
  const selected = flattenTree(repo.objects, readCommit(repo.objects, first).tree).get("selected.txt")!;
  let tip = first; const unrelatedPayloads = new Set<ObjectId>(); const ancestors = new Set<ObjectId>([first]);
  for (let index = 1; index < 2000; index++) {
    const payload = repo.objects.write("blob", Buffer.from(`unrelated ${index}`)); unrelatedPayloads.add(payload);
    const tree = buildTree(repo.objects, new Map([["selected.txt", selected], ["unrelated.txt", { id: payload, mode: "100644", fileId: "e".repeat(32) }]]));
    tip = writeCommit(repo.objects, { tree, parents: [tip], author, committer: author, message: `unrelated ${index}` }); ancestors.add(tip);
  }
  const other = writeCommit(repo.objects, { tree: readCommit(repo.objects, first).tree, parents: [], author, committer: author, message: "unrelated ref" });
  repo.refs.compareAndSwap("refs/heads/unrelated", null, other);
  const expectedChange = change(repo, first);
  const reads = new Map<ObjectId, number>(); const original = repo.objects.read.bind(repo.objects);
  repo.objects.read = (id) => { reads.set(id, (reads.get(id) ?? 0) + 1); return original(id); };
  const rows = annotatePath(repo.objects, tip, "selected.txt");
  assert.equal(rows.length, 1); assert.equal(rows[0].changeId, expectedChange);
  assert.equal(reads.has(other), false); for (const id of unrelatedPayloads) assert.equal(reads.has(id), false);
  assert.equal([...ancestors].reduce((sum, id) => sum + (reads.get(id) ?? 0), 0), 2000);
  assert.ok([...reads.values()].every((count) => count === 1));
  assert.ok(reads.size <= 4001, `metadata and one file payload only: ${reads.size}`);
  // A late file's unavailable alternatives must not walk history before its birth.
  repo.objects.read = original;
  const fileId = "c".repeat(32);
  const unit = repo.objects.write("conflict", encodeConflict({ kind: "field", field: "status",
    base: fieldSide(repo.objects, "base", fileId), ours: fieldSide(repo.objects, "ours", fileId), theirs: fieldSide(repo.objects, "theirs", fileId) }), fileId);
  const files = flattenTree(repo.objects, readCommit(repo.objects, tip).tree);
  files.set("late.toon", { id: repo.objects.write("record", encodeRecord({ status: "ours" }), fileId), mode: "100644", fileId, conflicts: [unit] });
  const birth = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [tip], author, committer: author, message: "late conflicted file" });
  reads.clear(); repo.objects.read = (id) => { reads.set(id, (reads.get(id) ?? 0) + 1); return original(id); };
  const late = annotatePath(repo.objects, birth, "late.toon");
  assert.ok(late[0].alternatives!.every((side) => side.unavailable === true));
  assert.ok(reads.size <= 10, `only file birth and immediate parent metadata: ${reads.size}`);
  for (const id of ancestors) if (id !== tip) assert.equal(reads.has(id), false);

});

test("shallow annotations state their boundary and unresolved alternatives remain explicitly unavailable", async () => {
  const repo = Repository.init(temp()); edit(repo, "text.txt", "base\n");
  repo.createBranch("other", "HEAD", now); repo.switchTo("other", now); edit(repo, "text.txt", "theirs\n");
  repo.switchTo("main", now); edit(repo, "text.txt", "ours\n");
  repo.merge("other", { message: "conflict", author, recordConflicts: true }, now);
  const clone = join(temp(), "clone"); await cloneFrom(repo.root, clone, now, "origin", repo.root, undefined, { depth: 1 });
  const shallow = Repository.open(clone); const rows = annotatePath(shallow.objects, shallow.resolve("HEAD"), "text.txt");
  assert.equal(rows[0].boundary, true);
  assert.ok(rows[0].alternatives!.every((alternative) => alternative.unavailable === true && alternative.origins.length === 0));
  assert.deepEqual(shallow.verify().missing, []);
});

test("directory path components and absent identities do not become file attribution", () => {
  const root = temp(); const repo = Repository.init(root);
  mkdirSync(join(root, "nested"));
  edit(repo, "nested/file.txt", "nested\n");
  assert.equal(annotatePath(repo.objects, repo.resolve("HEAD"), "nested/file.txt")[0].text, "nested");
  assert.throws(() => annotatePath(repo.objects, repo.resolve("HEAD"), "nested"), /No file/);
  assert.throws(() => annotatePath(repo.objects, repo.resolve("HEAD"), "nested/file.txt/missing"), /No file/);
});

test("packed host emits grouped TOON and full JSON annotation at a selected change", async () => {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("annotationcli", { defaults: true, author: "fixture" });
  await installPackedExtension(root);
  const repo = Repository.init(root); const first = edit(repo, "text.txt", "one\ntwo\nthree\n");
  edit(repo, "text.txt", "one\nchanged\nthree\n");
  const pm = (args: string[]) => execFileSync(process.execPath, [pmExecutable, ...args], { cwd: root, env: { ...withoutPmContext(process.env), ...discardChildCoverage() }, encoding: "utf8" });
  const toon = pm(["vcs", "annotate", "text.txt", "--at", first]);
  assert.match(toon, /annotations\[1\]/); assert.match(toon, /one/);
  const full = JSON.parse(pm(["--json", "vcs", "annotate", "text.txt", "--at", first, "--full"]));
  assert.equal(full.annotations.length, 3); assert.ok(full.annotations.every((row: { changeId: string }) => row.changeId === change(repo, first)));
});

test("--at accepts stable change identities and ambiguous rewritten versions require an explicit ref", async () => {
  const repo = Repository.init(temp()); const first = edit(repo, "text.txt", "first\n");
  const stable = change(repo, first);
  assert.equal(repo.resolve(stable), first);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs annotate", args: ["text.txt"], options: { at: stable }, pmRoot: join(repo.root, ".agents/pm") });
  assert.equal(result.errorMessage, undefined);
  repo.refs.setHeadDetached(first); repo.refs.compareAndSwap("refs/heads/main", first, null);
  assert.equal(repo.resolve(stable), first);
  repo.refs.setHeadToRef("refs/heads/main"); repo.refs.compareAndSwap("refs/heads/main", null, first);
  const rewritten = writeCommit(repo.objects, { ...readCommit(repo.objects, first), message: "another version" });
  repo.refs.compareAndSwap("refs/heads/other", null, rewritten);
  assert.throws(() => repo.resolve(stable), /several reachable versions/);
  assert.throws(() => repo.resolve("f".repeat(64)), /not a known/);
  const unborn = Repository.init(temp()); assert.throws(() => unborn.resolve(stable), /not a known/);
});

test("absent fields and empty disputed text ranges still report their alternatives", () => {
  for (const structured of [false, true]) {
    const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
    const path = structured ? "item.toon" : "text.txt";
    edit(repo, path, structured ? '{"status":"base"}' : "base\n");
    repo.createBranch("other", "HEAD", now); repo.switchTo("other", now); edit(repo, path, structured ? '{"status":"theirs"}' : "theirs\n");
    repo.switchTo("main", now); edit(repo, path, structured ? '{}' : "");
    const merged = repo.merge("other", { message: "record absence", author, recordConflicts: true }, now).head;
    const rows = annotatePath(repo.objects, merged, path);
    assert.equal(rows.length, 1); assert.equal(rows[0].alternatives!.length, 3);
    assert.ok(rows[0].alternatives!.some((side) => side.unavailable === true));
  }
});

test("nested renames traverse identity metadata and empty manifest annotations stay empty", () => {
  const repo = Repository.init(temp()); mkdirSync(join(repo.root, "nested"));
  const first = edit(repo, "nested/old.txt", "retained\n");
  renameSync(join(repo.root, "nested/old.txt"), join(repo.root, "moved.txt")); repo.stage([]); repo.commit({ message: "move out of directory", author }, now);
  assert.equal(annotatePath(repo.objects, repo.resolve("HEAD"), "moved.txt")[0].changeId, change(repo, first));
  const payload = repo.objects.write("manifest", encodeManifest({ mode: "fixed", totalLength: 0, fragments: [] }));
  const tree = buildTree(repo.objects, new Map([["large.bin", { id: payload, mode: "100644", fileId: "a".repeat(32) }]]));
  const commit = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "fragmented file" });
  assert.deepEqual(annotatePath(repo.objects, commit, "large.bin"), []);
});

test("empty conflict alternatives exhaust shared ancestry without attributing missing history", () => {
  const repo = Repository.init(temp()); edit(repo, "unrelated.txt", "earlier\n"); edit(repo, "text.txt", "");
  repo.createBranch("other", "HEAD", now); repo.switchTo("other", now); edit(repo, "text.txt", "theirs\n");
  repo.switchTo("main", now); edit(repo, "text.txt", "ours\n");
  const merged = repo.merge("other", { message: "empty base conflict", author, recordConflicts: true }, now).head;
  const row = annotatePath(repo.objects, merged, "text.txt")[0];
  assert.equal(row.alternatives![0].unavailable, true); assert.equal(row.alternatives![1].origins.length, 1);
});

test("PM provenance stays absent without a matching recorded event, and unsafe item links cannot open paths", async () => {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("unrecorded", { defaults: true, author: "fixture" });
  const first = (await client.create({ type: "Task", title: "One item", author: "different-author" })).item;
  const second = (await client.create({ type: "Task", title: "Another item", author: "different-author" })).item;
  const env = { PATH: process.env.PATH, HOME: root, PM_AUTHOR: "fixture", PM_AGENT_PROBES: "0" };
  for (const item of [first, second]) execFileSync(process.execPath, [pmExecutable, "--no-extensions", "update", item.id, "--description", "no inferred provenance"], { cwd: root, env });
  const repo = Repository.init(root, "main", { recordPaths: ["**/*.toon"], recordPolicy: {} }); repo.stage([]); repo.commit({ message: "tracker", author }, now);
  const plain = edit(repo, "text.txt", "plain\n", author, ["../unsafe", "missing-item", first.id, second.id]);
  const row = annotatePath(repo.objects, plain, "text.txt")[0];
  assert.equal(row.agentHarness, undefined); assert.equal(row.agentModel, undefined);
  assert.ok(row.items.includes(first.id)); assert.ok(row.items.includes("missing-item"));
  execFileSync(process.execPath, [pmExecutable, "--no-extensions", "update", second.id, "--description", "harness without model"], { cwd: root, env: { ...env, CODEX_CI: "1" } });
  repo.stage([]); const harnessOnly = repo.commit({ message: "recorded harness", author, items: [second.id] }, now);
  const rows = annotatePath(repo.objects, harnessOnly, `.agents/pm/tasks/${second.id}.toon`);
  const description = rows.find((row) => row.field === "description")!;
  assert.equal(description.agentHarness, "codex"); assert.equal(description.agentModel, undefined);
});

test("repeated field contenders retain all alternative origin groups on the one field row", () => {
  const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
  edit(repo, "item.toon", '{"status":"base"}');
  repo.createBranch("other", "HEAD", now); repo.createBranch("third", "HEAD", now);
  repo.switchTo("other", now); edit(repo, "item.toon", '{"status":"theirs"}');
  repo.switchTo("third", now); const third = edit(repo, "item.toon", '{"status":"third"}');
  repo.switchTo("main", now); edit(repo, "item.toon", '{"status":"ours"}');
  repo.merge("other", { message: "first dispute", author, recordConflicts: true }, now);
  const merged = repo.merge("third", { message: "another dispute", author, recordConflicts: true }, now).head;
  const row = annotatePath(repo.objects, merged, "item.toon")[0];
  assert.equal(row.alternatives!.length, 6); assert.equal(new Set(row.alternatives!.map((side) => side.conflict)).size, 2);
  assert.ok(row.alternatives!.some((side) => side.origins.some((origin) => origin.changeId === change(repo, third))));
});

test("copied disputes keep source origins while unattached alternative ancestry is explicitly unavailable", () => {
  const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
  edit(repo, "item.toon", '{"status":"base"}'); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); edit(repo, "item.toon", '{"status":"theirs"}');
  repo.switchTo("main", now); edit(repo, "item.toon", '{"status":"ours"}');
  const merged = repo.merge("other", { message: "recorded", author, recordConflicts: true }, now).head;
  copyFileSync(join(repo.root, "item.toon"), join(repo.root, "copy.toon")); repo.stage([]); repo.commit({ message: "copy dispute", author }, now);
  const rows = annotatePath(repo.objects, repo.resolve("HEAD"), "copy.toon");
  assert.ok(rows[0].alternatives!.every((side) => side.origins.length === 1));
  // Distinct payloads make the immediate copy source unambiguous to Phase 6 staging.
  edit(repo, "copy.toon", JSON.stringify({ status: "ours", independent: 1 }));
  copyFileSync(join(repo.root, "copy.toon"), join(repo.root, "second-copy.toon")); repo.stage([]); repo.commit({ message: "copy a copy", author }, now);
  assert.ok(annotatePath(repo.objects, repo.resolve("HEAD"), "second-copy.toon").find((row) => row.field === "status")!.alternatives!.every((side) => side.origins.length === 1));
  const files = flattenTree(repo.objects, readCommit(repo.objects, merged).tree);
  const original = files.get("item.toon")!;
  const existing = readConflict(repo.objects, original.conflicts![0]);
  const proposedUnit = repo.objects.write("conflict", encodeConflict({ ...existing, theirs: fieldSide(repo.objects, "proposal only", original.fileId) }), original.fileId);
  const proposalFiles = new Map(files); proposalFiles.set("item.toon", { ...original, conflicts: [proposedUnit] });
  const proposal = writeCommit(repo.objects, { tree: buildTree(repo.objects, proposalFiles), parents: [merged], author, committer: author, message: "proposal without side ancestry" });
  const proposedRow = annotatePath(repo.objects, proposal, "item.toon")[0];
  assert.equal(proposedRow.alternatives!.find((side) => side.side === "theirs")!.unavailable, true);
  files.set("unattached.toon", { ...original, fileId: "d".repeat(32) });
  const unattached = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [merged], author, committer: author, message: "alternative data without origin ancestry" });
  assert.ok(annotatePath(repo.objects, unattached, "unattached.toon")[0].alternatives!.every((side) => side.unavailable === true));
});

test("multiple setters sharing PM history decode the immutable event payload once", async () => {
  const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
  await client.init("historycache", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Shared provenance", author: "fixture" })).item;
  const repo = Repository.init(root); repo.stage([]); repo.commit({ message: "tracker", author }, now);
  edit(repo, "text.txt", "first\nretained\n", author, [item.id]);
  const tip = edit(repo, "text.txt", "second\nretained\n", author, [item.id]);
  const history = flattenTree(repo.objects, readCommit(repo.objects, tip).tree).get(`.agents/pm/history/${item.id}.jsonl`)!.id;
  let count = 0; const original = repo.objects.read.bind(repo.objects);
  repo.objects.read = (id) => { if (id === history) count++; return original(id); };
  const rows = annotatePath(repo.objects, tip, "text.txt", true);
  assert.equal(rows.length, 2); assert.equal(count, 1); assert.ok(rows.every((row) => row.items.includes(item.id)));
});

test("text alternative origins follow their disputed hunk instead of an unrelated identical occurrence", () => {
  for (const repeated of [false, true]) {
    const repo = Repository.init(temp()); const path = "text.txt";
    const text = (value: string) => `${repeated ? "theirs" : "header"}\nseparator\n${value}\ntail\n`;
    edit(repo, path, text("base"), { ...author, name: "initial" }); repo.createBranch("other", "HEAD", now);
    repo.switchTo("other", now); const theirs = edit(repo, path, text("theirs"), { ...author, name: "theirs-editor" });
    repo.switchTo("main", now); edit(repo, path, text("ours"), { ...author, name: "ours-editor" });
    const merged = repo.merge("other", { message: "repeated text dispute", author, recordConflicts: true }, now).head;
    const side = annotatePath(repo.objects, merged, path, true)[2].alternatives!.find((side) => side.side === "theirs")!;
    assert.deepEqual(side.origins.map((origin) => [origin.changeId, origin.author]), [[change(repo, theirs), "theirs-editor"]]);
  }
});

test("repeated multi-line alternatives keep separate setters through inserted and deleted prefixes", () => {
  for (const shift of ["", "inserted\n", "delete"]) {
    const repo = Repository.init(temp()); const path = "text.txt";
    const document = (left: string, right: string) => `header\n${left}\nanchor-a\nanchor-b\n${right}\ntail\n`;
    edit(repo, path, document("base-a", "base-b")); repo.createBranch("other", "HEAD", now);
    repo.switchTo("other", now);
    const first = edit(repo, path, document("repeated\nblock", "base-b"), { ...author, name: "first-setter" });
    const second = edit(repo, path, document("repeated\nblock", "repeated\nblock"), { ...author, name: "second-setter" });
    repo.switchTo("main", now); edit(repo, path, document("ours-a", "ours-b"));
    repo.merge("other", { message: "two disputes", author, recordConflicts: true }, now);
    const projection = document("ours-a", "ours-b");
    const tip = shift === "" ? repo.resolve("HEAD") : edit(repo, path,
      shift === "delete" ? projection.slice("header\n".length) : shift + projection);
    const disputed = annotatePath(repo.objects, tip, path, true).filter((row) => row.alternatives !== undefined);
    assert.equal(disputed.length, 2);
    assert.deepEqual(disputed.map((row) => row.alternatives!.find((side) => side.side === "theirs")!.origins.map((origin) => [origin.changeId, origin.author])),
      [[[change(repo, first), "first-setter"]], [[change(repo, second), "second-setter"]]]);
    assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("unattached text alternatives stay unavailable and copied hunk ancestry keeps its own position", () => {
  const repo = Repository.init(temp()); const path = "text.txt";
  const first = edit(repo, path, "theirs\nseparator\nbase\ntail\n"); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); const theirs = edit(repo, path, "theirs\nseparator\ntheirs\ntail\n");
  repo.switchTo("main", now); edit(repo, path, "theirs\nseparator\nours\ntail\n");
  const merged = repo.merge("other", { message: "dispute", author, recordConflicts: true }, now).head;
  renameSync(join(repo.root, path), join(repo.root, "moved.txt")); repo.stage([]); repo.commit({ message: "rename disputed file", author }, now);
  copyFileSync(join(repo.root, "moved.txt"), join(repo.root, "copy.txt")); repo.stage([]); const copied = repo.commit({ message: "copy disputed file", author }, now);
  const side = annotatePath(repo.objects, copied, "copy.txt", true)[2].alternatives!.find((side) => side.side === "theirs")!;
  assert.deepEqual(side.origins.map((origin) => origin.changeId), [change(repo, theirs)]);
  const files = flattenTree(repo.objects, readCommit(repo.objects, merged).tree); const entry = files.get(path)!;
  const unit = readConflict(repo.objects, entry.conflicts![0]);
  const replacement = repo.objects.write("conflict", encodeConflict({ ...unit, theirs: repo.objects.write("blob", Buffer.from("separator")) }));
  files.set(path, { ...entry, conflicts: [replacement] });
  const proposal = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [merged], author, committer: author, message: "unattached text alternative" });
  const unavailable = annotatePath(repo.objects, proposal, path, true)[2].alternatives!.find((side) => side.side === "theirs")!;
  assert.equal(unavailable.unavailable, true); assert.deepEqual(unavailable.origins, []);
  assert.notEqual(change(repo, first), change(repo, theirs));
});


test("supported annotations stop at unsupported ancestry while selected kinds and historical corruption still refuse", () => {
  for (const record of [false, true]) {
    const repo = Repository.init(temp()); const path = record ? "item.toon" : "text.txt"; const fileId = "a".repeat(32);
    const unsupported = buildTree(repo.objects, new Map());
    const old = writeCommit(repo.objects, { tree: buildTree(repo.objects, new Map([[path, { id: unsupported, fileId, mode: "100644" }]])),
      parents: [], author, committer: author, message: "structural predecessor" });
    const side = (value: string) => record ? fieldSide(repo.objects, value) : repo.objects.write("blob", Buffer.from(value));
    const sides = { base: side("base"), ours: side("ours"), theirs: side("theirs") };
    const dispute = repo.objects.write("conflict", encodeConflict(record ? { kind: "field", field: "status", ...sides }
      : { kind: "text", start: 0, end: 1, ...sides }));
    const payload = record ? repo.objects.write("record", encodeRecord({ status: "ours" })) : repo.objects.write("blob", Buffer.from("ours\n"));
    const tip = writeCommit(repo.objects, { tree: buildTree(repo.objects, new Map([[path, { id: payload, fileId, mode: "100644", conflicts: [dispute] }]])),
      parents: [old], author, committer: author, message: "supported successor" });
    let reads = 0; const read = repo.objects.read.bind(repo.objects);
    repo.objects.read = (id) => { if (id === unsupported) reads++; return read(id); };
    const rows = annotatePath(repo.objects, tip, path);
    assert.equal(rows[0].changeId, tip); assert.ok(rows[0].alternatives!.every((side) => side.unavailable === true));
    assert.equal(reads, 1); repo.objects.read = read;
    assert.throws(() => annotatePath(repo.objects, old, path), { code: "unsupported_annotation" });
    const location = join(repo.controlDirectory, "objects", unsupported.slice(0, 2), unsupported.slice(2));
    writeFileSync(location, "corrupt compressed ancestor");
    assert.throws(() => annotatePath(repo.objects, tip, path), { code: "corrupt_object" });
    rmSync(location); mkdirSync(location);
    assert.throws(() => annotatePath(repo.objects, tip, path), { code: "EISDIR" });
  }
});

test("unavailable optional PM history omits agent metadata and caches failure without masking unrelated I/O", async () => {
  for (const kind of ["wrong-kind", "malformed", "missing", "obliterated", "corrupt", "directory"]) {
    const root = temp(); const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true });
    await client.init("optionalhistory", { defaults: true, author: "fixture" });
    const item = (await client.create({ type: "Task", title: "Optional provenance", author: "fixture" })).item.id;
    const repo = Repository.init(root); repo.stage([]); const base = repo.commit({ message: "tracker", author }, now);
    const files = flattenTree(repo.objects, readCommit(repo.objects, base).tree); const path = `.agents/pm/history/${item}.jsonl`;
    const history = files.get(path)!;
    const id = kind === "wrong-kind" ? repo.objects.write("record", encodeRecord({ author: "fixture" }))
      : kind === "malformed" ? repo.objects.write("blob", Buffer.from("invalid JSON record\n")) : history.id;
    files.set(path, { ...history, id });
    const fileId = "d".repeat(32);
    files.set("text.txt", { fileId, mode: "100644", id: repo.objects.write("blob", Buffer.from("first\nretained\n")) });
    const first = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [base], author, committer: author, items: [item], message: "first setter" });
    files.set("text.txt", { fileId, mode: "100644", id: repo.objects.write("blob", Buffer.from("second\nretained\n")) });
    const tip = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [first], author, committer: author, items: [item], message: "second setter" });
    const location = join(repo.controlDirectory, "objects", id.slice(0, 2), id.slice(2));
    if (kind === "missing" || kind === "directory") { rmSync(location); if (kind === "directory") mkdirSync(location); }
    if (kind === "corrupt") writeFileSync(location, "corrupt optional history");
    if (kind === "obliterated") { repo.setAuthority("fixture", "read-fixture", "erase-fixture"); repo.identity(); repo.obliterate(history.fileId!, "erase-fixture", "fixture", now); }
    if (kind === "directory") { assert.throws(() => annotatePath(repo.objects, tip, "text.txt", true), { code: "EISDIR" }); continue; }
    let reads = 0; const read = repo.objects.read.bind(repo.objects);
    repo.objects.read = (address) => { if (address === id) reads++; return read(address); };
    const rows = annotatePath(repo.objects, tip, "text.txt", true);
    assert.deepEqual(rows.map((row) => row.changeId), [tip, first]);
    assert.ok(rows.every((row) => row.agentHarness === undefined && row.agentModel === undefined && row.items.includes(item)));
    assert.equal(reads, 1);
  }
});
