/** Conflict resolution replays real descendant histories without changing their identities. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { decodeRecord, effectiveChangeId, readCommit, writeCommit } from "../engine/model.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { readConflict, summarizeConflicts } from "../engine/conflicts.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { withoutPmContext } from "../scripts/pm-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const author = { name: "agent-c", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date(1000);
afterEach(() => { for (const dir of owned.splice(0)) dir.cleanup(); });
/** Allocate an independently owned fixture. */
function temp() { const dir = makeTempDir(); owned.push(dir); return dir.root; }
/** Commit actual working bytes. */
function edit(repo: Repository, path: string, text: string, identity = author) {
  writeFileSync(join(repo.root, path), text); repo.stage([path]); return repo.commit({ message: "descendant", author: identity }, now);
}
/** Produce a recorded disagreement through ordinary edits. */
function conflict(text = false, occupied = false) {
  const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
  if (occupied) edit(repo, "destination.toon", JSON.stringify({ status: "other identity" }));
  const path = text ? "text.txt" : "item.toon";
  const value = (side: string) => text ? `header\n${side}\ntail\n` : JSON.stringify({ independent: 0, status: side });
  edit(repo, path, value("base")); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); edit(repo, path, value("theirs"));
  repo.switchTo("main", now); edit(repo, path, value("ours"));
  const merged = repo.merge("other", { message: "disagreement", author, recordConflicts: true }, now).head;
  return { repo, path, merged, value };
}
/** Read a structured unit from an immutable snapshot. */
function statusAt(repo: Repository, revision: string, path: string) {
  const commit = readCommit(repo.objects, repo.resolve(revision));
  return decodeRecord(repo.objects.readTyped(flattenTree(repo.objects, commit.tree).get(path)!.id, "record")).status;
}

test("ancestor resolution carries through sibling branches, tags and detached HEAD in one undoable operation", () => {
  for (const detached of [false, true]) {
    const { repo, path, merged } = conflict();
    repo.createBranch("sibling", "HEAD", now);
    const first = edit(repo, "a.txt", "a"); const second = edit(repo, "b.txt", "b");
    repo.refs.compareAndSwap("refs/tags/review", null, repo.resolve("HEAD")); repo.switchTo("sibling", now);
    const sibling = edit(repo, "c.txt", "c");
    if (detached) repo.switchTo(sibling, now);
    const before = repo.operations.read().length;
    const oldIds = [first, second, sibling].map((id) => effectiveChangeId(id, readCommit(repo.objects, id)));
    repo.resolveConflicts(path, { field: "status", take: "theirs" }, { message: "resolution", author }, now, merged);
    assert.equal(repo.operations.read().length, before + 1);
    for (const ref of ["main", "sibling", "review", "HEAD"]) {
      assert.equal(statusAt(repo, ref, path), "theirs");
      assert.equal(summarizeConflicts(repo.objects, readCommit(repo.objects, repo.resolve(ref)).tree).length, 0);
    }
    for (const id of oldIds) assert.ok(repo.log("HEAD").concat(repo.log("main")).some((row) => row.changeId === id));
    assert.deepEqual(repo.verify().corrupt, []); assert.deepEqual(repo.verify().missing, []);
    repo.undo(null, now); assert.equal(repo.resolve("main"), second); assert.equal(repo.resolve("sibling"), sibling);
    assert.equal(repo.resolve("review"), second); assert.equal(statusAt(repo, "HEAD", path), "ours");
  }
});

