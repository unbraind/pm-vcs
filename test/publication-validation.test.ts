/** Bounded publication regressions over real SDK repositories and original physical reads. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { deflateSync } from "node:zlib";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { serializeBundle } from "../engine/bundle.ts";
import { writeCommit, writeTree, type Signature } from "../engine/model.ts";
import { frameObject, hashObject, ObjectStore, ObjectStoreError, type ObjectId } from "../engine/objects.ts";
import { OperationLog } from "../engine/oplog.ts";
import { RefStore } from "../engine/refs.ts";
import { Repository } from "../engine/repo.ts";
import { FileTransport, type PushUpdate } from "../engine/transport.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const signature: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const temporary: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) directory.cleanup(); });

/** Create five hash-valid objects with two distinct tips sharing both history and payload. */
async function fixture(): Promise<{ repo: Repository; ids: ObjectId[]; left: ObjectId; right: ObjectId }> {
  const directory = makeTempDir(); temporary.push(directory);
  const client = new PmClient({ cwd: directory.root, pmRoot: join(directory.root, ".agents", "pm"), noExtensions: true });
  await client.init("publication", { defaults: true, author: "fixture" });
  const repo = Repository.init(directory.root);
  const leaf = repo.objects.write("blob", Buffer.from([0, 255, 17]));
  const tree = writeTree(repo.objects, [{ name: "ordinary.bin", mode: "100644", id: leaf, fileId: "a".repeat(32) }]);
  const base = writeCommit(repo.objects, { tree, parents: [], author: signature, committer: signature, message: "base" });
  const left = writeCommit(repo.objects, { tree, parents: [base], author: signature, committer: signature, message: "left" });
  const right = writeCommit(repo.objects, { tree, parents: [base], author: signature, committer: signature, message: "right" });
  return { repo, ids: [leaf, tree, base, left, right], left, right };
}

