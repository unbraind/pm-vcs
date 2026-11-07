import "./helpers/isolate-session.ts";
/** Legacy index entries still obey the current instance's source boundary. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Repository } from "../engine/repo.ts";
import { makeTempDir } from "./helpers/tmp.ts";

test("legacy entries without sparse markers cannot supply identity outside the active view", () => {
  for (const sparse of [undefined, false]) {
    const scope = makeTempDir();
    try {
      const repo = Repository.init(scope.root); writeFileSync(join(scope.root, "hidden"), "legacy payload\n"); repo.stage(["hidden"]);
      repo.setView(["dest"]); repo.writeIndex(repo.readIndex().map(entry => ({ ...entry, sparse, stat: undefined })));
      const hidden = repo.readIndex()[0]; writeFileSync(join(scope.root, "dest"), "legacy payload\n");
      const before = readFileSync(join(repo.controlDirectory, "index"));
      assert.throws(() => repo.stage(["dest"], undefined, [{ fileId: hidden.fileId!, path: "dest" }]), { code: "invalid_move_intent" });
      assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), before);
      repo.stage(["dest"]);
      assert.deepEqual(repo.readIndex().find(entry => entry.path === "hidden"), hidden);
      const destination = repo.readIndex().find(entry => entry.path === "dest")!;
      assert.notEqual(destination.fileId, hidden.fileId); assert.equal(destination.copiedFrom, undefined);
    } finally { scope.cleanup(); }
  }
});
