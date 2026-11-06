import "./helpers/isolate-session.ts";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync, linkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { Repository } from "../engine/repo.ts";
import { AmbiguousMoveError, type MoveIntent, type MoveCandidate, resolveMoveIntents, inferMoveSource } from "../engine/moves.ts";
import { alignFileMoves } from "../engine/merge-moves.ts";
import { readCommit, type Signature, migratedFileId } from "../engine/model.ts";
import { mergeTrees } from "../engine/rewrite.ts";
import { buildTree, flattenTree, type IndexEntry } from "../engine/worktree.ts";
import { cloneFrom } from "../engine/sync.ts";
import { traceFile } from "../engine/attribution.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { testEnvironment } from "./helpers/test-environment.ts";

const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const scopes: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) scope.cleanup(); });
/** Keep each fixture's native control state isolated, without a Git repository. */
function fresh(): Repository { const scope = makeTempDir(); scopes.push(scope); return Repository.init(scope.root); }
/** Write bytes at a repository-relative working path. */
function put(repo: Repository, path: string, text: string): void { writeFileSync(join(repo.root, path), text); }
/** Record a reproducible native commit. */
function commit(repo: Repository, message: string): string { return repo.commit({ message, author, items: ["move-fixture"] }, new Date(1)); }
/** Clear filesystem hints to model a cross-filesystem move without depending on inode reuse. */
function forgetStats(repo: Repository): void { repo.writeIndex(repo.readIndex().map(entry => ({ ...entry, stat: undefined }))); }
/** Create two indistinguishable source files with deliberately distinct logical identities. */
function twins(repo: Repository): IndexEntry[] {
  put(repo, "a", "first\nanchor\nlast\n"); put(repo, "b", "first\nanchor\nlast\n"); repo.stage(["a", "b"]); commit(repo, "base");
  forgetStats(repo); return repo.readIndex();
}
/** Read canonical tree entries and payload bytes, independent of index stat hints. */
function projection(repo: Repository, tree: string): unknown {
  return [...flattenTree(repo.objects, tree)].map(([path, entry]) => [path, entry, repo.objects.read(entry.id).payload.toString("hex")]);
}

test("explicit mapping wins over a misleading inode and content match, retains provenance and is retryable", () => {
  const repo = fresh(); const [a, b] = twins(repo);
  put(repo, "b", "misleading edited source\n"); repo.stage(["b"]);
  renameSync(join(repo.root, "b"), join(repo.root, "dest")); unlinkSync(join(repo.root, "a"));
  const intent = [{ fileId: a.fileId!, path: "./dest" }];
  repo.stage(["dest"], undefined, intent);
  assert.equal(repo.readIndex().find(entry => entry.path === "dest")?.fileId, a.fileId);
  assert.equal(repo.readIndex().some(entry => entry.path === "a"), false);
  repo.stage(["dest"], undefined, intent); repo.stage([]);
  const moved = commit(repo, "explicit edited move");
  assert.deepEqual(traceFile(repo.objects, [moved], a.fileId!).map(change => change.kind), ["moved"]);
  assert.notEqual(repo.readIndex()[0].fileId, b.fileId);
  put(repo, "copy", readFileSync(join(repo.root, "dest"), "utf8")); repo.stage(["copy"]);
  const copy = repo.readIndex().find(entry => entry.path === "copy")!;
  assert.notEqual(copy.fileId, a.fileId); assert.equal(copy.copiedFrom, a.fileId);
  unlinkSync(join(repo.root, "copy")); put(repo, "copy-moved", "edited copy\n");
  repo.stage(["copy-moved"], undefined, [{ fileId: copy.fileId!, path: "copy-moved" }]);
  assert.equal(repo.readIndex().find(entry => entry.path === "copy-moved")?.copiedFrom, a.fileId);
});

