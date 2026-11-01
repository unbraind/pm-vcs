import "./helpers/isolate-session.ts";
/** Native derivation edges are a primary erasure proof, including historical unknowns and bounded DAGs. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, symlinkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants as zlibConstants, deflateSync } from "node:zlib";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { collectGarbage } from "../engine/gc.ts";
import { type DerivationRecord, unknownDerivations, upgradeDerivations, provenanceLimits, clearDerivations, recordDerivation, derivations, derivationClosure, UncataloguedProvenance } from "../engine/derivations.ts";
import { allowsDeniedRoot, assertArrivalsAllowed, encodeTombstone, type ErasureTombstone } from "../engine/lifecycle.ts";
import { compositionLimits, manifestIdentities, manifestIdentity } from "../engine/erasure-provenance.ts";
import { serveForge } from "../engine/forge.ts";
import { Repository } from "../engine/repo.ts";
import { encodeManifest, encodeRecord, encodeTree, readCommit, readTree, writeCommit, type RecordDocument, type Signature } from "../engine/model.ts";
import { encodePagedManifest } from "../engine/manifest-pages.ts";
import { competingResolutions, carryConflicts, encodeConflict, fieldSide, readConflict, resolvePayload } from "../engine/conflicts.ts";
import { mergePath, mergeTrees } from "../engine/rewrite.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { frameObject, hashObject, ObjectStore, type ObjectId, type StoredObject } from "../engine/objects.ts";
import { writeFragmented, writeCdcFragmented, writeFragmentedFile, readFragmented } from "../engine/fragments.ts";
import { erasureScanBoundary } from "../engine/erasure-scan.ts";
import { WorktreeMutation } from "../engine/worktree-mutation.ts";
import { nativeOutputs } from "../engine/native-outputs.ts";
import { encodeLink, writePrivateJson } from "../engine/composition.ts";
import { renderWorkingRecord } from "../engine/record-format.ts";
import { writeBundleFile } from "../engine/managed-exports.ts";
import { exportBundle, importBundle, parseBundle } from "../engine/bundle.ts";
import { makeTempDir } from "./helpers/tmp.ts";
const temps: ReturnType<typeof makeTempDir>[] = [];
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
afterEach(() => { for (const temp of temps.splice(0)) temp.cleanup(); });
/** Real non-Git tracker and native history; selected identity remains discoverable even after a rename. */
async function fixture() {
  const temp = makeTempDir(); temps.push(temp); process.env.GIT_CEILING_DIRECTORIES = temp.root;
  await new PmClient({ cwd: temp.root, pmRoot: join(temp.root, ".agents/pm"), noExtensions: true }).init("derivations", { defaults: true, author: "fixture" });
  const repo = Repository.init(temp.root); repo.setAuthority("fixture", "read-fixture", "erase-fixture");
  const secret = "selected secret provenance 937184";
  writeFileSync(join(repo.root, "asset"), secret);
  const id = repo.objects.write("blob", Buffer.from(secret), "f".repeat(32));
  repo.writeIndex([{ path: "asset", id, mode: "100644", fileId: "f".repeat(32) }]);
  const entry = repo.readIndex()[0];
  repo.commit({ message: "selected", author }, new Date(0));
  return { repo, entry, secret };
}
/** Erasure must deny every supplied native identity and preserve a verified structural history. */
function erase(repo: Repository, fileId: string, ids: readonly ObjectId[]) {
  const receipt = repo.obliterate(fileId, "erase-fixture", "provenance", new Date(1));
  for (const id of ids) { assert.ok(receipt.removed.includes(id), `omitted ${id}`); assert.throws(() => repo.objects.read(id), { code: "object_obliterated" }); }
  assert.equal(repo.verify().verification.status, "verified"); return receipt;
}

test("merge of different FileIds erases derived record and its materialized worktree", async () => {
  const { repo, entry, secret } = await fixture(); const other = "0".repeat(32);
  const base = repo.objects.write("record", encodeRecord({ common: "base" }), other);
  const ours = repo.objects.write("record", encodeRecord({ common: "base", public: "ours" }), other);
  const theirs = repo.objects.write("record", encodeRecord({ common: "base", secret }), entry.fileId);
  const tree = (id: ObjectId, fileId: string) => buildTree(repo.objects, new Map([["joined.json", { id, fileId, mode: "100644" as const }]]));
  const merged = mergeTrees({ store: repo.objects, config: repo.config, committer: author }, tree(base, other), tree(ours, other), tree(theirs, entry.fileId!));
  const result = flattenTree(repo.objects, merged.tree).get("joined.json")!;
  assert.equal(result.fileId, other);
  assert.ok(repo.objects.read(result.id).payload.includes(secret)); repo.materialize(merged.tree);
  assert.ok(readFileSync(join(repo.root, "joined.json")).includes(secret));
  repo.commit({ message: "native derived merge", author }, new Date(1));
  const boundary = erasureScanBoundary.visit;
  try {
    erasureScanBoundary.visit = step => { if (step === "pending") throw new Error("pending derived interruption"); };
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), /pending derived interruption/);
  } finally { erasureScanBoundary.visit = boundary; }
  assert.equal(repo.objects.denials()[0].pending, true);
  const receipt = erase(repo, entry.fileId!, [entry.id, theirs, result.id]);
  assert.ok(receipt.removed.includes(result.id)); assert.equal(existsSync(join(repo.root, "joined.json")), false);
  assert.equal(repo.objects.read(ours).payload.includes("ours"), true);
  assert.equal(repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(2)).tombstone, receipt.tombstone);
  writeFileSync(join(repo.root, "joined.json"), JSON.stringify({ public: "fresh independent replacement" }));
  repo.stage(["joined.json"]); const fresh = repo.readIndex().find(row => row.path === "joined.json")!;
  assert.equal(fresh.fileId, result.fileId); assert.equal(repo.objects.read(fresh.id).payload.includes("fresh independent"), true);
  assert.equal(repo.verify().verification.status, "verified");
});

for (const kind of ["record", "text", "history"] as const) test(`common replay merge producer certifies ${kind} outputs and conflict envelopes`, async () => {
  const { repo, entry, secret } = await fixture(); const other = "b".repeat(32);
  const type = kind === "record" ? "record" : "blob";
  const content: (string | RecordDocument)[] = kind === "record" ? [{ x: "base", tail: "base" }, { x: "ours", tail: "base", public: "ours" }, { x: secret, tail: secret }] : kind === "history"
    ? ['{"ts":0}\n', '{"ts":0}\n{"ts":1,"value":"ours"}\n', `{"ts":0}\n{"ts":2,"value":"${secret}"}\n`]
    : ["start\nbase\nend\ntail\n", "start\nours\nend\ntail\n", `start\n${secret} disputed\nend\n${secret} tail\n`];
  const ids = content.slice(0, 2).map(value => repo.objects.write(type, typeof value === "string" ? Buffer.from(value) : encodeRecord(value)));
  // Only one native input belongs to the selected identity; the output belongs to a different one.
  const selected = repo.objects.write(type, typeof content[2] === "string" ? Buffer.from(content[2]) : encodeRecord(content[2]), entry.fileId, [entry.id]);
  const result = mergePath({ store: repo.objects, config: repo.config, committer: author, recordConflicts: true }, kind === "history" ? ".agents/pm/history/fixture.jsonl" : kind === "record" ? "item.json" : "text.txt", ids[0], ids[1], selected, undefined, other);
  const catalog = derivations(repo.controlDirectory, () => {});
  assert.ok(derivationClosure(catalog, new Set([selected]), () => {}).has(result.id));
  const produced = [...catalog].filter(([_id, row]) => row.sources.includes(selected)).map(([id]) => id);
  erase(repo, entry.fileId!, [selected, result.id, ...produced]);
});

test("resolution and shifted text conflict producers retain transitive input provenance", async () => {
  const { repo, entry, secret } = await fixture(); const other = "c".repeat(32);
  const side = repo.objects.write("blob", Buffer.from(secret), entry.fileId, [entry.id]);
  const ours = repo.objects.write("blob", Buffer.from(`ours\nunchanged\n`), other);
  const alternative = repo.objects.write("blob", Buffer.from("alternative"), other);
  const unit = repo.objects.write("conflict", encodeConflict({ kind: "text", start: 0, end: 1, base: alternative, ours: side, theirs: alternative }), other);
  const shifted = repo.objects.write("blob", Buffer.from("prefix\nours\nunchanged\n"), other);
  const carried = carryConflicts(repo.objects, [unit], ours, shifted, other)![0];
  assert.equal(readConflict(repo.objects, carried).kind, "text");
  const resolved = resolvePayload(repo.objects, { id: shifted, fileId: other, conflicts: [carried] }, { take: "ours" });
  assert.ok(repo.objects.read(resolved.id).payload.includes(secret));
  erase(repo, entry.fileId!, [side, unit, carried, resolved.id]);
});

for (const kind of ["replacement", "rename", "copy", "fragment-rewrite"] as const) test(`staging records ${kind} native derivation`, async () => {
  const { repo, entry, secret } = await fixture();
  if (kind === "rename") renameSync(join(repo.root, "asset"), join(repo.root, "renamed"));
  else writeFileSync(join(repo.root, kind === "copy" ? "copied" : "asset"), kind === "replacement" ? secret + " appended" : kind === "fragment-rewrite" ? (secret + "\n").repeat(32768) : secret);
  const path = kind === "rename" ? "renamed" : kind === "copy" ? "copied" : "asset"; repo.stage([path]);
  const output = repo.readIndex().find(row => row.path === path)!; const row = derivations(repo.controlDirectory, () => {}).get(output.id)!;
  assert.ok(row.derived.includes(output.fileId!));
  if (kind === "copy") {
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "erasure_dedup_conflict" }); return;
  }
  erase(repo, entry.fileId!, [entry.id, output.id]); assert.equal(existsSync(join(repo.root, path)), false);
});

