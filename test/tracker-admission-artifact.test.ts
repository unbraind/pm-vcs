import "./helpers/isolate-session.ts";
/** Actual npm packaging of a disposable fixture proves the install validator rebuilds stale output. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { trackerAdmissionArtifact } from "./helpers/tracker-admission-artifact.ts";
import { makeTempDir } from "./helpers/tmp.ts";

test("install validator packages newly built bytes even when dist is stale or absent", () => {
  const scope = makeTempDir();
  try {
    const root = scope.root; mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "source.txt"), "fresh built artifact"); writeFileSync(join(root, "dist/index.js"), "stale artifact");
    writeFileSync(join(root, "build.cjs"), "require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').copyFileSync('source.txt','dist/index.js');");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "admission-build-fixture", version: "1.0.0", files: ["dist"], scripts: { build: "node build.cjs", prepack: "node -e process.exit(91)" } }));
    const destination = join(root, "packs"); mkdirSync(destination);
    const artifact = trackerAdmissionArtifact(root, destination);
    assert.match(artifact.digest, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(root, "dist/index.js"), "utf8"), "fresh built artifact");
    assert.equal(execFileSync("tar", ["-xOf", artifact.archive, "package/dist/index.js"], { encoding: "utf8" }), "fresh built artifact");
  } finally { scope.cleanup(); }
});
