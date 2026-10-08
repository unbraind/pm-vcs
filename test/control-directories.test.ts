/** Real-tracker regressions for nested control state, filesystem aliases and hostile stored trees. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Repository } from "../engine/repo.ts";
import { writeCommit, type Signature } from "../engine/model.ts";
import { isControlPath, isIgnored, isPrunableDirectory, parseIgnore } from "../engine/ignore.ts";
import { buildTree, flattenTree, isProtectedWorktreePath, listWorkingTree, pruneEmptyDirectories } from "../engine/worktree.ts";
import { runPm } from "../scripts/pm-environment.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let fixture: ReturnType<typeof makeTempDir> | undefined;
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date(1);

afterEach(() => { fixture?.cleanup(); fixture = undefined; });

/** Initialize an actual PM tracker and the VCS engine in one disposable working tree. */
function repository(symlinkedParent = false): Repository {
  fixture = makeTempDir();
  let root = fixture.root;
  if (symlinkedParent) {
    const parent = join(root, "parent");
    mkdirSync(parent);
    symlinkSync(parent, join(root, "linked-parent"), "junction");
    root = join(root, "linked-parent", "repo");
    mkdirSync(root);
  }
  runPm(root, ["init", "control-fence", "--yes", "--agent-guidance", "skip"]);
  return Repository.init(root);
}

/** Construct stored content without the staging fence, as a legacy or malicious tree would arrive. */
function hostileTree(repo: Repository, paths: readonly string[]): string {
  const id = repo.objects.write("blob", Buffer.from("hostile\n"));
  return buildTree(repo.objects, new Map(paths.map((path) => [path, { id, mode: "100644" as const }])));
}

test("control names are reserved at every depth and in every case, including leaf names", () => {
  const rules = parseIgnore("**\n!**\n!.pmvcs/**\n");
  for (const path of [".pmvcs", ".PMVCS/config", "agent-a/.pmvcs/credentials.json", "a/b/.PmVcS", "a/b/c/.PMVCS/objects/x"]) {
    assert.equal(isControlPath(path), true, path);
    assert.equal(isIgnored(path, rules), true, path);
  }
  assert.equal(isPrunableDirectory(".PmVcS"), true);
  for (const path of [".pmvcsignore", "src/pmvcs.ts", "nested/.pmvcs-backup/config"]) {
    assert.equal(isControlPath(path), false, path);
    assert.equal(isIgnored(path, rules), false, path);
  }
});

test("staging and commit retain real PM records and nested source while excluding credentials", () => {
  const repo = repository();
  runPm(repo.root, ["create", "Task", "Public fixture item"]);
  const child = Repository.init(join(repo.root, "agent-a"));
  child.remotes.add("origin", "https://synthetic-token@example.invalid/repo");
  mkdirSync(join(repo.root, "deep/team/.PMVCS"), { recursive: true });
  writeFileSync(join(repo.root, "deep/team/.PMVCS/credentials.json"), "private sentinel\n");
  writeFileSync(join(child.root, "source.txt"), "source\n");
  writeFileSync(join(repo.root, ".pmvcsignore"), "!.pmvcs/**\n!**/.PMVCS/**\n");
  const reported = repo.status().untracked;
  assert.ok(reported.some((path) => path.endsWith(".toon")));
  assert.ok(reported.includes("agent-a/source.txt"));
  assert.equal(reported.includes("agent-a/.pmvcs/credentials.json"), false);
  assert.equal(reported.includes("deep/team/.PMVCS/credentials.json"), false);
  assert.equal(reported.some(isControlPath), false);
  const changed = repo.stage([]);
  assert.equal(changed.some(isControlPath), false);
  assert.equal(repo.readIndex().some((entry) => entry.path === "agent-a/.pmvcs/credentials.json"), false);
  assert.equal(repo.readIndex().some((entry) => isControlPath(entry.path)), false);
  for (const path of [".pmvcs/config.json", "agent-a/.pmvcs/credentials.json", "deep/team/.PMVCS/credentials.json", "deep/team/.PMVCS", "missing/.PmVcS/file"]) {
    assert.throws(() => repo.stage([path]), { code: "path_ignored" }, path);
  }
  repo.commit({ message: "public source and tracker\n", author }, now);
  const committed = [...flattenTree(repo.objects, repo.headTree()).keys()];
  assert.equal(committed.some(isControlPath), false);
  assert.ok(committed.includes("agent-a/source.txt"));
  assert.equal(repo.status().clean, true);
  assert.ok(readFileSync(join(child.controlDirectory, "credentials.json"), "utf8").includes("synthetic-token"));
});

