import { readCommit, readTree, writeTree, writeCommit } from "../engine/model.ts";
/** Real receiver authority, durable generations and multi-process publication races. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { exportBundle, parseBundle } from "../engine/bundle.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { PublicationLeases, PublicationLeaseError, filesystemPrincipal, type FileLease } from "../engine/publication-leases.ts";
import { Repository } from "../engine/repo.ts";
import { startRepositoryServer, TokenGrants } from "../engine/serve.ts";
import { FileTransport } from "../engine/transport.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const dirs: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) dir.cleanup(); });
const author = { name: "Author", email: "author@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
/** Bound IPC readiness and completion, rejecting a peer that exits before its message. */
function peerMessage(child: ChildProcess): Promise<[unknown]> {
  return new Promise((resolve, reject) => {
    /** Remove competing listeners once this synchronization point settles. */
    const cleanup = (): void => { clearTimeout(timer); child.off("message", message); child.off("error", failed); child.off("exit", exited); };
    /** Accept exactly the next real peer message. */
    const message = (value: unknown): void => { cleanup(); resolve([value]); };
    /** Preserve process errors while releasing the synchronization listeners. */
    const failed = (error: Error): void => { cleanup(); reject(error); };
    /** An exit cannot stand in for readiness or an operation receipt. */
    const exited = (code: number | null): void => failed(new Error(`peer exited ${code} before its message`));
    const timer = setTimeout(() => { failed(new Error("peer message deadline exceeded")); child.kill(); }, 60_000);
    child.once("message", message); child.once("error", failed); child.once("exit", exited);
    if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode);
  });
}
/** Build actual attributed receiver history and an independent empty receiver. */
function fixture() {
  const dir = makeTempDir(); dirs.push(dir);
  const sender = Repository.init(join(dir.root, "sender"));
  writeFileSync(join(sender.root, "asset"), "initial"); sender.stage(["asset"]);
  const first = sender.commit({ message: "initial", author }, new Date());
  const fileId = sender.readIndex()[0].fileId!;
  const receiver = Repository.init(join(dir.root, "receiver"));
  const wire = new FileTransport("receiver", receiver.root);
  return { dir, sender, receiver, wire, first, fileId, updates: [{ ref: "refs/heads/main", expected: null, next: first }] };
}
/** Wait using the actual receiver clock so expiration assertions cannot use sender log timestamps. */
function expire(lease: FileLease): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, Math.max(1, lease.expiry - Date.now() + 5));
}

test("filesystem publication refuses missing, expired, scope and stale fencing proofs without moving refs", async () => {
  const { sender, receiver, wire, first, fileId, updates } = fixture();
  const bundle = exportBundle(sender.objects, sender.refs, []);
  const refused = (reason: string, holder: string | null) => (error: unknown) => {
    assert.ok(error instanceof PublicationLeaseError); assert.equal(error.reason, reason);
    assert.equal(error.fileId, fileId); assert.equal(error.holder, holder);
    assert.equal(receiver.refs.read("refs/heads/main"), null); return true;
  };
  await assert.rejects(wire.push(bundle, updates, false, new Date(0)), refused("missing", null));
  const lease = await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/other"], ttlMs: 60000 });
  await assert.rejects(wire.publish(updates, true, new Date(0)), refused("out_of_scope", filesystemPrincipal().principal));
  await wire.lease({ action: "release", fileId, token: lease!.token });
  const short = await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 30 }); expire(short!);
  await assert.rejects(wire.publish(updates, false, new Date(0)), refused("expired", filesystemPrincipal().principal));
  await assert.rejects(wire.lease({ action: "renew", fileId, token: short!.token, ttlMs: 60000 }), { code: "lease_expired" });
  const next = await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 });
  assert.equal(next!.generation, short!.generation + 1);
  await assert.rejects(wire.publish(updates, false, new Date(), [short!]), refused("fenced", filesystemPrincipal().principal));
  await wire.publish(updates, false, new Date("2100-01-01")); assert.equal(receiver.resolve("main"), first);
  assert.equal(readFileSync(join(receiver.controlDirectory, "leases", `${fileId}.jsonl`), "utf8").trim().split("\n").length, 4);
});