for (const mode of ["push", "publish"] as const) {
  test(`publication ${mode} reads each shared object once under one writer lease`, async () => {
    const { repo, ids, left, right } = await fixture();
    const transport = new FileTransport(repo.root, repo.root);
    const updates: PushUpdate[] = [
      { ref: "refs/heads/first", expected: null, next: left },
      { ref: "refs/tags/shared", expected: null, next: left },
      { ref: "refs/heads/second", expected: null, next: right },
    ];
    const bundle = serializeBundle(repo.objects, { refs: { "refs/heads/advertised": left }, prerequisites: [], objects: [] });
    const original = ObjectStore.prototype.read;
    const reads = new Map<ObjectId, number>(); const owners: string[] = []; const leases: bigint[] = [];
    const originalTransaction = RefStore.prototype.transaction; const originalAppend = OperationLog.prototype.append;
    OperationLog.prototype.append = function (...args) {
      const lock = join(repo.controlDirectory, "objects.lock");
      owners.push(existsSync(lock) ? readFileSync(lock, "utf8") : "absent");
      if (existsSync(lock)) leases.push(lstatSync(lock, { bigint: true }).ino);
      return originalAppend.apply(this, args);
    };
    RefStore.prototype.transaction = function (moves) {
      const lock = join(repo.controlDirectory, "objects.lock");
      owners.push(existsSync(lock) ? readFileSync(lock, "utf8") : "absent");
      if (existsSync(lock)) leases.push(lstatSync(lock, { bigint: true }).ino);
      return originalTransaction.call(this, moves);
    };
    ObjectStore.prototype.read = function (id) {
      const object = original.call(this, id);
      if (ids.includes(id)) {
        reads.set(id, (reads.get(id) ?? 0) + 1);
        const lock = join(repo.controlDirectory, "objects.lock");
        owners.push(existsSync(lock) ? readFileSync(lock, "utf8") : "absent");
        if (existsSync(lock)) leases.push(lstatSync(lock, { bigint: true }).ino);
      }
      return object;
    };
    try {
      const receipt = mode === "push"
        ? await transport.push(bundle, updates, false, new Date(1000))
        : await transport.publish(updates, false, new Date(1000));
      assert.deepEqual(receipt.updated, updates); assert.deepEqual(receipt.added, []);
    } finally {
      Object.defineProperty(ObjectStore.prototype, "read", { value: original });
      Object.defineProperty(RefStore.prototype, "transaction", { value: originalTransaction });
      Object.defineProperty(OperationLog.prototype, "append", { value: originalAppend });
    }
    assert.deepEqual([...reads.keys()].sort(), [...ids].sort());
    assert.deepEqual([...reads.values()], Array(ids.length).fill(1), "publication repeated physical integrity reads for shared roots");
    assert.deepEqual(owners, Array(ids.length + 2).fill(String(process.pid)), "closure was inspected outside the publication lease");
    assert.equal(new Set(leases).size, 1, "validation and ref transaction used different leases");
    assert.equal(existsSync(join(repo.controlDirectory, "objects.lock")), false);
    assert.deepEqual(repo.operations.read().at(-1)?.refs, updates.map(update => ({ ref: update.ref, before: null, after: update.next })));
    console.log(`publication read-walk: ${mode}, ${updates.length} refs, ${new Set(updates.map(update => update.next)).size} tips, ${ids.length} objects, ${[...reads.values()].reduce((sum, count) => sum + count, 0)} original reads, one writer lease`);
  });

  test(`publication ${mode} refuses a corrupt or missing unadvertised second target atomically`, async () => {
    const { repo, left, right } = await fixture();
    const transport = new FileTransport(repo.root, repo.root);
    const payload = Buffer.from("new carried bytes behind an invalid second root"); const arrival = hashObject("blob", payload);
    const bundle = Buffer.from(`pmvcs-bundle-1\n${JSON.stringify({ refs: { "refs/heads/advertised": left }, prerequisites: [], objects: [arrival] })}\nblob ${arrival} ${payload.toString("base64")}\n`);
    const updates: PushUpdate[] = [{ ref: "refs/heads/first", expected: null, next: left }, { ref: "refs/heads/second", expected: null, next: right }];
    const path = join(repo.controlDirectory, "objects", right.slice(0, 2), right.slice(2));
    const bytes = readFileSync(path); const refs = repo.refs.list("refs/"); const operations = repo.operations.read(); const index = repo.readIndex();
    for (const damage of ["corrupt", "missing"] as const) {
      if (damage === "corrupt") writeFileSync(path, deflateSync(frameObject("commit", Buffer.from("different valid bytes"))));
      else rmSync(path);
      try {
        await assert.rejects(mode === "push" ? transport.push(bundle, updates, true, new Date()) : transport.publish(updates, true, new Date()), (error: unknown) => error instanceof ObjectStoreError && error.code === "incomplete_bundle" && error.message.includes(right));
        assert.equal(repo.objects.has(arrival), false, "invalid second root imported unrelated bytes");
        assert.deepEqual(repo.refs.list("refs/"), refs); assert.deepEqual(repo.operations.read(), operations); assert.deepEqual(repo.readIndex(), index);
      } finally { writeFileSync(path, bytes); }
    }
    const missing = "f".repeat(64) as ObjectId;
    updates[1] = { ...updates[1]!, next: missing };
    await assert.rejects(mode === "push" ? transport.push(bundle, updates, false, new Date()) : transport.publish(updates, false, new Date()), (error: unknown) => error instanceof ObjectStoreError && error.code === "incomplete_bundle" && error.message.includes(missing));
    assert.deepEqual(repo.refs.list("refs/"), refs);
  });

  test(`publication ${mode} validates names before arrivals and preserves force and stale CAS`, async () => {
    const { repo, left, right } = await fixture();
    const transport = new FileTransport(repo.root, repo.root);
    const payload = Buffer.from("fresh unrelated publication arrival"); const arrival = { id: hashObject("blob", payload), type: "blob" as const, payload };
    const bundle = Buffer.from(`pmvcs-bundle-1\n${JSON.stringify({ refs: {}, prerequisites: [], objects: [arrival.id] })}\nblob ${arrival.id} ${payload.toString("base64")}\n`);
    for (const [ref, code] of [["refs/heads/../invalid", "invalid_ref_name"], ["refs/remotes/other/main", "unpushable_ref"]]) {
      const invalid = [{ ref: ref!, expected: null, next: left }];
      await assert.rejects(mode === "push" ? transport.push(bundle, invalid, false, new Date()) : transport.publish(invalid, false, new Date()), (error: unknown) => error instanceof ObjectStoreError && error.code === code);
      assert.equal(repo.objects.has(arrival.id), false, "invalid publication stored unrelated arrival bytes");
    }
    const empty = serializeBundle(repo.objects, { refs: {}, prerequisites: [], objects: [] });
    const first = "refs/heads/first"; repo.refs.compareAndSwap(first, null, left);
    const move = [{ ref: first, expected: left, next: right }, { ref: "refs/tags/second", expected: null, next: right }];
    await assert.rejects(mode === "push" ? transport.push(empty, move, false, new Date()) : transport.publish(move, false, new Date()), (error: unknown) => error instanceof ObjectStoreError && error.code === "non_fast_forward");
    assert.equal(repo.refs.read(first), left); assert.equal(repo.refs.read("refs/tags/second"), null);
    if (mode === "push") await transport.push(empty, move, true, new Date());
    else await transport.publish(move, true, new Date());
    assert.equal(repo.refs.read(first), right); assert.equal(repo.refs.read("refs/tags/second"), right);
    const stale = [{ ref: first, expected: right, next: left }, { ref: "refs/tags/second", expected: left, next: left }];
    const operations = repo.operations.read();
    await assert.rejects(mode === "push" ? transport.push(empty, stale, true, new Date()) : transport.publish(stale, true, new Date()), (error: unknown) => error instanceof ObjectStoreError && error.code === (mode === "push" ? "ref_changed" : "publication_race"));
    assert.equal(repo.refs.read(first), right); assert.equal(repo.refs.read("refs/tags/second"), right); assert.deepEqual(repo.operations.read(), operations);
    await transport.uploadObjects([arrival]);
    await assert.rejects(transport.publish([{ ref: "refs/remotes/other/main", expected: null, next: left }], false, new Date()), (error: unknown) => error instanceof ObjectStoreError && error.code === "unpushable_ref");
    const receipt = await transport.publish([{ ref: "refs/heads/receipt", expected: null, next: left }], false, new Date());
    assert.deepEqual(receipt.added, [], "a refused attempt retained the connection's accepted objects");
  });
}

