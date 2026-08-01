import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import {
  type IndexEntry,
  buildTree,
  computeStatus,
  decodeIndex,
  encodeIndex,
  flattenTree,
  isCanonicalRepoPath,
  listWorkingTree,
  materializeTree,
  normalizeRepoPath,
  readWorkingFile,
  sameIndexStat,
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
  assert.equal(normalizeRepoPath(root, "back\\slash.txt"), sep === "\\" ? "back/slash.txt" : "back\\slash.txt");
  assert.equal(isCanonicalRepoPath("back\\slash.txt", "/"), true);
  assert.equal(isCanonicalRepoPath("back\\slash.txt", "\\"), false);
  assert.equal(isCanonicalRepoPath("nul\0path", "/"), false);
  assert.throws(
    () => normalizeRepoPath(root, "nul\0path"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "path_outside_repo",
  );
});

test("encodeIndex and decodeIndex round-trip cached metadata in path order", () => {
  const entries: IndexEntry[] = [
    {
      path: "z.txt",
      id: "1".repeat(64),
      mode: "100644",
      stat: { size: 3n, mtimeNs: -4n, ctimeNs: -5n, dev: 6n, ino: 7n, observedAtNs: 1_000_000_005n },
    },
    { path: "a.txt", id: "2".repeat(64), mode: "100755" },
  ];
  const encoded = encodeIndex(entries);
  assert.equal(encoded.split("\n")[0], "pm-vcs-index 2");
  // Sorted by path: a.txt (mode 100755, id 2s) before z.txt (mode 100644, id 1s).
  assert.deepEqual(encoded.split("\n").slice(1).map((line) => JSON.parse(line)[2]), ["a.txt", "z.txt"]);
  assert.deepEqual(decodeIndex(encoded), [...entries].sort((l, r) => (l.path < r.path ? -1 : 1)));
  assert.deepEqual(decodeIndex(""), []);
  const backslashEntry = { path: "back\\slash", id: "1".repeat(64), mode: "100644" as const };
  if (sep !== "\\") assert.deepEqual(decodeIndex(encodeIndex([backslashEntry])), [backslashEntry]);
  assert.throws(
    () => encodeIndex([{ ...backslashEntry, path: "../outside" }]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
  assert.throws(
    () => encodeIndex([backslashEntry, backslashEntry]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
});

test("decodeIndex reads the legacy format and refuses malformed or future indexes", () => {
  assert.deepEqual(
    decodeIndex(`100644 ${"1".repeat(64)} path with spaces.txt\n\n`),
    [{ path: "path with spaces.txt", id: "1".repeat(64), mode: "100644" }],
  );
  assert.deepEqual(decodeIndex("pm-vcs-index 2\n"), []);
  assert.throws(
    () => decodeIndex("garbage line"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
  assert.throws(
    () => decodeIndex("pm-vcs-index 3"),
    (error: unknown) => error instanceof ObjectStoreError
      && error.code === "unsupported_index_version"
      && /version 3/.test(error.message),
  );
  for (const line of [
    "not-json",
    JSON.stringify(["100644"]),
    JSON.stringify(["100600", "1".repeat(64), "a.txt", null]),
    JSON.stringify(["100644", "1".repeat(64), "a.txt", ["1", "2"]]),
    JSON.stringify(["100644", "1".repeat(64), "a.txt", ["-1", "2", "3", "4", "5", "6"]]),
    ...["/absolute", "../outside", "a//b", "a/./b", "a/../b"].map((path) =>
      JSON.stringify(["100644", "1".repeat(64), path, null])),
  ]) {
    assert.throws(
      () => decodeIndex(`pm-vcs-index 2\n${line}`),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
    );
  }
  assert.throws(
    () => decodeIndex(`100644 ${"1".repeat(64)} ../outside`),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
  assert.throws(
    () => decodeIndex(`100644 ${"1".repeat(64)} duplicate\n100755 ${"2".repeat(64)} duplicate`),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
  const duplicateV2 = JSON.stringify(["100644", "1".repeat(64), "duplicate", null]);
  assert.throws(
    () => decodeIndex(`pm-vcs-index 2\n${duplicateV2}\n${duplicateV2}`),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_index",
  );
  if (sep !== "\\") {
    assert.deepEqual(
      decodeIndex(`100644 ${"1".repeat(64)} back\\slash`),
      [{ path: "back\\slash", id: "1".repeat(64), mode: "100644" }],
    );
  }
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
  if (sep !== "\\") {
    writeFileSync(join(root, "back\\slash"), "x");
    assert.deepEqual(listWorkingTree(root, ".pmvcs", noRules), ["back\\slash", "src/a.ts", "tracked.txt"]);
  }
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

test("readWorkingFile returns cache metadata when identity is stable across the read", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "stable"), "stable");
  assert.ok(readWorkingFile(root, "stable").stat);
});

test("readWorkingFile records the final observation of a stable read", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "slow-stable"), "stable");
  const observations = [10n, 20n];
  assert.equal(readWorkingFile(root, "slow-stable", () => observations.shift()!).stat?.observedAtNs, 20n);
});

test("readWorkingFile omits metadata when the file changes during the read", () => {
  dir = makeTempDir();
  const root = dir.root;
  const path = join(root, "changing");
  writeFileSync(path, "before");
  let observations = 0;
  const result = readWorkingFile(root, "changing", () => {
    if (observations++ === 0) writeFileSync(path, "longer-after");
    return BigInt(observations);
  });
  assert.equal(result.stat, undefined);
  assert.deepEqual(result.content, Buffer.from("longer-after"));
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

test("computeStatus does not read unchanged cached file content", () => {
  const { store, root } = fresh();
  const path = join(root, "large.bin");
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024, 7));
  const content = readFileSync(path);
  const id = store.write("blob", content);
  const file = statSync(path, { bigint: true });
  const tree = writeTree(store, [{ name: "large.bin", mode: "100644", id }]);
  const index: IndexEntry[] = [{
    path: "large.bin",
    id,
    mode: "100644",
    stat: {
      size: file.size,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs,
      dev: file.dev,
      ino: file.ino,
      observedAtNs: (file.ctimeNs > file.mtimeNs ? file.ctimeNs : file.mtimeNs) + 2_000_000_000n,
    },
  }];

  const actualNow = Date.now;
  Date.now = () => actualNow() + 5_000;
  try {
    const status = computeStatus(store, root, tree, index, ".pmvcs", noRules, undefined, () => {
      throw new Error("content reader must not run for a cache hit");
    });
    assert.equal(status.clean, true);
  } finally {
    Date.now = actualNow;
  }
});

test("sameIndexStat rejects current racy observations and detects ctime changes", () => {
  const stable = {
    size: 6n,
    mtimeNs: 10n,
    ctimeNs: 20n,
    dev: 30n,
    ino: 40n,
    observedAtNs: 2_000_000_020n,
  };
  assert.equal(sameIndexStat(
    { ...stable, observedAtNs: 1_000_000_020n },
    { ...stable, observedAtNs: 5_000_000_020n },
  ), false);
  assert.equal(sameIndexStat(stable, { ...stable, observedAtNs: 2_000_000_019n }), false);
  assert.equal(sameIndexStat(stable, { ...stable, observedAtNs: 3_000_000_020n }), false);
  assert.equal(sameIndexStat(stable, { ...stable, ctimeNs: 21n, observedAtNs: 4_000_000_020n }), false);
  assert.equal(sameIndexStat(stable, { ...stable, observedAtNs: 4_000_000_020n }), true);
});

test("computeStatus detects a same-size edit even when its mtime is restored", () => {
  const { store, root } = fresh();
  const path = join(root, "racy.txt");
  writeFileSync(path, "before");
  const fixed = new Date(Math.floor((Date.now() - 5_000) / 1_000) * 1_000);
  utimesSync(path, fixed, fixed);
  const original = statSync(path, { bigint: true });
  const id = store.write("blob", Buffer.from("before"));
  const tree = writeTree(store, [{ name: "racy.txt", mode: "100644", id }]);
  writeFileSync(path, "after!");
  utimesSync(path, fixed, fixed);
  const changed = statSync(path, { bigint: true });
  assert.equal(changed.size, original.size);
  assert.equal(changed.mtimeNs, original.mtimeNs);
  const index: IndexEntry[] = [{
    path: "racy.txt",
    id,
    mode: "100644",
    stat: {
      size: original.size,
      mtimeNs: original.mtimeNs,
      ctimeNs: original.ctimeNs,
      dev: original.dev,
      ino: original.ino,
      observedAtNs: BigInt(Date.now()) * 1_000_000n,
    },
  }];

  const status = computeStatus(store, root, tree, index, ".pmvcs", noRules);
  assert.deepEqual(status.unstaged, [{ path: "racy.txt", kind: "modified" }]);
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

test("computeStatus reports multiple unstaged changes, exercising the sort comparator", () => {
  const { store, root } = fresh();
  const aId = store.write("blob", Buffer.from("a"));
  const bId = store.write("blob", Buffer.from("b"));
  const headTree = writeTree(store, [
    { name: "a.txt", mode: "100644", id: aId },
    { name: "b.txt", mode: "100644", id: bId },
  ]);
  const index: IndexEntry[] = [
    { path: "a.txt", id: aId, mode: "100644" },
    { path: "b.txt", id: bId, mode: "100644" },
  ];
  // Both files differ in the working tree → 2 unstaged modifications.
  writeFileSync(join(root, "a.txt"), "modified-a");
  writeFileSync(join(root, "b.txt"), "modified-b");
  const status = computeStatus(store, root, headTree, index, ".pmvcs", noRules);
  assert.equal(status.unstaged.length, 2);
  assert.deepEqual(
    status.unstaged.map((c) => c.path),
    ["a.txt", "b.txt"],
  );
});
