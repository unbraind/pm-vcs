import "./helpers/isolate-session.ts";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "../engine/repo.ts";
import { inferMoveSource, type MoveCandidate } from "../engine/moves.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { sourceCases, exerciseSourceCase } from "./helpers/move-source-corpus.ts";

for (const scenario of sourceCases) for (const bulk of [false, true]) test(`inferred move sources exclude intentional absence and private scope: ${scenario} ${bulk ? "bulk" : "selected"}`, () => {
  const scope = makeTempDir();
  try { const repo = Repository.init(scope.root); exerciseSourceCase(repo, scenario, paths => repo.stage(bulk ? [] : paths)); }
  finally { scope.cleanup(); }
});

test("shared inference ignores sparse candidates for every cardinality and preserves legacy visible evidence", () => {
  const scope = makeTempDir();
  try {
    const repo = Repository.init(scope.root); writeFileSync(join(scope.root, "live"), "payload\n"); repo.stage(["live"]);
    const visible = { ...repo.readIndex()[0], stat: undefined };
    const sparse = { ...visible, path: "hidden", fileId: "a".repeat(32), sparse: true };
    const other = { ...sparse, path: "other-hidden", fileId: "b".repeat(32) };
    for (const hidden of [[sparse], [sparse, other]]) for (const flag of [undefined, false]) {
      const inferred = new Map<string, MoveCandidate>();
      assert.equal(inferMoveSource(scope.root, "dest", hidden, inferred), undefined); assert.equal(inferred.size, 0);
      const legacy = { ...visible, sparse: flag, fileId: undefined };
      for (const candidates of [[...hidden, legacy], [legacy, ...hidden]]) {
        assert.deepEqual(inferMoveSource(scope.root, "dest", candidates, inferred), legacy); assert.equal(inferred.size, 0);
      }
    }
  } finally { scope.cleanup(); }
});


test("shared inference discards sparse candidates before probing unreadable ancestry", () => {
  const scope = makeTempDir(); const directory = join(scope.root, "locked"); mkdirSync(directory);
  const mode = lstatSync(directory).mode & 0o7777;
  try {
    const repo = Repository.init(scope.root); writeFileSync(join(directory, "source"), "distinct old payload\n"); repo.stage(["locked/source"]);
    repo.writeIndex(repo.readIndex().map(entry => ({ ...entry, stat: undefined }))); const original = repo.readIndex()[0];
    chmodSync(directory, 0o000); const inferred = new Map<string, MoveCandidate>();
    assert.equal(inferMoveSource(scope.root, "dest", [{ ...original, sparse: true }], inferred), undefined);
    assert.equal(inferred.size, 0);
  } finally { chmodSync(directory, mode); scope.cleanup(); }
});