test("ambiguous sources and competing destinations are typed refusals before object or index publication", () => {
  const repo = fresh(); const originals = twins(repo); const before = readFileSync(join(repo.controlDirectory, "index"));
  unlinkSync(join(repo.root, "a")); unlinkSync(join(repo.root, "b")); put(repo, "dest", "first\nanchor\nlast\n"); put(repo, "new", "unrelated edit\n");
  const inventory = repo.objects.inventory();
  assert.throws(() => repo.stage(["new", "dest"]), (error: unknown) => {
    assert.ok(error instanceof AmbiguousMoveError); assert.equal(error.code, "ambiguous_move"); assert.match(error.remedy, /--file-id/);
    assert.deepEqual(error.candidates.map(candidate => candidate.source), ["a", "b"]); return true;
  });
  assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), before); assert.deepEqual(repo.objects.inventory(), inventory);
  repo.stage(["dest"], undefined, [{ path: "dest", fileId: originals[0].fileId! }]);
  // The remaining identity can be paired to only one destination in a staging batch.
  put(repo, "one", "first\nanchor\nlast\n"); put(repo, "two", "first\nanchor\nlast\n");
  repo.writeIndex([originals[1]]);
  assert.throws(() => repo.stage(["one", "two"]), (error: unknown) => error instanceof AmbiguousMoveError && error.candidates.length === 2);
  // Explicit declarations reserve the identity even when an earlier target has exact matching bytes.
  repo.stage(["one", "two"], undefined, [{ path: "two", fileId: originals[1].fileId! }]);
  assert.equal(repo.readIndex().find(entry => entry.path === "two")?.fileId, originals[1].fileId);
  assert.notEqual(repo.readIndex().find(entry => entry.path === "one")?.fileId, originals[1].fileId);
});

test("invalid intent corpus leaves existing index bytes untouched; legacy and normalized retry remain supported", () => {
  const repo = fresh(); const [a, b] = twins(repo); put(repo, "dest", "edited\n");
  const before = readFileSync(join(repo.controlDirectory, "index"));
  const reject = (intents: MoveIntent[], targets = ["dest"]): void => { assert.throws(() => repo.stage(targets, undefined, intents), { code: "invalid_move_intent" }); assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), before); };
  reject([{ fileId: a.fileId!, path: "dest" }]); // Source still exists: this is a copy.
  unlinkSync(join(repo.root, "a"));
  for (const fileId of ["", "BAD", "f".repeat(32)]) reject([{ fileId, path: "dest" }]);
  reject([{ fileId: a.fileId!, path: "dest" }], ["b"]);
  reject([{ fileId: a.fileId!, path: "b" }], ["b"]);
  reject([{ fileId: a.fileId!, path: "missing" }], ["missing"]);
  mkdirSync(join(repo.root, "dir")); reject([{ fileId: a.fileId!, path: "dir" }], ["dir"]);
  reject([{ fileId: a.fileId!, path: "dest" }, { fileId: a.fileId!, path: "dest" }]);
  unlinkSync(join(repo.root, "b")); reject([{ fileId: a.fileId!, path: "dest" }, { fileId: b.fileId!, path: "dest" }]);
  const intent = [{ fileId: a.fileId!, path: "dest" }];
  assert.throws(() => resolveMoveIntents(repo.root, [a, { ...a, path: "other" }], ["dest"], intent, () => true), { code: "invalid_move_intent" });
  assert.throws(() => resolveMoveIntents(repo.root, [{ ...a, sparse: true }], ["dest"], intent, () => true), { code: "invalid_move_intent" });
  assert.throws(() => resolveMoveIntents(repo.root, [a], ["dest"], intent, () => false), { code: "invalid_move_intent" });
  const legacy = { path: "a", id: a.id, mode: a.mode };
  repo.writeIndex([legacy]); repo.stage(["dest"], undefined, [{ path: "./dest", fileId: migratedFileId(legacy) }]);
  assert.equal(repo.readIndex()[0].fileId, migratedFileId(legacy));
  assert.equal(existsSync(join(repo.root, ".git")), false);
});

test("both edited sides merge and replay by explicit identity, and clone reproduces canonical bytes", async () => {
  const repo = fresh(); const [a] = twins(repo); const base = repo.refs.resolveHead()!;
  repo.createBranch("edit", "HEAD", new Date(1));
  unlinkSync(join(repo.root, "a")); put(repo, "dest", "ours\nanchor\nlast\n");
  repo.stage(["dest"], undefined, [{ fileId: a.fileId!, path: "dest" }]); const moved = commit(repo, "move and edit");
  repo.switchTo("edit", new Date(1)); put(repo, "a", "first\nanchor\ntheirs\n"); repo.stage(["a"]); const edited = commit(repo, "other edit");
  repo.switchTo("main", new Date(1)); const merged = repo.merge("edit", { message: "merge", author }, new Date(1));
  assert.equal(merged.clean, true); assert.equal(readFileSync(join(repo.root, "dest"), "utf8"), "ours\nanchor\ntheirs\n");
  assert.equal(existsSync(join(repo.root, "a")), false);
  const expectedTree = readCommit(repo.objects, merged.head!).tree;
  repo.createBranch("replay", moved, new Date(1)); repo.switchTo("replay", new Date(1));
  const replayed = repo.rebase("replay", edited, author, new Date(1))!;
  assert.equal(readCommit(repo.objects, replayed).tree, expectedTree);
  assert.equal(readCommit(repo.objects, moved).changeId, readCommit(repo.objects, replayed).changeId);
  assert.equal(flattenTree(repo.objects, expectedTree).get("dest")?.fileId, a.fileId);
  const scope = makeTempDir(); scopes.push(scope); const target = join(scope.root, "clone"); await cloneFrom(repo.root, target, new Date(1));
  const cloned = Repository.open(target);
  assert.equal(cloned.refs.resolveHead(), replayed); assert.deepEqual(projection(cloned, expectedTree), projection(repo, expectedTree));
  for (const id of [base, edited, replayed, expectedTree]) assert.deepEqual(cloned.objects.read(id), repo.objects.read(id));
});

