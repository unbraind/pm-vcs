import { durability } from "../engine/durability.ts";
/** Public-tracker-only benchmark; reports aggregate sizes and warm verified-read latency, never item contents. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../engine/repo.ts";
import { collectGarbage } from "../engine/gc.ts";

/** Median and p95 of a deterministic verified object-read schedule. */
function latency(repo: Repository, ids: readonly string[], samples: number) {
  const times: number[] = [];
  for (let i = 0; i < samples + 20; i++) {
    const start = performance.now(); repo.objects.read(ids[(i * 7919) % ids.length]);
    if (i >= 20) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { samples, medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.ceil(samples * 0.95) - 1] };
}
/** Measure exact physical bytes and filesystem allocation separately; packs trade index bytes for fewer files. */
function storage(repo: Repository) {
  const paths = new Set([...repo.objects.walkInventory()].map((item) => item.path));
  let bytes = 0; let allocatedBytes = 0;
  for (const path of paths) { const stat = statSync(path); bytes += stat.size; allocatedBytes += stat.blocks * 512; }
  return { files: paths.size, bytes, allocatedBytes };
}
/** Copy the caller-approved public tracker into an isolated non-git project, then compare every logical object and GC. */
export function benchmarkIndexedPacks(tracker: string, samples = 301) {
  const scratch = mkdtempSync(join(tmpdir(), "pm-vcs-packs-"));
  try {
    cpSync(tracker, join(scratch, ".agents/pm"), { recursive: true });
    const repo = Repository.init(scratch, "main", { recordPaths: [".agents/pm/**/*.toon"], recordPolicy: {} });
    repo.stage([]);
    assert.ok(repo.readIndex().length > 0, "Benchmark needs nonempty public tracker records.");
    repo.commit({ message: "public tracker pack benchmark", author: { name: "Benchmark", email: "benchmark@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
    const original = new Map([...repo.objects.walkInventory()].map((item) => [item.id, { type: item.object.type, payload: item.object.payload }]));
    const ids = [...original.keys()].sort();
    const loose = { ...storage(repo), read: latency(repo, ids, samples) };
    const receipt = repo.objects.compact();
    const packed = { ...storage(repo), read: latency(repo, ids, samples) };
    for (const [id, expected] of original) assert.deepEqual(repo.objects.read(id), expected);
    const gc = collectGarbage(repo, true);
    for (const [id, expected] of original) assert.deepEqual(repo.objects.read(id), expected);
    return { trackerFiles: repo.readIndex().length, objects: ids.length, loose, packed, compaction: receipt, gcRemoved: gc.removed, verifiedReads: original.size * 2 };
  } finally { durability.remove(scratch, { recursive: true, force: true }); }
}