test("ccc4942-era conflict-side envelope remains readable/exportable but unknown provenance refuses before deletion", async () => {
  const { repo, entry, secret } = await fixture();
  // Exact ccc4942 fieldSide frame and compression, published without any later catalog format.
  const other = "e".repeat(32); const payload = encodeRecord({ value: secret });
  const legacy = hashObject("record", payload); const fanout = join(repo.objects.storageRoot(), legacy.slice(0, 2)); mkdirSync(fanout, { recursive: true });
  writeFileSync(join(fanout, legacy.slice(2)), deflateSync(frameObject("record", payload), { level: zlibConstants.Z_BEST_SPEED }));
  assert.equal(repo.objects.read(legacy).payload.toString(), encodeRecord({ value: secret }).toString());
  // A later same-address write may not launder this legacy identity into a newly certified origin.
  fieldSide(repo.objects, secret, other, [entry.id]);
  assert.equal(derivations(repo.controlDirectory, () => {}).has(legacy), false);
  repo.materialize(buildTree(repo.objects, new Map([["asset", { id: legacy, mode: "100644" as const, fileId: other }]])));
  repo.commit({ message: "legacy envelope fixture", author }, new Date(1));
  assert.ok(parseBundle(exportBundle(repo.objects, repo.refs, [])).lines.some(row => row.id === legacy));
  const before = repo.objects.inventory().map(row => row.id).sort();
  const working = readFileSync(join(repo.root, "asset"));
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), error => error instanceof UncataloguedProvenance && error.objects.includes(legacy));
  assert.deepEqual(repo.objects.inventory().map(row => row.id).sort(), before); assert.equal(repo.objects.denials().length, 0);
  assert.deepEqual(readFileSync(join(repo.root, "asset")), working);
  const transferred = new ObjectStore(join(repo.root, "scratch", "objects"));
  assert.ok(exportBundle(repo.objects, repo.refs, []).length > 0);
  assert.equal(transferred.denials().length, 0);
});

test("memoized composition reads each distinct node once and checks time and lease inside traversal", async () => {
  const { repo } = await fixture(); const store = repo.objects;
  const blob = store.write("blob", Buffer.from("abc"));
  const leaf = store.write("manifest", encodeManifest({ totalLength: 384, fragments: Array.from({ length: 128 }, () => ({ id: blob, length: 3 })) }));
  const root = store.write("manifest", encodePagedManifest({ totalLength: 768, fragments: [], height: 1, pages: [{ id: leaf, length: 384, count: 128 }, { id: leaf, length: 384, count: 128 }] }));
  const reads = new Map<string, number>();
  const read = (id: ObjectId) => { reads.set(id, (reads.get(id) ?? 0) + 1); return store.read(id); };
  const results = store.withWriteLock(() => manifestIdentities([root, leaf], read, () => store.assertWriteLease()));
  assert.equal(results.get(root)!.id, hashObject("blob", Buffer.from("abc".repeat(256))));
  assert.deepEqual([...reads.values()], [1, 1, 1]);
  const before = compositionLimits.timeMs; compositionLimits.timeMs = 0;
  try { assert.throws(() => manifestIdentity(root, read), { bound: "time_ms" }); } finally { compositionLimits.timeMs = before; }
  let checks = 0;
  assert.throws(() => store.withWriteLock(() => manifestIdentity(root, read, () => { store.assertWriteLease(); if (++checks === 6) rmSync(join(repo.controlDirectory, "objects.lock")); })), { code: "store_locked" });
});

test("eight native objects describing 512 TiB refuse within the primary budget before deletion", async () => {
  const { repo, entry, secret } = await fixture(); const store = repo.objects;
  let id = store.write("blob", Buffer.from("q")); let length = 1; let count = 1;
  id = store.write("manifest", encodeManifest({ totalLength: 128, fragments: Array.from({ length: 128 }, () => ({ id, length: 1 })) })); length = 128; count = 128;
  for (let height = 1; height <= 6; height++) {
    id = store.write("manifest", encodePagedManifest({ totalLength: length * 128, fragments: [], height, pages: Array.from({ length: 128 }, () => ({ id, length, count })) })); length *= 128; count *= 128;
  }
  assert.equal(length, 512 * 1024 ** 4);
  // Most-expensive root first; refusal must occur without visiting even its first child.
  let reads = 0; const started = performance.now();
  assert.throws(() => manifestIdentity(id, object => { reads++; return store.read(object); }), { bound: "logical_bytes" });
  assert.equal(reads, 1); assert.ok(performance.now() - started < 1000);
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { bound: "logical_bytes" });
  assert.equal(store.denials().length, 0); assert.equal(readFileSync(join(repo.root, "asset"), "utf8"), secret);
});


test("generated native derivation history removes every recoverable dependent and retires catalog edges", async () => {
  for (let seed = 0; seed < 3; seed++) {
    const { repo, entry, secret } = await fixture(); const other = "d".repeat(32);
    const envelope = fieldSide(repo.objects, secret + seed, other, [entry.id]);
    const document = repo.objects.write("record", encodeRecord({ preserved: secret + seed, extra: seed }), other, [envelope]);
    const bytes = Buffer.from(JSON.stringify({ preserved: secret + seed, extra: seed }));
    const fragmented = repo.objects.withDerivation([document], () => writeFragmented(repo.objects, bytes, 5 + seed, other));
    assert.deepEqual(readFragmented(repo.objects, fragmented.manifestId), bytes);
    repo.materialize(buildTree(repo.objects, new Map([["derived", { id: fragmented.manifestId, mode: "100644" as const, fileId: other }]])));
    repo.commit({ message: "derived history", author }, new Date(seed + 1));
    const bundle = join(repo.root, "native.bundle"); writeBundleFile(repo, bundle, () => exportBundle(repo.objects, repo.refs, []));
    if (seed !== 1) repo.objects.compact();
    repo.operations.append("native-summary", bytes.toString("base64"), [], new Date(0));
    const catalog = derivations(repo.controlDirectory, () => {});
    const dependents = derivationClosure(catalog, new Set([entry.id]), () => {});
    for (const id of [envelope, document, fragmented.manifestId]) assert.ok(dependents.has(id));
    const receipt = erase(repo, entry.fileId!, [...dependents]);
    const retained = derivations(repo.controlDirectory, () => {});
    for (const [id, row] of retained) { assert.equal(dependents.has(id), false); assert.equal(row.sources.some(source => dependents.has(source)), false); }
    assert.equal(existsSync(bundle), false); assert.equal(existsSync(join(repo.root, "derived")), false);
    assert.throws(() => readFragmented(repo.objects, fragmented.manifestId), { code: "object_obliterated" });
    assert.equal(repo.operations.read().some(row => row.summary === bytes.toString("base64")), false);
    assert.ok(receipt.tombstone); assert.ok(parseBundle(exportBundle(repo.objects, repo.refs, [])).lines.every(row => !dependents.has(row.id)));
  }
});


test("link pin replacements preserve their previous native descriptor identity", async () => {
  const { repo, secret } = await fixture();
  const descriptor = { version: 1 as const, repository: repo.objects.identity(), revision: repo.resolve("HEAD"), mappings: [{ source: "asset", destination: "vendor/asset" }] };
  const first = repo.stageLink("dependency.link", descriptor);
  repo.commit({ message: "initial pin", author }, new Date(1));
  const second = repo.stageLink("dependency.link", { ...descriptor, revision: repo.resolve("HEAD") });
  assert.ok(derivations(repo.controlDirectory, () => {}).get(second)!.sources.includes(first));
  const entry = repo.readIndex().find(row => row.path === "dependency.link")!;
  erase(repo, entry.fileId!, [first, second]);
  assert.equal(readFileSync(join(repo.root, "asset"), "utf8"), secret);
});

test("native review updates certify previous record and outcome inputs", async () => {
  const { repo, secret } = await fixture();
  const document = repo.objects.write("record", encodeRecord({ series: "1".repeat(64), status: "pending", comments: [secret] }));
  const outcome = repo.objects.write("record", encodeRecord({ action: "fixture" }));
  const tree = buildTree(repo.objects, new Map([["review.json", { id: document, mode: "100644" as const }], ["outcome.json", { id: outcome, mode: "100644" as const }]]));
  const prior = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "native review fixture" });
  repo.refs.compareAndSwap("refs/forge-review/fixture", null, prior);
  const result = serveForge(repo, { action: "publish", kind: "review", name: "fixture", expected: prior, fields: { status: "approved" } }, { principal: "fixture", breakLeases: false });
  const entries = readTree(repo.objects, readCommit(repo.objects, result.revision as string).tree);
  const catalog = derivations(repo.controlDirectory, () => {});
  for (const entry of entries) { assert.ok(catalog.get(entry.id)!.sources.includes(document)); assert.ok(catalog.get(entry.id)!.sources.includes(outcome)); }
  assert.ok(repo.objects.read(entries.find(entry => entry.name === "review.json")!.id).payload.includes(secret));
});