/** A fixed PRNG makes every generated move/edit sequence reproducible. */
function random(seed: number): () => number { let state = seed; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; }

test("seeded move/edit/merge sequences agree with an independent identity-keyed oracle", () => {
  const repo = fresh(); const next = random(0x6d6f7665);
  let model = Array.from({ length: 4 }, (_, i) => ({ fileId: String(i + 1).repeat(32), path: `file-${i}`, left: "first", right: "last" }));
  const tree = (rows: typeof model): string => buildTree(repo.objects, new Map(rows.map(row => [row.path, { fileId: row.fileId, mode: "100644" as const, id: repo.objects.write("blob", Buffer.from(`${row.left}\nanchor\n${row.right}\n`), row.fileId) }])));
  for (let turn = 0; turn < 18; turn++) {
    const base = tree(model); const ours = model.map(row => ({ ...row })); const theirs = model.map(row => ({ ...row }));
    const expected = model.map((row, index) => {
      const mover = next() % 2 === 0 ? ours : theirs;
      if (next() % 3 !== 0) mover[index].path = `moved-${turn}-${index}`;
      if (next() % 3 !== 0) ours[index].left = `left-${turn}-${index}`;
      if (next() % 3 !== 0) theirs[index].right = `right-${turn}-${index}`;
      return { fileId: row.fileId, path: mover[index].path, left: ours[index].left, right: theirs[index].right };
    });
    const result = mergeTrees({ store: repo.objects, config: repo.config, committer: author }, base, tree(ours), tree(theirs));
    assert.deepEqual(result.conflicts, [], `seed 0x6d6f7665 turn ${turn}`);
    assert.deepEqual(projection(repo, result.tree), projection(repo, tree(expected)), `oracle turn ${turn}`);
    const reverse = mergeTrees({ store: repo.objects, config: repo.config, committer: author }, base, tree(theirs), tree(ours));
    assert.equal(reverse.tree, result.tree); model = expected;
  }
});

/** Start an OS child and retain both readiness and termination before releasing its barrier. */
function worker(repo: Repository, intents: MoveIntent[], cut = "none") {
  const child = fork(join(packageRoot, "test/helpers/move-intent-worker.ts"), [repo.root, JSON.stringify(intents), cut], { env: testEnvironment(), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", bytes => { stderr += String(bytes); });
  const ready = new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
  let reply: { ok?: boolean; code?: string } | undefined;
  child.on("message", message => { if (typeof message === "object") reply = message; });
  const done = new Promise<{ code: number | null; signal: string | null; reply: typeof reply }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`move worker timeout: ${stderr}`)); }, 60_000);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, reply }); }); child.once("error", reject);
  });
  return { child, ready, done };
}

test("OS processes preserve disjoint declared moves and refuse a competing claim of the same FileId", async () => {
  const repo = fresh(); const originals = twins(repo);
  for (const entry of originals) { unlinkSync(join(repo.root, entry.path)); put(repo, `dest-${entry.path}`, "independent edited bytes\n"); }
  const children = originals.map(entry => worker(repo, [{ path: `dest-${entry.path}`, fileId: entry.fileId! }]));
  await Promise.all(children.map(child => child.ready)); children.forEach(child => child.child.send("go"));
  for (const result of await Promise.all(children.map(child => child.done))) { assert.equal(result.code, 0); assert.deepEqual(result.reply, { ok: true }); }
  for (const entry of originals) assert.equal(repo.readIndex().find(candidate => candidate.path === `dest-${entry.path}`)?.fileId, entry.fileId);
  unlinkSync(join(repo.root, "dest-a")); put(repo, "choice-1", "changed\n"); put(repo, "choice-2", "changed\n");
  const competitors = [1, 2].map(n => worker(repo, [{ path: `choice-${n}`, fileId: originals[0].fileId! }]));
  await Promise.all(competitors.map(child => child.ready)); competitors.forEach(child => child.child.send("go"));
  const results = await Promise.all(competitors.map(child => child.done));
  assert.equal(results.filter(result => result.reply?.ok).length, 1);
  assert.equal(results.filter(result => result.reply?.code === "invalid_move_intent").length, 1);
  assert.equal(repo.readIndex().filter(entry => entry.fileId === originals[0].fileId).length, 1);
});

