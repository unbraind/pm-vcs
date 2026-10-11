/** Real durable-denial no-op transfers and immutable audit integrity regressions. */
import assert from "node:assert/strict";
import fs, { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { BUNDLE_FORMAT, exportBundle, importBundleObjects, parseBundle } from "../engine/bundle.ts";
import { encodeTombstone, type ErasureDenial } from "../engine/lifecycle.ts";
import { type Signature } from "../engine/model.ts";
import { hashObject, ObjectStore, type ObjectId } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { cloneFrom, fetchFrom } from "../engine/sync.ts";
import { FileTransport } from "../engine/transport.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const temps: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1000, timezoneOffsetMinutes: 0 };
afterEach(() => { mock.restoreAll(); for (const temp of temps.splice(0)) temp.cleanup(); });

/** Create an ordinary erased history with a surviving payload and real terminal audit. */
function fixture() {
  const temp = makeTempDir(); temps.push(temp);
  const repo = Repository.init(join(temp.root, "repo")); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(repo.root, "secret"), "selected ordinary fixture bytes");
  writeFileSync(join(repo.root, "survivor"), "surviving ordinary fixture bytes");
  repo.stage(["secret", "survivor"]); const selected = repo.readIndex().find(entry => entry.path === "secret")!;
  const tip = repo.commit({ message: "ordinary history", author }, new Date(1000));
  repo.obliterate("secret", "erase-fixture", "incident", new Date(2000));
  return { repo, temp, selected, tip, denial: repo.objects.denials()[0]! };
}

/** Actual durable registry and audit file identity, timestamps and bytes. */
function durable(repo: Repository) {
  return [join(repo.controlDirectory, "denials.json"), ...repo.objects.denials().map(denial =>
    join(join(repo.controlDirectory, "objects"), denial.id.slice(0, 2), denial.id.slice(2)))].map(path => {
    const stat = lstatSync(path, { bigint: true });
    return { path, ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs, bytes: readFileSync(path) };
  });
}

/** Change only synthetic archive metadata while retaining actual original object lines. */
function metadata(bytes: Buffer, denials: readonly ErasureDenial[] | undefined): Buffer {
  const lines = bytes.toString().trimEnd().split("\n"); const header = parseBundle(bytes).header;
  return Buffer.from([BUNDLE_FORMAT, JSON.stringify({ ...header, denials }), ...lines.slice(2)].join("\n") + "\n");
}

test("denial no-op repair retains registry, tombstones and two warmed handles across real transfers", async () => {
  const { repo, temp, selected, tip, denial } = fixture();
  const second = new ObjectStore(join(repo.controlDirectory, "objects")); const firstEntry = repo.objects.denials()[0]; const secondEntry = second.denials()[0];
  const before = durable(repo); const bundle = exportBundle(repo.objects, repo.refs, []);
  let writes = 0; let registryReads = 0; const persist = ObjectStore.prototype.recordDenials; const open = fs.openSync;
  mock.method(ObjectStore.prototype, "recordDenials", function (this: ObjectStore, entries: readonly ErasureDenial[]) {
    writes += 1; return persist.call(this, entries);
  });
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === join(repo.controlDirectory, "denials.json")) registryReads += 1;
    return open(...args);
  });
  const assertStable = () => {
    assert.deepEqual(durable(repo), before, "no-op transfer must not replace the durable registry or audit");
    assert.equal(repo.objects.denials()[0], firstEntry); assert.equal(second.denials()[0], secondEntry);
    assert.throws(() => second.read(selected.id), { code: "object_obliterated" });
  };
  for (const bytes of [bundle, bundle, metadata(bundle, undefined), metadata(bundle, [denial])]) {
    assert.deepEqual(importBundleObjects(repo.objects, bytes).added, []); assertStable();
  }
  assert.equal(writes, 0);
  const peer = await cloneFrom(repo.root, join(temp.root, "peer"), new Date(3000));
  const afterCloneWrites = writes; repo.remotes.add("peer", peer.root); await fetchFrom(repo, "peer", new Date(3000));
  const beforeRepeatFetchReads = registryReads;
  for (let i = 0; i < 2; i += 1) { assert.equal((await fetchFrom(repo, "peer", new Date(3000))).upToDate, true); assertStable(); }
  const transport = new FileTransport(repo.root, repo.root);
  await transport.push(bundle, [{ ref: "refs/heads/main", expected: tip, next: tip }], false, new Date(3000)); assertStable();
  assert.equal(writes, afterCloneWrites, "only the fresh clone persists denial metadata");
  assert.equal(registryReads - beforeRepeatFetchReads, 3, "two newly opened peer handles and one push handle read their registry once; original handles stay warm");
});