test("competing field resolutions certify side envelopes and their final projection transitively", async () => {
  const { repo, entry, secret } = await fixture(); const other = "9".repeat(32);
  const baseRecord = repo.objects.write("record", encodeRecord({ x: "base", keep: "public" }));
  const unit = repo.objects.write("conflict", encodeConflict({ kind: "field", field: "x", base: fieldSide(repo.objects, "base"), ours: fieldSide(repo.objects, "left"), theirs: fieldSide(repo.objects, "right") }));
  const ours = repo.objects.write("record", encodeRecord({ x: "our resolution", keep: "public" }));
  const theirs = repo.objects.write("record", encodeRecord({ x: secret, keep: "public" }), entry.fileId, [entry.id]);
  const result = competingResolutions(repo.objects, { id: baseRecord, conflicts: [unit] }, { id: ours, fileId: other }, { id: theirs }, { id: ours });
  assert.equal(result.conflicts?.length, 1);
  const descriptor = readConflict(repo.objects, result.conflicts![0]);
  const certificate = derivations(repo.controlDirectory, () => {}).get(descriptor.theirs)!;
  erase(repo, entry.fileId!, [theirs, descriptor.theirs, result.conflicts![0], result.id]);
  assert.ok(certificate.sources.includes(theirs));
});


test("derivation classification preserves foreign schemas, kinds, stages and namespace replacements", async () => {
  const { repo, entry, secret } = await fixture();
  const directory = join(repo.controlDirectory, "derivations"); const path = join(directory, `${entry.id}.json`);
  const original = readFileSync(path); const native = JSON.parse(original.toString()) as unknown;
  const invalid: unknown[] = [null, 7, [], {}, { format: "foreign", sources: [], independent: [], derived: [] },
    { format: "pm-vcs-derivation-1", sources: null, independent: [], derived: [] },
    { format: "pm-vcs-derivation-1", sources: [7], independent: [], derived: [] },
    { format: "pm-vcs-derivation-1", sources: ["wrong"], independent: [], derived: [] },
    { format: "pm-vcs-derivation-1", sources: [], independent: null, derived: [] },
    { format: "pm-vcs-derivation-1", sources: [], independent: [7], derived: [] },
    { format: "pm-vcs-derivation-1", sources: [], independent: [], derived: ["wrong"] },
    ...[null, [7], ["wrong"]].map(members => ({ format: "pm-vcs-derivation-3", sources: [], independent: [], derived: [], unknown: [], whole: null, members })),
    ...[0, "wrong"].map(whole => ({ format: "pm-vcs-derivation-3", sources: [], independent: [], derived: [], unknown: [], members: [], whole })),
    { format: "pm-vcs-derivation-2", sources: [], independent: [], derived: [], unknown: null },
    { format: "pm-vcs-derivation-2", sources: [], independent: [], derived: [], unknown: [7] }];
  for (const value of invalid) {
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "unsupported_erasure_storage" });
    assert.equal(repo.objects.denials().length, 0);
  }
  writeFileSync(path, original);
  const stage = `${path}.123456abcdef.tmp`; writeFileSync(stage, "");
  assert.ok(derivations(repo.controlDirectory, () => {}).has(entry.id));
  writeFileSync(stage, JSON.stringify(native)); assert.ok(derivations(repo.controlDirectory, () => {}).has(entry.id));
  writeFileSync(stage, "foreign bytes"); assert.throws(() => derivations(repo.controlDirectory, () => {}), { code: "unsupported_erasure_storage" }); rmSync(stage);
  const foreign = join(directory, "foreign-backup"); writeFileSync(foreign, "foreign bytes");
  assert.throws(() => derivations(repo.controlDirectory, () => {}), { code: "unsupported_erasure_storage" }); rmSync(foreign);
  renameSync(path, stage); symlinkSync(stage, path);
  assert.throws(() => derivations(repo.controlDirectory, () => {}), { code: "unsupported_erasure_storage" }); rmSync(path); renameSync(stage, path);
  let changed = false;
  try { assert.throws(() => derivations(repo.controlDirectory, () => { if (!changed) { changed = true; writeFileSync(foreign, "foreign bytes"); } }), { code: "unsupported_erasure_storage" }); }
  finally { rmSync(foreign, { force: true }); }
  const extraStage = join(directory, `${"f".repeat(64)}.json.123456abcdef.tmp`); writeFileSync(extraStage, "");
  const first = readdirSync(directory)[0]; const count = readdirSync(directory).length; const replacement = "0".repeat(64) + ".json"; let visited = 0;
  try { assert.throws(() => derivations(repo.controlDirectory, () => { if (++visited === count) renameSync(join(directory, first), join(directory, replacement)); }), { code: "unsupported_erasure_storage" }); }
  finally { renameSync(join(directory, replacement), join(directory, first)); rmSync(extraStage); }
  const contents = readdirSync(directory).map(name => ({ name, bytes: readFileSync(join(directory, name)) })); let swapped = false;
  try { assert.throws(() => derivations(repo.controlDirectory, () => {
    if (swapped) return; swapped = true; renameSync(directory, directory + "-replacement"); mkdirSync(directory);
    for (const file of contents) writeFileSync(join(directory, file.name), file.bytes);
  }), { code: "unsupported_erasure_storage" }); }
  finally { rmSync(directory, { recursive: true }); renameSync(directory + "-replacement", directory); }
  renameSync(directory, directory + "-saved"); symlinkSync(directory + "-saved", directory, "dir");
  try {
    assert.throws(() => derivations(repo.controlDirectory, () => {}), { code: "unsupported_erasure_storage" });
    assert.throws(() => recordDerivation(repo.controlDirectory, "a".repeat(64), [], undefined, false), { code: "unsupported_erasure_storage" });
  } finally { rmSync(directory); renameSync(directory + "-saved", directory); }
  for (const [id, sources, fileId] of [["wrong", [], undefined], [entry.id, ["wrong"], undefined], [entry.id, [7], undefined], [entry.id, [], "wrong"]] as const) {
    assert.throws(() => recordDerivation(repo.controlDirectory, id, sources as unknown as readonly string[], fileId, false), { code: "invalid_provenance" });
  }
  assert.equal(readFileSync(join(repo.root, "asset"), "utf8"), secret);
  const empty = join(repo.root, "empty-control"); mkdirSync(empty);
  assert.equal(derivations(empty, () => {}).size, 0); clearDerivations(empty, new Set(), derivations(empty, () => {}), () => {});
  recordDerivation(empty, entry.id, [], undefined, false);
  assert.equal(derivationClosure(derivations(empty, () => {}), new Set([entry.id]), () => {}).size, 1);
  clearDerivations(empty, new Set([entry.id]), derivations(empty, () => {}), () => {}); assert.equal(derivations(empty, () => {}).size, 0);
});

test("composition faults and primary cache/edge bounds refuse before granting an identity", () => {
  const a = "a".repeat(64); const b = "b".repeat(64); const c = "c".repeat(64);
  const objects = new Map<ObjectId, StoredObject>();
  const read = (id: ObjectId) => objects.get(id)!;
  objects.set(a, { type: "blob", payload: Buffer.from("abc") });
  assert.throws(() => manifestIdentity(a, read), { code: "invalid_manifest" });
  objects.set(a, { type: "record", payload: encodeRecord({ x: 1 }) });
  assert.throws(() => manifestIdentity(a, read), { code: "invalid_manifest" });
  objects.set(b, { type: "blob", payload: Buffer.from("abc") });
  objects.set(a, { type: "manifest", payload: encodeManifest({ totalLength: 1, fragments: [{ id: b, length: 1 }] }) });
  assert.throws(() => manifestIdentity(a, read), { code: "invalid_manifest" });
  objects.set(a, { type: "manifest", payload: encodePagedManifest({ totalLength: 3, height: 1, fragments: [], pages: [{ id: b, length: 3, count: 1 }] }) });
  assert.throws(() => manifestIdentity(a, read), { code: "invalid_manifest" });
  objects.set(c, { type: "blob", payload: Buffer.from("abc") });
  objects.set(b, { type: "manifest", payload: encodeManifest({ totalLength: 3, fragments: [{ id: c, length: 3 }] }) });
  objects.set(a, { type: "manifest", payload: encodeManifest({ totalLength: 3, fragments: [{ id: b, length: 3 }] }) });
  assert.throws(() => manifestIdentity(a, read), { code: "invalid_manifest" });
  objects.set(a, { type: "manifest", payload: encodeManifest({ totalLength: 3, fragments: [{ id: a, length: 3 }] }) });
  assert.throws(() => manifestIdentity(a, read), { code: "invalid_manifest" });
  objects.set(a, { type: "manifest", payload: encodeManifest({ totalLength: 3, fragments: [{ id: c, length: 3 }] }) });
  const before = { ...compositionLimits };
  try {
    compositionLimits.bytes = 3; assert.throws(() => manifestIdentity(a, read), { bound: "logical_bytes" }); compositionLimits.bytes = before.bytes;
    compositionLimits.edges = 1; assert.throws(() => manifestIdentity(a, read), { bound: "edges" }); compositionLimits.edges = before.edges;
    compositionLimits.cacheBytes = 2; assert.throws(() => manifestIdentity(a, read), { bound: "cache_bytes" });
    compositionLimits.cacheBytes = 5; assert.throws(() => manifestIdentity(a, read), { bound: "cache_bytes" });
    compositionLimits.cacheBytes = 10; assert.throws(() => manifestIdentity(c, read), { code: "invalid_manifest" });
    compositionLimits.cacheBytes = 2; assert.throws(() => manifestIdentity(c, read), { bound: "cache_bytes" });
  } finally { Object.assign(compositionLimits, before); }
  objects.set(a, { type: "manifest", payload: encodeManifest({ totalLength: 0, fragments: [] }) });
  assert.equal(manifestIdentity(a, read).id, hashObject("blob", Buffer.alloc(0)));
});