test("publication fresh binary staging after unrelated erasure retains malformed encoding refusal", async () => {
  const { repo } = await fixture(); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  const marker = Buffer.from("unrelated synthetic erasure marker for binary contract");
  writeFileSync(join(repo.root, "marker.bin"), marker); repo.stage(["marker.bin"]); repo.commit({ message: "marker", author: signature }, new Date());
  repo.obliterate("marker.bin", "erase-fixture", "incident", new Date());
  const denied = readFileSync(join(repo.controlDirectory, "denials.json"));
  const ordinary = Buffer.from([0, 255, 17, 0, 128]); writeFileSync(join(repo.root, "fresh.bin"), ordinary);
  assert.deepEqual(repo.stage(["fresh.bin"]), ["fresh.bin"]);
  assert.deepEqual(repo.objects.read(repo.readIndex().find(entry => entry.path === "fresh.bin")!.id).payload, ordinary);
  for (const [name, bytes, code] of [
    ["malformed.bin", Buffer.from([0x78, 0x9c, 0xff]), "uninspectable_payload"],
    ["encoded-malformed.bin", Buffer.from(Buffer.from([0x78, 0x9c, 0xff]).toString("base64")), "uninspectable_payload"],
    ["retained.bin", deflateSync(frameObject("blob", marker)), "object_obliterated"],
  ] as const) {
    writeFileSync(join(repo.root, name), bytes);
    assert.throws(() => repo.stage([name]), (error: unknown) => error instanceof ObjectStoreError && error.code === code);
    assert.deepEqual(readFileSync(join(repo.root, name)), bytes); assert.equal(repo.readIndex().some(entry => entry.path === name), false);
  }
  assert.deepEqual(readFileSync(join(repo.controlDirectory, "denials.json")), denied);
});
