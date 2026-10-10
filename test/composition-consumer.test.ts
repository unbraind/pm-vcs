/** Built and npm-packed acceptance against real SDK trackers under Node and Bun. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";

/** Identical consumer program exercises the built CLI harness and engine through package-owned imports. */
const consumer = `
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "pm-vcs";
import { Repository } from "pm-vcs/dist/engine/repo.js";
import { authorize, encodeLink } from "pm-vcs/dist/engine/composition.js";
import { cloneFrom } from "pm-vcs/dist/engine/sync.js";
import { FileTransport } from "pm-vcs/dist/engine/transport.js";
const root = join(process.cwd(), process.argv[2]); mkdirSync(root);
const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents", "pm"), noExtensions: true });
await client.init("consumer", { defaults: true, author: "fixture" });
const repo = Repository.init(root); repo.identity(); repo.setAuthority("fixture", "consumer-read", "consumer-erase");
const author = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
repo.stage([]); repo.commit({ message: "tracker", author }, new Date());
const target = Repository.init(join(process.cwd(), process.argv[2] + "-target")); target.setAuthority("target", "target-read", "target-erase");
writeFileSync(join(target.root, "asset.bin"), Buffer.from([0, 255, 128, 19, 47])); target.stage(["asset.bin"]);
const pin = target.commit({ message: "pin", author }, new Date());
const link = { version: 1, repository: target.identity(), revision: pin, mappings: [{ source: "asset.bin", destination: "vendor/asset.bin" }] };
const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
assert.equal(JSON.parse(readFileSync(join(repo.controlDirectory, "authority.json"), "utf8")).version, 2);
const newRead = join(process.cwd(), process.argv[2] + ".new-read"); const newErase = join(process.cwd(), process.argv[2] + ".new-erase"); const currentErase = join(process.cwd(), process.argv[2] + ".current-erase");
writeFileSync(newRead, "consumer-read-next"); writeFileSync(newErase, "consumer-erase-next"); writeFileSync(currentErase, "consumer-erase");
const rotationOptions = { principal: "rotated", readTokenFile: newRead, eraseTokenFile: newErase };
const beforeGrant = readFileSync(join(repo.controlDirectory, "authority.json"));
for (const extra of [{}, { regenerateLegacy: true }, { currentEraseTokenFile: newErase }]) {
  const refused = await harness.runCommand({ command: "vcs authority", pmRoot: join(root, ".agents/pm"), options: { ...rotationOptions, ...extra } });
  assert.ok(refused.errorMessage); assert.deepEqual(readFileSync(join(repo.controlDirectory, "authority.json")), beforeGrant);
}
const rotation = await harness.runCommand({ command: "vcs authority", pmRoot: join(root, ".agents/pm"), options: { ...rotationOptions, currentEraseTokenFile: currentErase } });
assert.equal(rotation.errorMessage, undefined); assert.equal(authorize(repo.controlDirectory, "erase", "consumer-erase-next"), "rotated");
repo.setAuthority("fixture", "consumer-read", "consumer-erase", { currentEraseCredential: "consumer-erase-next" });
repo.addLayer("ordinary-path", new Map([["src/search/a.txt", { content: Buffer.from("ordinary path overlay"), executable: false }]]));
assert.equal(readFileSync(join(root, "src/search/a.txt"), "utf8"), "ordinary path overlay"); repo.removeLayer("ordinary-path");
const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); assert.equal(dead.status, 0);
writeFileSync(join(repo.controlDirectory, "objects.lock"), dead.stdout);
const recovered = await harness.runCommand({ command: "vcs recover-lock", pmRoot: root }); assert.equal(recovered.errorMessage, undefined); assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
const legacy = Repository.init(join(process.cwd(), process.argv[2] + "-legacy"));
assert.equal((await new FileTransport(legacy.root, legacy.root).advertise()).repositoryId, undefined); assert.equal(existsSync(join(legacy.controlDirectory, "identity")), false);
const spec = join(process.cwd(), process.argv[2] + ".link.json"); writeFileSync(spec, encodeLink(link));
const staged = await harness.runCommand({ command: "vcs link", args: ["dependency.link"], pmRoot: root, options: { spec } }); assert.equal(staged.errorMessage, undefined);
repo.commit({ message: "descriptor", author }, new Date());
writeFileSync(join(target.root, "asset.bin"), "branch moved"); target.stage(["asset.bin"]); target.commit({ message: "move", author }, new Date());
repo.resolveLink("dependency.link", target, "target-read", "resolved"); assert.deepEqual(readFileSync(join(root, "vendor/asset.bin")), Buffer.from([0, 255, 128, 19, 47]));
assert.equal(repo.status().excludedLayers[0].name, "resolved"); assert.throws(/** Explicit staging remains masked in the real consumer. */ () => repo.stage(["vendor/asset.bin"]), /** Assert the stable typed refusal. */ error => error.code === "layer_excluded"); repo.stage([]); repo.removeLayer("resolved");
const retired = join(process.cwd(), process.argv[2] + "-retired");
repo.linkInstance("retired", retired); repo.unlinkInstance("retired"); rmSync(retired, { recursive: true });
const pruneToken = join(process.cwd(), process.argv[2] + ".prune-token"); writeFileSync(pruneToken, "consumer-erase");
const pruned = await harness.runCommand({ command: "vcs instance prune-retired", args: ["../" + process.argv[2] + "-retired"], pmRoot: root, options: { eraseTokenFile: pruneToken, reason: "retired" } });
assert.equal(pruned.errorMessage, undefined); assert.equal(repo.operations.read().at(-1).command, "prune-retired-instance");
writeFileSync(join(root, "secret.bin"), "consumer unique permanent bytes 638529"); repo.stage(["secret.bin"]); const revision = repo.commit({ message: "secret", author }, new Date());
const token = join(process.cwd(), process.argv[2] + ".erase-token"); writeFileSync(token, "consumer-erase");
writeFileSync(join(repo.controlDirectory, "objects.lock"), dead.stdout); writeFileSync(token, "wrong-consumer-erase");
const denied = await harness.runCommand({ command: "vcs obliterate", args: ["secret.bin"], pmRoot: root, options: { eraseTokenFile: token, reason: "incident", recoverLock: true } });
assert.match(String(denied.errorMessage), /authority|credential|Unauthorized/i); assert.equal(readFileSync(join(repo.controlDirectory, "objects.lock"), "utf8"), dead.stdout);
writeFileSync(token, "consumer-erase");
const erased = await harness.runCommand({ command: "vcs obliterate", args: ["secret.bin"], pmRoot: root, options: { eraseTokenFile: token, reason: "incident", recoverLock: true } }); assert.equal(erased.errorMessage, undefined);
assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
assert.equal(repo.readFileState(revision, "secret.bin").kind, "obliterated"); assert.deepEqual(repo.verify().corrupt, []);
const clone = Repository.open((await cloneFrom(root, join(process.cwd(), process.argv[2] + "-clone"), new Date())).root);
assert.equal(clone.identity(), repo.identity()); assert.equal(clone.readFileState(revision, "secret.bin").kind, "obliterated"); assert.equal(clone.links()[0].link.revision, pin);
process.stdout.write(JSON.stringify({ runtime: process.argv[2], linked: true, layers: true, erased: true, clone: true }));
`;

