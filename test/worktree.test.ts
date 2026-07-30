import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import {
  type IndexEntry,
  buildTree,
  computeStatus,
  decodeIndex,
  encodeIndex,
  flattenTree,
  listWorkingTree,
  materializeTree,
  normalizeRepoPath,
  readWorkingFile,
} from "../engine/worktree.ts";
import { writeTree } from "../engine/model.ts";
import type { IgnoreRules } from "../engine/ignore.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/** Empty ignore rules: nothing excluded except the always-ignored set. */
const noRules: IgnoreRules = { patterns: [], negations: [] };

/**
 * Creates a fresh store and root directory.
 *
 * @returns The store and repository root.
 */
function fresh(): { store: ObjectStore; root: string } {
  dir = makeTempDir();
  // The store lives under a control directory named `.pmvcs`, which the
  // working-tree walk skips, so object files never appear as untracked content.
  return { store: new ObjectStore(join(dir.root, ".pmvcs", "objects")), root: dir.root };
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

test("normalizeRepoPath canonicalises paths and rejects escapes", () => {
  dir = makeTempDir();
  const root = dir.root;
  assert.equal(normalizeRepoPath(root, "a/b"), "a/b");
  assert.equal(normalizeRepoPath(root, "./a/./b"), "a/b");
  assert.equal(normalizeRepoPath(root, `${root}/a`), "a");
  // The root itself is not a path inside the repo.
  assert.throws(
    () => normalizeRepoPath(root, "."),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "path_outside_repo",
  );
  // A path that resolves outside the repo must never reach a filesystem call.
  assert.throws(
    () => normalizeRepoPath(root, "../escape"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "path_outside_repo",
  );
});

test("encodeIndex and decodeIndex round-trip, sorted by path", () => {
  const entries: IndexEntry[] = [
    { path: "z.txt", id: "1".repeat(64), mode: "100644" },
    { path: "a.txt", id: "2".repeat(64), mode: "100755" },
  ];
  const encoded = encodeIndex(entries);
  // Sorted by path: a.txt (mode 100755, id 2s) before z.txt (mode 100644, id 1s).
  assert.match(encoded, /^100755 2{64} a\.txt\n100644 1{64} z\.txt$/);
  assert.deepEqual(decodeIndex(encoded), [...entries].sort((l, r) => (l.path < r.path ? -1 : 1)));
  assert.deepEqual(decodeIndex(""), []);
});

test("decodeIndex rejects a malformed line", () => {
  assert.throws(
    () => decodeIndex("garbage line"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
});

test("listWorkingTree skips the control directory and prunable directories", () => {
  dir = makeTempDir();
  const root = dir.root;
  mkdirSync(join(root, ".pmvcs"));
  writeFileSync(join(root, ".pmvcs", "config"), "x");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "pkg.js"), "x");
  writeFileSync(join(root, "tracked.txt"), "x");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "x");
  assert.deepEqual(listWorkingTree(root, ".pmvcs", noRules), ["src/a.ts", "tracked.txt"]);
});

test("readWorkingFile reads a regular file and reports its executable bit", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "plain"), "plain", { mode: 0o644 });
  writeFileSync(join(root, "exe"), "exe", { mode: 0o755 });
  assert.equal(readWorkingFile(root, "plain").executable, false);
  assert.equal(readWorkingFile(root, "exe").executable, true);
  assert.deepEqual(readWorkingFile(root, "plain").content, Buffer.from("plain"));
});

test("readWorkingFile reads a symlink's target rather than following it", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "target"), "the target");
  symlinkSync("target", join(root, "link"));
  // The link contributes its target text, not the linked file's content.
  assert.deepEqual(readWorkingFile(root, "link").content, Buffer.from("target"));
});

test("flattenTree and buildTree round-trip a nested structure", () => {
  const { store } = fresh();
  const blob = (text: string): ObjectId => store.write("blob", Buffer.from(text));
  const map = new Map<string, { id: ObjectId; mode: "100644" }>([
    ["readme.md", { id: blob("read"), mode: "100644" }],
    ["src/index.ts", { id: blob("idx"), mode: "100644" }],
    ["src/deep/nested.ts", { id: blob("nested"), mode: "100644" }],
  ]);
  const treeId = buildTree(store, map);
  const flat = flattenTree(store, treeId);
  assert.deepEqual([...flat.keys()].sort(), ["readme.md", "src/deep/nested.ts", "src/index.ts"]);
  assert.equal(flat.get("src/index.ts")?.id, blob("idx"));
  // An empty tree id flattens to nothing.
  assert.equal(flattenTree(store, null).size, 0);
});

test("materializeTree writes the tree, removes absent paths and prunes emptied directories", () => {
  const { store, root } = fresh();
  const aId = store.write("blob", Buffer.from("a"));
  const bId = store.write("blob", Buffer.from("b"));

  // Start the working tree with a.txt and dir/b.txt.
  const first = writeTree(store, [
    { name: "a.txt", mode: "100644", id: aId },
    { name: "dir", mode: "40000", id: writeTree(store, [{ name: "b.txt", mode: "100644", id: bId }]) },
  ]);
  materializeTree(store, root, first, ".pmvcs", noRules);
  assert.deepEqual(readFileSync(join(root, "a.txt"), "utf8"), "a");
  assert.deepEqual(readFileSync(join(root, "dir", "b.txt"), "utf8"), "b");

  // Switch to a tree that carries only a.txt: b.txt and the emptied dir vanish.
  const second = writeTree(store, [{ name: "a.txt", mode: "100644", id: aId }]);
  materializeTree(store, root, second, ".pmvcs", noRules);
  assert.deepEqual(readFileSync(join(root, "a.txt"), "utf8"), "a");
  assert.throws(() => readFileSync(join(root, "dir", "b.txt"), "utf8"));
  // The directory b.txt lived in is pruned, not left as a skeleton.
  assert.throws(() => readFileSync(join(root, "dir"), "utf8"));
});