test("catalog retirement refuses replaced parents and foreign selected entries", async () => {
  const { repo, entry } = await fixture(); const directory = join(repo.controlDirectory, "derivations");
  const snapshot = derivations(repo.controlDirectory, () => {}); const selected = new Set([entry.id]); const name = `${entry.id}.json`;
  const original = readFileSync(join(directory, name));
  renameSync(directory, directory + "-saved"); mkdirSync(directory); writeFileSync(join(directory, name), original);
  try { assert.throws(() => clearDerivations(repo.controlDirectory, selected, snapshot, () => {}), { code: "unsupported_erasure_storage" }); assert.deepEqual(readFileSync(join(directory, name)), original); }
  finally { rmSync(directory, { recursive: true }); renameSync(directory + "-saved", directory); }
  const restored = derivations(repo.controlDirectory, () => {});
  assert.throws(() => clearDerivations(repo.controlDirectory, selected, new Map(), () => {}), { code: "unsupported_erasure_storage" });
  renameSync(directory, directory + "-saved");
  try {
    assert.throws(() => clearDerivations(repo.controlDirectory, selected, restored, () => {}), { code: "unsupported_erasure_storage" });
    symlinkSync(directory + "-saved", directory, "dir");
    assert.throws(() => clearDerivations(repo.controlDirectory, selected, restored, () => {}), { code: "unsupported_erasure_storage" });
    rmSync(directory);
  } finally { renameSync(directory + "-saved", directory); }
  const absentRoot = join(repo.root, "absent-control"); mkdirSync(absentRoot);
  const absent = derivations(absentRoot, () => {}); mkdirSync(join(absentRoot, "derivations"));
  assert.throws(() => clearDerivations(absentRoot, selected, absent, () => {}), { code: "unsupported_erasure_storage" });
  writeFileSync(join(directory, name), "foreign backup");
  assert.throws(() => clearDerivations(repo.controlDirectory, selected, restored, () => {}), { code: "unsupported_erasure_storage" });
  assert.equal(readFileSync(join(directory, name), "utf8"), "foreign backup"); writeFileSync(join(directory, name), original);
  const extra = join(directory, `${entry.id}.foreign`); writeFileSync(extra, "foreign");
  assert.throws(() => clearDerivations(repo.controlDirectory, selected, restored, () => {}), { code: "unsupported_erasure_storage" }); rmSync(extra);
  // A retry after any completed removal uses a fresh catalog; missing canonical entries are legitimate.
  const invalidKind = join(directory, `${entry.id}.json.abcdef123456.tmp`); mkdirSync(invalidKind);
  assert.throws(() => clearDerivations(repo.controlDirectory, selected, restored, () => {}), { code: "unsupported_erasure_storage" }); rmSync(invalidKind, { recursive: true });
  const filledStage = join(directory, `${entry.id}.json.abc123def456.tmp`); writeFileSync(filledStage, original);
  const stages = join(directory, `${entry.id}.json.123456abcdef.tmp`); writeFileSync(stages, "");
  clearDerivations(repo.controlDirectory, selected, derivations(repo.controlDirectory, () => {}), () => {});
  assert.equal(existsSync(stages), false);
});

test("derived tombstone roles are canonical, exact, and cannot authorize wrong-file or structural aliases", async () => {
  const { repo, entry } = await fixture(); const other = "a".repeat(32); const third = "b".repeat(32); const output = "1".repeat(64);
  const base: ErasureTombstone = { version: 1, fileId: entry.fileId!, roots: [entry.id], objects: [entry.id, output], payloads: [], principal: "fixture", timestamp: new Date(0).toISOString(), reason: "provenance" };
  const roles = [{ fileId: third, id: output }, { id: output, fileId: other }, { id: output, fileId: other }, { id: entry.id, fileId: other }];
  const payload = encodeTombstone({ ...base, derived: roles }); const tombstone = JSON.parse(payload.toString()) as ErasureTombstone;
  assert.equal(tombstone.derived!.length, 3); assert.deepEqual(encodeTombstone(tombstone), payload);
  const denial = { id: hashObject("tombstone", payload), tombstone, pending: false };
  assert.equal(allowsDeniedRoot(denial, output, other), true); assert.equal(allowsDeniedRoot(denial, output, "c".repeat(32)), false);
  assert.equal(allowsDeniedRoot(denial, "2".repeat(64), other), false);
  for (const [fileId, mode, allowed] of [[other, "100644", true], ["c".repeat(32), "100644", false], [other, "40000", false]] as const) {
    const tree = encodeTree([{ name: "derived", mode, id: output, ...(mode === "40000" ? {} : { fileId }) }]); const arrival = { id: hashObject("tree", tree), type: "tree" as const, payload: tree };
    if (allowed) assert.doesNotThrow(() => assertArrivalsAllowed([denial], [arrival], true));
    else assert.throws(() => assertArrivalsAllowed([denial], [arrival], true), { code: "invalid_erasure_role" });
  }
  const invalid: unknown[] = [null, {}, [null], [7], [{ id: output, fileId: other, extra: true }], [{ id: 7, fileId: other }], [{ id: "2".repeat(64), fileId: other }], [{ id: output, fileId: 7 }], [{ id: output, fileId: "wrong" }]];
  for (const derived of invalid) assert.throws(() => encodeTombstone({ ...base, derived } as ErasureTombstone), { code: "bad_tombstone" });
});

test("nested native derivation scopes restore inputs and cannot resurrect an erased source", async () => {
  const { repo, entry } = await fixture(); const other = "a".repeat(32);
  const parent = repo.objects.write("blob", Buffer.from("parent"));
  const nested = repo.objects.withDerivation([entry.id], () => repo.objects.withDerivation([parent], () => repo.objects.write("blob", Buffer.from("nested native result"), other)));
  const row = derivations(repo.controlDirectory, () => {}).get(nested)!;
  assert.ok(row.sources.includes(entry.id)); assert.ok(row.sources.includes(parent));
  assert.throws(() => repo.objects.withDerivation([entry.id], () => { throw new Error("native failure"); }), /native failure/);
  const independent = repo.objects.write("blob", Buffer.from("independent after failed derivation"), other);
  assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(independent)!.sources, []);
  erase(repo, entry.fileId!, [entry.id, nested]);
  assert.throws(() => repo.objects.write("blob", Buffer.from("new body from forbidden source"), other, [entry.id]), { code: "object_obliterated" });
  assert.equal(repo.objects.read(independent).payload.toString(), "independent after failed derivation");
  assert.throws(() => repo.objects.assertWriteLease(), { code: "store_locked" });
});


test("erasing a native conflict alternative preserves an independently owned projection", async () => {
  const { repo, entry, secret } = await fixture(); const other = "a".repeat(32);
  const alternative = fieldSide(repo.objects, secret, other, [entry.id]);
  const unit = repo.objects.write("conflict", encodeConflict({ kind: "field", field: "private", base: fieldSide(repo.objects, "base"), ours: fieldSide(repo.objects, "public"), theirs: alternative }), other);
  const projection = repo.objects.write("record", encodeRecord({ private: "public", public: "independent" }), other);
  repo.materialize(buildTree(repo.objects, new Map([["unrelated.json", { id: projection, mode: "100644" as const, fileId: other, conflicts: [unit] }]])));
  repo.commit({ message: "independent projection with native alternatives", author }, new Date(1));
  const before = readFileSync(join(repo.root, "unrelated.json"));
  erase(repo, entry.fileId!, [entry.id, alternative, unit]);
  assert.deepEqual(readFileSync(join(repo.root, "unrelated.json")), before);
  assert.equal(repo.objects.read(projection).payload.includes("independent"), true);
});


for (const registered of [false, true]) test(`derived worktree ownership preserves ${registered ? "edited" : "unregistered"} foreign bytes before deletion`, async () => {
  const { repo, entry, secret } = await fixture(); const other = "a".repeat(32);
  const derived = repo.objects.write("record", encodeRecord({ secret, extra: "native output" }), other, [entry.id]);
  const tree = buildTree(repo.objects, new Map([["derived.json", { id: derived, mode: "100644" as const, fileId: other }]]));
  if (registered) repo.materialize(tree);
  else repo.writeIndex([{ path: "derived.json", id: derived, mode: "100644", fileId: other }]);
  writeFileSync(join(repo.root, "derived.json"), "independent replacement bytes");
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "worktree_path_changed" });
  assert.equal(repo.objects.denials().length, 0); assert.equal(readFileSync(join(repo.root, "derived.json"), "utf8"), "independent replacement bytes");
  assert.equal(repo.objects.read(derived).payload.includes(secret), true); assert.equal(repo.objects.read(entry.id).payload.toString(), secret);
});