test("legacy control entries, including sparse entries, cannot be committed and add removes them", () => {
  const repo = repository();
  repo.stage([]);
  const clean = repo.readIndex();
  const paths = ["agent-a/.pmvcs/credentials.json", "deep/.PMVCS/private", ".pmvcs"];
  const id = repo.objects.write("blob", Buffer.from("private\n"));
  for (const sparse of [false, true]) {
    repo.writeIndex([...clean, ...paths.map((path) => ({ path, id, mode: "100644" as const, sparse }))]);
    assert.throws(() => repo.commit({ message: "refuse private\n", author }, now), { code: "path_ignored" });
    assert.equal(repo.refs.resolveHead(), null);
  }
  assert.equal(repo.status().staged.some((change) => isControlPath(change.path)), false);
  assert.equal(repo.status().unstaged.some((change) => isControlPath(change.path)), false);
  assert.deepEqual(repo.stage([]), paths.sort());
  assert.equal(repo.readIndex().some((entry) => isControlPath(entry.path)), false);
  repo.commit({ message: "sanitized\n", author }, now);
  assert.equal([...flattenTree(repo.objects, repo.headTree()).keys()].some(isControlPath), false);
});

test("symlink aliases cannot stage control content or receive writes from hostile trees", () => {
  const repo = repository();
  const child = Repository.init(join(repo.root, "nested/child"));
  writeFileSync(join(child.controlDirectory, "sentinel"), "private\n");
  writeFileSync(join(repo.root, "ordinary.txt"), "ordinary\n");
  symlinkSync(child.controlDirectory, join(repo.root, "alias"), "junction");
  symlinkSync("alias", join(repo.root, "chain"), "junction");
  symlinkSync("nested/child/.pmvcs/sentinel", join(repo.root, "leaf"));
  symlinkSync("leaf", join(repo.root, "leaf-chain"));
  symlinkSync("missing/.PMVCS/secret", join(repo.root, "dangling"));
  symlinkSync("ordinary.txt", join(repo.root, "ordinary-link"));
  symlinkSync("missing.txt", join(repo.root, "ordinary-dangling"));
  const protectedPaths = ["alias", "alias/sentinel", "alias/new", "chain/sentinel", "leaf", "leaf-chain", "dangling"];
  repo.stage([]);
  for (const path of protectedPaths) {
    assert.throws(() => repo.stage([path]), { code: "path_ignored" }, path);
    assert.equal(repo.status().untracked.includes(path), false, path);
  }
  assert.ok(repo.readIndex().some((entry) => entry.path === "ordinary-link"));
  assert.ok(repo.readIndex().some((entry) => entry.path === "ordinary-dangling"));
  assert.equal(isProtectedWorktreePath(repo.root, "ordinary-link", true), false);
  assert.equal(isProtectedWorktreePath(repo.root, "ordinary-dangling", true), false);
  assert.equal(isProtectedWorktreePath(repo.root, "alias/sentinel", true), true);
  assert.equal(isProtectedWorktreePath(repo.root, "leaf-chain", true), true);
  const cleanIndex = repo.readIndex();
  repo.writeIndex([...cleanIndex, { path: "alias/sentinel", id: "f".repeat(64), mode: "100644", sparse: true }]);
  assert.throws(() => repo.commit({ message: "refuse alias\n", author }, now), { code: "path_ignored" });
  assert.ok(repo.stage([]).includes("alias/sentinel"));
  const unsafe = hostileTree(repo, [...protectedPaths.filter((path) => path !== "alias"), "ordinary-link", "safe/new.txt"]);
  repo.materialize(unsafe);
  assert.equal(readFileSync(join(child.controlDirectory, "sentinel"), "utf8"), "private\n");
  assert.equal(existsSync(join(child.controlDirectory, "new")), false);
  assert.equal(readlinkSync(join(repo.root, "alias")), child.controlDirectory);
  assert.equal(readlinkSync(join(repo.root, "leaf")), "nested/child/.pmvcs/sentinel");
  assert.equal(readlinkSync(join(repo.root, "ordinary-link")), "ordinary.txt");
  assert.equal(readFileSync(join(repo.root, "safe/new.txt"), "utf8"), "hostile\n");
  assert.deepEqual(repo.readIndex().map((entry) => entry.path), ["safe/new.txt"]);
  repo.materialize(hostileTree(repo, ["alias"]));
  assert.equal(readlinkSync(join(repo.root, "alias")), child.controlDirectory);
});

