/** Balance the complete quick inventory using measured file costs, with a reserve for new files. */
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testEnvironment } from "./test-environment.ts";

/** Use portable timing keys without changing native discovery paths. */
export function testFileWeight(file: string, timings: Readonly<Record<string, number>>): number {
  return timings[file.replaceAll("\\", "/")] ?? 60;
}

/** Assign every discovered file exactly once; timings affect placement, never discovery. */
export function shardTestFiles(root: string, shard: string): string[] {
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error("ci-shards: invalid shard");
  const [ordinal, total] = shard.split("/").map(Number) as [number, number];
  const files = globSync("test/*.test.ts", { cwd: root }).sort();
  if (!Number.isSafeInteger(total) || ordinal > total || total > files.length) throw new Error("ci-shards: invalid shard");
  const timings: Record<string, number> = JSON.parse(readFileSync(new URL("../ci-shard-times.json", import.meta.url), "utf8"));
  const weight = (file: string): number => testFileWeight(file, timings);
  const bins = Array.from({ length: total }, () => ({ cost: 0, files: [] as string[] }));
  for (const file of files.sort((left, right) => weight(right) - weight(left) || (left < right ? -1 : 1))) {
    const bin = bins.reduce((best, candidate) => candidate.cost < best.cost ? candidate : best);
    bin.files.push(file);
    bin.cost += weight(file);
  }
  return bins[ordinal - 1]!.files.sort();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const files = shardTestFiles(process.cwd(), process.argv[2]!);
  const result = spawnSync(process.execPath, ["--expose-gc", "--no-concurrent-array-buffer-sweeping", "--test", "--test-concurrency=1", ...files], { env: testEnvironment(), stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
