import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Capability-forced durability and real Windows-compatible CLI collection on a non-git tracker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { closeSync, existsSync, fstatSync, globSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import ts from "typescript5";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { writePrivateJson } from "../engine/composition.ts";
import { durability, durabilityCapabilities } from "../engine/durability.ts";
import { Repository } from "../engine/repo.ts";
import { collectGarbage } from "../engine/gc.ts";
import { installPackedExtension, pmExecutable } from "../scripts/pm-environment.ts";
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
  const forbidden = /^(?:fsync|rename|unlink|link|rm|rmdir)(?:Sync)?$/;
  /** Resolve actual fs receivers and named imports without confusing the journal backend with raw filesystem calls. */
  const violations = (file: string, body: string): string[] => {
    const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true); const names = new Set<string>(); const namespaces = new Set<string>(); const found: string[] = [];
    for (const node of source.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?fs(?:\/promises)?$/.test(node.moduleSpecifier.text)) {
      const clause = node.importClause; if (clause?.name) namespaces.add(clause.name.text); const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (forbidden.test((element.propertyName ?? element.name).text)) names.add(element.name.text);
    }
    /** Calls through the configured backend remain governed by durability rather than a coincidentally named method. */
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) { const expression = node.expression; if (ts.isIdentifier(expression) && names.has(expression.text) || ts.isPropertyAccessExpression(expression) && namespaces.has(expression.expression.getText(source)) && forbidden.test(expression.name.text)) found.push(expression.getText(source)); }
      ts.forEachChild(node, visit);
    };
    visit(source); return found;
  };
  for (const file of globSync(["*.ts", "engine/**/*.ts", "scripts/**/*.ts"], { cwd: packageRoot })) if (file !== "engine/durability.ts") assert.deepEqual(violations(file, readFileSync(join(packageRoot, file), "utf8")), [], file);
  for (const method of ["rm", "unlink", "rename", "link", "rmdir", "fsync", "rmSync"]) assert.equal(violations("raw.ts", `import fs from "node:fs"; fs.${method}("fixture");`).length, 1);
  assert.equal(violations("alias.ts", 'import { unlink as retire } from "node:fs/promises"; retire("fixture");').length, 1);
  assert.equal(violations("bare-alias.ts", 'import { rm as retire } from "fs/promises"; retire("fixture");').length, 1);
  assert.deepEqual(violations("backend.ts", 'backend.unlink("fixture");'), []);
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
  const env = { ...testEnvironment(), ...discardChildCoverage(), GIT_CEILING_DIRECTORIES: dirname(repo.root),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./helpers/forbid-git.ts", import.meta.url).href}` };
  const result = spawnSync(process.execPath, [pmExecutable, "vcs", "gc", "--apply", "--json"], { cwd: repo.root, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).gc.applied, true);
  assert.equal(repo.objects.has(garbage), false); assert.deepEqual(repo.objects.readTyped(live, "blob"), Buffer.from("retained cross-platform CLI payload"));
  assert.ok(!existsSync(join(repo.root, ".git")));
});


test("metadata durability opens writable file handles for Windows flushes", async () => {
  const repo = await fixture(); const flags = new Map<number,string | number>(); let writableFlushes = 0; const open = fs.openSync; const sync = fs.fsyncSync;
  mock.method(fs,"openSync",(...args: Parameters<typeof fs.openSync>) => { const fd = open(...args); flags.set(fd,args[1]); return fd; });
  mock.method(fs,"fsyncSync",(fd: number) => {
    if (!fstatSync(fd).isDirectory()) { const mode = flags.get(fd) ?? "r"; assert.ok(typeof mode === "number" ? (mode & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : /[wa+]/.test(mode), "Native file flushes require a writable handle, including default-flag opens"); writableFlushes++; }
    return sync(fd);
  }); syncBuiltinESMExports();
  const path = join(repo.controlDirectory,"writable-flush.json"); writePrivateJson(path,{verified:true}); durability.persist(path);
  assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),{verified:true}); assert.ok(writableFlushes > 0);
});


test("unpublished owner bootstrap cleanup requires the exclusive descriptor lifetime and preserves absent or foreign owners", () => {
 const temp=makeTempDir();temporary.push(temp);
 for(const mode of ["owned","absent","replacement","held-dev","held-ino","held-birth","path-dev","path-birth"]){
  const path=join(temp.root,mode);const fd=openSync(path,"wx");const original=fstatSync(fd,{bigint:true});
  try{
   if(mode==="absent")rmSync(path);
   if(mode==="replacement"){renameSync(path,`${path}.old`);writeFileSync(path,"foreign owner");}
   let expected=original;
   if(mode.startsWith("held-")){const field=mode==="held-dev"?"dev":mode==="held-ino"?"ino":"birthtimeNs";expected={...original,[field]:original[field]+1n};}
   if(mode.startsWith("path-")){const stat=fs.lstatSync;mock.method(fs,"lstatSync",(...args:Parameters<typeof fs.lstatSync>)=>{const value=stat(...args);if(args[0]!==path)return value;const field=mode==="path-dev"?"dev":"birthtimeNs";return{...value,[field]:(value as fs.BigIntStats)[field]+1n};});syncBuiltinESMExports();}
   const result=durability.discardUnpublished(path,fd,expected);assert.equal(result.released,mode==="owned");assert.equal(result.reason,mode==="owned"?"owned_bootstrap":mode==="absent"?"absent":"foreign_owner");mock.restoreAll();syncBuiltinESMExports();if(mode!=="owned"&&mode!=="absent")assert.ok(existsSync(path));
  }finally{mock.restoreAll();syncBuiltinESMExports();closeSync(fd);}
 }
});