for (const cut of ["before", "after"]) test(`crash ${cut} index publication converges after explicit retry and clone`, async () => {
  const repo = fresh(); const [a] = twins(repo);
  unlinkSync(join(repo.root, "a")); put(repo, "dest", "edited after move\n");
  const intent = [{ path: "dest", fileId: a.fileId! }]; const before = readFileSync(join(repo.controlDirectory, "index"));
  const child = worker(repo, intent, cut); await child.ready; child.child.send("go"); const killed = await child.done;
  assert.equal(killed.signal, "SIGKILL");
  if (cut === "before") assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), before);
  else assert.equal(repo.readIndex().find(entry => entry.path === "dest")?.fileId, a.fileId);
  repo.objects.recoverWriterLock(); repo.stage(["dest"], undefined, intent);
  const after = repo.readIndex().map(({ stat: _stat, ...entry }) => entry); repo.stage(["dest"], undefined, intent); assert.deepEqual(repo.readIndex().map(({ stat: _stat, ...entry }) => entry), after);
  const head = commit(repo, "recovered move"); const tree = readCommit(repo.objects, head).tree;
  assert.equal(flattenTree(repo.objects, tree).get("dest")?.fileId, a.fileId);
  const scope = makeTempDir(); scopes.push(scope); const target = join(scope.root, "clone"); await cloneFrom(repo.root, target, new Date(1));
  assert.deepEqual(projection(Repository.open(target), tree), projection(repo, tree));
});