test("denial no-op repair fresh clone persists metadata before objects and reconstructs terminal state", async () => {
  const { repo, temp, selected, tip, denial } = fixture(); const persist = ObjectStore.prototype.recordDenials;
  let publications = 0;
  mock.method(ObjectStore.prototype, "recordDenials", function (this: ObjectStore, entries: readonly ErasureDenial[]) {
    assert.deepEqual(entries, [denial]); assert.equal(this.has(selected.id), false); publications += 1;
    assert.equal(this.has(tip), false, "durable received denial must precede commit publication");
    return persist.call(this, entries);
  });
  const clone = await cloneFrom(repo.root, join(temp.root, "clone"), new Date(3000)); assert.equal(publications, 1);
  const reopened = Repository.open(clone.root); assert.deepEqual(reopened.objects.denials(), [denial]);
  assert.deepEqual(reopened.objects.readTyped(denial.id, "tombstone"), encodeTombstone(denial.tombstone));
  assert.equal(reopened.readFileState(repo.refs.resolveHead()!, "secret").kind, "obliterated"); assert.deepEqual(reopened.verify().corrupt, []);
});

test("denial no-op repair extends durable local metadata only after complete closure validation", async () => {
  const { repo, temp, denial } = fixture(); const before = durable(repo);
  const peer = Repository.open((await cloneFrom(repo.root, join(temp.root, "extension"), new Date(3000))).root);
  peer.setAuthority("fixture", "read-fixture", "erase-fixture");
  writeFileSync(join(peer.root, "second"), "second terminal fixture bytes"); peer.stage(["second"]);
  const tip = peer.commit({ message: "second history", author }, new Date(3000));
  peer.obliterate("second", "erase-fixture", "incident", new Date(4000));
  const next = peer.objects.denials().find(entry => entry.id !== denial.id)!;
  const bundle = exportBundle(peer.objects, peer.refs, []);
  assert.throws(() => importBundleObjects(repo.objects, bundle, ["e".repeat(64)]), { code: "incomplete_bundle" });
  assert.deepEqual(durable(repo), before); assert.equal(repo.objects.has(next.id), false); assert.equal(repo.objects.has(tip), false);
  importBundleObjects(repo.objects, bundle); assert.deepEqual(repo.objects.denials(), [denial, next]);
  assert.deepEqual(repo.objects.readTyped(next.id, "tombstone"), encodeTombstone(next.tombstone));
  assert.equal(repo.readFileState(tip, "second").kind, "obliterated");
  const extended = durable(repo); importBundleObjects(repo.objects, bundle); assert.deepEqual(durable(repo), extended);
});

for (const damage of ["missing", "corrupt"] as const) test(`denial no-op repair refuses ${damage} local audit objects without reconstruction`, () => {
  const { repo, denial } = fixture(); const bundle = metadata(exportBundle(repo.objects, repo.refs, []), undefined);
  const path = join(join(repo.controlDirectory, "objects"), denial.id.slice(0, 2), denial.id.slice(2));
  if (damage === "missing") rmSync(path); else writeFileSync(path, "ordinary damaged compressed object");
  const registry = readFileSync(join(repo.controlDirectory, "denials.json")); const before = lstatSync(join(repo.controlDirectory, "denials.json"), { bigint: true });
  assert.throws(() => importBundleObjects(repo.objects, bundle), { code: damage === "missing" ? "object_not_found" : "corrupt_object" });
  assert.deepEqual(readFileSync(join(repo.controlDirectory, "denials.json")), registry);
  assert.equal(lstatSync(join(repo.controlDirectory, "denials.json"), { bigint: true }).ino, before.ino);
});

test("denial no-op repair refuses duplicated, conflicting, denied and pending arrivals atomically", () => {
  const { repo, denial, selected } = fixture(); const bundle = exportBundle(repo.objects, repo.refs, []); const before = durable(repo);
  const tombstone = { ...denial.tombstone, reason: "different" };
  const conflict: ErasureDenial = { id: hashObject("tombstone", encodeTombstone(tombstone)), tombstone, pending: false };
  for (const [entries, code] of [[[denial, denial], "bad_tombstone"], [[conflict], "tombstone_conflict"], [[{ ...denial, pending: true }], "erasure_incomplete"]] as const) {
    assert.throws(() => importBundleObjects(repo.objects, metadata(bundle, entries)), { code }); assert.deepEqual(durable(repo), before);
  }
  const payload = Buffer.from("selected ordinary fixture bytes"); const allowed = Buffer.from("ordinary incoming survivor"); const allowedId = hashObject("blob", allowed);
  const header = { refs: {}, objects: [allowedId, selected.id], denials: [denial] };
  const arrival = Buffer.from(`${BUNDLE_FORMAT}\n${JSON.stringify(header)}\nblob ${allowedId} ${allowed.toString("base64")}\nblob ${selected.id} ${payload.toString("base64")}\n`);
  assert.throws(() => importBundleObjects(repo.objects, arrival), { code: "object_obliterated" }); assert.deepEqual(durable(repo), before);
  assert.equal(repo.objects.has(allowedId), false, "a valid earlier arrival cannot leak out of a refused batch");
  repo.objects.recordDenials([{ ...denial, pending: true }]); const pending = durable(repo);
  assert.throws(() => importBundleObjects(repo.objects, metadata(bundle, undefined)), { code: "erasure_incomplete" }); assert.deepEqual(durable(repo), pending);
});
