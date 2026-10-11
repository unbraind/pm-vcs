/** Real child heap ceiling rejects behaviorally correct full-list materialization. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ManifestWriter } from "../engine/manifest-pages.ts";
import { ObjectStore } from "../engine/objects.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
const dirs: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) dir.cleanup(); });
const count = 1_048_577;
for (const format of ["v1", "paged"] as const) {
  test(`${format} read and range retain bounded metadata in a real 48 MiB heap process over ${count} fragments`, () => {
    const dir = makeTempDir(); dirs.push(dir);
    const root = join(dir.root, "objects"); const store = new ObjectStore(root);
    const fragment = store.write("blob", Buffer.from("x"));
    let id: string;
    if (format === "v1") {
      const payload = Buffer.from(`pm-vcs-manifest 1\ntotal ${count}\n` + `frag ${fragment} 1\n`.repeat(count));
      id = store.write("manifest", payload);
    } else {
      id = store.withWriteLock(() => {
        const writer = new ManifestWriter(store);
        for (let i = 0; i < count; i++) writer.add({ id: fragment, length: 1 });
        return writer.finish().manifestId;
      });
    }
    for (const operation of ["read", "range"]) {
      const destination = join(dir.root, operation);
      const result = spawnSync(process.execPath, ["--max-old-space-size=48", "--expose-gc", join(packageRoot, "test/helpers/manifest-memory-worker.ts"), root, id, operation, destination, String(count)],
        { env: { ...process.env }, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 20 });
      assert.equal(result.status, 0, `${format} ${operation}: ${result.signal ?? result.error ?? "nonzero exit"}; ${result.stderr.slice(-5000)}`);
      const measurement = JSON.parse(readFileSync(destination + ".measurement.json", "utf8")) as { maximumHeap: number; samples: number };
      assert.equal(measurement.samples, 1); assert.ok(measurement.maximumHeap < 48 * 1024 * 1024);
      if (operation === "read") { assert.equal(statSync(destination).size, count); assert.ok(readFileSync(destination).every(byte => byte === 120)); }
      process.stdout.write(`${format} ${operation}: live heap ${measurement.maximumHeap} bytes, ${count} logical entries, 48 MiB ceiling\n`);
    }
  });
}