test("ordinary leaf links under a symlinked parent stay listed, staged and committed", () => {
  const repo = repository(true);
  writeFileSync(join(repo.root, "b.txt"), "ordinary\n");
  mkdirSync(join(repo.root, "nested"));
  const links = new Map([
    ["a", "b.txt"],
    ["nested/relative", "../b.txt"],
    ["absolute", join(realpathSync(repo.root), "b.txt")],
    ["dangling", "missing.txt"],
    ["root-link", "."],
  ]);
  for (const [path, target] of links) symlinkSync(target, join(repo.root, path));
  const listed = listWorkingTree(repo.root, ".pmvcs", parseIgnore(""));
  for (const path of links.keys()) assert.ok(listed.includes(path), path);
  repo.stage([]);
  const first = repo.commit({ message: "ordinary links\n", author }, now);
  const before = repo.readIndex().find((entry) => entry.path === "a")!;
  assert.ok(before.fileId);
  writeFileSync(join(repo.root, "b.txt"), "changed\n");
  repo.stage([]);
  const after = repo.readIndex().find((entry) => entry.path === "a")!;
  assert.equal(after.fileId, before.fileId);
  assert.equal(after.id, before.id);
  assert.equal(after.mode, before.mode);
  const second = repo.commit({ message: "retain ordinary links\n", author }, now);
  assert.notEqual(second, first);
  const tree = flattenTree(repo.objects, repo.headTree());
  for (const [path, target] of links) {
    assert.ok(tree.has(path), path);
    assert.equal(repo.objects.read(tree.get(path)!.id).payload.toString(), target);
  }
  assert.equal(repo.status().clean, true);
});

test("control and outside leaf links under a symlinked parent stay protected", () => {
  const repo = repository(true);
  const canonicalRoot = realpathSync(repo.root);
  writeFileSync(join(repo.controlDirectory, "sentinel"), "control\n");
  writeFileSync(join(canonicalRoot, "..", "outside.txt"), "outside\n");
  mkdirSync(join(repo.root, "nested/.PMVCS"), { recursive: true });
  writeFileSync(join(repo.root, "nested/.PMVCS/sentinel"), "nested control\n");
  writeFileSync(join(repo.root, "ordinary.txt"), "ordinary\n");
  const links = new Map([
    ["control", ".pmvcs/sentinel"],
    ["nested-control", "nested/.PMVCS/sentinel"],
    ["absolute-control", join(canonicalRoot, ".pmvcs/sentinel")],
    ["dangling-control", "missing/.pmvcs/sentinel"],
    ["outside-relative", "../outside.txt"],
    ["outside-absolute", join(canonicalRoot, "..", "outside.txt")],
    ["outside-dangling", "../missing.txt"],
    ["chain", "ordinary-alias"],
    ["ancestor/file", "ordinary.txt"],
  ]);
  symlinkSync("ordinary.txt", join(repo.root, "ordinary-alias"));
  symlinkSync("nested", join(repo.root, "ancestor"), "junction");
  for (const [path, target] of links) symlinkSync(target, join(repo.root, path));
  const listed = listWorkingTree(repo.root, ".pmvcs", parseIgnore(""));
  for (const path of links.keys()) {
    assert.equal(isProtectedWorktreePath(repo.root, path, true), true, path);
    assert.equal(listed.includes(path), false, path);
    assert.throws(() => repo.stage([path]), { code: "path_ignored" }, path);
  }
  repo.stage([]);
  repo.commit({ message: "protect aliases\n", author }, now);
  const tree = flattenTree(repo.objects, repo.headTree());
  for (const path of links.keys()) assert.equal(tree.has(path), false, path);
  assert.equal(readFileSync(join(repo.controlDirectory, "sentinel"), "utf8"), "control\n");
  assert.equal(readFileSync(join(canonicalRoot, "..", "outside.txt"), "utf8"), "outside\n");
});

