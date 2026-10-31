import "./helpers/isolate-session.ts";
/** Real plain-directory publication with faults restricted to the owned temporary descriptor. */
import assert from "node:assert/strict";
import fs, { existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ObjectStore, hashObject } from "../engine/objects.ts";
import { RefStore } from "../engine/refs.ts";
import { makeTempDir } from "./helpers/tmp.ts";

for (const kind of ["ref", "object"] as const) {
  for (const stage of ["writeSync", "fsyncSync", "closeSync", "renameSync"] as const) {
    test(`atomic ${kind} publication cleans up after ${stage} failure and retries`, (context) => {
      const directory = makeTempDir();
      const root = join(directory.root, ".pmvcs");
      const refs = new RefStore(root); const store = new ObjectStore(join(root, "objects"));
      const previous = "a".repeat(64); const next = "b".repeat(64);
      const payload = Buffer.from("new publication"); const objectId = hashObject("blob", payload);
      refs.setHeadDetached(previous);
      const retained = store.write("blob", Buffer.from("retained object"));
      const destination = kind === "ref" ? join(root, "HEAD") : join(root, "objects", objectId.slice(0, 2), objectId.slice(2));
      mkdirSync(dirname(destination), { recursive: true });
      const sentinel = join(dirname(destination), "unrelated.lock"); writeFileSync(sentinel, "other writer");
      const before = readdirSync(dirname(destination)).sort();
      const open = fs.openSync; const write = fs.writeSync; const sync = fs.fsyncSync; const close = fs.closeSync; const rename = fs.renameSync;
      let descriptor: number | undefined; let retired = false;
      const failure = Object.assign(new Error(`injected ${stage} failure`), { code: stage === "writeSync" ? "ENOSPC" : "EIO" });
      /** Observe the actual exclusive temp open without intercepting lease metadata writes. */
      context.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const handle = open(...args); const path = String(args[0]);
        if (dirname(path) === dirname(destination) && (kind === "ref" ? /ref-.*\.lock$/.test(path) : path.startsWith(`${destination}.`) && path.endsWith(".tmp"))) descriptor = handle;
        return handle;
      });
      context.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
        if (stage === "writeSync" && !retired && args[0] === descriptor) throw failure;
        return write(...args);
      });
      context.mock.method(fs, "fsyncSync", (handle: number) => {
        if (stage === "fsyncSync" && !retired && handle === descriptor) throw failure;
        return sync(handle);
      });
      context.mock.method(fs, "closeSync", (handle: number) => {
        const owned = !retired && handle === descriptor; close(handle); if (owned) retired = true;
        if (stage === "closeSync" && owned) throw failure;
      });
      context.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        if (stage === "renameSync" && args[1] === destination) throw failure;
        return rename(...args);
      });
      syncBuiltinESMExports();
      try {
        const publish = () => kind === "ref" ? refs.setHeadDetached(next) : store.write("blob", payload);
        assert.throws(publish, error => error === failure);
        assert.notEqual(descriptor, undefined);
        assert.throws(() => fstatSync(descriptor!), { code: "EBADF" });
        context.mock.restoreAll(); syncBuiltinESMExports();
        assert.deepEqual(readdirSync(dirname(destination)).sort(), before, "failed publication left a temporary file");
        assert.equal(readFileSync(sentinel, "utf8"), "other writer");
        assert.equal(refs.resolveHead(), previous);
        assert.deepEqual(store.read(retained).payload, Buffer.from("retained object"));
        if (kind === "object") assert.equal(existsSync(destination), false);
        publish();
        if (kind === "ref") assert.equal(refs.resolveHead(), next);
        else assert.deepEqual(store.read(objectId).payload, payload);
        assert.equal(existsSync(join(directory.root, ".git")), false);
      } finally {
        context.mock.restoreAll(); syncBuiltinESMExports(); directory.cleanup();
      }
    });
  }
}


test("atomic ref publication removes temps after repeated native rename refusals", () => {
  const directory = makeTempDir(); const root = join(directory.root, ".pmvcs");
  const destination = join(root, "HEAD"); const refs = new RefStore(root);
  try {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "retained"), "original destination");
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.throws(() => refs.setHeadDetached("a".repeat(64)), error => error instanceof Error && "code" in error);
      assert.deepEqual(readdirSync(root), ["HEAD"]);
      assert.equal(readFileSync(join(destination, "retained"), "utf8"), "original destination");
    }
    fs.rmSync(destination, { recursive: true }); refs.setHeadDetached("a".repeat(64));
    assert.equal(refs.resolveHead(), "a".repeat(64));
  } finally { directory.cleanup(); }
});

test("an interrupted writer temporary retirement retries its exact intent and releases the published owner", context => {
  const directory = makeTempDir(); const root = join(directory.root, ".pmvcs"); const store = new ObjectStore(join(root, "objects"));
  const unlink = fs.unlinkSync; const failure = Object.assign(new Error("temporary retirement interrupted"), { code: "EIO" }); let interrupted = false;
  context.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
    if (!interrupted && String(args[0]).startsWith(join(root, "objects.lock.")) && String(args[0]).endsWith(".tmp")) { interrupted = true; throw failure; }
    return unlink(...args);
  }); syncBuiltinESMExports();
  try {
    assert.throws(() => store.withWriteLock(() => assert.fail("publication must finish before the callback")), error => error === failure);
    context.mock.restoreAll(); syncBuiltinESMExports(); assert.ok(interrupted);
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith("objects.lock")), []);
    assert.equal(store.withWriteLock(() => "retry completed"), "retry completed");
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); directory.cleanup(); }
});

test("retrying temporary retirement preserves owner bytes changed before its descriptor stamp refresh", context => {
  for (const sameLength of [false,true]) {
    const directory=makeTempDir();const root=join(directory.root,".pmvcs");const store=new ObjectStore(join(root,"objects"));const owner=join(root,"objects.lock");
    const unlink=fs.unlinkSync;const failure=Object.assign(new Error("temporary retirement interrupted"),{code:"EIO"});let interrupted=false;let changed=false;
    const peer=sameLength?"x".repeat(String(process.pid).length):"peer changed owner bytes";
    context.mock.method(fs,"unlinkSync",(...args:Parameters<typeof fs.unlinkSync>)=>{
      const selected=String(args[0]).startsWith(join(root,"objects.lock."))&&String(args[0]).endsWith(".tmp");
      if(selected&&!interrupted){interrupted=true;throw failure;}unlink(...args);
      if(selected){writeFileSync(owner,peer);fs.utimesSync(owner,1,1);changed=true;}
    });syncBuiltinESMExports();
    try { assert.throws(()=>store.withWriteLock(()=>assert.fail("publication interrupted")),error=>error===failure);assert.ok(changed);assert.equal(readFileSync(owner,"utf8"),peer);assert.deepEqual(readdirSync(root).filter(name=>name.startsWith("objects.lock.")),[]); }
    finally { context.mock.restoreAll();syncBuiltinESMExports();directory.cleanup(); }
  }
});
