/** Capability-forced durability and real Windows-compatible CLI collection on a non-git tracker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { closeSync, existsSync, fstatSync, globSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import ts from "typescript5";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { writePrivateJson } from "../engine/composition.ts";
import { durability, durabilityCapabilities } from "../engine/durability.ts";
import { Repository } from "../engine/repo.ts";
import { collectGarbage } from "../engine/gc.ts";
import { installPackedExtension, withoutPmContext, pmExecutable } from "../scripts/pm-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const temporary: ReturnType<typeof makeTempDir>[] = [];
const nativeCapability = durabilityCapabilities.directorySync;
afterEach(() => { durabilityCapabilities.directorySync = nativeCapability; mock.restoreAll(); syncBuiltinESMExports(); for (const temp of temporary.splice(0)) temp.cleanup(); });
/** Real SDK initialization establishes the same plain-directory tracker used by shipped commands. */
async function fixture() {
  const temp = makeTempDir(); temporary.push(temp);
  await new PmClient({ cwd: temp.root, pmRoot: join(temp.root, ".agents/pm"), noExtensions: true }).init("durability", { defaults: true, author: "fixture" });
  return Repository.init(temp.root);
}

test("all production fsync, rename, link and deletion operations use the single durability policy", () => {
  const forbidden = new Set(["fsyncSync", "renameSync", "unlinkSync", "linkSync", "rmSync", "rmdirSync"]);
  for (const file of globSync(["*.ts", "engine/**/*.ts", "scripts/**/*.ts"], { cwd: packageRoot })) {
    if (file === "engine/durability.ts") continue;
    const source = ts.createSourceFile(file, readFileSync(join(packageRoot, file), "utf8"), ts.ScriptTarget.Latest, true);
    /** Inspect executable calls, excluding documentation and generated fixture text. */
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
        assert.ok(!forbidden.has(name), `${file} must route ${name} through durability`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("capability can be forced both ways; file flushes remain enabled and loose GC never refuses after deletion", async () => {
  const repo = await fixture(); const live = repo.objects.write("blob", Buffer.from("retained capability fixture"));
  repo.refs.compareAndSwap("refs/metadata/retained", null, live);
  const sync = fs.fsyncSync;
  for (const capability of [true, false]) {
    durabilityCapabilities.directorySync = capability;
    let directories = 0; let files = 0;
    mock.method(fs, "fsyncSync", (fd: number) => {
      if (fstatSync(fd).isDirectory()) { directories++; assert.equal(capability, true); } else files++;
      return sync(fd);
    }); syncBuiltinESMExports();
    const garbage = repo.objects.write("blob", Buffer.from(`discard capability ${capability}`));
    assert.equal(collectGarbage(repo, true).removed, 1); assert.equal(repo.objects.has(garbage), false);
    assert.deepEqual(repo.objects.readTyped(live, "blob"), Buffer.from("retained capability fixture"));
    assert.ok(files > 0); assert.equal(directories > 0, capability);
    mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("durability preserves native failures before rename and supports both namespace policies", () => {
  const temp = makeTempDir(); temporary.push(temp); const source = join(temp.root, "source"); const target = join(temp.root, "target");
  writeFileSync(source, "durable payload"); const sync = fs.fsyncSync;
  mock.method(fs, "fsyncSync", () => { throw Object.assign(new Error("flush failed"), { code: "EIO" }); }); syncBuiltinESMExports();
  assert.throws(() => durability.rename(source, target), { code: "EIO" }); assert.ok(existsSync(source)); assert.ok(!existsSync(target));
  mock.restoreAll(); syncBuiltinESMExports();
  for (const supported of [true, false]) {
    durabilityCapabilities.directorySync = supported;
    const directory = join(temp.root, String(supported)); mkdirSync(directory);
    writeFileSync(source, "durable payload"); durability.rename(source, join(directory, "named"));
    durability.link(join(directory, "named"), join(directory, "alias")); durability.unlink(join(directory, "alias"));
    const fd = openSync(join(directory, "named"), "r+"); try { durability.file(fd); } finally { closeSync(fd); }
    durability.remove(join(directory, "named")); durability.removeDirectory(directory);
    durability.remove(join(temp.root, "missing-parent", "missing"), { force: true });
  }
  durability.directory(temp.root, true, "win32"); durability.directory(temp.root, false, "linux");
  assert.equal(typeof sync, "function");
});

test("Windows GC applies the shipped CLI to a real non-git tracker and retains live packed and loose data", async () => {
  const repo = await fixture(); installPackedExtension(repo.root);
  const live = repo.objects.write("blob", Buffer.from("retained cross-platform CLI payload")); repo.refs.compareAndSwap("refs/metadata/live", null, live);
  repo.objects.compact();
  const garbage = repo.objects.write("blob", Buffer.from("unreachable cross-platform CLI payload"));
  const env = { ...withoutPmContext(process.env), ...discardChildCoverage(), GIT_CEILING_DIRECTORIES: dirname(repo.root),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./helpers/forbid-git.ts", import.meta.url).href}` };
  const result = spawnSync(process.execPath, [pmExecutable, "vcs", "gc", "--apply", "--json"], { cwd: repo.root, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).gc.applied, true);
  assert.equal(repo.objects.has(garbage), false); assert.deepEqual(repo.objects.readTyped(live, "blob"), Buffer.from("retained cross-platform CLI payload"));
  assert.ok(!existsSync(join(repo.root, ".git")));
});


test("metadata durability opens writable file handles for Windows flushes", async () => {
  const repo = await fixture(); const flags = new Map<number,string | number>(); const open = fs.openSync; const sync = fs.fsyncSync;
  mock.method(fs,"openSync",(...args: Parameters<typeof fs.openSync>) => { const fd = open(...args); flags.set(fd,args[1]); return fd; });
  mock.method(fs,"fsyncSync",(fd: number) => {
    if (!fstatSync(fd).isDirectory() && flags.get(fd) === "r") throw Object.assign(new Error("Windows requires a writable flush handle"),{code:"EPERM"});
    return sync(fd);
  }); syncBuiltinESMExports();
  const path = join(repo.controlDirectory,"writable-flush.json"); writePrivateJson(path,{verified:true});
  assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),{verified:true});
});
