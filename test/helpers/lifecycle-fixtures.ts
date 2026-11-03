/** Real lifecycle fixtures, shared by serial regressions and isolated crash workers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { writePrivateJson } from "../../engine/composition.ts";
import { Repository } from "../../engine/repo.ts";
import { accountabilityBoundary } from "../../engine/erasure-accountability.ts";
import { ErasureStorageRefusal } from "../../engine/erasure-scan.ts";
import { makeTempDir, packageRoot } from "./tmp.ts";
import { testEnvironment } from "./test-environment.ts";
import { discardChildCoverage } from "./sandbox.ts";
let retiredTemplate: string | undefined;
let packTemplate: string | undefined;
let purgeTemplate: string | undefined;
const dirs: ReturnType<typeof makeTempDir>[] = [];
/** Cache quiescent preparation: a retired root has no live deletion authority; packs precede the killed unpack. */
export async function prepareTemplate(scenario: string): Promise<void> {
  if (scenario === "purge-journal") {
    const dir = makeTempDir(); await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("accountable", { defaults: true, author: "fixture" });
    Repository.init(dir.root).setAuthority("fixture", "read-fixture", "erase-fixture"); purgeTemplate = dir.root; return;
  }
  if (scenario === "retired-instance") retiredTemplate = (await retiredPending(true)).dir.root;
  else packTemplate = (await packedFixture(true)).dir.root;
  dirs.splice(0);
}
/** Copy only fixture-owned bytes; the native engine establishes all new publication identities. */
function copyFixture(source: string) {
  const dir = makeTempDir(); dirs.push(dir); fs.cpSync(source, dir.root, { recursive: true });
  const repo = Repository.open(join(dir.root, "hub"));
  return { dir, repo, id: repo.readIndex().find(entry => entry.path === "first")!.fileId! };
}
/** Remove each owned fixture immediately, including failed or killed cuts. */
export function cleanupFixtures(): void { for (const dir of dirs.splice(0)) dir.cleanup(); }
/** One SDK tracker and native hub outside Git, shared by an entire model run. */
export async function fixture() {
  const dir = makeTempDir(); dirs.push(dir); const root = join(dir.root, "hub");
  mkdirSync(root);
  await new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true }).init("lifecycle", { defaults: true, author: "fixture" });
  const repo = Repository.init(root); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  for (const name of ["first", "second"]) writeFileSync(join(root, name), `selected ${name} lifecycle payload 783629`);
  repo.stage(["first", "second"]); repo.commit({ message: "fixture", author: { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 } }, new Date(1));
  return { dir, repo, id: repo.readIndex().find(entry => entry.path === "first")!.fileId! };
}
/** Foreign files always remain explicit reference-model state, independently of production classification. */
export function foreign(root: string, name = "foreign"): string { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "foreign lifecycle bytes"); return path; }
/** Persist actual pending authority, then retire its root using the public lifecycle operations. */
export async function retiredPending(source = false) {
  if (retiredTemplate !== undefined && !source) {
    const f = copyFixture(retiredTemplate); const path = join(f.repo.controlDirectory, "erasure-purge.json"); const bytes = fs.readFileSync(path);
    const journal = JSON.parse(bytes.toString("utf8")) as { operations: Record<string, { status: string; root: string }[]> };
    for (const entries of Object.values(journal.operations)) for (const entry of entries) if (entry.status === "planned") {
      const root = resolve(f.repo.controlDirectory, entry.root); const owned = relative(f.dir.root, root);
      assert.ok(!isAbsolute(owned) && !owned.startsWith(".."), "cached retired authority stays within its disposable fixture");
      assert.equal(fs.existsSync(root), false, "cached pending authority names only a retired missing root");
    }
    writePrivateJson(path, journal); assert.deepEqual(fs.readFileSync(path), bytes, "native republication cannot change the cached journal");
    return { ...f, second: f.repo.readIndex().find(entry => entry.path === "second")!.fileId! };
  }
  const f = await fixture(); const path = join(f.dir.root, "secondary"); f.repo.linkInstance("secondary", path); foreign(join(path, ".pmvcs/objects"));
  const cut = new ErasureStorageRefusal("unverifiable", "temporary-storage"); accountabilityBoundary.visit = step => { if (step === "purge-set-persisted") throw cut; };
  assert.throws(() => f.repo.obliterate(f.id, "erase-fixture", "incident", new Date(1), { purgeUnaccounted: true }), failure => failure === cut); accountabilityBoundary.visit = () => {};
  f.repo.unlinkInstance("secondary"); rmSync(path, { recursive: true, force: true }); f.repo.pruneRetiredInstance(relative(f.repo.root, path), "erase-fixture", "removed", new Date(1));
  return { ...f, second: f.repo.readIndex().find(entry => entry.path === "second")!.fileId! };
}