for (const kind of ["bundle", "record-rendering", "large-output"] as const) test(`staging a native ${kind} retains its producer provenance`, async () => {
  const { repo, entry, secret } = await fixture(); const path = kind === "bundle" ? "native.bundle" : "rendered.txt";
  let source = entry.id;
  if (kind === "bundle") writeBundleFile(repo, join(repo.root, path), () => exportBundle(repo.objects, repo.refs, []));
  else {
    if (kind === "record-rendering") source = repo.objects.write("record", encodeRecord({ secret }), entry.fileId, [entry.id]);
    const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
    try { mutation.write(path, kind === "record-rendering" ? renderWorkingRecord("native.json", { secret }) : Buffer.from((secret + "\n").repeat(65536)), 0o644, { objects: [source] }); } finally { mutation.close(); }
  }
  repo.stage([path]); const staged = repo.readIndex().find(row => row.path === path)!;
  const certificate = derivations(repo.controlDirectory, () => {}).get(staged.id)!;
  erase(repo, entry.fileId!, [entry.id, source, staged.id]); assert.equal(existsSync(join(repo.root, path)), false);
  assert.ok(certificate.derived.includes(staged.fileId!)); assert.equal(certificate.independent.includes(staged.fileId!), false);
});


test("large native output certificates retain collected input ancestry through unchanged staging", async () => {
  const { repo, entry } = await fixture(); const bytes = Buffer.alloc(1024 * 1024 + 1, 51);
  const middle = repo.objects.write("blob", bytes, undefined, [entry.id]);
  const legacy = repo.objects.write("blob", Buffer.concat([bytes, Buffer.from("tail")]), entry.fileId, [middle]);
  writeFileSync(join(repo.root, "asset"), repo.objects.read(legacy).payload);
  repo.writeIndex([{ path: "asset", id: legacy, mode: "100644", fileId: entry.fileId }]);
  assert.ok(derivations(repo.controlDirectory, () => {}).get(legacy)!.sources.includes(entry.id));
  assert.ok(collectGarbage(repo, true).candidates.includes(middle)); assert.equal(repo.objects.has(middle), false);
  repo.stage(["asset"]); assert.equal(repo.readIndex()[0].id, legacy); assert.equal(repo.objects.read(legacy).type, "blob");
  const certificate = derivations(repo.controlDirectory, () => {}).get(legacy)!;
  assert.ok(certificate.sources.includes(entry.id)); assert.ok(certificate.sources.includes(middle));
});


test("recovery validation fences missing/replaced parents and changed leases inside native traversal", async () => {
  const { repo } = await fixture(); const store = repo.objects;
  for (const kind of ["missing-parent", "replaced-parent", "changed-lock"] as const) {
    let tested = false; let refused = false; let acted = false; const interrupted = new Error("stop read-only recovery proof");
    assert.throws(() => store.withRecoveryValidation(() => {
      store.assertWriteLease();
      if (!tested) {
        tested = true;
        if (kind === "changed-lock") {
          const path = join(repo.controlDirectory, "objects.lock"); writeFileSync(path, "2147483647");
          try { assert.throws(() => store.assertWriteLease(), { code: "store_locked" }); refused = true; } finally { rmSync(path); }
        } else {
          renameSync(repo.controlDirectory, repo.controlDirectory + "-saved");
          if (kind === "replaced-parent") mkdirSync(repo.controlDirectory);
          try { assert.throws(() => store.assertWriteLease(), { code: "store_locked" }); refused = true; }
          finally { if (kind === "replaced-parent") rmSync(repo.controlDirectory, { recursive: true }); renameSync(repo.controlDirectory + "-saved", repo.controlDirectory); }
        }
      }
      throw interrupted;
    }, () => { acted = true; }), error => error === interrupted);
    assert.equal(tested, true); assert.equal(refused, true); assert.equal(acted, false);
  }
});


for (const kind of ["partial", "replaced"] as const) test(`staging preserves independent ownership for a ${kind} native output`, async () => {
  const { repo, entry } = await fixture(); const path = "native-output";
  const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { mutation.write(path, Buffer.from("native generated bytes"), 0o644, { objects: [entry.id] }); } finally { mutation.close(); }
  if (kind === "partial") writePrivateJson(join(repo.controlDirectory, "outputs.json"), nativeOutputs(repo.controlDirectory).map(row => ({ ...row, complete: false })));
  else { writeFileSync(join(repo.root, "replacement"), "independent replacement bytes"); renameSync(join(repo.root, "replacement"), join(repo.root, path)); }
  repo.stage([path]); const staged = repo.readIndex().find(row => row.path === path)!;
  assert.ok(derivations(repo.controlDirectory, () => {}).get(staged.id)!.independent.includes(staged.fileId!));
  const bytes = readFileSync(join(repo.root, path));
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: kind === "partial" ? "erasure_dedup_conflict" : "worktree_path_changed" });
  assert.equal(repo.objects.denials().length, 0); assert.deepEqual(readFileSync(join(repo.root, path)), bytes);
});


for (const old of [false, true]) test(`GC cannot hide unknown legacy merge ancestry (${old ? "direct-parent upgrade" : "self-contained"})`, async () => {
  const { repo, entry, secret } = await fixture(); const other = "0".repeat(32);
  const base = repo.objects.write("record", encodeRecord({ common: "base" }), other);
  const ours = repo.objects.write("record", encodeRecord({ common: "base", public: "ours" }), other);
  const payload = encodeRecord({ common: "base", secret }); const legacy = hashObject("record", payload);
  const directory = join(repo.objects.storageRoot(), legacy.slice(0, 2)); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, legacy.slice(2)), deflateSync(frameObject("record", payload), { level: zlibConstants.Z_BEST_SPEED }));
  const result = mergePath({ store: repo.objects, config: repo.config, committer: author }, "joined.json", base, ours, legacy, undefined, other);
  repo.materialize(buildTree(repo.objects, new Map([["joined.json", { id: result.id, fileId: other, mode: "100644" as const }]])));
  if (old) writePrivateJson(join(repo.controlDirectory, "derivations", `${result.id}.json`), { format: "pm-vcs-derivation-1", sources: [legacy], independent: [], derived: [other] });
  const gc = collectGarbage(repo, true); assert.ok(gc.candidates.includes(legacy)); assert.equal(repo.objects.has(legacy), false);
  const before = repo.objects.inventory().map(row => row.id).sort(); const working = readFileSync(join(repo.root, "joined.json"));
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), error => error instanceof UncataloguedProvenance && error.objects.includes(result.id));
  assert.deepEqual(repo.objects.inventory().map(row => row.id).sort(), before); assert.equal(repo.objects.denials().length, 0);
  assert.deepEqual(readFileSync(join(repo.root, "joined.json")), working); assert.ok(working.includes(secret));
});

for (const old of [false, true]) test(`collected manifest retains fragment and page ancestry in native output (${old ? "upgrade" : "new"})`, async () => {
  const { repo, entry, secret } = await fixture(); const suffix = repo.objects.write("blob", Buffer.from(" public suffix"));
  const length = (Buffer.byteLength(secret) + 14) * 64;
  const leaf = repo.objects.write("manifest", encodeManifest({ totalLength: length, fragments: Array.from({ length: 64 }, () => [{ id: entry.id, length: Buffer.byteLength(secret) }, { id: suffix, length: 14 }]).flat() }));
  const root = repo.objects.write("manifest", encodePagedManifest({ totalLength: length * 2, fragments: [], height: 1, pages: Array.from({ length: 2 }, () => ({ id: leaf, length, count: 128 })) }));
  if (old) for (const id of [leaf, root]) writePrivateJson(join(repo.controlDirectory, "derivations", `${id}.json`), { format: "pm-vcs-derivation-1", sources: [], independent: [], derived: [] });
  const content = readFragmented(repo.objects, root); const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { mutation.write("rendered", content, 0o644, { objects: [root] }); } finally { mutation.close(); }
  const output = nativeOutputs(repo.controlDirectory).find(row => row.path === "rendered")!;
  // Simulate the previous native-output writer too; GC must recover every edge while containers remain.
  if (old) writePrivateJson(join(repo.controlDirectory, "derivations", `${output.id}.json`), { format: "pm-vcs-derivation-1", sources: [root], independent: [], derived: [] });
  // Virtual output IDs need no physical object: their explicit old input list is retained evidence.
  const gc = collectGarbage(repo, true); assert.ok(gc.candidates.includes(root)); assert.ok(gc.candidates.includes(leaf));
  assert.equal(repo.objects.has(root), false); assert.equal(repo.objects.has(leaf), false);
  const row = derivations(repo.controlDirectory, () => {}).get(output.id)!;
  erase(repo, entry.fileId!, [entry.id, root, leaf, output.id]); assert.equal(existsSync(join(repo.root, "rendered")), false); assert.ok(row.sources.includes(entry.id));
});