test("materializeTree never writes to an ignored path even when the tree names one", () => {
  const { store, root } = fresh();
  // A tree that records node_modules/x.js — an always-ignored path — must not
  // materialise it, so switching onto it leaves that path absent.
  const ignored = store.write("blob", Buffer.from("ignored"));
  const tree = writeTree(store, [{ name: "node_modules", mode: "40000", id: writeTree(store, [{ name: "x.js", mode: "100644", id: ignored }]) }]);
  const entries = materializeTree(store, root, tree, ".pmvcs", noRules);
  // Nothing was written under the ignored directory.
  assert.equal(entries.length, 0);
  assert.throws(() => readFileSync(join(root, "node_modules", "x.js"), "utf8"));
});

test("computeStatus reports staged, unstaged, untracked and clean", () => {
  const { store, root } = fresh();
  const aId = store.write("blob", Buffer.from("a"));
  // HEAD carries a.txt; index matches it; working tree matches it -> clean.
  const headTree = writeTree(store, [{ name: "a.txt", mode: "100644", id: aId }]);
  const index: IndexEntry[] = [{ path: "a.txt", id: aId, mode: "100644" }];
  writeFileSync(join(root, "a.txt"), "a");

  let status = computeStatus(store, root, headTree, index, ".pmvcs", noRules);
  assert.equal(status.clean, true);

  // Stage a modification: b.txt added to the index but not in HEAD.
  const bId = store.write("blob", Buffer.from("b"));
  writeFileSync(join(root, "b.txt"), "b");
  status = computeStatus(store, root, headTree, [{ path: "a.txt", id: aId, mode: "100644" }, { path: "b.txt", id: bId, mode: "100644" }], ".pmvcs", noRules);
  assert.deepEqual(status.staged.map((c) => c.path), ["b.txt"]);
  assert.equal(status.clean, false);
  // b.txt was never in the real index, so remove it before the next assertion to
  // keep the untracked set attributable to the untracked.log file alone.
  rmSync(join(root, "b.txt"), { force: true });

  // An untracked file appears as untracked.
  writeFileSync(join(root, "untracked.log"), "noise");
  status = computeStatus(store, root, headTree, index, ".pmvcs", noRules);
  assert.deepEqual(status.untracked, ["untracked.log"]);

  // An unstaged modification to a tracked file.
  writeFileSync(join(root, "a.txt"), "changed");
  status = computeStatus(store, root, headTree, index, ".pmvcs", noRules);
  assert.deepEqual(status.unstaged.map((c) => c.path), ["a.txt"]);

  // A staged deletion: the file is gone from the working tree but still indexed.
  const goneTree = writeTree(store, [{ name: "gone.txt", mode: "100644", id: aId }]);
  status = computeStatus(store, root, goneTree, [], ".pmvcs", noRules);
  assert.deepEqual(status.staged.map((c) => c.kind), ["deleted"]);
});

test("computeStatus reports an unstaged deletion of an indexed file", () => {
  const { store, root } = fresh();
  const aId = store.write("blob", Buffer.from("a"));
  const headTree = writeTree(store, [{ name: "a.txt", mode: "100644", id: aId }]);
  writeFileSync(join(root, "a.txt"), "a");
  const index: IndexEntry[] = [{ path: "a.txt", id: aId, mode: "100644" }];
  // The indexed file has been removed from the working tree but not re-staged.
  rmSync(join(root, "a.txt"), { force: true });
  const status = computeStatus(store, root, headTree, index, ".pmvcs", noRules);
  assert.deepEqual(status.unstaged.map((c) => c.kind), ["deleted"]);
});

test("materializeTree preserves a prunable directory rather than pruning it", () => {
  const { store, root } = fresh();
  const aId = store.write("blob", Buffer.from("a"));
  const tree = writeTree(store, [{ name: "a.txt", mode: "100644", id: aId }]);
  // A node_modules directory exists in the working tree. materializeTree must not
  // prune it (it is reconstructible but not this tool's to delete), and must not
  // treat it as emptying the root.
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg.js"), "x");
  materializeTree(store, root, tree, ".pmvcs", noRules);
  // The prunable directory and its file survive the materialisation.
  assert.equal(readFileSync(join(root, "node_modules", "pkg.js"), "utf8"), "x");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a");
});

test("computeStatus treats an executable bit change as a modification", () => {
  const { store, root } = fresh();
  const aId = store.write("blob", Buffer.from("a"));
  const headTree = writeTree(store, [{ name: "a.txt", mode: "100644", id: aId }]);
  // The working file is now executable, so the mode differs from the index.
  writeFileSync(join(root, "a.txt"), "a", { mode: 0o755 });
  const index: IndexEntry[] = [{ path: "a.txt", id: aId, mode: "100644" }];
  const status = computeStatus(store, root, headTree, index, ".pmvcs", noRules);
  assert.deepEqual(status.unstaged.map((c) => c.path), ["a.txt"]);
});
