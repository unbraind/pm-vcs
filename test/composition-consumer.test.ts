/** Built and npm-packed acceptance against real SDK trackers under Node and Bun. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { withoutPmContext } from "../scripts/pm-environment.ts";

/** Identical consumer program exercises the built CLI harness and engine through package-owned imports. */
const consumer = `
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
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
const installedSdk = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"), "utf8"));
assert.equal(installedSdk.version, "2026.10.10");
assert.equal(Boolean(process.versions.bun), process.argv[2].startsWith("bun-"));
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
for (const caller of ["hub", "linked"]) {
  const hub = join(process.cwd(), process.argv[2] + "-custom-" + caller); mkdirSync(hub);
  const tracker = join(hub, "custom/team");
  await new PmClient({ cwd: hub, pmRoot: tracker, noExtensions: true }).init("custom", { defaults: true, author: "fixture" });
  Repository.init(hub); const custom = Repository.open(hub, tracker);
  custom.setAuthority("fixture", "custom-read", "custom-erase"); assert.deepEqual(custom.config.recordPaths, []);
  const selected = Buffer.from("packed-custom-" + caller + "-selected-marker-928463");
  writeFileSync(join(hub, "secret.bin"), selected); custom.stage(["secret.bin"]); custom.commit({ message: "custom", author }, new Date());
  const sibling = hub + "-sibling"; custom.linkInstance("shared", sibling);
  const siblingTracker = join(sibling, "custom/team");
  await new PmClient({ cwd: sibling, pmRoot: siblingTracker, noExtensions: true }).init("custom", { defaults: true, author: "fixture" });
  const runtimePaths = ["runtime/cache", "search/cache", "locks/item.lock", "transactions/state", "checkpoints/point"];
  for (const root of [tracker, siblingTracker]) for (const path of runtimePaths) {
    mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), selected);
  }
  const invoked = Repository.open(caller === "hub" ? hub : sibling, caller === "hub" ? tracker : siblingTracker);
  for (const root of [hub, sibling]) {
    const copy = join(root, "unrelated/custom/team/runtime/cache"); mkdirSync(join(copy, ".."), { recursive: true }); writeFileSync(copy, selected);
    assert.throws(/** Ordinary same-named folders cannot inherit the active tracker exemption. */ () => invoked.obliterate("secret.bin", "custom-erase", "incident", new Date()), /** Verify the typed pre-denial refusal. */ error => error.code === "erasure_worktree_conflict");
    assert.deepEqual(custom.objects.denials(), []); assert.deepEqual(readFileSync(copy), selected); rmSync(join(root, "unrelated"), { recursive: true });
  }
  invoked.obliterate("secret.bin", "custom-erase", "incident", new Date());
  for (const root of [hub, sibling]) assert.equal(existsSync(join(root, "secret.bin")), false);
  for (const root of [tracker, siblingTracker]) for (const path of runtimePaths) assert.deepEqual(readFileSync(join(root, path)), selected);
}
for (const deniedSide of ["base", "ours", "theirs"]) {
  const mergedRepo = Repository.init(join(process.cwd(), process.argv[2] + "-merge-" + deniedSide));
  const pmRoot = join(mergedRepo.root, ".agents/pm");
  await new PmClient({ cwd: mergedRepo.root, pmRoot, noExtensions: true }).init("merge", { defaults: true, author: "fixture" });
  mergedRepo.setAuthority("fixture", "merge-read", "merge-erase"); mergedRepo.identity();
  mergedRepo.stage([]); mergedRepo.commit({ message: "tracker", author }, new Date());
  const record = bytes => { writeFileSync(join(mergedRepo.root, "p"), bytes); mergedRepo.stage(["p"]); mergedRepo.commit({ message: "file", author }, new Date()); };
  if (deniedSide === "base") record("terminal consumer base 846319");
  const base = mergedRepo.refs.resolveHead(); mergedRepo.createBranch("left", base, new Date()); mergedRepo.createBranch("right", base, new Date());
  if (deniedSide !== "base") { mergedRepo.switchTo(deniedSide === "ours" ? "left" : "right", new Date()); record("terminal consumer side 846319"); }
  const terminal = mergedRepo.readIndex().find(entry => entry.path === "p"); mergedRepo.obliterate("p", "merge-erase", "incident", new Date());
  const denials = readFileSync(join(mergedRepo.controlDirectory, "denials.json"));
  for (const branch of ["left", "right"]) {
    if (deniedSide === "ours" && branch === "left" || deniedSide === "theirs" && branch === "right") continue;
    mergedRepo.switchTo(branch, new Date());
    if (deniedSide === "base") mergedRepo.writeIndex(mergedRepo.readIndex().filter(entry => entry.path !== "p"));
    record("unrelated consumer " + branch); assert.notEqual(mergedRepo.readIndex().find(entry => entry.path === "p").fileId, terminal.fileId);
  }
  mergedRepo.switchTo("left", new Date()); const ours = mergedRepo.readIndex().find(entry => entry.path === "p");
  let result;
  if (process.argv[2] === "node-global-cli") {
    const version = spawnSync("pm", ["--version"], { encoding: "utf8" }); assert.equal(version.status, 0); assert.equal(version.stdout.trim(), installedSdk.version);
    const installed = spawnSync("pm", ["package", "install", process.argv[3], "--project"], { cwd: mergedRepo.root, encoding: "utf8" }); assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    const merged = spawnSync("pm", ["--json", "vcs", "merge", "right", "--message", "denied merge"], { cwd: mergedRepo.root, encoding: "utf8" });
    assert.equal(merged.status, 0, merged.stderr + merged.stdout); result = JSON.parse(merged.stdout).merge;
  } else result = mergedRepo.merge("right", { message: "denied merge", author }, new Date());
  assert.equal(result.clean, false); assert.ok(result.conflicts.some(conflict => conflict.path === "p" && conflict.reason === "content"));
  const retained = mergedRepo.readIndex().find(entry => entry.path === "p"); assert.equal(retained.id, ours.id); assert.equal(retained.fileId, ours.fileId);
  if (deniedSide === "ours") assert.equal(existsSync(join(mergedRepo.root, "p")), false);
  else assert.equal(readFileSync(join(mergedRepo.root, "p"), "utf8"), "unrelated consumer left");
  assert.deepEqual(readFileSync(join(mergedRepo.controlDirectory, "denials.json")), denials);
}
process.stdout.write(JSON.stringify({ runtime: process.argv[2], sdk: installedSdk.version, linked: true, layers: true, erased: true, clone: true, deniedMerge: true }));
`;

test("built and npm-packed SDK10 Node/native Bun consumers and global CLI execute composition and denied merges", /** Use a packed artifact and real peer dependency instead of SDK doubles. */ () => {
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
    for (const [runtime, script, scenario] of [[process.execPath, "built.mjs", "node-built"], [process.execPath, "packed.mjs", "node-packed"], ["bun", "built.mjs", "bun-built"], ["bun", "packed.mjs", "bun-packed"], [process.execPath, "packed.mjs", "node-global-cli"]]) {
      const result = spawnSync(runtime, [script, scenario, archive], { cwd: project, env: { ...withoutPmContext(process.env), ...discardChildCoverage() }, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`); assert.deepEqual(JSON.parse(result.stdout), { runtime: scenario, sdk: "2026.10.10", linked: true, layers: true, erased: true, clone: true, deniedMerge: true });
    }
  } finally { temporary.cleanup(); }
});
