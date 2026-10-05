/** Real benchmark and boundary fixtures keep the coverage contract over all scripts. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { countObjects, main, measureReuse, measureReuseByObjects, seededBytes } from "../scripts/cdc-benchmark.ts";
import { ObjectStore } from "../engine/objects.ts";
import { writeFragmented } from "../engine/fragments.ts";
import { isMainInvocation } from "../scripts/pm-environment.ts";
import { execFileSync } from "node:child_process";
import { makeTempDir } from "./helpers/tmp.ts";

test("the complete benchmark measures real CDC and fixed-size stores", () => {
  main();
  const output = execFileSync(process.execPath, [new URL("../scripts/cdc-benchmark.ts", import.meta.url).pathname], { encoding: "utf8" });
  assert.match(output, /Measured fixed-size reuse/);
});
test("benchmark empty stores, directory noise and invocation identity are measured", () => {
  const fixture = makeTempDir();
  try {
    const store = new ObjectStore(join(fixture.root, "objects"));
    mkdirSync(join(fixture.root, "objects", "noise"), { recursive: true });
    mkdirSync(join(fixture.root, "objects", "noise", "nested"));
    writeFileSync(join(fixture.root, "objects", "stray"), "noise");
    writeFileSync(join(fixture.root, "objects", "noise", "pending.tmp"), "noise");
    assert.equal(countObjects(fixture.root), 0);
    assert.equal(measureReuseByObjects(store, fixture.root, Buffer.alloc(0), 0, 0, () => {}).reuseFraction, 1);
    assert.equal(measureReuseByObjects(store, fixture.root, seededBytes(16, 1), 0, 1, (s, c) => { writeFragmented(s, c, 4); }).totalFragments > 0, true);
    assert.equal(measureReuse(store, Buffer.alloc(0), 0, 0, () => ({ manifestId: "empty", manifest: { fragments: [] } })).reuseFraction, 1);
    assert.equal(isMainInvocation([], import.meta.url), false);
    assert.equal(isMainInvocation(["node", import.meta.filename], import.meta.url), true);
    assert.equal(isMainInvocation(["node", import.meta.filename], new URL("../scripts/cdc-benchmark.ts", import.meta.url).href), false);
  } finally { fixture.cleanup(); }
});