test("GC-anywhere histories preserve complete certificates or refuse before deletion", async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const { repo, entry, secret } = await fixture(); let input = entry.id; const produced: ObjectId[] = []; let state = seed;
    const unknown = seed % 3 === 0;
    if (unknown) { const payload = Buffer.from(secret + " legacy"); input = hashObject("blob", payload); repo.objects.accept([{ id: input, type: "blob", payload }], true); }
    for (let step = 0; step < 4; step++) {
      state = (state * 1664525 + 1013904223) >>> 0; const payload = Buffer.from(`${secret} derived ${seed}/${step}`);
      input = step % 2 === 0 ? repo.objects.write("blob", payload, undefined, [input]) : repo.objects.withDerivation([input], () => writeFragmented(repo.objects, payload, 7).manifestId); produced.push(input);
      const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
      try { mutation.write(`derived-${step}`, payload, 0o644, { objects: [input] }); } finally { mutation.close(); }
      if (state & 1) { if (state & 2) repo.objects.compact(); collectGarbage(repo, true); }
    }
    const bundle = join(repo.root, "generated.bundle"); writeBundleFile(repo, bundle, () => exportBundle(repo.objects, repo.refs, []));
    repo.operations.append("native-gc-summary", secret + " summary", [], new Date(0)); collectGarbage(repo, true);
    if (unknown) {
      const before = repo.objects.inventory().map(row => row.id).sort();
      assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), { code: "uncatalogued_provenance" });
      assert.deepEqual(repo.objects.inventory().map(row => row.id).sort(), before); assert.equal(repo.objects.denials().length, 0);
      for (let step = 0; step < 4; step++) assert.ok(readFileSync(join(repo.root, `derived-${step}`)).includes(secret));
    } else {
      const receipt = repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1));
      assert.ok(receipt.tombstone); for (const id of produced) { assert.throws(() => repo.objects.read(id), { code: "object_obliterated" }); assert.throws(() => readFragmented(repo.objects, id), { code: "object_obliterated" }); }
      for (let step = 0; step < 4; step++) assert.equal(existsSync(join(repo.root, `derived-${step}`)), false);
      assert.equal(existsSync(bundle), false); assert.equal(repo.operations.read().some(row => row.summary.includes(secret)), false);
    }
  }
});

for (const missing of ["old-object", "old-object-erasure", "certificate"] as const) test(`absent ${missing} ancestry remains unknown before erasure`, async () => {
  const { repo, entry, secret } = await fixture();
  const input = repo.objects.write("blob", Buffer.from(secret + " intermediate"), undefined, [entry.id]);
  const output = repo.objects.write("blob", Buffer.from(secret + " derived"), undefined, [input]);
  const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
  try { mutation.write("retained", repo.objects.read(output).payload, 0o644, { objects: [output] }); } finally { mutation.close(); }
  if (missing.startsWith("old-object")) {
    writePrivateJson(join(repo.controlDirectory, "derivations", `${input}.json`), { format: "pm-vcs-derivation-1", sources: [entry.id], independent: [], derived: [] });
    rmSync(join(repo.objects.storageRoot(), input.slice(0, 2), input.slice(2)));
    if (missing === "old-object") collectGarbage(repo, true);
  } else { collectGarbage(repo, true); rmSync(join(repo.controlDirectory, "derivations", `${input}.json`)); }
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), error => error instanceof UncataloguedProvenance && error.objects.includes(output));
  assert.equal(repo.objects.denials().length, 0); assert.ok(readFileSync(join(repo.root, "retained")).includes(secret));
});

test("direct-parent certificate upgrade retains complete known roots before GC", async () => {
  const { repo, entry, secret } = await fixture();
  const first = repo.objects.write("blob", Buffer.from(secret + " first"), undefined, [entry.id]);
  const last = repo.objects.write("blob", Buffer.from(secret + " last"), undefined, [first]);
  for (const [id, sources] of [[first, [entry.id]], [last, [first]]] as const) writePrivateJson(join(repo.controlDirectory, "derivations", `${id}.json`), { format: "pm-vcs-derivation-1", sources, independent: [], derived: [] });
  const before = readFileSync(join(repo.controlDirectory, "derivations", `${last}.json`));
  const preview = collectGarbage(repo); assert.deepEqual(readFileSync(join(repo.controlDirectory, "derivations", `${last}.json`)), before);
  const applied = collectGarbage(repo, true); assert.deepEqual(applied.candidates, preview.candidates);
  const certificate = derivations(repo.controlDirectory, () => {}).get(last)!;
  assert.equal(certificate.format, "pm-vcs-derivation-3"); assert.deepEqual(certificate.unknown, []);
  assert.ok(certificate.sources.includes(entry.id)); assert.ok(certificate.sources.includes(first));
  assert.equal(repo.objects.has(first), false); assert.equal(repo.objects.has(last), false);
  erase(repo, entry.fileId!, [entry.id, first, last]);
});

test("certificate upgrade bounds, cycles, malformed records and lease loss never grant provenance", async () => {
  const { repo, entry } = await fixture(); const a = repo.objects.write("blob", Buffer.from("cycle a")); const b = repo.objects.write("blob", Buffer.from("cycle b"));
  const old = (id: ObjectId, sources: readonly ObjectId[]) => writePrivateJson(join(repo.controlDirectory, "derivations", `${id}.json`), { format: "pm-vcs-derivation-1", sources, independent: [], derived: [] });
  old(a, [b]); old(b, [a]);
  const read = (id: ObjectId) => repo.objects.has(id) ? repo.objects.read(id) : undefined;
  for (const bound of ["timeMs", "objects", "depth", "edges"] as const) {
    const before = provenanceLimits[bound]; provenanceLimits[bound] = bound === "edges" ? 1 : 0;
    try { assert.throws(() => repo.objects.withWriteLock(() => upgradeDerivations(repo.controlDirectory, derivations(repo.controlDirectory, () => {}), read, () => repo.objects.assertWriteLease())), { code: "unverified" }); }
    finally { provenanceLimits[bound] = before; }
  }
  repo.objects.withWriteLock(() => upgradeDerivations(repo.controlDirectory, derivations(repo.controlDirectory, () => {}), read, () => repo.objects.assertWriteLease()));
  assert.ok(derivations(repo.controlDirectory, () => {}).get(a)!.unknown!.length > 0);
  old(a, [entry.id]); let reads = 0;
  assert.throws(() => repo.objects.withWriteLock(() => upgradeDerivations(repo.controlDirectory, derivations(repo.controlDirectory, () => {}), id => { const result = read(id); if (++reads === 1) rmSync(join(repo.controlDirectory, "objects.lock")); return result; }, () => repo.objects.assertWriteLease())), { code: "store_locked" });
  for (const unknown of [undefined, null, ["foreign"]]) {
    writePrivateJson(join(repo.controlDirectory, "derivations", `${a}.json`), { format: "pm-vcs-derivation-2", sources: [], independent: [], derived: [], ...(unknown === undefined ? {} : { unknown }) });
    assert.throws(() => derivations(repo.controlDirectory, () => {}), { code: "unsupported_erasure_storage" });
  }
});

test("certificate migration preserves replaced catalog parents and certifies only native structural inputs", async () => {
  const { repo, entry } = await fixture(); const store = repo.objects;
  const tree = encodeTree([]); const id = hashObject("tree", tree);
  // An imported structural frame has no local certificate, but holds no payload snapshot.
  store.accept([{ id, type: "tree", payload: tree }], true);
  rmSync(join(repo.controlDirectory, "derivations", `${id}.json`), { force: true });
  const legacyOutput = store.write("blob", Buffer.from("old structural fixture"));
  writePrivateJson(join(repo.controlDirectory, "derivations", `${legacyOutput}.json`), { format: "pm-vcs-derivation-1", sources: [id], independent: [], derived: [] });
  store.withWriteLock(() => upgradeDerivations(repo.controlDirectory, derivations(repo.controlDirectory, () => {}), source => store.has(source) ? store.read(source) : undefined, () => store.assertWriteLease()));
  assert.equal(derivations(repo.controlDirectory, () => {}).get(id)!.format, "pm-vcs-derivation-3");
  rmSync(join(repo.controlDirectory, "derivations", `${id}.json`));
  const output = store.write("blob", Buffer.from("structural fixture"), undefined, [id]);
  assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(output)!.unknown, []);
  assert.equal(derivations(repo.controlDirectory, () => {}).get(id)!.format, "pm-vcs-derivation-3");
  for (const type of ["manifest", "conflict"] as const) {
    const opaque = store.write(type, Buffer.from("legacy opaque fixture"));
    assert.equal(store.read(opaque).type, type); assert.ok(derivations(repo.controlDirectory, () => {}).get(opaque)!.unknown!.includes(opaque));
  }
  writePrivateJson(join(repo.controlDirectory, "derivations", `${output}.json`), { format: "pm-vcs-derivation-1", sources: [entry.id], independent: [], derived: [] });
  const catalog = derivations(repo.controlDirectory, () => {}); const directory = join(repo.controlDirectory, "derivations"); const retained = directory + "-original";
  renameSync(directory, retained); mkdirSync(directory); writeFileSync(join(directory, "foreign"), "keep foreign bytes");
  try {
    assert.throws(() => store.withWriteLock(() => upgradeDerivations(repo.controlDirectory, catalog, input => store.has(input) ? store.read(input) : undefined, () => store.assertWriteLease())), { code: "unsupported_erasure_storage" });
    assert.equal(readFileSync(join(directory, "foreign"), "utf8"), "keep foreign bytes"); assert.equal(existsSync(join(directory, `${output}.json`)), false);
  } finally { rmSync(directory, { recursive: true }); renameSync(retained, directory); }
});


test("certificate unknown sets remain explicit through self edges, defaults and read-only migration", async () => {
  const { repo, entry } = await fixture(); const id = "a".repeat(64); const absent = "b".repeat(64);
  recordDerivation(repo.controlDirectory, id, [absent], undefined, false);
  assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(id)!.unknown, [absent]);
  const original = { format: "pm-vcs-derivation-1" as const, sources: [entry.id], independent: [], derived: [] };
  writePrivateJson(join(repo.controlDirectory, "derivations", `${entry.id}.json`), original);
  const before = readFileSync(join(repo.controlDirectory, "derivations", `${entry.id}.json`));
  const upgraded = upgradeDerivations(repo.controlDirectory, derivations(repo.controlDirectory, () => {}), input => repo.objects.has(input) ? repo.objects.read(input) : undefined, () => {}, false);
  assert.deepEqual(upgraded.get(entry.id)!.unknown, [entry.id]); assert.deepEqual(readFileSync(join(repo.controlDirectory, "derivations", `${entry.id}.json`)), before);
  assert.deepEqual(unknownDerivations(new Map([[entry.id, original]]), [entry.id], () => {}), [entry.id]);
  const complete = { format: "pm-vcs-derivation-3" as const, members: [], whole: null, sources: [entry.id], unknown: [], independent: [], derived: [] };
  assert.deepEqual(unknownDerivations(new Map<ObjectId, DerivationRecord>([[id, complete], [entry.id, original]]), [id], () => {}), [id]);
});


