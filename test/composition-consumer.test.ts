/** Built and npm-packed acceptance against real SDK trackers under Node and Bun. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { pmExecutable, withoutPmContext } from "../scripts/pm-environment.ts";

/** Identical consumer program exercises the built CLI harness and engine through package-owned imports. */
const consumer = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "pm-vcs";
import { Repository } from "pm-vcs/dist/engine/repo.js";
import { writeFragmented, writeFragmentedFile, writeFragmentsFromFd, writeCdcFragmented, writeCdcFragmentedFile, writeCdcFragmentsFromFd, readFragmented } from "pm-vcs/dist/engine/fragments.js";
import { writeManifest, encodeRecord, migratedFileId } from "pm-vcs/dist/engine/model.js";
import { mergeTrees } from "pm-vcs/dist/engine/rewrite.js";
import { buildTree, flattenTree } from "pm-vcs/dist/engine/worktree.js";
import { authorize, encodeLink } from "pm-vcs/dist/engine/composition.js";
import { cloneFrom } from "pm-vcs/dist/engine/sync.js";
import { FileTransport } from "pm-vcs/dist/engine/transport.js";
import { exportBundle, importBundleObjects, serializeBundle } from "pm-vcs/dist/engine/bundle.js";
const installedSdk = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"), "utf8"));
assert.equal(installedSdk.version, "2026.10.10");
const cliExecutable = process.argv[4];
if (process.argv[2] === "node-project-cli") {
  const version = spawnSync(process.execPath, [cliExecutable, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, "Project-installed PM CLI unavailable before fixture setup: " + (version.error?.message ?? version.stderr + version.stdout));
  assert.equal(version.stdout.trim(), installedSdk.version, "Project-installed PM CLI version mismatch before fixture setup: expected " + installedSdk.version + ", got " + version.stdout.trim());
}
const root = join(process.cwd(), process.argv[2]); mkdirSync(root);
const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents", "pm"), noExtensions: true });
await client.init("consumer", { defaults: true, author: "fixture" });
const repo = Repository.init(root); repo.identity(); repo.setAuthority("fixture", "consumer-read", "consumer-erase");
const author = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
assert.equal(Boolean(process.versions.bun), process.argv[2].startsWith("bun-"));
repo.stage([]); const publicationBase = repo.commit({ message: "tracker", author }, new Date());
writeFileSync(join(root, "publication.bin"), Buffer.from([0, 255, 17])); repo.stage(["publication.bin"]);
const publicationTip = repo.commit({ message: "publication", author }, new Date());
const publicationWire = new FileTransport(root, root);
const emptyPublication = serializeBundle(repo.objects, { refs: {}, prerequisites: [], objects: [] });
for (const mode of ["push", "publish"]) {
  const updates = [{ ref: "refs/heads/" + mode + "-one", expected: null, next: publicationTip }, { ref: "refs/tags/" + mode + "-two", expected: null, next: publicationBase }];
  const receipt = mode === "push" ? await publicationWire.push(emptyPublication, updates, false, new Date()) : await publicationWire.publish(updates, false, new Date());
  assert.deepEqual(receipt.updated, updates); assert.deepEqual(receipt.added, []);
  for (const update of updates) assert.equal(repo.refs.read(update.ref), update.next);
  const missing = [...updates.map(update => ({ ...update, expected: update.next })), { ref: "refs/heads/" + mode + "-missing", expected: null, next: "f".repeat(64) }];
  await assert.rejects(mode === "push" ? publicationWire.push(emptyPublication, missing, true, new Date()) : publicationWire.publish(missing, true, new Date()), error => error.code === "incomplete_bundle");
  assert.equal(repo.refs.read(missing.at(-1).ref), null);
}
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
const spec = join(process.cwd(), process.argv[2] + ".link.json"); writeFileSync(spec, JSON.stringify(link, null, 2) + "\\n");
const staged = await harness.runCommand({ command: "vcs link", args: ["dependency.link"], pmRoot: root, options: { spec } }); assert.equal(staged.errorMessage, undefined);
assert.deepEqual(readFileSync(join(root, "dependency.link")), encodeLink(link));
writeFileSync(spec, encodeLink(link).toString() + "\\n");
const restaged = await harness.runCommand({ command: "vcs link", args: ["dependency.link"], pmRoot: root, options: { spec } }); assert.equal(restaged.errorMessage, undefined); assert.deepEqual(restaged.result, staged.result);
const beforeIndex = readFileSync(join(repo.controlDirectory, "index")); const beforeObjects = repo.objects.inventory();
for (const input of ["{", "null", "[]", JSON.stringify({ ...link, extra: true })]) {
  writeFileSync(spec, input); const refused = await harness.runCommand({ command: "vcs link", args: ["invalid.link"], pmRoot: root, options: { spec } });
  assert.equal(refused.errorCode, "bad_link"); assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), beforeIndex); assert.deepEqual(repo.objects.inventory(), beforeObjects);
}
const largeLink = { ...link, mappings: Array.from({ length: 400 }, (_, i) => {
  const hex = createHash("sha256").update("mapping-" + i).digest("hex");
  return { source: "src/" + hex.slice(0, 16) + "/" + i + ".bin", destination: "vendor/" + hex.slice(16, 32) + "/" + i + ".bin" };
}) };
const largeLinkId = repo.stageLink("large.link", largeLink); assert.equal(repo.links().find(entry => entry.path === "large.link").id, largeLinkId);
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
const toolRoot = join(root, "vendor/lib"); mkdirSync(toolRoot, { recursive: true });
const gitfile = Buffer.from("gitdir: ../../.git/modules/lib\\n"); writeFileSync(join(toolRoot, ".git"), gitfile);
const toolBytes = Buffer.from("consumer unique permanent bytes 638529");
for (const name of ["CVS", "node_modules"]) writeFileSync(join(toolRoot, name), toolBytes);
const toolTarget = join(process.cwd(), process.argv[2] + ".tool-target"); writeFileSync(toolTarget, toolBytes);
symlinkSync(toolTarget, join(toolRoot, ".hg"));
const erased = await harness.runCommand({ command: "vcs obliterate", args: ["secret.bin"], pmRoot: root, options: { eraseTokenFile: token, reason: "incident", recoverLock: true } }); assert.equal(erased.errorMessage, undefined);
assert.deepEqual(readFileSync(join(toolRoot, ".git")), gitfile);
for (const name of ["CVS", "node_modules"]) assert.deepEqual(readFileSync(join(toolRoot, name)), toolBytes);
assert.equal(readlinkSync(join(toolRoot, ".hg")), toolTarget); assert.deepEqual(readFileSync(toolTarget), toolBytes);
assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
assert.equal(repo.readFileState(revision, "secret.bin").kind, "obliterated"); assert.deepEqual(repo.verify().corrupt, []);
const clone = Repository.open((await cloneFrom(root, join(process.cwd(), process.argv[2] + "-clone"), new Date())).root);
assert.equal(clone.identity(), repo.identity()); assert.equal(clone.readFileState(revision, "secret.bin").kind, "obliterated"); assert.equal(clone.links()[0].link.revision, pin);
// Real registry corruption must never stage private bytes through any artifact/runtime.
repo.addLayer("registry-repair", new Map([["private-repair.txt", { content: Buffer.from("private consumer bytes"), executable: false }]]));
const layersPath = join(repo.controlDirectory, "layers.json"); const layerBytes = readFileSync(layersPath);
const registryIndex = readFileSync(join(repo.controlDirectory, "index")); const registryObjects = repo.objects.inventory(); const registryOps = repo.operations.read();
writeFileSync(layersPath, "null"); assert.throws(() => repo.layers(), { code: "bad_layers" }); assert.throws(() => repo.stage([]), { code: "bad_layers" });
assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), registryIndex); assert.deepEqual(repo.objects.inventory(), registryObjects); assert.deepEqual(repo.operations.read(), registryOps);
assert.equal(readFileSync(join(root, "private-repair.txt"), "utf8"), "private consumer bytes"); writeFileSync(layersPath, layerBytes); repo.removeLayer("registry-repair");
// Legacy inputs are produced before erasure; provenance comes from their actual base.
const repaired = Repository.init(join(process.cwd(), process.argv[2] + "-writer-repair")); repaired.identity();
await new PmClient({ cwd: repaired.root, pmRoot: join(repaired.root, ".agents/pm"), noExtensions: true }).init("repair", { defaults: true, author: "fixture" });
repaired.setAuthority("fixture", "repair-read", "repair-erase");
const selectedBytes = Buffer.from("consumer terminal marker 71294638");
writeFileSync(join(repaired.root, "selected"), selectedBytes); writeFileSync(join(repaired.root, "owner"), "original owner bytes"); repaired.stage([]); repaired.commit({ message: "repair baseline", author }, new Date());
const owner = repaired.readIndex().find(entry => entry.path === "owner"); const selectedOwner = repaired.readIndex().find(entry => entry.path === "selected");
const legacyInputs = ["blob", "record"].map(type => {
  const path = "legacy-" + type;
  const payloads = type === "blob" ? ["a\\nb\\nc\\n", "A\\nb\\nc\\n", "a\\nb\\nC\\n"].map(text => Buffer.from(text)) : [{ left: "a", right: "c" }, { left: "A", right: "c" }, { left: "a", right: "C" }].map(encodeRecord);
  const ids = payloads.map(payload => repaired.objects.write(type, payload));
  return { type, path, owner: migratedFileId({ path, id: ids[0] }), trees: ids.map(id => buildTree(repaired.objects, new Map([[path, { id, mode: "100644" }]]))) };
});
repaired.obliterate("selected", "repair-erase", "incident", new Date());
const fragmentBytes = Buffer.from("independent consumer survivor 98364271\\n".repeat(8)); const fragmentSource = join(process.cwd(), process.argv[2] + ".fragment-source"); writeFileSync(fragmentSource, fragmentBytes);
const fragmentParams = { minChunkSize: 64, maxChunkSize: 64, mask: 1 };
const fragmentResults = [writeFragmented(repaired.objects, fragmentBytes, 64, owner.fileId), writeFragmentedFile(repaired.objects, fragmentSource, 64, owner.fileId), writeCdcFragmented(repaired.objects, fragmentBytes, fragmentParams, owner.fileId), writeCdcFragmentedFile(repaired.objects, fragmentSource, fragmentParams, owner.fileId)];
for (const cdc of [false, true]) {
  const fd = openSync(fragmentSource, "r");
  try {
    const fragments = cdc ? writeCdcFragmentsFromFd(repaired.objects, fd, fragmentBytes.length, fragmentParams, fragmentSource, owner.fileId) : writeFragmentsFromFd(repaired.objects, fd, fragmentBytes.length, 64, fragmentSource, owner.fileId);
    const manifest = { totalLength: fragmentBytes.length, fragments, ...(cdc ? { mode: "cdc" } : {}) }; fragmentResults.push({ manifestId: writeManifest(repaired.objects, manifest, owner.fileId), manifest });
  } finally { closeSync(fd); }
}
for (const result of fragmentResults) assert.deepEqual(readFragmented(repaired.objects, result.manifestId), fragmentBytes);
assert.throws(() => writeFragmented(repaired.objects, fragmentBytes, 64, selectedOwner.fileId), { code: "file_obliterated" });
assert.throws(() => writeCdcFragmented(repaired.objects, selectedBytes, fragmentParams, owner.fileId), { code: "object_obliterated" });
assert.throws(() => writeFragmented(repaired.objects, fragmentBytes, 64), { code: "unattributed_arrival" });
repaired.writeIndex(repaired.readIndex().map(entry => entry.path === "owner" ? { ...entry, id: fragmentResults[0].manifestId } : entry)); writeFileSync(join(repaired.root, "owner"), fragmentBytes);
for (const input of legacyInputs) {
  const merged = mergeTrees({ store: repaired.objects, config: repaired.config, committer: author }, ...input.trees); assert.deepEqual(merged.conflicts, []);
  const entry = flattenTree(repaired.objects, merged.tree).get(input.path); assert.equal(entry.fileId, input.owner); repaired.writeIndex([...repaired.readIndex(), { path: input.path, ...entry }]);
}
repaired.commit({ message: "repaired writers", author }, new Date()); exportBundle(repaired.objects, repaired.refs, []);
const repairedClone = Repository.open((await cloneFrom(repaired.root, repaired.root + "-clone", new Date())).root); assert.deepEqual(readFileSync(join(repairedClone.root, "owner")), fragmentBytes); assert.deepEqual(repairedClone.verify().corrupt, []);
const warmedDenial = repo.objects.denials()[0];
const durablePaths = [join(repo.controlDirectory, "denials.json"), join(repo.controlDirectory, "objects", warmedDenial.id.slice(0, 2), warmedDenial.id.slice(2))];
const durableSnapshot = () => durablePaths.map(path => {
  const stat = lstatSync(path, { bigint: true }); return { ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs, bytes: readFileSync(path) };
});
const durableBefore = durableSnapshot(); const repeatedBundle = exportBundle(repo.objects, repo.refs, []);
for (let repeat = 0; repeat < 2; repeat += 1) {
  assert.deepEqual(importBundleObjects(repo.objects, repeatedBundle).added, []);
  assert.deepEqual(durableSnapshot(), durableBefore); assert.equal(repo.objects.denials()[0], warmedDenial);
}
await new FileTransport(root, root).push(repeatedBundle, [], false, new Date());
assert.deepEqual(durableSnapshot(), durableBefore); assert.equal(repo.objects.denials()[0], warmedDenial);
assert.deepEqual(clone.objects.denials(), repo.objects.denials());
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
if (process.argv[2] === "node-project-cli") {
  const installed = spawnSync(process.execPath, [cliExecutable, "package", "install", process.argv[3], "--project"], { cwd: root, encoding: "utf8" }); assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  for (const input of [JSON.stringify(link, null, 2), encodeLink(link).toString() + "\\n"]) {
    writeFileSync(spec, input);
    const linked = spawnSync(process.execPath, [cliExecutable, "--json", "vcs", "link", "operator.link", "--spec", spec], { cwd: root, encoding: "utf8" });
    assert.equal(linked.status, 0, linked.stderr + linked.stdout); assert.deepEqual(readFileSync(join(root, "operator.link")), encodeLink(link));
  }
  const cliIndex = readFileSync(join(repo.controlDirectory, "index")); const cliObjects = repo.objects.inventory();
  writeFileSync(spec, "null");
  const invalidLink = spawnSync(process.execPath, [cliExecutable, "--json", "vcs", "link", "invalid.link", "--spec", spec], { cwd: root, encoding: "utf8" });
  assert.notEqual(invalidLink.status, 0); assert.match(invalidLink.stderr + invalidLink.stdout, /bad_link/);
  assert.deepEqual(readFileSync(join(root, "operator.link")), encodeLink(link)); assert.deepEqual(readFileSync(join(repo.controlDirectory, "index")), cliIndex); assert.deepEqual(repo.objects.inventory(), cliObjects);
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
  if (process.argv[2] === "node-project-cli") {
    const installed = spawnSync(process.execPath, [cliExecutable, "package", "install", process.argv[3], "--project"], { cwd: mergedRepo.root, encoding: "utf8" }); assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    const merged = spawnSync(process.execPath, [cliExecutable, "--json", "vcs", "merge", "right", "--message", "denied merge"], { cwd: mergedRepo.root, encoding: "utf8" });
    assert.equal(merged.status, 0, merged.stderr + merged.stdout); result = JSON.parse(merged.stdout).merge;
  } else result = mergedRepo.merge("right", { message: "denied merge", author }, new Date());
  assert.equal(result.clean, false); assert.ok(result.conflicts.some(conflict => conflict.path === "p" && conflict.reason === "content"));
  const retained = mergedRepo.readIndex().find(entry => entry.path === "p"); assert.equal(retained.id, ours.id); assert.equal(retained.fileId, ours.fileId);
  if (deniedSide === "ours") assert.equal(existsSync(join(mergedRepo.root, "p")), false);
  else assert.equal(readFileSync(join(mergedRepo.root, "p"), "utf8"), "unrelated consumer left");
  assert.deepEqual(readFileSync(join(mergedRepo.controlDirectory, "denials.json")), denials);
}
process.stdout.write(JSON.stringify({ runtime: process.argv[2], sdk: installedSdk.version, linked: true, layers: true, erased: true, clone: true, deniedMerge: true, publication: true }));
`;

test("built and npm-packed SDK10 Node/native Bun consumers and project-installed CLI execute composition and denied merges", /** Use a packed artifact and real peer dependency instead of SDK doubles. */ () => {
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
    const environment = { ...withoutPmContext(process.env), ...discardChildCoverage() };
    const unavailable = spawnSync(process.execPath, ["packed.mjs", "node-project-cli", archive, join(project, "missing-cli.js")], { cwd: project, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(unavailable.status, 1); assert.match(unavailable.stderr, /Project-installed PM CLI unavailable before fixture setup/);
    assert.equal(existsSync(join(project, "node-project-cli")), false);
    writeFileSync(join(project, "wrong-version.mjs"), consumer.replace("version.stdout.trim(), installedSdk.version", 'version.stdout.trim(), "2026.8.1"'));
    const wrongVersion = spawnSync(process.execPath, ["wrong-version.mjs", "node-project-cli", archive, pmExecutable], { cwd: project, env: environment, encoding: "utf8", timeout: 120_000 });
    assert.equal(wrongVersion.status, 1); assert.match(wrongVersion.stderr, /Project-installed PM CLI version mismatch before fixture setup/);
    assert.equal(existsSync(join(project, "node-project-cli")), false);
    for (const [runtime, script, scenario] of [[process.execPath, "built.mjs", "node-built"], [process.execPath, "packed.mjs", "node-packed"], ["bun", "built.mjs", "bun-built"], ["bun", "packed.mjs", "bun-packed"], [process.execPath, "packed.mjs", "node-project-cli"]]) {
      const result = spawnSync(runtime, [script, scenario, archive, pmExecutable], { cwd: project, env: environment, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`); assert.deepEqual(JSON.parse(result.stdout), { runtime: scenario, sdk: "2026.10.10", linked: true, layers: true, erased: true, clone: true, deniedMerge: true, publication: true });
    }
  } finally { temporary.cleanup(); }
});