test("stored control trees cannot write, remove or prune nested control state or enter sparse indexes", () => {
  const repo = repository();
  const child = Repository.init(join(repo.root, "agent-a"));
  child.remotes.add("origin", "https://synthetic-token@example.invalid/repo");
  const credentials = readFileSync(join(child.controlDirectory, "credentials.json"));
  mkdirSync(join(repo.root, "a/b/.PmVcS/empty"), { recursive: true });
  writeFileSync(join(repo.root, "a/b/.PmVcS/sentinel"), "private\n");
  const paths = [".pmvcs/config.json", "agent-a/.pmvcs/credentials.json", "agent-a/.pmvcs/new", "a/b/.PmVcS/sentinel", "absent/deep/.PMVCS/new", "leaf/.pmvcs"];
  const tree = hostileTree(repo, [...paths, "public.txt"]);
  const id = repo.objects.write("blob", Buffer.from("private\n"));
  repo.writeIndex(paths.map((path) => ({ path, id, mode: "100644" as const })));
  repo.materialize(tree);
  assert.deepEqual(repo.readIndex().map((entry) => entry.path), ["public.txt"]);
  assert.deepEqual(readFileSync(join(child.controlDirectory, "credentials.json")), credentials);
  assert.equal(readFileSync(join(repo.root, "a/b/.PmVcS/sentinel"), "utf8"), "private\n");
  assert.equal(existsSync(join(repo.root, "absent")), false);
  assert.equal(existsSync(join(repo.root, "leaf")), false);
  repo.materialize(null);
  assert.deepEqual(readFileSync(join(child.controlDirectory, "credentials.json")), credentials);
  assert.equal(existsSync(join(repo.root, "a/b/.PmVcS/empty")), true);
  const missing = "e".repeat(64);
  repo.materialize(buildTree(repo.objects, new Map([["ghost/.PmVcS/secret", { id: missing, mode: "100644" }]])));
  assert.equal(existsSync(join(repo.root, "ghost")), false, "protected blobs are never read or materialized");
  // Exercise control-name pruning separately from the root control argument.
  assert.equal(pruneEmptyDirectories(repo.root, join(repo.root, "a/b"), "custom-control"), false);
  const tip = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "legacy hostile tree\n" });
  repo.refs.compareAndSwap("refs/heads/main", null, tip);
  repo.materialize(tree);
  repo.setView(["unrelated/**"]);
  repo.materialize(tree);
  assert.equal(repo.readIndex().some((entry) => isControlPath(entry.path)), false);
  repo.reset(tip, "mixed", now);
  assert.deepEqual(repo.readIndex().map((entry) => entry.path), ["public.txt"]);
  assert.equal(repo.status().staged.some((change) => isControlPath(change.path)), false);
  assert.equal(repo.status().unstaged.some((change) => isControlPath(change.path)), false);
});

test("restore preflights all paths and protects control state for present and absent source entries", () => {
  const repo = repository();
  const child = Repository.init(join(repo.root, "child"));
  writeFileSync(join(child.controlDirectory, "sentinel"), "private\n");
  writeFileSync(join(repo.root, "public.txt"), "local\n");
  symlinkSync("child/.pmvcs/sentinel", join(repo.root, "alias"));
  const tree = hostileTree(repo, ["child/.pmvcs/sentinel", "alias", "public.txt"]);
  const tip = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "legacy tree\n" });
  repo.refs.compareAndSwap("refs/heads/main", null, tip);
  for (const path of ["child/.pmvcs/sentinel", "alias", "child/.pmvcs/format", "child/.PMVCS/missing"]) {
    assert.throws(() => repo.restore(["public.txt", path], tip), { code: "path_ignored" });
    assert.equal(readFileSync(join(repo.root, "public.txt"), "utf8"), "local\n");
  }
  assert.equal(readFileSync(join(child.controlDirectory, "sentinel"), "utf8"), "private\n");
  assert.ok(existsSync(join(child.controlDirectory, "format")));
  assert.deepEqual(repo.restore(["public.txt"], tip), ["public.txt"]);
});

test("sparse view writes and removals fence legacy control and alias entries before reading blobs", () => {
  const repo = repository();
  const child = Repository.init(join(repo.root, "child"));
  writeFileSync(join(child.controlDirectory, "sentinel"), "private\n");
  symlinkSync("child/.pmvcs/sentinel", join(repo.root, "alias"));
  const id = "f".repeat(64); // Missing objects prove that fenced paths are not even read.
  for (const sparse of [true, false]) {
    repo.writeIndex(["child/.pmvcs/sentinel", "child/.PMVCS/format", "alias"].map((path) => ({ path, id, mode: "100644" as const, sparse })));
    repo.setView(sparse ? null : ["visible/**"]);
    assert.deepEqual(repo.readIndex(), []);
    assert.equal(readFileSync(join(child.controlDirectory, "sentinel"), "utf8"), "private\n");
    assert.equal(readlinkSync(join(repo.root, "alias")), "child/.pmvcs/sentinel");
  }
  repo.writeIndex([{ path: "alias/private", id, mode: "100644" }]);
  assert.deepEqual(repo.scan().dirty, []);
});

test("merge continuation refuses injected control entries without moving refs", () => {
  const repo = repository();
  repo.stage([]);
  const base = repo.commit({ message: "base\n", author }, now);
  writeFileSync(join(repo.controlDirectory, "MERGE_STATE"), JSON.stringify({ ours: base, theirs: base, base, revision: "side", conflicts: [], message: "merge\n", author, committer: author }));
  const id = repo.objects.write("blob", Buffer.from("private\n"));
  repo.writeIndex([...repo.readIndex(), { path: "nested/.pmvcs/secret", id, mode: "100644" }]);
  assert.throws(() => repo.mergeContinue(now), { code: "path_ignored" });
  assert.equal(repo.refs.resolveHead(), base);
  assert.ok(repo.readMergeState());
});
