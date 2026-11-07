/** Real native branches used by SDK and installed CLI merge consumers. */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repository } from "../../engine/repo.ts";

export const chainAuthor = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };

/** Build a valid recorded chain and an independently edited branch without Git. */
export function prepareRenameChain(repo: Repository, names: readonly string[], side: "ours" | "theirs"): string {
  for (const [i, path] of names.slice(0, -1).entries()) writeFileSync(join(repo.root, path), `identity ${i}\n`);
  writeFileSync(join(repo.root, "keep"), "base\n"); repo.stage([...names.slice(0, -1), "keep"]);
  repo.commit({ message: "base", author: chainAuthor }, new Date(1)); repo.createBranch("edit", "HEAD", new Date(1));
  const index = repo.readIndex();
  for (let i = names.length - 2; i >= 0; i--) renameSync(join(repo.root, names[i]), join(repo.root, names[i + 1]));
  repo.writeIndex(index.map(entry => { const i = names.indexOf(entry.path); return i < 0 ? entry : { ...entry, path: names[i + 1], stat: undefined }; }));
  repo.commit({ message: "recorded chain", author: chainAuthor }, new Date(1));
  repo.switchTo("edit", new Date(1)); writeFileSync(join(repo.root, "keep"), "independent edit\n"); repo.stage(["keep"]);
  repo.commit({ message: "other branch", author: chainAuthor }, new Date(1));
  if (side === "ours") { repo.switchTo("main", new Date(1)); return "edit"; }
  return "main";
}
