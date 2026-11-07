import "./helpers/isolate-session.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { alignFileMoves } from "../engine/merge-moves.ts";
import { Repository } from "../engine/repo.ts";
import type { flattenTree } from "../engine/worktree.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { chainAuthor, prepareRenameChain } from "./helpers/rename-chain.ts";

type FlatTree = ReturnType<typeof flattenTree>;
/** Enumerate the complete small path/insertion-order domain rather than rely on PRNG luck. */
function permutations<T>(values: readonly T[]): T[][] { return values.length === 0 ? [[]] : values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest])); }
/** Project logical roles so filesystem spelling cannot influence the expected model. */
function roles(tree: FlatTree, names: readonly string[]): unknown { return [...tree].map(([path, entry]) => [names.indexOf(path), entry]).sort((a, b) => Number(a[0]) - Number(b[0])); }

test("rename chains decide against original occupancy for every path, insertion and side order", (t) => {
  let cells = 0;
  for (const size of [2, 3]) for (const names of permutations(["a", "b", "c", "d"].slice(0, size + 1))) for (const order of permutations(Array.from({ length: size }, (_, i) => i))) for (const reverse of [false, true]) {
    const entries = Array.from({ length: size }, (_, i) => ({ id: String(i + 1).repeat(64), mode: "100644" as const, fileId: String(i + 1).repeat(32) }));
    const base: FlatTree = new Map(order.map(i => [names[i], entries[i]])); const moved: FlatTree = new Map(order.map(i => [names[i + 1], entries[i]]));
    const unchanged = new Map(base); const trees = [base, reverse ? unchanged : moved, reverse ? moved : unchanged];
    const expected = trees.map(tree => new Map(tree));
    // Only the tail destination was originally vacant. Earlier links remain conflicts.
    for (const tree of expected) { tree.delete(names[size - 1]); tree.set(names[size], entries[size - 1]); }
    // The moved side already owns the tail, and the preceding identity occupies its old path.
    expected[reverse ? 2 : 1] = new Map(moved);
    const conflicts = alignFileMoves(trees[0], trees[1], trees[2]);
    assert.deepEqual(conflicts.map(path => names.indexOf(path)).sort(), Array.from({ length: size - 1 }, (_, i) => i + 1));
    for (const [i, tree] of trees.entries()) assert.deepEqual(roles(tree, names), roles(expected[i], names));
    cells++;
  }
  assert.equal(cells, 312); t.diagnostic(`${cells} exhaustive chain cells`);
});

test("accepted moves snapshot all input entries before writing aliased tree maps", () => {
  const entry = { id: "a".repeat(64), mode: "100644" as const, fileId: "b".repeat(32) };
  for (const reverse of [false, true]) {
    const base: FlatTree = new Map([["old", entry]]); const moved: FlatTree = new Map([["new", entry]]);
    assert.deepEqual(alignFileMoves(base, reverse ? base : moved, reverse ? moved : base), []);
    assert.deepEqual([...base], [["new", entry]]); assert.deepEqual([...moved], [["new", entry]]);
  }
});

test("native merge and replay retain occupied-chain conflicts under path and side permutations", (t) => {
  let cells = 0;
  for (const names of [["a", "b", "c"], ["b", "a", "c"]]) for (const side of ["ours", "theirs"] as const) for (const operation of ["merge", "record", "rebase"] as const) {
    const scope = makeTempDir();
    try {
      const repo = Repository.init(scope.root); const other = prepareRenameChain(repo, names, side);
      if (operation === "rebase") assert.throws(() => repo.rebase(other, "HEAD", chainAuthor, new Date(1)), { code: "rewrite_conflict" });
      else if (operation === "record") { const before = repo.refs.resolveHead(); assert.throws(() => repo.merge(other, { message: "merge", author: chainAuthor, recordConflicts: true }, new Date(1)), { code: "unsupported_recorded_conflict" }); assert.equal(repo.refs.resolveHead(), before); }
      else { const result = repo.merge(other, { message: "merge", author: chainAuthor }, new Date(1)); assert.equal(result.clean, false); assert.ok(result.conflicts.some(conflict => conflict.path === names[1] && conflict.reason === "identity")); }
      assert.equal(existsSync(join(scope.root, ".git")), false); cells++;
    } finally { scope.cleanup(); }
  }
  assert.equal(cells, 12); t.diagnostic(`${cells} native merge/replay cells`);
});