test("authenticated HTTP uses receiver principals, explicit break grants and preserves typed refusal fields", async () => {
  const { sender, receiver, fileId, updates } = fixture();
  const server = await startRepositoryServer({ root: receiver.root, host: "127.0.0.1", port: 0,
    grants: new TokenGrants([{ token: "alice-secret", repository: "", access: "write", principal: "alice" },
      { token: "bob-secret", repository: "", access: "write", principal: "bob" },
      { token: "admin-secret", repository: "", access: "write", principal: "administrator", breakLeases: true }]) });
  try {
    const alice = new HttpTransport(`http://${server.host}:${server.port}`, { token: "alice-secret" });
    const bob = new HttpTransport(`http://${server.host}:${server.port}`, { token: "bob-secret" });
    const admin = new HttpTransport(`http://${server.host}:${server.port}`, { token: "admin-secret" });
    const lease = await alice.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 });
    const bundle = exportBundle(sender.objects, sender.refs, []);
    await assert.rejects(bob.push(bundle, updates, true, new Date(), [lease!]), (error: unknown) => {
      assert.ok(error instanceof PublicationLeaseError); assert.equal(error.reason, "wrong_principal");
      assert.equal(error.holder, "alice"); assert.equal(error.expiry, lease!.expiry); assert.equal(error.fileId, fileId); return true;
    });
    assert.equal(receiver.refs.read("refs/heads/main"), null);
    await assert.rejects(bob.lease({ action: "break", fileId }), { code: "lease_break_forbidden" });
    await admin.lease({ action: "break", fileId });
    const newer = await bob.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 });
    assert.ok(newer!.generation > lease!.generation);
    await bob.publish(updates, false, new Date());
    assert.equal(receiver.resolve("main"), updates[0].next);
    const audit = readFileSync(join(receiver.controlDirectory, "leases", `${fileId}.jsonl`), "utf8");
    assert.match(audit, /administrator/); assert.doesNotMatch(audit, /alice-secret|bob-secret/);
  } finally { await server.close(); }
});

test("leases survive renames and deletion publication still needs the deleted stable identity", async () => {
  const { sender, receiver, wire, fileId, first, updates } = fixture();
  const initial = await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 });
  await wire.push(exportBundle(sender.objects, sender.refs, []), updates, false, new Date());
  renameSync(join(sender.root, "asset"), join(sender.root, "moved")); sender.stage([]);
  const renamed = sender.commit({ message: "rename", author }, new Date());
  assert.equal(sender.readIndex()[0].fileId, fileId);
  await wire.push(exportBundle(sender.objects, sender.refs, []), [{ ref: "refs/heads/main", expected: first, next: renamed }], false, new Date());
  rmSync(join(sender.root, "moved")); sender.stage([]); const deleted = sender.commit({ message: "delete", author }, new Date());
  await wire.lease({ action: "release", fileId, token: initial!.token });
  await assert.rejects(wire.push(exportBundle(sender.objects, sender.refs, []), [{ ref: "refs/heads/main", expected: renamed, next: deleted }], false, new Date()), { code: "lease_missing" });
  assert.equal(receiver.resolve("main"), renamed);
});

