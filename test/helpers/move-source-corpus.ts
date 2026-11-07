/** One source-eligibility corpus reused by native and installed consumers. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repository } from "../../engine/repo.ts";

export const sourceCases = ["content", "inode", "content-with-live", "inode-before-live", "visible-move", "private", "ignored"] as const;
export type SourceCase = typeof sourceCases[number];

/** Preserve excluded identities while allowing visible copies/moves, including poisoned stat hints. */
export function exerciseSourceCase(repo: Repository, scenario: SourceCase, stage: (paths: string[]) => void): void {
  const author = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
  const payload = "shared native payload\n";
  const hiddenPayload = scenario === "inode-before-live" ? "unrelated hidden payload\n" : payload;
  writeFileSync(join(repo.root, "hidden"), hiddenPayload);
  const live = ["content-with-live", "inode-before-live", "visible-move"].includes(scenario);
  if (live) writeFileSync(join(repo.root, "live"), payload);
  repo.stage(live ? ["hidden", "live"] : ["hidden"]);
  repo.commit({ message: "base", author, items: ["source-fixture"] }, new Date(1));
  const source = repo.readIndex().find(entry => entry.path === "live");
  if (scenario === "private") repo.addLayer("private", new Map([["hidden", { content: Buffer.from(payload), executable: false }]]));
  else if (scenario === "ignored") writeFileSync(join(repo.root, ".pmvcsignore"), "hidden\n");
  else repo.setView(["live", "dest"]);
  if (scenario === "visible-move") unlinkSync(join(repo.root, "live"));
  writeFileSync(join(repo.root, "dest"), scenario === "inode" ? "new independent payload\n" : payload);
  const stat = lstatSync(join(repo.root, "dest"), { bigint: true });
  repo.writeIndex(repo.readIndex().map(entry => ({ ...entry, stat: entry.path === "hidden" && scenario.startsWith("inode")
    ? { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, observedAtNs: 0n } : undefined })));
  const hidden = repo.readIndex().find(entry => entry.path === "hidden")!;
  stage(["dest"]);
  const index = repo.readIndex(); const destination = index.find(entry => entry.path === "dest")!;
  assert.deepEqual(index.find(entry => entry.path === "hidden"), hidden, scenario + ": excluded entry must remain intact");
  assert.notEqual(destination.fileId, hidden.fileId, scenario + ": excluded identity must not be adopted");
  if (scenario === "visible-move") {
    assert.equal(destination.fileId, source!.fileId); assert.equal(index.some(entry => entry.path === "live"), false);
    assert.equal(destination.copiedFrom, source!.copiedFrom);
  } else {
    assert.equal(destination.copiedFrom, source?.fileId, scenario + ": provenance must use only an eligible source");
    if (source) assert.notEqual(destination.fileId, source.fileId);
  }
  repo.commit({ message: "new visible content", author, items: ["source-fixture"] }, new Date(1));
  if (scenario !== "private" && scenario !== "ignored") {
    repo.setView(null);
    assert.equal(existsSync(join(repo.root, "hidden")), true);
    assert.equal(readFileSync(join(repo.root, "hidden"), "utf8"), hiddenPayload);
    assert.equal(repo.readIndex().find(entry => entry.path === "hidden")?.fileId, hidden.fileId);
  }
  assert.equal(existsSync(join(repo.root, ".git")), false);
}
