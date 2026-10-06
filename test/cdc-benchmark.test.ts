/** Real benchmark and boundary fixtures keep the coverage contract over all scripts. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { countObjects, main, measureReuse, measureReuseByObjects, seededBytes } from "../scripts/cdc-benchmark.ts";
import { ObjectStore } from "../engine/objects.ts";
import { writeFragmented } from "../engine/fragments.ts";
import { isMainInvocation } from "../scripts/pm-environment.ts";
import { execFileSync } from "node:child_process";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

test("the complete benchmark measures real CDC and fixed-size stores", () => {
  main();
  // A URL's pathname keeps its percent escapes, so a checkout path with a space
  // in it would name a file that does not exist; the path conversion resolves it.
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/cdc-benchmark.ts", import.meta.url))], { encoding: "utf8" });
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


test("the benchmark test runs from a checkout path containing spaces", () => {
  const fixture = makeTempDir();
  try {
    const alias = join(fixture.root, "checkout with spaces");
    mkdirSync(join(alias, "test/helpers"), { recursive: true });
    mkdirSync(join(alias, "scripts"));
    for (const path of ["package.json", "test/cdc-benchmark.test.ts", "test/helpers/tmp.ts", "scripts/cdc-benchmark.ts", "scripts/pm-environment.ts"]) {
      cpSync(join(packageRoot, path), join(alias, path));
    }
    symlinkSync(join(packageRoot, "engine"), join(alias, "engine"), "dir");
    symlinkSync(join(packageRoot, "node_modules"), join(alias, "node_modules"), "dir");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    env.NODE_V8_COVERAGE = "";
    const output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^the complete benchmark", join(alias, "test/cdc-benchmark.test.ts")], { env, encoding: "utf8" });
    assert.match(output, /# fail 0/);
  } finally { fixture.cleanup(); }
});
