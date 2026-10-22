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
      let descriptor: number | undefined;
      const failure = Object.assign(new Error(`injected ${stage} failure`), { code: stage === "writeSync" ? "ENOSPC" : "EIO" });
      /** Observe the actual exclusive temp open without intercepting lease metadata writes. */
      context.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const handle = open(...args); const path = String(args[0]);
        if (dirname(path) === dirname(destination) && (kind === "ref" ? /ref-.*\.lock$/.test(path) : path.startsWith(`${destination}.`) && path.endsWith(".tmp"))) descriptor = handle;
        return handle;
      });
      context.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
        if (stage === "writeSync" && args[0] === descriptor) throw failure;
        return write(...args);
      });
      context.mock.method(fs, "fsyncSync", (handle: number) => {
        if (stage === "fsyncSync" && handle === descriptor) throw failure;
        return sync(handle);
      });
      context.mock.method(fs, "closeSync", (handle: number) => {
        close(handle);
        if (stage === "closeSync" && handle === descriptor) throw failure;
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