test("independent processes contend for acquisition; exactly one generation wins", async () => {
  const { receiver, fileId } = fixture();
  const children = [0, 1].map(() => fork(join(packageRoot, "test/helpers/publication-lease-worker.ts"), [receiver.root, fileId, "acquire"],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  try {
    await Promise.all(children.map(child => peerMessage(child)));
    const done = children.map(child => peerMessage(child));
    for (const child of children) child.send("start");
    const results = (await Promise.all(done)).map(([result]) => result as { code: string });
    assert.deepEqual(results.map(result => result.code).sort(), ["lease_held", "ok"]);
    assert.equal(new PublicationLeases(receiver.objects, receiver.controlDirectory).inspect(fileId)!.generation, 1);
  } finally { for (const child of children) child.kill(); }
});

/** Start a real peer process and pause it before the receiver transaction. */
async function peer(root: string, fileId: string, action: string, extra: string[] = []) {
  const child = fork(join(packageRoot, "test/helpers/publication-lease-worker.ts"), [root, fileId, action, ...extra],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await peerMessage(child);
  return child;
}

for (const mutation of ["renew", "release", "break", "expiry"] as const) {
  test(`a real paused publisher rechecks ${mutation} at receiver preflight without moving refused refs`, async () => {
    const { sender, receiver, wire, fileId, updates } = fixture();
    // Import immutable closure before starting the independent publication process.
    const bundle = exportBundle(sender.objects, sender.refs, []);
    const { lines } = parseBundle(bundle); await wire.uploadObjects(lines);
    const lease = await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: mutation === "expiry" ? 100 : 60000 });
    const publisher = await peer(receiver.root, fileId, "publish", [JSON.stringify(updates), JSON.stringify([lease])]);
    try {
      if (mutation === "expiry") expire(lease!);
      else {
        const other = await peer(receiver.root, fileId, mutation, [lease!.token]);
        try {
          const done = peerMessage(other); other.send("start");
          const [result] = await done; assert.equal((result as { code: string }).code, "ok");
        } finally { other.kill(); }
      }
      const done = peerMessage(publisher); publisher.send("start");
      const [result] = await done;
      assert.equal((result as { code: string }).code, mutation === "renew" ? "ok" : mutation === "expiry" ? "lease_expired" : "lease_missing");
      assert.equal(receiver.refs.read("refs/heads/main"), mutation === "renew" ? updates[0].next : null);
    } finally { publisher.kill(); }
  });
}

test("batch refusal leaves every ref unmoved and create-then-delete identities cannot evade lease checks", async () => {
  const { sender, receiver, wire, fileId, updates } = fixture();
  await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 60000 });
  await assert.rejects(wire.push(exportBundle(sender.objects, sender.refs, []), [...updates, { ...updates[0], ref: "refs/heads/second" }], true, new Date()), { code: "lease_out_of_scope" });
  assert.equal(receiver.refs.read("refs/heads/main"), null); assert.equal(receiver.refs.read("refs/heads/second"), null);
  writeFileSync(join(sender.root, "temporary"), "temporary history"); sender.stage([]);
  sender.commit({ message: "introduce transient file", author }, new Date());
  const transient = sender.readIndex().find(entry => entry.path === "temporary")!.fileId!;
  rmSync(join(sender.root, "temporary")); sender.stage([]);
  const tip = sender.commit({ message: "remove transient file", author }, new Date());
  await assert.rejects(wire.push(exportBundle(sender.objects, sender.refs, []), [{ ...updates[0], next: tip }], true, new Date()), (error: unknown) => {
    assert.ok(error instanceof PublicationLeaseError); assert.equal(error.fileId, transient); return true;
  });
  assert.equal(receiver.refs.read("refs/heads/main"), null);
});


test("receiver walks nested stable identities while preserving legacy anonymous tree compatibility", async () => {
  const { sender, receiver, wire, fileId, first } = fixture();
  await wire.lease({ action: "acquire", fileId, refs: ["refs/heads/main"], ttlMs: 86400000 });
  mkdirSync(join(sender.root, "nested")); writeFileSync(join(sender.root, "nested/asset"), "nested"); sender.stage([]);
  const tip = sender.commit({ message: "nested identity", author }, new Date());
  const nested = sender.readIndex().find(entry => entry.path === "nested/asset")!.fileId!;
  const updates = [{ ref: "refs/heads/main", expected: null, next: tip }];
  await assert.rejects(wire.push(exportBundle(sender.objects, sender.refs, []), updates, false, new Date()), error => error instanceof PublicationLeaseError && error.fileId === nested);
  assert.equal(receiver.refs.read("refs/heads/main"), null);
  await wire.lease({ action: "acquire", fileId: nested, refs: ["refs/heads/main"], ttlMs: 86400000 });
  await wire.publish(updates, false, new Date());
  const blob = sender.objects.write("blob", Buffer.from("legacy"));
  const tree = writeTree(sender.objects, [...readTree(sender.objects, readCommit(sender.objects, tip).tree), { name: "legacy", mode: "100644", id: blob }]);
  const legacy = writeCommit(sender.objects, { tree, parents: [tip], author, committer: author, message: "legacy compatibility" });
  sender.refs.compareAndSwap("refs/heads/main", tip, legacy);
  await wire.push(exportBundle(sender.objects, sender.refs, []), [{ ref: "refs/heads/main", expected: tip, next: legacy }], false, new Date());
  assert.equal(receiver.refs.read("refs/heads/main"), legacy); assert.notEqual(first, legacy);
});
