import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Real benchmark and boundary fixtures keep the coverage contract over all scripts. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testTime } from "./support/depth.ts";
import { test } from "node:test";
import { countObjects, measureReuse, measureReuseByObjects, seededBytes } from "../scripts/cdc-benchmark.ts";
import { ObjectStore } from "../engine/objects.ts";
import { writeFragmented } from "../engine/fragments.ts";
import { isMainInvocation } from "../scripts/pm-environment.ts";
import { execFileSync } from "node:child_process";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

test("the complete benchmark CLI measures real CDC and fixed-size stores", () => {
  const entry = fileURLToPath(new URL("../scripts/cdc-benchmark.ts", import.meta.url));
  const output = execFileSync(process.execPath, [entry], {env: testEnvironment(), encoding: "utf8", timeout: testTime(600_000)});
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
    for (const path of ["package.json", "test/helpers/tmp.ts", "test/helpers/test-environment.ts", "test/helpers/isolate-session.ts", "scripts/cdc-benchmark.ts", "scripts/pm-environment.ts", "scripts/main-invocation.ts"]) {
      cpSync(join(packageRoot, path), join(alias, path));
    }
    symlinkSync(join(packageRoot, "engine"), join(alias, "engine"), "dir");
    symlinkSync(join(packageRoot, "node_modules"), join(alias, "node_modules"), "dir");
    const env = { ...testEnvironment() };
    delete env.NODE_TEST_CONTEXT;
    env.NODE_V8_COVERAGE = "";
    // Run the real CLI once from the space-containing checkout. Nesting the
    // complete test here repeated both full benchmark paths a second time.
    const entry = fileURLToPath(pathToFileURL(join(alias, "scripts/cdc-benchmark.ts")));
    const output = execFileSync(process.execPath, [entry], { env, encoding: "utf8", timeout: testTime(600_000) });
    assert.match(output, /Measured fixed-size reuse/);
  } finally { fixture.cleanup(); }
});