test("native writers retain unknown absent inputs and legacy structural identities", async () => {
  const { repo, entry, secret } = await fixture(); const store = repo.objects; const absent = "b".repeat(64);
  writePrivateJson(join(repo.controlDirectory, "derivations", `${entry.id}.json`), { format: "pm-vcs-derivation-1", sources: [], independent: [entry.fileId], derived: [] });
  store.write("blob", Buffer.from(secret), entry.fileId); assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(entry.id)!.unknown, []);
  const derived = store.write("blob", Buffer.from(secret + " unknown input"), undefined, [absent]);
  assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(derived)!.unknown, [absent]);
  const mutation = new WorktreeMutation(repo.root, ".pmvcs", store);
  try { mutation.write("unknown-output", Buffer.from(secret + " output"), 0o644, { objects: [absent] }); } finally { mutation.close(); }
  const tree = encodeTree([]); const id = store.write("tree", tree);
  writePrivateJson(join(repo.controlDirectory, "derivations", `${id}.json`), { format: "pm-vcs-derivation-1", sources: [], independent: [], derived: [] });
  store.write("tree", tree); assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(id)!.unknown, []);
  writePrivateJson(join(repo.controlDirectory, "derivations", `${id}.json`), { format: "pm-vcs-derivation-1", sources: [], independent: [], derived: [] });
  rmSync(join(store.storageRoot(), id.slice(0, 2), id.slice(2))); store.write("tree", tree);
  assert.equal(store.read(id).type, "tree"); assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(id)!.unknown, [id]);
  assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), error => error instanceof UncataloguedProvenance && error.objects.includes(derived));
  assert.equal(store.denials().length, 0); assert.ok(readFileSync(join(repo.root, "unknown-output")).includes(secret));
});


test("first erasure upgrades direct-parent evidence before its pending boundary and resumes", async () => {
  const { repo, entry, secret } = await fixture();
  const first = repo.objects.write("blob", Buffer.from(secret + " first erasure"), undefined, [entry.id]);
  const last = repo.objects.write("blob", Buffer.from(secret + " last erasure"), undefined, [first]);
  writePrivateJson(join(repo.controlDirectory, "derivations", `${last}.json`), { format: "pm-vcs-derivation-1", sources: [first], independent: [], derived: [] });
  const before = erasureScanBoundary.visit; erasureScanBoundary.visit = step => { if (step === "pending") throw new Error("upgraded pending boundary"); };
  try { assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "provenance", new Date(1)), /upgraded pending boundary/); }
  finally { erasureScanBoundary.visit = before; }
  const certificate = derivations(repo.controlDirectory, () => {}).get(last)!;
  assert.equal(certificate.format, "pm-vcs-derivation-3"); assert.ok(certificate.sources.includes(entry.id)); assert.deepEqual(certificate.unknown, []);
  erase(repo, entry.fileId!, [entry.id, first, last]);
});


for (const packed of [false, true]) test(`whole-content equivalence survives collected manifest inputs (${packed ? "packed" : "loose"})`, async () => {
  const { repo, entry, secret } = await fixture(); const other = "0".repeat(32);
  const bytes = Buffer.from(secret); const fragments = [];
  for (let start = 0; start < bytes.length; start += 7) { const chunk = bytes.subarray(start, start + 7); fragments.push({ id: repo.objects.write("blob", chunk), length: chunk.length }); }
  const source = { manifestId: repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments })) };
  const derived = repo.objects.write("record", encodeRecord({ secret, derived: true }), other, [source.manifestId]);
  repo.materialize(buildTree(repo.objects, new Map([["derived.json", { id: derived, fileId: other, mode: "100644" as const }]])));
  repo.commit({ message: "derived from equivalent content", author }, new Date(1));
  if (packed) repo.objects.compact();
  const gc = collectGarbage(repo, true); assert.ok(gc.candidates.includes(source.manifestId)); assert.equal(repo.objects.has(source.manifestId), false);
  const wholeCertified = derivations(repo.controlDirectory, () => {}).get(derived)!.sources.includes(entry.id);
  erase(repo, entry.fileId!, [entry.id, source.manifestId, derived]); assert.equal(existsSync(join(repo.root, "derived.json")), false); assert.equal(wholeCertified, true);
});

test("equivalence-through-GC closes fixed, CDC, descriptor, re-split and packed representations", async () => {
  for (let seed = 0; seed < 4; seed++) {
    const { repo, entry, secret } = await fixture(); const bytes = Buffer.from(secret);
    const sourcePath = join(repo.root, "source-input"); writeFileSync(sourcePath, bytes);
    const first = seed === 1 ? writeCdcFragmented(repo.objects, bytes, { minChunkSize: 3, maxChunkSize: 7, mask: 3 }) : seed === 2 ? writeFragmentedFile(repo.objects, sourcePath, 5) : writeFragmented(repo.objects, bytes, 3 + seed);
    const second = writeFragmented(repo.objects, readFragmented(repo.objects, first.manifestId), 5 + seed);
    const derived = repo.objects.write("blob", Buffer.from(secret + " descendant"), undefined, [second.manifestId]);
    const mutation = new WorktreeMutation(repo.root, ".pmvcs", repo.objects);
    try { mutation.write("descendant", repo.objects.read(derived).payload, 0o644, { objects: [derived] }); } finally { mutation.close(); }
    if (seed & 1) repo.objects.compact(); collectGarbage(repo, true);
    assert.equal(repo.objects.has(first.manifestId), false); assert.equal(repo.objects.has(second.manifestId), false);
    erase(repo, entry.fileId!, [entry.id, first.manifestId, second.manifestId, derived]); assert.equal(existsSync(join(repo.root, "descendant")), false);
  }
});


test("bundle import retains whole-content equivalence without inventing clone-private origins", async () => {
  const source = await fixture(); const target = await fixture(); const other = "c".repeat(32);
  const representation = writeFragmented(source.repo.objects, Buffer.from(source.secret), 5);
  source.repo.materialize(buildTree(source.repo.objects, new Map([["represented", { id: representation.manifestId, fileId: other, mode: "100644" as const }]])));
  const commit = source.repo.commit({ message: "bundle equivalent", author }, new Date(1));
  source.repo.refs.compareAndSwap("refs/heads/equivalent", null, commit);
  importBundle(target.repo.objects, target.repo.refs, exportBundle(source.repo.objects, source.repo.refs, ["refs/heads/equivalent"]));
  const record = derivations(target.repo.controlDirectory, () => {}).get(representation.manifestId)!;
  assert.equal(record.whole, target.entry.id); assert.ok(record.sources.includes(target.entry.id)); assert.ok(record.unknown!.includes(representation.manifestId));
  target.repo.refs.compareAndSwap("refs/heads/equivalent", commit, null);
  const derived = target.repo.objects.write("record", encodeRecord({ secret: source.secret, imported: true }), other, [representation.manifestId]);
  target.repo.materialize(buildTree(target.repo.objects, new Map([["derived.json", { id: derived, fileId: other, mode: "100644" as const }]])));
  collectGarbage(target.repo, true); assert.equal(target.repo.objects.has(representation.manifestId), false);
  assert.throws(() => target.repo.obliterate(target.entry.fileId!, "erase-fixture", "provenance", new Date(1)), error => error instanceof UncataloguedProvenance && error.objects.includes(derived));
  assert.equal(target.repo.objects.denials().length, 0); assert.ok(readFileSync(join(target.repo.root, "derived.json")).includes(source.secret));
});


test("native whole-content completion validates lease, identity and manifest shape before changing evidence", async () => {
 const { repo, entry } = await fixture(); const store = repo.objects; const before = derivations(repo.controlDirectory, () => {});
 assert.throws(() => store.recordWholeContent(entry.id, entry.id), { code: "store_locked" });
 const malformed = store.write("manifest", Buffer.from("malformed native composition"));
 store.withWriteLock(() => {
  assert.throws(() => store.recordWholeContent(entry.id, "wrong"), { code: "invalid_provenance" });
  assert.throws(() => store.recordWholeContent(entry.id, entry.id), { code: "invalid_manifest" });
  assert.throws(() => store.recordWholeContent(malformed, entry.id), { code: "invalid_manifest" });
 });
 assert.deepEqual(derivations(repo.controlDirectory, () => {}).get(entry.id), before.get(entry.id));
 const native = writeFragmented(store, Buffer.alloc(0), 4); assert.equal(derivations(repo.controlDirectory, () => {}).get(native.manifestId)!.whole, hashObject("blob", Buffer.alloc(0)));
});

