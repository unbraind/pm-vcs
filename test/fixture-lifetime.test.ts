import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
/** Native fixture cleanup waits for its owners and retries transient nonempty directories. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { makeManagedTempDir } from "./helpers/managed-temp.ts";

afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

test("fixture cleanup retries a real transient native ENOTEMPTY without hiding persistent failures", async () => {
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
