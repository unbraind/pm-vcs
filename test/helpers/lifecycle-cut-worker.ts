/** Persistent isolated fixture owner; only the actual publication child receives SIGKILL. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
const { root, cache, scenario, entry, preloads } = JSON.parse(process.argv[2]) as { root: string; cache: string; entry: string; preloads: string[]; scenario: "retired-instance" | "interrupted-unpack" | "purge-journal" };
fs.mkdirSync(root, { recursive: true });
process.env.TMPDIR = root; process.env.TEMP = root; process.env.TMP = root; process.env.CRASH_COMPILE_CACHE = cache; process.env.CRASH_ENTRY = entry; process.env.CRASH_PRELOADS = JSON.stringify(preloads);
import { retiredPending, interruptedUnpack, purgeJournal, prepareTemplate, cleanupFixtures } from "./lifecycle-fixtures.ts";
import { objectFiles } from "../../engine/object-files.ts";
import { Repository } from "../../engine/repo.ts";
import { spawnSync } from "node:child_process";
import { testEnvironment } from "./test-environment.ts";
import { discardChildCoverage } from "./sandbox.ts";
import { packageRoot } from "./tmp.ts";
const prepare = scenario === "retired-instance" ? retiredPending : scenario === "purge-journal" ? purgeJournal : interruptedUnpack;
await prepareTemplate(scenario);
/** Keep successful probes and every killed child on exactly the same warmed entry point. */
function run(f: Awaited<ReturnType<typeof prepare>>, ordinal: number, source = false) {
  return spawnSync(process.execPath, [...(source ? [new URL("./forbid-git.ts", import.meta.url).href, new URL("./crash-child.ts", import.meta.url).href] : preloads).flatMap(path => ["--import", path]), source ? join(packageRoot, "test/helpers/erasure-purge-worker.ts") : entry, f.repo.root, f.second, String(ordinal)], { env: { ...testEnvironment(), ...discardChildCoverage(), CRASH_COMPILE_CACHE: cache, CRASH_TIMING: "1" }, stdio: ["ignore", "pipe", "pipe", "pipe"], encoding: "utf8", timeout: scenario === "interrupted-unpack" ? 120_000 : 30_000 });
}
process.send!({ ready: true });
process.on("message", async (message: { ordinal: number; steps?: string[] } | "close") => {
  if (message === "close") process.exit(0);
  const { ordinal, steps } = message;
  const cutRoot = fs.mkdtempSync(join(root, "cut-"));
  process.env.TMPDIR = cutRoot; process.env.TEMP = cutRoot; process.env.TMP = cutRoot;
  try {
    const start = performance.now(); const f = await prepare(); const prepared = performance.now();
    const childStart = performance.timeOrigin + prepared; const child = run(f, ordinal); const killed = performance.now();
    if (ordinal === 0) {
      assert.equal(child.status, 0, child.stderr);
      const original = run(await prepare(true), 0, true); assert.equal(original.status, 0, original.stderr);
      assert.deepEqual(JSON.parse(child.stdout), JSON.parse(original.stdout), "prepared entry point must preserve every source syscall boundary");
      process.send!({ steps: JSON.parse(original.stdout) }); return;
    }
    assert.equal(child.signal, "SIGKILL", `${ordinal}: ${child.stderr}`);
    f.repo.objects.recoverWriterLock();
    const receipt = f.repo.obliterate(f.second, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: scenario !== "retired-instance" });
    const recovered = performance.now();
    assert.equal(receipt.storage.accountable, true);
    if (scenario === "purge-journal") {
      assert.equal(receipt.purge.deleted + receipt.purge.observedAbsent, 1); assert.equal(receipt.purge.files.length, 1);
      const again = f.repo.obliterate(f.id, "erase-fixture", "incident", new Date(1)); assert.deepEqual(again.purge, receipt.purge);
    } else {
      const journal = JSON.parse(fs.readFileSync(join(f.repo.controlDirectory, "erasure-purge.json"), "utf8")) as { operations: Record<string, { status: string; reason?: string }[]> };
      if (scenario === "retired-instance") { assert.equal(journal.operations[f.id][0].status, "cancelled"); assert.equal(journal.operations[f.id][0].reason, "root_retired"); }
      else {
        f.repo.objects.withWriteLock(() => assert.equal([...f.repo.objects.walkErasureInventory()].some(entry => entry.id === (f as Awaited<ReturnType<typeof interruptedUnpack>>).selected), false));
        assert.deepEqual(f.repo.objects.readTyped(f.repo.readIndex().find(entry => entry.path === "second")!.id, "blob"), Buffer.from("selected second lifecycle payload 783629"));
        assert.equal(f.repo.obliterate(f.id, "erase-fixture", "incident", new Date(1)).tombstone, receipt.tombstone);
      }
    }
    assert.equal(f.repo.operations.read().filter(entry => entry.command === "obliterate").length, 1);
    assert.equal(objectFiles.active.size, 0);
    const [ready, fatal] = String(child.output[3]).trim().split("\n");
    const timing = JSON.parse(fatal) as { at: number; steps: string[] };
    assert.deepEqual(timing.steps, steps!.slice(0, ordinal), "the killed child must reach the complete recorded syscall prefix");
    process.send!({ ordinal, timing: { fixture: prepared - start, spawn: Number(ready) - childStart, preCut: timing.at - Number(ready), kill: performance.timeOrigin + killed - timing.at, recovery: recovered - killed, verification: performance.now() - recovered } });
  } catch (error) { process.send!({ error: error instanceof Error ? error.stack : String(error) }); }
  finally { try { cleanupFixtures(); } finally { fs.rmSync(cutRoot, { recursive: true, force: true }); process.env.TMPDIR = root; process.env.TEMP = root; process.env.TMP = root; } }
});
