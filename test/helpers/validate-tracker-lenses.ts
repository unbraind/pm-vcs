/** Manual public-data acceptance: pass two extracted tracker snapshots, never a live or private tracker. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { Repository } from "../../engine/repo.ts";
import { explainChange, TRACKER_LENSES, type ChangeStatement } from "../../engine/tracker-lenses.ts";

/** Hash every carried tracker file and count bytes without interpreting or printing its contents. */
function inventory(root: string, prefix = ""): { files: number; bytes: number; items: number; history: number; digest: string } {
  const hash = createHash("sha256"); let files = 0; let bytes = 0; let items = 0; let history = 0;
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      const nested = inventory(root, path); files += nested.files; bytes += nested.bytes; items += nested.items; history += nested.history;
      hash.update(path).update(nested.digest);
    } else {
      assert.ok(entry.isFile()); const content = readFileSync(join(root, path));
      files++; bytes += content.length; items += path.endsWith(".toon") ? 1 : 0;
      history += path.startsWith("history/") && path.endsWith(".jsonl") ? content.toString("utf8").trim().split("\n").filter(Boolean).length : 0;
      hash.update(path).update(content);
    }
  }
  return { files, bytes, items, history, digest: hash.digest("hex") };
}
/** Freeze the copied tracker only; native object state lives outside this directory. */
function readonly(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) readonly(path); else chmodSync(path, 0o444);
  }
  chmodSync(root, 0o555);
}

const [base, tip] = process.argv.slice(2);
assert.ok(base && tip, "Pass two public snapshot directories containing .agents/pm");
const root = mkdtempSync(join(tmpdir(), "pm-vcs-public-lenses-"));
const tracker = join(root, ".agents/pm");
const client = new PmClient({ cwd: root, pmRoot: tracker, noExtensions: true });
await client.init("public-copy", { defaults: true, author: "fixture" });
rmSync(tracker, { recursive: true }); cpSync(join(base, ".agents/pm"), tracker, { recursive: true });
const repository = Repository.init(root, "main", { recordPaths: [".agents/pm/**/*.toon"], recordPolicy: {} });
const author = { name: "fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
repository.stage([]); repository.commit({ message: "public base snapshot", author }, new Date(1000));
rmSync(tracker, { recursive: true }); cpSync(join(tip, ".agents/pm"), tracker, { recursive: true });
repository.stage([]); const revision = repository.commit({ message: "public tip snapshot", author }, new Date(2000));
readonly(tracker); assert.equal(existsSync(join(root, ".git")), false);
const before = inventory(tracker);
const started = performance.now(); const rows: ChangeStatement[] = []; let offset = 0; let pages = 0; let maxJsonBytes = 0;
do {
  const page = explainChange(repository.objects, revision, { lenses: TRACKER_LENSES, limit: 20, offset });
  maxJsonBytes = Math.max(maxJsonBytes, Buffer.byteLength(JSON.stringify(page))); rows.push(...page.statements); pages++;
  if (page.nextOffset === null) break; offset = page.nextOffset;
} while (true);
const durationMs = Math.round((performance.now() - started) * 100) / 100;
assert.deepEqual(inventory(tracker), before);
const lenses: Record<string, number> = {};
for (const row of rows) {
  lenses[row.lens] = (lenses[row.lens] ?? 0) + 1;
  for (const citation of [row.before, row.after]) if (citation) assert.ok(repository.objects.has(citation.object));
}
console.log(JSON.stringify({ source: before, statements: rows.length, pages, maxJsonBytes, durationMs, lenses,
  trackerBytesUnchanged: true, gitRepository: false }, null, 2));