test("real PM host accepts explicit FileId staging without Git and rejects unusable CLI guards", async () => {
  const repo = fresh(); const pmRoot = join(repo.root, ".agents/pm");
  await new PmClient({ cwd: repo.root, pmRoot, noExtensions: true }).init("moves", { defaults: true, author: "fixture" });
  const [a] = twins(repo); unlinkSync(join(repo.root, "a")); put(repo, "dest", "entirely edited\n");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as { capabilities: NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"] };
  const harness = await createExtensionTestHarness(extension, { capabilities: manifest.capabilities });
  for (const fileId of ["", " ", true, "bad"]) assert.match(String((await harness.runCommand({ command: "vcs add", args: ["dest"], options: { fileId }, pmRoot })).errorMessage), /--file-id requires/);
  assert.match(String((await harness.runCommand({ command: "vcs add", args: [], options: { fileId: a.fileId }, pmRoot })).errorMessage), /exactly one destination/);
  const result = await harness.runCommand({ command: "vcs add", args: ["dest"], options: { fileId: a.fileId }, pmRoot }); assert.equal(result.errorMessage, undefined);
  assert.equal(repo.readIndex().find(entry => entry.path === "dest")?.fileId, a.fileId); assert.equal(existsSync(join(repo.root, ".git")), false);
});

test("move alignment retains divergent, colliding, missing and duplicate identity conflicts", () => {
  const entry = { id: "a".repeat(64), mode: "100644" as const, fileId: "b".repeat(32) };
  const base = (): ReturnType<typeof flattenTree> => new Map([["old", entry]]);
  assert.deepEqual(alignFileMoves(base(), new Map([["left", entry]]), new Map([["right", entry]])), ["left", "right"]);
  assert.deepEqual(alignFileMoves(base(), new Map([["dest", entry]]), new Map([["old", entry], ["dest", { ...entry, fileId: "c".repeat(32) }]])), ["dest"]);
  assert.deepEqual(alignFileMoves(base(), new Map(), base()), []);
  assert.deepEqual(alignFileMoves(new Map([["old", entry], ["duplicate", entry]]), base(), base()), []);
  assert.deepEqual(alignFileMoves(new Map([["legacy", { id: entry.id, mode: entry.mode }]]), base(), base()), []);
  const repo = fresh(); const legacy = { path: "absent", id: entry.id, mode: entry.mode };
  const inferred = new Map<string, MoveCandidate>(); assert.equal(inferMoveSource(repo.root, "one", [legacy], inferred), legacy);
  assert.throws(() => inferMoveSource(repo.root, "two", [legacy], inferred), { code: "ambiguous_move" });
  assert.throws(() => inferMoveSource(repo.root, "three", [legacy, { ...legacy, path: "other" }], new Map()), { code: "ambiguous_move" });
  put(repo, "absent", "live copy"); put(repo, "other", "live copy"); assert.equal(inferMoveSource(repo.root, "copy", [legacy, { ...legacy, path: "other" }], new Map()), undefined);
});


test("explicit intent honors private, ignored, sparse, erased and unreadable source boundaries", () => {
  const repo = fresh(); put(repo, "source", "live identity\n"); repo.stage(["source"]); const original = repo.readIndex()[0];
  unlinkSync(join(repo.root, "source")); put(repo, "dest", "edited\n");
  const intent = [{ path: "dest", fileId: original.fileId! }]; const before = readFileSync(join(repo.controlDirectory, "index"));
  const failure = new Error("reader failed"); assert.throws(() => repo.stage(["dest"], () => { throw failure; }, intent), error => error === failure);
  assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), before);
  unlinkSync(join(repo.root, "dest")); repo.addLayer("private", new Map([["dest", { content: Buffer.from("private"), executable: false }]]));
  assert.throws(() => repo.stage(["dest"], undefined, intent), { code: "invalid_move_intent" }); repo.removeLayer("private", true);
  put(repo, "dest", "edited\n"); put(repo, ".pmvcsignore", "dest\n");
  assert.throws(() => repo.stage(["dest"], undefined, intent), { code: "invalid_move_intent" }); unlinkSync(join(repo.root, ".pmvcsignore"));
  assert.throws(() => repo.stage([".pmvcs/index"], undefined, [{ path: ".pmvcs/index", fileId: original.fileId! }]), { code: "invalid_move_intent" });
  repo.writeIndex([{ ...original, sparse: true }]); assert.throws(() => repo.stage(["dest"], undefined, intent), { code: "invalid_move_intent" });
  repo.writeIndex([original]); repo.stage(["source", "dest", "dest"], undefined, intent); assert.equal(repo.readIndex()[0].fileId, original.fileId);
  commit(repo, "move before erasure"); repo.setAuthority("fixture", "read-fixture", "erase-fixture"); repo.identity();
  repo.obliterate(original.fileId!, "erase-fixture", "fixture-erasure", new Date(1)); put(repo, "terminal-dest", "unrelated replacement\n");
  assert.throws(() => repo.stage(["terminal-dest"], undefined, [{ path: "terminal-dest", fileId: original.fileId! }]), { code: "invalid_move_intent" });
  put(repo, "legacy", "new unrelated identity\n"); repo.stage(["legacy"]);
  const live = repo.readIndex().find(entry => entry.path === "legacy")!; const legacy = { path: live.path, id: live.id, mode: live.mode };
  repo.writeIndex([legacy]); unlinkSync(join(repo.root, "legacy")); put(repo, "new-legacy", "edited legacy\n");
  repo.stage(["new-legacy"], undefined, [{ path: "new-legacy", fileId: migratedFileId(legacy) }]);
  assert.equal(repo.readIndex()[0].fileId, migratedFileId(legacy));
});

test("tied inode evidence on edited hardlink moves requires explicit identity", () => {
  const repo = fresh(); put(repo, "a", "original\n"); linkSync(join(repo.root, "a"), join(repo.root, "b"));
  repo.stage(["a", "b"]); const a = repo.readIndex()[0]; renameSync(join(repo.root, "a"), join(repo.root, "dest")); unlinkSync(join(repo.root, "b")); put(repo, "dest", "entirely edited\n");
  assert.throws(() => repo.stage(["dest"]), (error: unknown) => error instanceof AmbiguousMoveError && error.candidates.length === 2);
  repo.stage(["dest"], undefined, [{ path: "dest", fileId: a.fileId! }]); assert.equal(repo.readIndex().find(entry => entry.path === "dest")?.fileId, a.fileId);
});


test("identity planning bounds retained payloads and rejects content or mode drift on deferred reads", () => {
  for (const mode of ["memory", "content", "mode"]) {
    const repo = fresh();
    const result = JSON.parse(execFileSync(process.execPath, ["--expose-gc", join(packageRoot, "test/helpers/staging-buffer-worker.ts"), repo.root, mode], { env: testEnvironment(), encoding: "utf8", timeout: 60_000 })) as { peak: number; reads: number; paths: number };
    assert.ok(result.peak <= 6 * 1024 * 1024, `staging retained ${result.peak} bytes above baseline for ${mode}`);
    assert.ok(result.reads > result.paths, "a bounded plan must reread its released snapshots");
  }
});
