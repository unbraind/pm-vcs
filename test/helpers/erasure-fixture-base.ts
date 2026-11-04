/** Cache only completed SDK/control initialization; every cut still stages its original payload. */
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../../engine/repo.ts";
import { makeTempDir } from "./tmp.ts";
const bases = new Map<string, string>();
/** Native initialization remains the same public SDK and repository path as ordinary fixtures. */
async function initialize(root: string, project: string): Promise<Repository> {
  await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init(project, { defaults: true, author: "fixture" });
  const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture"); return repo;
}
/** Cached copies are synchronous so their native writes stay inside one temporary-namespace turn. */
export function erasureFixtureBase(root: string, project: string): Repository | Promise<Repository> {
  const base = bases.get(project);
  if (base === undefined) return initialize(root, project);
  cpSync(base, root, { recursive: true }); return Repository.open(root);
}
/** Keep payload generation and staging per cut, preserving the original random corpus and consumption order. */
export async function withErasureFixtureBase<T>(project: string, run: () => Promise<T>): Promise<T> {
  assert.equal(bases.has(project), false); const dir = makeTempDir();
  try { await initialize(dir.root, project); bases.set(project, dir.root); return await run(); }
  finally { bases.delete(project); dir.cleanup(); }
}