test("descendant field and text edits retain their own projection as a new recorded conflict", () => {
  for (const text of [false, true]) {
    const { repo, path, merged, value } = conflict(text);
    const descendant = edit(repo, path, value("descendant"));
    repo.resolveConflicts(path, { take: "theirs" }, { message: "resolution", author }, now, merged);
    assert.equal(readFileSync(join(repo.root, path), "utf8"), value("descendant"));
    assert.equal(repo.status().conflicts?.length, 1);
    const unit = readConflict(repo.objects, repo.status().conflicts![0].conflict);
    assert.equal(text ? repo.objects.readTyped(unit.base, "blob").toString() : decodeRecord(repo.objects.readTyped(unit.base, "record")).value, "ours");
    assert.equal(text ? repo.objects.readTyped(unit.ours, "blob").toString() : decodeRecord(repo.objects.readTyped(unit.ours, "record")).value, "descendant");
    assert.equal(effectiveChangeId(repo.resolve("HEAD"), readCommit(repo.objects, repo.resolve("HEAD"))),
      effectiveChangeId(descendant, readCommit(repo.objects, descendant)));
    repo.resolveConflicts(path, { take: "theirs" }, { message: "accept propagation", author }, now);
    assert.equal(readFileSync(join(repo.root, path), "utf8"), value("theirs"));
    assert.equal(repo.status().conflicts, undefined); assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("concurrent resolutions in independent worktrees preserve a disagreement even when one takes ours", () => {
  const { repo, path } = conflict(); const root = temp();
  repo.linkInstance("resolver-a", join(root, "a")); repo.linkInstance("resolver-b", join(root, "b"));
  const a = Repository.open(join(root, "a")); const b = Repository.open(join(root, "b"));
  a.resolveConflicts(path, { take: "ours" }, { message: "a resolves", author }, now);
  b.resolveConflicts(path, { take: "theirs" }, { message: "b resolves", author }, now);
  a.merge("resolver-b", { message: "resolution disagreement", author, recordConflicts: true }, now);
  assert.equal(statusAt(a, "HEAD", path), "ours"); assert.equal(a.status().conflicts?.length, 1);
  a.resolveConflicts(path, { take: "theirs" }, { message: "reconcile", author }, now);
  assert.equal(statusAt(a, "HEAD", path), "theirs"); assert.deepEqual(a.verify().corrupt, []);
});

test("real three-author tracker: two descendants per agent inherit a third author's resolution and pm get reads every item", async () => {
  const root = temp(); const hub = join(root, "hub"); mkdirSync(hub);
  const client = new PmClient({ cwd: hub, pmRoot: join(hub, ".agents/pm"), noExtensions: true });
  await client.init("proof", { defaults: true, author: "agent-c" });
  const item = (await client.create({ type: "Task", title: "Shared status", author: "agent-c" })).item.id;
  const repo = Repository.init(hub, "main", { recordPaths: ["**/*.toon"], recordPolicy: { fields: { updated_at: "timestamp" } } });
  repo.stage([]); repo.commit({ message: "baseline", author }, now);
  repo.linkInstance("agent-a", join(root, "a")); repo.linkInstance("agent-b", join(root, "b"));
  const a = Repository.open(join(root, "a")); const b = Repository.open(join(root, "b"));
  const pm = (repository: Repository, identity: string, args: string[]) => JSON.parse(execFileSync(join(packageRoot, "node_modules/.bin/pm"), ["--no-extensions", "--json", ...args],
    { cwd: repository.root, env: { ...withoutPmContext(process.env), ...discardChildCoverage(), PM_AUTHOR: identity }, encoding: "utf8" }));
  pm(a, "agent-a", ["update", item, "--status", "in_progress"]); a.stage([]); a.commit({ message: "a diverges", author: { ...author, name: "agent-a" } }, now);
  pm(b, "agent-b", ["update", item, "--status", "blocked", "--blocked-reason", "review"]); b.stage([]); b.commit({ message: "b diverges", author: { ...author, name: "agent-b" } }, now);
  const merged = a.merge("agent-b", { message: "record status disagreement", author, recordConflicts: true }, now).head;
  const path = a.status().conflicts![0].path;
  b.merge("agent-a", { message: "receive disagreement", author, recordConflicts: true }, now);
  const descendants = [edit(a, "a1.txt", "a1", { ...author, name: "agent-a" }), edit(a, "a2.txt", "a2", { ...author, name: "agent-a" }), edit(b, "b1.txt", "b1", { ...author, name: "agent-b" }), edit(b, "b2.txt", "b2", { ...author, name: "agent-b" })];
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const result = await harness.runCommand({ command: "vcs resolve", args: [path], options: { at: merged, field: "status", take: "theirs" }, global: { author: "agent-c" }, pmRoot: join(a.root, ".agents/pm") });
  assert.equal(result.errorMessage, undefined); assert.equal((result.result as { resolved: unknown[] }).resolved.length, 1);
  for (const old of descendants) {
    const change = effectiveChangeId(old, readCommit(a.objects, old));
    const updated = a.log("agent-a").concat(a.log("agent-b")).find((row) => row.changeId === change)!;
    assert.ok(updated); assert.equal(statusAt(a, updated.id, path), "blocked");
    assert.equal(summarizeConflicts(a.objects, readCommit(a.objects, updated.id).tree).length, 0);
  }
  // Reopen and switch each instance so its checkout follows the rewritten ref.
  b.switchTo("agent-b", now);
  for (const repository of [a, b]) {
    const listed = pm(repository, "agent-c", ["list", "--status", "all"]);
    for (const row of listed.items) assert.equal(pm(repository, "agent-c", ["get", row.id]).item.id, row.id);
    assert.equal(pm(repository, "agent-c", ["get", item]).item.status, "blocked");
    assert.deepEqual(repository.verify().missing, []); assert.deepEqual(repository.verify().corrupt, []);
  }
});

test("concurrent text resolutions preserve independent lines and agreement stays clean", () => {
  for (const agree of [false, true]) {
    const { repo, path } = conflict(true);
    repo.createBranch("resolution-b", "HEAD", now);
    repo.resolveConflicts(path, { take: "ours" }, { message: "a resolves", author }, now);
    const left = repo.resolve("HEAD");
    repo.switchTo("resolution-b", now);
    repo.resolveConflicts(path, { take: agree ? "ours" : "theirs" }, { message: "b resolves", author }, now);
    edit(repo, "independent.txt", "retained");
    repo.switchTo("main", now);
    repo.merge("resolution-b", { message: "reconcile resolutions", author, recordConflicts: true }, now);
    assert.equal(readFileSync(join(repo.root, path), "utf8"), "header\nours\ntail\n");
    assert.equal(readFileSync(join(repo.root, "independent.txt"), "utf8"), "retained");
    assert.equal(repo.status().conflicts?.length ?? 0, agree ? 0 : 1);
    if (!agree) {
      repo.resolveConflicts(path, { take: "theirs" }, { message: "choose b", author }, now);
      assert.equal(readFileSync(join(repo.root, path), "utf8"), "header\ntheirs\ntail\n");
    }
    assert.ok(repo.objects.has(left)); assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("unit-specific refusals name the path and field and preserve published state", () => {
  const { repo, path, merged } = conflict();
  for (const field of ["absent", "status"]) {
    if (field === "status") repo.resolveConflicts(path, { field, take: "ours" }, { message: "resolved", author }, now);
    const before = { refs: repo.refs.list("refs"), operations: repo.operations.read(), index: readFileSync(join(repo.controlDirectory, "index")) };
    assert.throws(() => repo.resolveConflicts(path, { field, take: "ours" }, { message: "invalid", author }, now),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "no_matching_conflict" && error.message.includes(`${path}:${field}`));
    assert.deepEqual({ refs: repo.refs.list("refs"), operations: repo.operations.read(), index: readFileSync(join(repo.controlDirectory, "index")) }, before);
  }
  assert.throws(() => repo.resolveConflicts("unknown", { field: "status", take: "base" }, { message: "invalid", author }, now, merged), /unknown:status/);
});

test("multi-parent descendants receive non-first-parent propagation and structural replay refuses atomically", () => {
  const { repo, path, merged } = conflict();
  repo.createBranch("side", "HEAD", now);
  const first = edit(repo, "a.txt", "a");
  repo.switchTo("side", now); edit(repo, "b.txt", "b");
  repo.merge("main", { message: "join descendants", author, recordConflicts: true }, now);
  repo.resolveConflicts(path, { take: "base" }, { message: "resolve", author }, now, merged);
  assert.equal(statusAt(repo, "HEAD", path), "base"); assert.equal(statusAt(repo, "main", path), "base");
  assert.ok(repo.allReachable().some((id) => effectiveChangeId(id, readCommit(repo.objects, id)) === effectiveChangeId(first, readCommit(repo.objects, first))));
  const { repo: incompatible, path: target, merged: ancestor } = conflict();
  // A deletion cannot be represented as a scalar or hunk disagreement.
  rmSync(join(incompatible.root, target)); incompatible.stage([target]);
  incompatible.commit({ message: "delete descendant", author }, now);
  const head = incompatible.resolve("HEAD"); const before = incompatible.operations.read().length;
  assert.throws(() => incompatible.resolveConflicts(target, { take: "theirs" }, { message: "refuse", author }, now, ancestor), /rewrite|conflict|record/i);
  assert.equal(incompatible.resolve("HEAD"), head); assert.equal(incompatible.operations.read().length, before);
  assert.equal(existsSync(join(incompatible.root, target)), false);
});

test("partial field resolution propagates without clearing other units, while equal explicit field choices agree", () => {
  for (const agree of [false, true]) {
    const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
    edit(repo, "item.toon", '{"status":"base","priority":0}'); repo.createBranch("other", "HEAD", now);
    repo.switchTo("other", now); edit(repo, "item.toon", '{"status":"theirs","priority":1}');
    repo.switchTo("main", now); edit(repo, "item.toon", '{"status":"ours","priority":2}');
    const merged = repo.merge("other", { message: "two fields", author, recordConflicts: true }, now).head;
    repo.createBranch("agree", "HEAD", now);
    edit(repo, "later.txt", "later");
    repo.resolveConflicts("item.toon", { field: "status", take: "ours" }, { message: "one unit", author }, now, merged);
    assert.equal(repo.status().conflicts?.length, 1); assert.equal(repo.status().conflicts?.[0].unit, "priority");
    if (agree) {
      repo.switchTo("agree", now);
      repo.resolveConflicts("item.toon", { field: "priority", take: "theirs" }, { message: "a", author }, now);
      repo.switchTo("main", now);
      repo.resolveConflicts("item.toon", { field: "priority", take: "theirs" }, { message: "b", author }, now);
      repo.merge("agree", { message: "agreement", author, recordConflicts: true }, now);
      assert.equal(repo.status().conflicts, undefined);
    }
    assert.deepEqual(repo.verify().missing, []);
  }
});

test("ancestor selectors accept stable change identities and refuse ambiguous live versions", () => {
  const { repo, path, merged } = conflict(); const stable = effectiveChangeId(merged, readCommit(repo.objects, merged));
  assert.equal(repo.resolve(stable), merged);
  edit(repo, "after.txt", "after");
  repo.resolveConflicts(path, { take: "theirs" }, { message: "by change id", author }, now, stable);
  assert.equal(statusAt(repo, "HEAD", path), "theirs");
  repo.refs.setHeadDetached(repo.resolve("HEAD"));
  assert.equal(repo.resolve(stable), merged);
  const alternate = writeCommit(repo.objects, { ...readCommit(repo.objects, merged), message: "another version" });
  repo.refs.compareAndSwap("refs/heads/alternate", null, alternate);
  assert.throws(() => repo.resolve(stable), /several reachable versions/);
  assert.throws(() => repo.resolve("f".repeat(64)), /not a known/);
  assert.throws(() => Repository.init(temp()).resolve(stable), /not a known/);
});

test("equal choices with independent edits and absent-field choices preserve precise resolution semantics", () => {
  for (const absent of [false, true]) {
    const { repo, path } = conflict(); repo.createBranch("resolver-b", "HEAD", now);
    repo.resolveConflicts(path, { take: "ours" }, { message: "a choice", author }, now);
    edit(repo, path, JSON.stringify({ independent: 1, status: "ours" }));
    repo.switchTo("resolver-b", now);
    repo.resolveConflicts(path, { value: absent ? null : "ours" }, { message: "b choice", author }, now);
    if (absent) edit(repo, path, JSON.stringify({ independent: 0 }));
    repo.switchTo("main", now);
    repo.merge("resolver-b", { message: "resolution semantics", author, recordConflicts: true }, now);
    assert.equal(statusAt(repo, "HEAD", path), "ours");
    assert.equal(repo.status().conflicts?.length ?? 0, absent ? 1 : 0);
    if (absent) {
      repo.resolveConflicts(path, { take: "theirs" }, { message: "accept absence", author }, now);
      assert.equal(statusAt(repo, "HEAD", path), undefined);
    }
    assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("equal text choices with independent prefix edits do not manufacture a conflict", () => {
  const { repo, path } = conflict(true); repo.createBranch("resolver-b", "HEAD", now);
  repo.resolveConflicts(path, { take: "ours" }, { message: "a choice", author }, now);
  edit(repo, path, "prefix\nheader\nours\ntail\n");
  repo.switchTo("resolver-b", now); repo.resolveConflicts(path, { take: "ours" }, { message: "b choice", author }, now);
  repo.switchTo("main", now); repo.merge("resolver-b", { message: "agreement", author, recordConflicts: true }, now);
  assert.equal(repo.status().conflicts, undefined); assert.equal(readFileSync(join(repo.root, path), "utf8"), "prefix\nheader\nours\ntail\n");
});

test("different text EOF choices and disjoint edits retain one conflict with the correct newline states", () => {
  const repo = Repository.init(temp()); edit(repo, "text.txt", "base\n"); repo.createBranch("other", "HEAD", now);
  repo.switchTo("other", now); edit(repo, "text.txt", "theirs\n"); repo.switchTo("main", now); edit(repo, "text.txt", "ours\n");
  repo.merge("other", { message: "conflict", author, recordConflicts: true }, now); repo.createBranch("resolver-b", "HEAD", now);
  repo.resolveConflicts("text.txt", { take: "ours" }, { message: "a resolves", author }, now);
  repo.switchTo("resolver-b", now); repo.resolveConflicts("text.txt", { value: "ours" }, { message: "b resolves", author }, now);
  repo.switchTo("main", now); repo.merge("resolver-b", { message: "newline disagreement", author, recordConflicts: true }, now);
  assert.equal(repo.status().conflicts?.length, 1); assert.equal(readFileSync(join(repo.root, "text.txt"), "utf8"), "ours\n");
  repo.resolveConflicts("text.txt", { take: "theirs" }, { message: "choose unterminated", author }, now);
  assert.equal(readFileSync(join(repo.root, "text.txt"), "utf8"), "ours");
});

test("different explicit choices already recorded by content merge retain exactly one dispute per unit", () => {
  for (const text of [false, true]) for (const partial of [false, true]) {
    const repo = Repository.init(temp(), "main", { recordPaths: ["*.toon"], recordPolicy: {} });
    const path = text ? "text.txt" : "item.toon";
    const value = (side: string) => text ? `header\n${side}\nmiddle\n${side}\ntail\n` : JSON.stringify({ first: side, second: side });
    edit(repo, path, value("base")); repo.createBranch("other", "HEAD", now);
    repo.switchTo("other", now); edit(repo, path, value("theirs")); repo.switchTo("main", now); edit(repo, path, value("ours"));
    repo.merge("other", { message: "two units", author, recordConflicts: true }, now); repo.createBranch("resolver-b", "HEAD", now);
    repo.resolveConflicts(path, { value: "left" }, { message: "a choice", author }, now);
    repo.switchTo("resolver-b", now); repo.resolveConflicts(path, { value: "right" }, { message: "b choice", author }, now);
    if (partial) edit(repo, path, text ? "header\nleft\nmiddle\nright\ntail\n" : JSON.stringify({ first: "left", second: "right" }));
    repo.switchTo("main", now); repo.merge("resolver-b", { message: "different choices", author, recordConflicts: true }, now);
    assert.equal(repo.status().conflicts?.length, partial ? 1 : 2); assert.deepEqual(repo.verify().corrupt, []);
  }
});

test("text field selectors refuse by unit name and replay preflights descendant mode conflicts", () => {
  const { repo: text, path: textPath } = conflict(true);
  assert.throws(() => text.resolveConflicts(textPath, { field: "status", take: "ours" }, { message: "invalid field", author }, now), /text.txt:status/);
  const { repo, path, merged } = conflict();
  chmodSync(join(repo.root, path), 0o755); repo.stage([path]); repo.commit({ message: "descendant executable mode", author }, now);
  const before = repo.resolve("HEAD"); const operations = repo.operations.read();
  assert.throws(() => repo.resolveConflicts(path, { take: "theirs" }, { message: "structural refusal", author }, now, merged), /rewrite|conflict/i);
  assert.equal(repo.resolve("HEAD"), before); assert.deepEqual(repo.operations.read(), operations);
});

test("merge descendants leave parents outside the resolved ancestry unchanged", () => {
  const { repo, path, merged } = conflict();
  const outside = readCommit(repo.objects, merged).parents[1];
  repo.createBranch("outside", outside, now); repo.switchTo("outside", now); const extra = edit(repo, "outside.txt", "independent");
  repo.switchTo("main", now); repo.merge("outside", { message: "join unrelated descendant", author, recordConflicts: true }, now);
  repo.resolveConflicts(path, { take: "theirs" }, { message: "ancestor resolution", author }, now, merged);
  assert.equal(statusAt(repo, "HEAD", path), "theirs"); assert.equal(repo.resolve("outside"), extra);
  assert.equal(readFileSync(join(repo.root, "outside.txt"), "utf8"), "independent"); assert.deepEqual(repo.verify().corrupt, []);
});


test("ancestor resolution follows a renamed inherited conflict through further descendants", () => {
  const { repo, path, merged } = conflict();
  const fileId = repo.readIndex().find((entry) => entry.path === path)!.fileId;
  renameSync(join(repo.root, path), join(repo.root, "renamed.toon")); repo.stage([]);
  const renamed = repo.commit({ message: "rename inherited conflict", author }, now);
  edit(repo, "after.txt", "after");
  repo.resolveConflicts(path, { take: "theirs" }, { message: "resolve before rename", author }, now, merged);
  assert.equal(statusAt(repo, "HEAD", "renamed.toon"), "theirs"); assert.equal(repo.status().conflicts, undefined);
  assert.equal(repo.readIndex().find((entry) => entry.path === "renamed.toon")!.fileId, fileId);
  assert.ok(repo.log("HEAD").some((row) => row.changeId === effectiveChangeId(renamed, readCommit(repo.objects, renamed))));
  assert.equal(existsSync(join(repo.root, path)), false); assert.deepEqual(repo.verify().corrupt, []);
});

test("a deleted sibling descendant refuses the whole resolution before any ref publication", () => {
  const { repo, path, merged } = conflict(); repo.createBranch("deleted", "HEAD", now);
  repo.switchTo("deleted", now); rmSync(join(repo.root, path)); repo.stage([path]); repo.commit({ message: "sibling deletes", author }, now);
  repo.switchTo("main", now); const before = repo.refs.list("refs"); const operations = repo.operations.read();
  assert.throws(() => repo.resolveConflicts(path, { take: "theirs" }, { message: "refuse structural loss", author }, now, merged), /rewrite|conflict/i);
  assert.deepEqual(repo.refs.list("refs"), before); assert.deepEqual(repo.operations.read(), operations);
});


test("a descendant rename onto another parent identity refuses rather than overwriting it during replay", () => {
  const { repo, path, merged } = conflict(false, true);
  const files = flattenTree(repo.objects, readCommit(repo.objects, merged).tree);
  const source = files.get(path)!; files.delete(path); files.set("destination.toon", source);
  const descendant = writeCommit(repo.objects, { tree: buildTree(repo.objects, files), parents: [merged], author, committer: author, message: "explicit identity replacement" });
  repo.switchTo(descendant, now);
  const refs = repo.refs.list("refs"); const operations = repo.operations.read();
  assert.throws(() => repo.resolveConflicts(path, { take: "theirs" }, { message: "identity collision", author }, now, merged), /rewrite|conflict/i);
  assert.equal(repo.resolve("HEAD"), descendant); assert.deepEqual(repo.refs.list("refs"), refs); assert.deepEqual(repo.operations.read(), operations);
});


test("shifted inherited text units resolve through independent prefix edits without spurious content conflicts", () => {
  const { repo, path, merged } = conflict(true);
  edit(repo, path, "prefix\nheader\nours\ntail\n");
  repo.resolveConflicts(path, { take: "theirs" }, { message: "resolve shifted hunk", author }, now, merged);
  assert.equal(repo.status().conflicts, undefined);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "prefix\nheader\ntheirs\ntail\n");
  assert.deepEqual(repo.verify().corrupt, []);
});
