/** Per-operation ownership invariants and a real low-descriptor-limit regression soak. */
import assert from "node:assert/strict";
import fs, { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { test, mock } from "node:test";
import { deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { ObjectStore, frameObject } from "../engine/objects.ts";
import { objectFiles } from "../engine/object-files.ts";
import { exercise, iterator, lifetimeReaders, type ExitMode } from "./helpers/object-lifetime.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";
const modes: readonly ExitMode[] = ["complete","early","error","abort"];

/** Use a real PM SDK tracker outside Git for both physical representations. */
async function fixture() {
  const dir = makeTempDir();
  await new PmClient({ cwd: dir.root, pmRoot: join(dir.root,".agents/pm"), noExtensions: true }).init("resource-lifetime",{defaults:true,author:"fixture"});
  const store = new ObjectStore(join(dir.root,"objects"));
  const id = store.write("blob",Buffer.from("line-a\nline-b\n"));
  return { dir, store, id };
}

/** Count the actual OS descriptor table; other platforms still check the ownership registry. */
function descriptors(): number { return process.platform === "linux" ? readdirSync("/proc/self/fd").length : objectFiles.active.size; }

test("every reader x four exit modes x loose and packed closes before each operation returns", async (t) => {
  const f = await fixture(); t.after(() => f.dir.cleanup());
  let cells = 0; let injected = 0;
  assert.equal(Object.keys(lifetimeReaders).length,25);
  for (const packed of [false,true]) {
    if (packed) f.store.compact();
    for (const [name,read] of Object.entries(lifetimeReaders)) for (const mode of modes) {
      const baseline = descriptors();
      const result = exercise(() => read(f.store,f.id),mode); injected += result.injected;
      assert.equal(descriptors(),baseline,`${name}/${packed ? "pack" : "loose"}/${mode}: must close before returning`);
      assert.equal(objectFiles.active.size,0,`${name}/${mode}: no retained owners`);
      cells++;
    }
  }
  assert.equal(cells,200); assert.ok(injected > 80);
  t.diagnostic(`${cells} per-operation cells; ${injected} acquired-handle error/abort injections; scalar early-stop is synchronous completion; an empty representation inventory opens no handle`);
});

test("synchronous completed packed streams release their descriptor before returning", async (t) => {
  const f = await fixture(); t.after(() => f.dir.cleanup()); f.store.compact();
  const baseline = descriptors();
  for (let i = 0; i < 128; i++) {
    assert.deepEqual(Buffer.concat([...f.store.readChunks(f.id,"blob")]),Buffer.from("line-a\nline-b\n"));
    assert.equal(descriptors(),baseline,`completed stream ${i} leaked`);
    assert.equal(objectFiles.active.size,0);
  }
});

test("all iterator readers close on explicit return, consumer throw, and asynchronous stream destroy or abort", async (t) => {
  const f = await fixture(); t.after(() => f.dir.cleanup()); f.store.compact();
  for (const read of Object.values(lifetimeReaders)) {
    const result = read(f.store,f.id); if (!iterator(result)) continue;
    result.return(undefined);
    for (const mode of ["return","throw","destroy","abort"] as const) {
      const baseline = descriptors(); const value = read(f.store,f.id); assert.ok(iterator(value));
      if (mode === "return" || mode === "throw") {
        value.next();
        if (mode === "return") value.return(undefined);
        else assert.throws(() => value.throw(new Error("consumer fault")),/consumer fault/);
      } else {
        const controller = new AbortController(); const stream = Readable.from(value,{signal:controller.signal});
        const settled = finished(stream);
        stream.once("data",() => { if (mode === "abort") controller.abort(); else stream.destroy(); });
        stream.resume();
        await settled.catch((error: Error) => { assert.ok(error.name === "AbortError" || "code" in error && error.code === "ERR_STREAM_PREMATURE_CLOSE"); });
      }
      assert.equal(descriptors(),baseline,`${mode} settled with an open descriptor`); assert.equal(objectFiles.active.size,0);
    }
  }
});

test("10,000 sequential reads per representation and exit mode converge under a 128-descriptor limit", async (t) => {
  if (process.platform !== "linux") { t.diagnostic("Linux descriptor-limit soak; portable ownership invariants run on every platform"); return; }
  const f = await fixture(); t.after(() => f.dir.cleanup());
  for (const packed of [false,true]) {
    if (packed) f.store.compact();
    for (const mode of modes) {
      const child = spawnSync("bash",["-c",'ulimit -n 128; exec "$@"',"object-soak",process.execPath,join(packageRoot,"test/helpers/object-lifetime-soak.ts"),f.store.storageRoot(),f.id,mode],{encoding:"utf8",timeout:300_000});
      assert.equal(child.status,0,`${packed ? "pack" : "loose"}/${mode}: ${child.stderr}`);
      assert.equal(child.signal,null); const receipt = JSON.parse(child.stdout) as {reads:number;baseline:number;after:number;emfile:number};
      assert.equal(receipt.reads,10_000); assert.equal(receipt.baseline,receipt.after); assert.equal(receipt.emfile,0);
      t.diagnostic(`${packed ? "packed" : "loose"}: ${child.stdout.trim()}`);
    }
  }
});

test("owned opens close on native metadata/read faults and cannot close a reused descriptor twice", async (t) => {
  const f = await fixture(); t.after(() => f.dir.cleanup());
  const path = join(f.store.storageRoot(),f.id.slice(0,2),f.id.slice(2));
  const file = objectFiles.open(path,"r"); file.close(); const next = objectFiles.open(path,"r"); file.close(); assert.ok(readFileSync(next.fd).length > 0); next.close();
  for (const packed of [false,true]) {
    if (packed) f.store.compact();
    for (const method of ["fstatSync","readSync"] as const) {
      const baseline = descriptors();
      mock.method(fs,method,() => { throw Object.assign(new Error("read failed"),{code:"EIO"}); }); syncBuiltinESMExports();
      try { assert.throws(() => [...f.store.readChunks(f.id,"blob")],{code:"EIO"}); }
      finally { mock.restoreAll(); syncBuiltinESMExports(); }
      assert.equal(descriptors(),baseline); assert.equal(objectFiles.active.size,0);
    }
  }
});

test("synchronous inflater verifies checksums, truncated input, bounds and empty streams", async (t) => {
  const f = await fixture(); t.after(() => f.dir.cleanup());
  const path = join(f.store.storageRoot(),f.id.slice(0,2),f.id.slice(2)); const original = readFileSync(path);
  for (const bytes of [original.subarray(0,original.length-1), Buffer.concat([original.subarray(0,original.length-1),Buffer.from([original.at(-1)! ^ 1])]),Buffer.alloc(0)]) {
    writeFileSync(path,bytes); const baseline = descriptors(); assert.throws(() => [...f.store.readChunks(f.id,"blob")],{code:"corrupt_object"}); assert.equal(descriptors(),baseline);
  }
  writeFileSync(path,deflateSync(frameObject("blob",Buffer.from("line-a\nline-b\n"))));
  assert.deepEqual(Buffer.concat([...f.store.readChunks(f.id,"blob")]),Buffer.from("line-a\nline-b\n"));
});


test("object-layer explicit opens use one owner and writer metadata faults close before refusal", async (t) => {
  for (const path of ["objects.ts","packs.ts","object-stream.ts","durability.ts"]) {
    const source = readFileSync(join(packageRoot,"engine",path),"utf8");
    assert.equal(/\b(?:openSync|createReadStream|createWriteStream)\s*\(/.test(source),false,`${path} bypasses registered ownership`);
  }
  const f = await fixture(); t.after(() => f.dir.cleanup()); const baseline = descriptors();
  mock.method(fs,"fstatSync",() => { throw Object.assign(new Error("writer stat failed"),{code:"EIO"}); }); syncBuiltinESMExports();
  try { assert.throws(() => f.store.withWriteLock(() => {}),{code:"EIO"}); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(descriptors(),baseline); assert.equal(objectFiles.active.size,0);
});
