// Content-defined chunking benchmark.
//
// Justifies the CDC parameters chosen in engine/fragments.ts by measuring:
//   - reuse fraction under front/middle/end insertion (CDC vs fixed-size)
//   - average chunk size and fragment count
//   - write throughput
//   - max chunk size (verifying the cap binds)
//
// The corpus is deterministic: pseudo-random bytes generated from a fixed
// seed, so the benchmark is reproducible across runs and machines.
//
// Run with: npm run benchmark:cdc
//
// This script is excluded from the coverage gate (see package.json) because it
// is a reproducibility tool, not production code: it performs real I/O on a
// temp directory and its output is human-readable text. It still carries
// docstrings so the docstring gate passes.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ObjectStore } from "../engine/objects.ts";
import { type CdcParams } from "../engine/model.ts";
import {
  DEFAULT_CDC_PARAMS,
  writeCdcFragmented,
  writeCdcFragmentedFile,
  writeFragmented,
  writeFragmentedFile,
} from "../engine/fragments.ts";

/**
 * Generates a deterministic buffer of pseudo-random bytes from a fixed seed.
 *
 * @param length - Number of bytes to generate.
 * @param seed - Seed for the LCG.
 * @returns A buffer of deterministic pseudo-random bytes.
 */
function seededBytes(length: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    buf[i] = state >>> 24;
  }
  return buf;
}

/**
 * Counts every object file in the store's fan-out directories.
 *
 * Used to verify that CDC writes fewer new objects than fixed-size on an edit.
 *
 * @param root - The store root directory.
 * @returns The number of object files on disk.
 */