for (const legacyWhole of [false, true]) test(`legacy equivalence upgrade preserves ${legacyWhole ? "unknown physical" : "known virtual"} whole-content origins through GC`, async () => {
 const { repo, entry, secret } = await fixture(); const bytes = Buffer.from(secret + " upgraded native whole"); const fragments = [];
 for (let offset = 0; offset < bytes.length; offset += 8) { const chunk = bytes.subarray(offset, offset + 8); fragments.push({ id: repo.objects.write("blob", chunk, undefined, [entry.id]), length: chunk.length }); }
 const whole = hashObject("blob", bytes); if (legacyWhole) repo.objects.write("blob", bytes);
 const manifest = repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments }));
 const other = "9".repeat(32); const derived = repo.objects.write("record", encodeRecord({ secret: bytes.toString() }), other, [manifest]);
 repo.materialize(buildTree(repo.objects, new Map([["upgraded.json", { id: derived, fileId: other, mode: "100644" as const }]])));
 repo.commit({ message: "old native equivalent manifest output", author }, new Date(1));
 // A genuine pre-equivalence certificate has no whole identity, including its flattened sources.
 for (const id of [manifest, derived]) writePrivateJson(join(repo.controlDirectory, "derivations", `${id}.json`), { format: "pm-vcs-derivation-2", sources: [...new Set([entry.id, ...fragments.map(fragment => fragment.id), ...(id === derived ? [manifest] : [])])].sort(), unknown: [], independent: [], derived: id === derived ? [other] : [] });
 rmSync(join(repo.controlDirectory, "derivations", `${whole}.json`));
 const result = collectGarbage(repo, true); assert.ok(result.candidates.includes(manifest)); assert.equal(repo.objects.has(manifest), false);
 const certificate = derivations(repo.controlDirectory, () => {}).get(derived)!; assert.ok(certificate.sources.includes(whole));
 if (legacyWhole) { assert.ok(certificate.unknown!.includes(whole)); assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "unknown-equivalence", new Date(1)), error => error instanceof UncataloguedProvenance && error.objects.includes(derived)); assert.equal(repo.objects.denials().length, 0); assert.ok(readFileSync(join(repo.root, "upgraded.json")).includes(bytes)); }
 else { assert.deepEqual(certificate.unknown, []); erase(repo, entry.fileId!, [entry.id, manifest, whole, derived]); assert.equal(existsSync(join(repo.root, "upgraded.json")), false); }
});

test("ancestry-only updates preserve an existing whole-content identity and its retained members", async () => {
 const { repo, entry } = await fixture(); const native = writeFragmented(repo.objects, Buffer.from("independent native whole content"), 5); const before = derivations(repo.controlDirectory, () => {}).get(native.manifestId)!;
 repo.objects.withWriteLock(() => recordDerivation(repo.controlDirectory, native.manifestId, [entry.id], undefined, true, false, id => repo.objects.has(id) ? repo.objects.read(id) : undefined, () => repo.objects.assertWriteLease()));
 const after = derivations(repo.controlDirectory, () => {}).get(native.manifestId)!; assert.equal(after.whole, before.whole); assert.deepEqual(after.members, before.members); assert.ok(after.sources.includes(entry.id));
});

test("incomplete native manifests remain readable but cannot certify whole-content equivalence or successful erasure", async () => {
 const { repo, entry } = await fixture(); const missing = "e".repeat(64); const id = repo.objects.write("manifest", encodeManifest({ totalLength: 3, fragments: [{ id: missing, length: 3 }] }));
 assert.equal(repo.objects.read(id).type, "manifest"); assert.equal(derivations(repo.controlDirectory, () => {}).get(id)!.whole, false);
 assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "missing-composition", new Date(1)), { code: "incomplete_erasure_inventory" }); assert.equal(repo.objects.denials().length, 0); assert.ok(existsSync(join(repo.root, "asset")));
});


for (const packed of [false, true]) test(`independent whole-equivalent FileIds retain shared-ownership refusal (${packed ? "packed" : "loose"})`, async () => {
 const { repo, entry, secret } = await fixture(); const other = "a".repeat(32); const result = writeFragmented(repo.objects, Buffer.from(secret), 5, other);
 if (packed) repo.objects.compact();
 const independent = derivations(repo.controlDirectory, () => {}).get(result.manifestId)!.independent.includes(other);
 assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "independent-equivalent", new Date(1)), { code: "erasure_dedup_conflict" }); assert.equal(repo.objects.denials().length, 0); assert.deepEqual(readFragmented(repo.objects, result.manifestId), Buffer.from(secret)); assert.equal(independent, true);
});

test("explicit native derivation retains whole equivalence without adopting independent ownership", async () => {
 const { repo, entry, secret } = await fixture(); const other = "b".repeat(32);
 const result = repo.objects.withDerivation([entry.id], () => writeFragmented(repo.objects, Buffer.from(secret), 5, other));
 const record = derivations(repo.controlDirectory, () => {}).get(result.manifestId)!; assert.ok(record.derived.includes(other)); assert.equal(record.independent.includes(other), false);
 erase(repo, entry.fileId!, [entry.id, result.manifestId]);
});

test("a whole blob created after GC still finds every retained equivalent derivation", async () => {
 const { repo } = await fixture(); const bytes = Buffer.from("late whole identity 572913"); const fragments = [];
 for (let offset = 0; offset < bytes.length; offset += 4) { const chunk = bytes.subarray(offset, offset + 4); fragments.push({ id: repo.objects.write("blob", chunk), length: chunk.length }); }
 const manifest = repo.objects.write("manifest", encodeManifest({ totalLength: bytes.length, fragments }));
 const other = "d".repeat(32); const derived = repo.objects.write("record", encodeRecord({ content: bytes.toString(), native: true }), other, [manifest]);
 repo.materialize(buildTree(repo.objects, new Map([["derived-late.json", { id: derived, fileId: other, mode: "100644" as const }]])));
 repo.commit({ message: "retain native descendant", author }, new Date(1)); collectGarbage(repo, true); assert.equal(repo.objects.has(manifest), false);
 writeFileSync(join(repo.root, "late-whole"), bytes); repo.stage(["late-whole"]); const selected = repo.readIndex().find(row => row.path === "late-whole")!;
 assert.equal(selected.id, hashObject("blob", bytes)); erase(repo, selected.fileId!, [selected.id, manifest, derived]); assert.equal(existsSync(join(repo.root, "derived-late.json")), false);
});

for (const missing of [false, true]) test(`legacy whole-content producers upgrade ${missing ? "missing" : "known"} input evidence before equivalence publication`, async () => {
 const { repo, entry, secret } = await fixture(); const lost = "f".repeat(64);
 /** Preserve an actual pre-equivalence certificate's fields without inventing origins. */
 const legacy = (id: string): void => {
  const path = join(repo.controlDirectory, "derivations", `${id}.json`); const current = JSON.parse(readFileSync(path, "utf8")) as DerivationRecord;
  writeFileSync(path, JSON.stringify({ format: "pm-vcs-derivation-2", sources: [...new Set([...current.sources, ...(missing ? [lost] : [])])], unknown: current.unknown, independent: current.independent, derived: current.derived }));
 };
 legacy(entry.id); const result = writeFragmented(repo.objects, Buffer.from(secret), 5, entry.fileId);
 assert.equal(derivations(repo.controlDirectory, () => {}).get(entry.id)!.format, "pm-vcs-derivation-3");
 legacy(result.manifestId); repo.objects.withWriteLock(() => repo.objects.recordWholeContent(result.manifestId, entry.id, entry.fileId));
 const evidence = derivations(repo.controlDirectory, () => {}).get(result.manifestId)!; assert.equal(evidence.format, "pm-vcs-derivation-3"); assert.equal(evidence.whole, entry.id);
 if (missing) { assert.ok(evidence.unknown!.includes(lost)); assert.throws(() => repo.obliterate(entry.fileId!, "erase-fixture", "legacy-producer", new Date(1)), { code: "uncatalogued_provenance" }); assert.equal(repo.objects.denials().length, 0); assert.deepEqual(readFragmented(repo.objects, result.manifestId), Buffer.from(secret)); }
 else { assert.deepEqual(evidence.unknown, []); erase(repo, entry.fileId!, [entry.id, result.manifestId]); }
});

for (const type of ["record", "link", "conflict"] as const) for (const packed of [false, true]) test(`typed whole-payload equivalence survives collected ${type} inputs (${packed ? "packed" : "loose"})`, async () => {
  const { repo, entry, secret } = await fixture(); const other = "0".repeat(32); const publicSide = repo.objects.write("blob", Buffer.from("public side"));
  const bytes = type === "record" ? encodeRecord({ secret, native: true }) : type === "link" ? encodeLink({ version: 1, repository: repo.identity(), revision: repo.refs.resolveHead()!, mappings: [{ source: secret, destination: "asset" }] }) : encodeConflict({ kind: "field", field: secret, base: publicSide, ours: publicSide, theirs: publicSide });
  const selected = repo.objects.write("blob", bytes, entry.fileId, [entry.id]);
  const record = repo.objects.write(type, bytes);
  const derived = repo.objects.write("blob", Buffer.concat([bytes, Buffer.from(" derived")]), other, [record]);
  repo.materialize(buildTree(repo.objects, new Map([["derived.txt", { id: derived, fileId: other, mode: "100644" as const }]])));
  repo.commit({ message: "derived from typed whole content", author }, new Date(1));
  if (packed) repo.objects.compact();
  assert.ok(collectGarbage(repo, true).candidates.includes(record)); assert.equal(repo.objects.has(record), false);
  erase(repo, entry.fileId!, [entry.id, selected, record, derived]); assert.equal(existsSync(join(repo.root, "derived.txt")), false);
});