test("built package and npm-packed Node/Bun consumers execute links, layers, erasure and intentional-absence clone", /** Use a packed artifact and real peer dependency instead of SDK doubles. */ () => {
  const temporary = makeTempDir();
  try {
    const npmEnvironment = { ...process.env, ...discardChildCoverage() };
    for (const key of Object.keys(npmEnvironment)) if (key.toLowerCase() === "npm_config_allow_scripts") delete npmEnvironment[key];
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary.root], { cwd: packageRoot, env: npmEnvironment, encoding: "utf8", timeout: 120_000 });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = join(temporary.root, packed.stdout.trim().split(/\r?\n/).at(-1)!);
    const project = join(temporary.root, "consumer"); mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "composition-consumer", private: true, type: "module" }));
    const installed = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archive], { cwd: project, env: npmEnvironment, encoding: "utf8", timeout: 120_000 });
    assert.equal(installed.status, 0, installed.stderr);
    // The consumer uses the actual pinned SDK and its installed dependency graph.
    symlinkSync(join(packageRoot, "node_modules", "@unbrained"), join(project, "node_modules", "@unbrained"), "junction");
    const design = readFileSync(join(project, "node_modules", "pm-vcs", "docs", "links-layers-obliteration.md"), "utf8"); assert.match(design, /Typed obliteration/);
    assert.match(design, /--current-erase-token-file/); assert.doesNotMatch(design, /PR[0-9]+|Review ID|Verified disposition|Renewed finding|source-only/);
    const built = consumer.replace('from "pm-vcs"', `from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist", "index.js")).href)}`).replaceAll(/"pm-vcs\/dist\/([^" ]+)"/g, /** Bind the same consumer to built files for direct built-package acceptance. */ (_match, path: string) => JSON.stringify(pathToFileURL(join(packageRoot, "dist", path)).href));
    writeFileSync(join(project, "built.mjs"), built); writeFileSync(join(project, "packed.mjs"), consumer);
    for (const [runtime, script, scenario] of [[process.execPath, "built.mjs", "node-built"], [process.execPath, "packed.mjs", "node-packed"], ["bun", "packed.mjs", "bun-packed"]]) {
      const result = spawnSync(runtime, [script, scenario], { cwd: project, env: { ...process.env, ...discardChildCoverage() }, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`); assert.deepEqual(JSON.parse(result.stdout), { runtime: scenario, linked: true, layers: true, erased: true, clone: true });
    }
  } finally { temporary.cleanup(); }
});