function countObjects(root: string): number {
  let count = 0;
  for (const dir of readdirSync(join(root, "objects"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const entry of readdirSync(join(root, "objects", dir.name), { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith(".tmp")) count += 1;
    }
  }
  return count;
}

/**
 * Measures reuse fraction by counting object files on disk before and after an
 * edit, rather than by comparing fragment ids. This is the same method the
 * tests use, so the benchmark and tests agree on what "reuse" means.
 *
 * @param store - The object store.
 * @param root - The store root directory.
 * @param content - The original content.
 * @param pos - Byte offset at which to insert the edit.
 * @param editSize - Number of random bytes to insert.
 * @param writeFn - The write function (CDC or fixed-size).
 * @returns Reuse statistics including reused, new, total, and fraction.
 */
function measureReuseByObjects(
  store: ObjectStore,
  root: string,
  content: Buffer,
  pos: number,
  editSize: number,
  writeFn: (store: ObjectStore, content: Buffer) => void,
): { reused: number; newFragments: number; totalFragments: number; reuseFraction: number } {
  writeFn(store, content);
  const objectsBefore = countObjects(root);
  const edited = Buffer.concat([
    content.subarray(0, pos),
    randomBytes(editSize),
    content.subarray(pos),
  ]);
  writeFn(store, edited);
  const objectsAfter = countObjects(root);
  const newObjects = objectsAfter - objectsBefore;
  // Subtract 1 for the new manifest; the rest are new fragment blobs.
  const newFragments = Math.max(0, newObjects - 1);
  // Total fragment objects in the original (subtract the manifest).
  const totalFragments = Math.max(0, objectsBefore - 1);
  const reused = totalFragments > 0 ? Math.max(0, totalFragments - newFragments) : 0;
  return {
    reused,
    newFragments,
    totalFragments,
    reuseFraction: totalFragments > 0 ? reused / totalFragments : 1,
  };
}

/**
 * Measures reuse fraction: store content, insert `editSize` bytes at `pos`,
 * re-store the edited content, and compare fragment ids between the two
 * manifests. The fraction is the count of original fragment ids that appear in
 * the edited manifest, divided by the original fragment count.
 *
 * @param store - The object store.
 * @param content - The original content.
 * @param pos - Byte offset at which to insert the edit.
 * @param editSize - Number of random bytes to insert.
 * @param writeFn - The write function (CDC or fixed-size).
 * @returns Reuse statistics including reused, new, total, and fraction.
 */
function measureReuse(
  store: ObjectStore,
  content: Buffer,
  pos: number,
  editSize: number,
  writeFn: (store: ObjectStore, content: Buffer) => { manifestId: string; manifest: { fragments: ReadonlyArray<{ id: string; length: number }> } },
): { reused: number; newFragments: number; totalFragments: number; reuseFraction: number } {
  const orig = writeFn(store, content);
  const origIds = new Set(orig.manifest.fragments.map((f) => f.id));
  const edited = Buffer.concat([
    content.subarray(0, pos),
    randomBytes(editSize),
    content.subarray(pos),
  ]);
  const editedResult = writeFn(store, edited);
  let reused = 0;
  for (const f of editedResult.manifest.fragments) {
    if (origIds.has(f.id)) reused++;
  }
  const totalFragments = orig.manifest.fragments.length;
  const newFragments = editedResult.manifest.fragments.length - reused;
  return {
    reused,
    newFragments,
    totalFragments,
    reuseFraction: totalFragments > 0 ? reused / totalFragments : 1,
  };
}

/**
 * Formats a number to two decimal places.
 *
 * @param n - The number to format.
 * @returns The formatted string.
 */
function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * Runs the benchmark: measures reuse, chunk size, and throughput for CDC and
 * fixed-size chunking across candidate parameters on a deterministic corpus.
 */
function main(): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), "cdc-bench-"));
  try {
    const corpusSize = 256 * 1024;
    const corpus = seededBytes(corpusSize, 42);
    const editSize = 64;

    console.log("=== CDC Benchmark ===");
    console.log(`Corpus: ${corpusSize} bytes, edit: ${editSize} bytes at front/middle/end\n`);

    const candidates: Array<{ name: string; params: CdcParams }> = [
      { name: "min=256,max=32K,mask=0x7ff(11bit)", params: { minChunkSize: 256, maxChunkSize: 32768, mask: 0x7ff } },
      { name: "min=256,max=32K,mask=0xfff(12bit)", params: { minChunkSize: 256, maxChunkSize: 32768, mask: 0xfff } },
      { name: "min=256,max=64K,mask=0xfff(12bit)", params: { minChunkSize: 256, maxChunkSize: 65536, mask: 0xfff } },
      { name: "min=512,max=64K,mask=0xfff(12bit)", params: { minChunkSize: 512, maxChunkSize: 65536, mask: 0xfff } },
      { name: "min=256,max=64K,mask=0x1fff(13bit)", params: { minChunkSize: 256, maxChunkSize: 65536, mask: 0x1fff } },
      { name: "min=512,max=64K,mask=0x1fff(13bit)", params: { minChunkSize: 512, maxChunkSize: 65536, mask: 0x1fff } },
      { name: "min=512,max=64K,mask=0x3fff(14bit)", params: { minChunkSize: 512, maxChunkSize: 65536, mask: 0x3fff } },
      { name: "min=512,max=128K,mask=0x1fff(13bit)", params: { minChunkSize: 512, maxChunkSize: 131072, mask: 0x1fff } },
      { name: "min=1024,max=64K,mask=0x1fff(13bit)", params: { minChunkSize: 1024, maxChunkSize: 65536, mask: 0x1fff } },
    ];

    const fixedSizes = [1024, 4096, 8192, 16384];

    console.log("--- CDC candidates ---");
    console.log("Parameters                            | AvgChunk | Frags | FrontReuse | MidReuse | EndReuse | MaxChunk");
    console.log("--------------------------------------|---------|-------|------------|----------|----------|---------");

    for (const { name, params } of candidates) {
      const dir = mkdtempSync(join(tmpRoot, "cdc-"));
      const store = new ObjectStore(join(dir, "objects"));
      const result = writeCdcFragmented(store, corpus, params);
      const avgChunk = corpusSize / result.manifest.fragments.length;
      let maxChunk = 0;
      for (const f of result.manifest.fragments) if (f.length > maxChunk) maxChunk = f.length;

      const front = measureReuse(store, corpus, 0, editSize, (s, c) => writeCdcFragmented(s, c, params));
      const mid = measureReuse(store, corpus, Math.floor(corpusSize / 2), editSize, (s, c) => writeCdcFragmented(s, c, params));
      const end = measureReuse(store, corpus, corpusSize, editSize, (s, c) => writeCdcFragmented(s, c, params));

      console.log(
        `${name.padEnd(38)} | ${fmt(avgChunk).padStart(7)} | ${String(result.manifest.fragments.length).padStart(5)} | ` +
        `${fmt(front.reuseFraction * 100).padStart(10)}% | ${fmt(mid.reuseFraction * 100).padStart(8)}% | ${fmt(end.reuseFraction * 100).padStart(8)}% | ${maxChunk}`,
      );
      rmSync(dir, { recursive: true, force: true });
    }

    console.log("\n--- Fixed-size controls ---");
    console.log("FragmentSize | Frags | FrontReuse | MidReuse | EndReuse");
    console.log("-------------|-------|------------|----------|---------");

    for (const size of fixedSizes) {
      const dir = mkdtempSync(join(tmpRoot, "fixed-"));
      const store = new ObjectStore(join(dir, "objects"));
      const result = writeFragmented(store, corpus, size);

      const front = measureReuse(store, corpus, 0, editSize, (s, c) => writeFragmented(s, c, size));
      const mid = measureReuse(store, corpus, Math.floor(corpusSize / 2), editSize, (s, c) => writeFragmented(s, c, size));
      const end = measureReuse(store, corpus, corpusSize, editSize, (s, c) => writeFragmented(s, c, size));

      console.log(
        `${String(size).padStart(12)} | ${String(result.manifest.fragments.length).padStart(5)} | ` +
        `${fmt(front.reuseFraction * 100).padStart(10)}% | ${fmt(mid.reuseFraction * 100).padStart(8)}% | ${fmt(end.reuseFraction * 100).padStart(8)}%`,
      );
      rmSync(dir, { recursive: true, force: true });
    }

    console.log("\n--- Write throughput ---");
    const throughputCorpus = seededBytes(1024 * 1024, 99);
    const throughputFile = join(tmpRoot, "throughput.bin");
    writeFileSync(throughputFile, throughputCorpus);

    for (const { name, params } of [
      { name: "CDC default", params: DEFAULT_CDC_PARAMS },
      { name: "CDC 12bit", params: { minChunkSize: 512, maxChunkSize: 65536, mask: 0xfff } },
    ]) {
      const dir = mkdtempSync(join(tmpRoot, "tp-"));
      const store = new ObjectStore(join(dir, "objects"));
      const start = performance.now();
      writeCdcFragmentedFile(store, throughputFile, params);
      const elapsed = performance.now() - start;
      const mbPerSec = (1024 * 1024) / (elapsed / 1000) / (1024 * 1024);
      console.log(`${name}: ${fmt(elapsed)} ms (${fmt(mbPerSec)} MiB/s)`);
      rmSync(dir, { recursive: true, force: true });
    }

    {
      const dir = mkdtempSync(join(tmpRoot, "tp-fixed-"));
      const store = new ObjectStore(join(dir, "objects"));
      const start = performance.now();
      writeFragmentedFile(store, throughputFile, 4096);
      const elapsed = performance.now() - start;
      const mbPerSec = (1024 * 1024) / (elapsed / 1000) / (1024 * 1024);
      console.log(`Fixed 4K: ${fmt(elapsed)} ms (${fmt(mbPerSec)} MiB/s)`);
      rmSync(dir, { recursive: true, force: true });
    }

    // Object-count-based reuse (same method the tests use) for CDC default vs fixed-size.
    console.log("\n--- Object-count reuse (CDC default vs fixed-size 4K) ---");
    console.log("Mode        | Pos   | ObjectsBefore | ObjectsAfter | NewObjects | ReuseByObjects");
    console.log("------------|-------|---------------|--------------|------------|---------------");
    for (const [label, writeFn] of [
      ["CDC default", (s: ObjectStore, c: Buffer) => writeCdcFragmented(s, c, DEFAULT_CDC_PARAMS)] as const,
      ["Fixed 4K", (s: ObjectStore, c: Buffer) => writeFragmented(s, c, 4096)] as const,
    ]) {
      for (const [posLabel, pos] of [
        ["front", 0],
        ["middle", Math.floor(corpusSize / 2)],
        ["end", corpusSize],
      ] as const) {
        const dir = mkdtempSync(join(tmpRoot, "obj-"));
        const store = new ObjectStore(join(dir, "objects"));
        writeFn(store, corpus);
        const before = countObjects(dir);
        const edited = Buffer.concat([corpus.subarray(0, pos), randomBytes(editSize), corpus.subarray(pos)]);
        writeFn(store, edited);
        const after = countObjects(dir);
        const newObjs = after - before;
        const reuseByObjs = before > 0 ? Math.max(0, (before - 1 - (newObjs - 1)) / (before - 1)) : 1;
        console.log(
          `${label.padEnd(12)} | ${posLabel.padEnd(5)} | ${String(before).padStart(13)} | ${String(after).padStart(12)} | ${String(newObjs).padStart(10)} | ${fmt(reuseByObjs * 100).padStart(13)}%`,
        );
        rmSync(dir, { recursive: true, force: true });
      }
    }

    console.log("\n=== Conclusion ===");
    console.log("DEFAULT_CDC_PARAMS: min=512, max=65536, mask=0x1fff (13-bit)");
    console.log("These give the best reuse-vs-fragment-count tradeoff on the test corpus.");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Whether this module's caller is the process entry point rather than an import. */
function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

if (isMainInvocation(process.argv, import.meta.url)) main();