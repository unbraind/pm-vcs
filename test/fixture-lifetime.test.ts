import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Native fixture cleanup waits for its owners and retries transient nonempty directories. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, mock, test } from "node:test";
import { makeManagedTempDir } from "./helpers/managed-temp.ts";

afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

test("fixture cleanup retries an injected transient ENOTEMPTY without hiding persistent failures", async () => {
  const fixture = makeManagedTempDir(); mkdirSync(join(fixture.root, ".pm-cli/locks"), { recursive: true }); writeFileSync(join(fixture.root, ".pm-cli/locks/owned"), "complete");
  const original = fs.rmdir; const fault = { remaining: 4, persistent: "" }; let injected = 0;
  mock.method(fs, "rmdir", (...args: Parameters<typeof fs.rmdir>) => {
    if (fault.remaining > 0 && (String(args[0]).endsWith("locks") || String(args[0]) === fault.persistent)) { fault.remaining--; injected++; const callback = args.at(-1) as (error: NodeJS.ErrnoException) => void; queueMicrotask(() => callback(Object.assign(new Error("transient nonempty"), { code: "ENOTEMPTY" }))); return; }
    return original(...args);
  });
  await fixture.cleanup(); assert.equal(injected, 4); assert.equal(existsSync(fixture.root), false);
  const failed = makeManagedTempDir(); fault.persistent = failed.root; fault.remaining = Infinity;
  await assert.rejects(failed.cleanup(), (error: unknown) => error instanceof AggregateError && error.errors.some((entry: NodeJS.ErrnoException) => entry.code === "ENOTEMPTY")); assert.ok(existsSync(failed.root));
  fault.remaining = 0; await failed.cleanup(); assert.equal(existsSync(failed.root), false);
});

test("fixture teardown joins child close, stops watchers and drains queued writers before removal", async () => {
  const fixture = makeManagedTempDir(); let closed = false;
  fixture.watcher(watch(fixture.root)).once("close", () => { closed = true; });
  const child = fixture.child(spawn(process.execPath, ["-e", "process.send('ready');process.on('message',()=>{require('node:fs').mkdirSync(process.argv[1]+'/.pm-cli/locks',{recursive:true});process.exit(0)})", fixture.root], { env: testEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  await once(child, "message");
  const childClosed = once(child, "close");
  fixture.task(new Promise<void>((resolve, reject) => { setTimeout(() => { try { writeFileSync(join(fixture.root, "pending"), "settled"); resolve(); } catch (error) { reject(error); } }, 20); }));
  const finish = setTimeout(() => { if (child.connected) child.send("finish"); }, 250);
  try { await fixture.cleanup(); assert.equal(child.exitCode, 0); assert.ok(closed); assert.equal(existsSync(fixture.root), false); }
  finally { clearTimeout(finish); if (child.connected) child.send("finish"); await childClosed; await fixture.cleanup(); }
});

test("fixture teardown surfaces task failures after closing all other owners and removing its directory", async () => {
  const fixture = makeManagedTempDir(); const error = new Error("owned task failed"); fixture.task(Promise.reject(error));
  await new Promise<void>(resolve => { setImmediate(resolve); });
  let closed = false; fixture.watcher(watch(fixture.root)).once("close", () => { closed = true; });
  await assert.rejects(fixture.cleanup(), (failure: unknown) => failure instanceof AggregateError && failure.errors.includes(error)); assert.ok(closed); assert.equal(existsSync(fixture.root), false);
});


test("fixture cleanup actively stops a registered live child before removing its root", async () => {
  const fixture = makeManagedTempDir(); const child = fixture.child(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: testEnvironment(), stdio: "ignore" }));
  const cleanup = fixture.cleanup(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { const completed = await Promise.race([cleanup.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); })]); assert.equal(completed, true, "Cleanup must stop its live child"); assert.equal(existsSync(fixture.root), false); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await cleanup; }
});


test("path-identity fixture cleanup still runs when its handle invariant fails", async () => {
 const fixture = makeManagedTempDir();
 const preload = join(fixture.root, "leak-probe.mjs");
 const source = `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module"; import {join} from "node:path"; import {objectFiles} from ${JSON.stringify(new URL("../engine/object-files.ts", import.meta.url).href)}; const create=fs.mkdtempSync; let leaked=false; fs.mkdtempSync=(...args)=>{const root=create(...args); if(!leaked&&String(args[0]).endsWith("pm-vcs-eng-")){leaked=true;process.stdout.write("FIXTURE_ROOT:"+root+"\\n");objectFiles.open(join(root,"held-probe"),"wx");}return root;};syncBuiltinESMExports();`;
 writeFileSync(preload, source);
 try {
  const child = spawnSync(process.execPath, ["--import", preload, "--test", "--test-concurrency=1", "--test-name-pattern=^documented relative ObjectStore", fileURLToPath(new URL("./path-identity.test.ts", import.meta.url))], { env: testEnvironment({ TMPDIR: fixture.root, TMP: fixture.root, TEMP: fixture.root, NODE_V8_COVERAGE: "" }), encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 1, child.stdout + child.stderr); assert.match(child.stdout + child.stderr, /AssertionError|ERR_ASSERTION/u);
  const roots = [...child.stdout.matchAll(/FIXTURE_ROOT:([^\r\n]+)/gu)].map(match => match[1]); assert.equal(roots.length, 1, child.stdout);
  assert.equal(existsSync(roots[0]), false, "A failed descriptor invariant must not bypass fixture removal");
 } finally { await fixture.cleanup(); }
});


test("ordinary workers share recovery storage and parent cleanup removes normal and killed child artifacts", async () => {
  const fixture = makeManagedTempDir(); const artifacts: string[] = [];
  const source = `import {makeTempDir} from ${JSON.stringify(new URL("./helpers/tmp.ts", import.meta.url).href)}; import {ObjectStore} from ${JSON.stringify(new URL("../engine/objects.ts", import.meta.url).href)}; import {tmpdir} from "node:os"; import {join} from "node:path"; import {readdirSync,writeSync} from "node:fs"; const dir=makeTempDir(); new ObjectStore(join(dir.root,"objects")).write("blob",Buffer.from("owned worker cleanup fixture")); const ledgers=readdirSync(tmpdir()).filter(name=>/^pm-vcs-namespace-[0-9a-f]{64}$/.test(name)); writeSync(1,JSON.stringify({scope:tmpdir(),root:dir.root,ledgers})); if(process.argv[1]==="kill")process.kill(process.pid,"SIGKILL");`;
  try {
    for (const mode of ["exit", "kill"]) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, mode], { env: testEnvironment({ TMPDIR: fixture.root, TMP: fixture.root, TEMP: fixture.root, NODE_V8_COVERAGE: "" }), encoding: "utf8", timeout: 30_000 });
      if (mode === "kill") assert.equal(child.signal, "SIGKILL", child.stderr); else assert.equal(child.status, 0, child.stderr);
      const owned = JSON.parse(child.stdout) as { scope: string; root: string; ledgers: string[] };
      assert.equal(owned.scope, fixture.root, "workers must use the same recovery namespace as their parent");
      assert.ok(relative(fixture.root, owned.root).startsWith("pm-vcs-eng-")); assert.ok(existsSync(owned.root)); assert.ok(owned.ledgers.length > 0, "real native writes must create external recovery ledgers");
      artifacts.push(owned.root, ...owned.ledgers.map(name => join(owned.scope, name)));
    }
  } finally { await fixture.cleanup(); }
  for (const path of artifacts) assert.equal(existsSync(path), false, "parent cleanup removes both fixture data and sibling native ledgers");
});