/** Reproduce a killed unpack with a loose copy and two independently produced native packs. */
async function packedFixture(source = false) {
  if (packTemplate !== undefined && !source) return copyFixture(packTemplate);
  const f = await fixture();
  f.repo.objects.compact();
  // Both physical packs represent known local identities; the retained member has an independent native origin here.
  f.repo.objects.write("blob", Buffer.from("independent retained pack member"));
  const extra = Repository.init(join(f.dir.root, "independent-pack")); extra.objects.write("blob", Buffer.from("selected first lifecycle payload 783629")); extra.objects.write("blob", Buffer.from("independent retained pack member")); extra.objects.compact();
  for (const name of fs.readdirSync(join(extra.objects.storageRoot(), "packs")).filter(name => name.endsWith(".pack"))) fs.copyFileSync(join(extra.objects.storageRoot(), "packs", name), join(f.repo.objects.storageRoot(), "packs", name));
  return f;
}
/** Recreate the inode-bound killed unpack for each copied pack checkpoint. */
export async function interruptedUnpack(source = false) {
  const f = await packedFixture(source); const selected = f.repo.readIndex().find(entry => entry.fileId === f.id)!;
  const preloadArgs = !source && process.env.CRASH_PRELOADS !== undefined ? (JSON.parse(process.env.CRASH_PRELOADS) as string[]).flatMap(path => ["--import", path]) : ["--import", new URL("./forbid-git.ts", import.meta.url).href, ...(process.env.CRASH_COMPILE_CACHE === undefined ? [] : ["--import", new URL("./crash-child.ts", import.meta.url).href])];
  const killed = spawnSync(process.execPath, [...preloadArgs, (source ? undefined : process.env.CRASH_ENTRY) ?? join(packageRoot, "test/helpers/erasure-purge-worker.ts"), f.repo.root, f.id, "unpacked"], { env: { ...testEnvironment(), ...discardChildCoverage(), CRASH_COMPILE_CACHE: process.env.CRASH_COMPILE_CACHE }, encoding: "utf8", timeout: 120_000 });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  f.repo.objects.recoverWriterLock();
  f.repo.objects.withWriteLock(() => assert.equal([...f.repo.objects.walkErasureInventory()].filter(entry => entry.id === selected.id).length, 3));
  foreign(f.repo.objects.storageRoot(), "unaccounted-purge");
  return { ...f, second: f.id, selected: selected.id };
}

/** Copy completed initialization only, then stage the original purge payload independently for every cut. */
export async function purgeJournal(source = false) {
  const dir = makeTempDir(); dirs.push(dir);
  if (purgeTemplate !== undefined && !source) fs.cpSync(purgeTemplate, dir.root, { recursive: true });
  else { await new PmClient({ cwd: dir.root, pmRoot: join(dir.root, ".agents/pm"), noExtensions: true }).init("accountable", { defaults: true, author: "fixture" }); Repository.init(dir.root).setAuthority("fixture", "read-fixture", "erase-fixture"); }
  const repo = Repository.open(dir.root); writeFileSync(join(dir.root, "asset"), Buffer.from("ordinary retained live data")); repo.stage(["asset"]);
  writeFileSync(join(repo.objects.storageRoot(), "unaccounted-purge"), Buffer.from("foreign bytes to purge")); const id = repo.readIndex()[0]!.fileId!;
  return { dir, repo, id, second: id };
}
