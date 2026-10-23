/** Capability contracts on real native repositories and SDK-created, non-Git trackers. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { ChangeBundleRefusal, exportChangeBundle, importChangeBundle, inspectChangeBundle, parseChangeBundleAuthorization, parseChangeBundleScope, type ChangeBundleAuthorization, type ChangeBundleManifest, type ChangeBundleScope } from "../index.ts";
import { parseBundle, serializeBundle } from "../engine/bundle.ts";
import { canonicalRecordValue, encodeCommit, encodeManifest, encodeTree, readCommit, type RecordValue, type Signature, type TreeEntry } from "../engine/model.ts";
import { encodeConflict } from "../engine/conflicts.ts";
import { Repository } from "../engine/repo.ts";
import { keyFingerprint, publicKeyText } from "../engine/signatures.ts";
import { configureAuthority, writePrivateJson } from "../engine/composition.ts";
import { updateTrustedKeys } from "../engine/signature-policy.ts";
import { DEFAULT_CONFIG } from "../engine/config.ts";
import { withoutPmContext, installPackedExtension } from "../scripts/pm-environment.ts";
import { discardChildCoverage } from "./helpers/sandbox.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const owned: ReturnType<typeof makeTempDir>[] = [];
const keys = generateKeyPairSync("ed25519");
const publicKey = publicKeyText(keys.publicKey);
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
const branch = "refs/heads/review";
afterEach(() => { for (const dir of owned.splice(0)) dir.cleanup(); });
/** Own and clean only a newly allocated scratch directory. */
function temp() { const dir = makeTempDir(); owned.push(dir); return dir.root; }
/** Canonical bytes constructed independently by a sender, including adversarial signed contracts. */
function canonical(value: unknown): Buffer { return Buffer.from(canonicalRecordValue(value as RecordValue)); }
/** Hash the archive independently of the production bundle writer. */
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
interface Wire { manifest: ChangeBundleManifest; signature: string; archive: string }
/** Decode a valid fixture envelope so tests can tamper with individual signed fields. */
function wire(bytes: Buffer): Wire { return JSON.parse(bytes.toString("utf8").split("\n")[1]) as Wire; }
/** Encode and optionally re-sign an adversarial manifest; untrusted senders can own genuine private keys. */
function seal(value: Wire, resign = true): Buffer {
  if (resign) value.signature = sign(null, Buffer.concat([Buffer.from("pm-vcs/change-bundle\0v1\0"), canonical(value.manifest)]), keys.privateKey).toString("base64");
  return Buffer.from("pmvcs-change-bundle-1\n" + canonical(value).toString("utf8") + "\n");
}
/** Change manifest fields without losing canonical envelope formatting. */
function changed(bytes: Buffer, patch: Record<string, unknown>, resign = true): Buffer {
  const value = wire(bytes); value.manifest = { ...value.manifest, ...patch } as ChangeBundleManifest; return seal(value, resign);
}
/** Replace an archive and bind its exact new digest and included ids with a real signature. */
function archiveChanged(bytes: Buffer, archive: Buffer): Buffer {
  const value = wire(bytes); value.archive = archive.toString("base64");
  const included = parseBundle(archive).lines.map(line => line.id).sort();
  value.manifest = { ...value.manifest, archiveDigest: digest(archive), included, excluded: value.manifest.excluded.filter(id => !included.includes(id)) };
  return seal(value);
}
/** Assert refusals expose stable categories and an actionable remedy. */
function refused(run: () => unknown, code: string): void {
  assert.throws(run, error => error instanceof ChangeBundleRefusal && error.code === code && error.remedy.length > 20);
}
/** Real SDK item and two native changes, with one deliberately excluded loose object. */
async function fixture() {
  const root = temp(); const pmRoot = join(root, ".agents/pm");
  const client = new PmClient({ cwd: root, pmRoot, noExtensions: true });
  await client.init("bundle", { defaults: true, author: "fixture" });
  const item = (await client.create({ type: "Task", title: "Public selected item", author: "fixture" })).item;
  const path = `.agents/pm/tasks/${item.id}.toon`;
  const repo = Repository.init(root, "main", { ...DEFAULT_CONFIG, recordPaths: ["**/*.toon"] });
  repo.stage([path]); const first = repo.commit({ message: "Create selected item", author }, new Date(1));
  await client.update(item.id, { title: "Revised public item", author: "fixture" });
  repo.stage([path]); const last = repo.commit({ message: "Revise selected item", author }, new Date(2));
  const excluded = repo.objects.write("blob", Buffer.from("Excluded native bytes"));
  const scope: ChangeBundleScope = { paths: [path], refs: [branch] };
  const policy: ChangeBundleAuthorization = { scope, trust: { version: 1, keys: [{ identity: author.email, publicKey }], revocations: [] } };
  const selected = { [branch]: last };
  const bytes = exportChangeBundle(repo.objects, selected, scope, author.email, keys.privateKey);
  const receiver = Repository.init(temp());
  return { root, pmRoot, repo, receiver, first, last, excluded, path, scope, policy, selected, bytes };
}
/** Native inventory and branch state must remain byte-for-byte unchanged after preflight refusal. */
function snapshot(repo: Repository) { return { ids: repo.objects.inventory().map(entry => entry.id).sort(), refs: repo.refs.list("refs/") }; }

test("signed selective history imports exact identities, replays by explicit CAS, and excludes unrelated bytes", async () => {
  const f = await fixture(); const before = snapshot(f.receiver);
  const inspected = inspectChangeBundle(f.receiver.objects, f.bytes, f.policy, 10);
  assert.deepEqual(snapshot(f.receiver), before); assert.equal(inspected.changes, 2); assert.equal(inspected.refs, 1);
  assert.equal(inspected.scopeComplete, true); assert.equal(inspected.complete, false); assert.ok(inspected.excluded > 0);
  assert.equal(wire(f.bytes).manifest.excluded.includes(f.excluded), true);
  const report = importChangeBundle(f.receiver, f.bytes, f.policy, { [branch]: null }, 10);
  assert.deepEqual(report, inspected); assert.equal(f.receiver.refs.read(branch), f.last);
  assert.equal(f.receiver.objects.has(f.excluded), false);
  assert.deepEqual(readCommit(f.receiver.objects, f.last), readCommit(f.repo.objects, f.last));
  assert.deepEqual(importChangeBundle(f.receiver, f.bytes, f.policy, { [branch]: f.last }, 10), report);
  const all = exportChangeBundle(f.receiver.objects, f.selected, f.scope, author.email, keys.privateKey);
  assert.equal(inspectChangeBundle(f.repo.objects, all, f.policy).complete, true);
  const identity = f.repo.identity();
  const identified = exportChangeBundle(f.repo.objects, f.selected, f.scope, author.email, keys.privateKey);
  assert.equal(parseBundle(Buffer.from(wire(identified).archive, "base64")).header.identity, undefined);
  importChangeBundle(f.receiver, identified, f.policy, { [branch]: f.last });
  assert.equal(f.receiver.objects.recordedIdentity(), undefined); assert.equal(f.repo.identity(), identity);
  const linkedRoot = join(temp(), "linked"); f.receiver.linkInstance("linked", linkedRoot, { branch: "review" });
  const linked = Repository.open(linkedRoot);
  assert.deepEqual(importChangeBundle(linked, f.bytes, f.policy, { [branch]: f.last }), report);
  assert.ok(JSON.stringify(report).length < 300); assert.equal(existsSync(join(f.root, ".git")), false);
});

test("signed or unsigned scope widening cannot import even one object or move a ref", async () => {
  const f = await fixture(); const before = snapshot(f.receiver);
  for (const scope of [{ ...f.scope, paths: ["another.txt"] }, { ...f.scope, refs: ["refs/heads/other"] }]) {
    const policy = { ...f.policy, scope };
    refused(() => importChangeBundle(f.receiver, f.bytes, policy, { [branch]: null }), "bundle_scope_refused");
  }
  const forged = changed(f.bytes, { scope: { ...f.scope, paths: ["another.txt"] } });
  refused(() => importChangeBundle(f.receiver, forged, { ...f.policy, scope: { ...f.scope, paths: ["another.txt"] } }, { [branch]: null }), "bundle_scope_refused");
  refused(() => exportChangeBundle(f.repo.objects, f.selected, { ...f.scope, paths: ["another.txt"] }, author.email, keys.privateKey), "bundle_scope_refused");
  assert.deepEqual(snapshot(f.receiver), before);
});

test("every manifest field and archive byte is bound by the signature", async () => {
  const f = await fixture(); const before = snapshot(f.receiver);
  for (const patch of [{ unknownOmissions: true }, { excluded: [] }, { included: [] }, { signer: "other" }, { publicKey: publicKeyText(generateKeyPairSync("ed25519").publicKey) },
    { scope: { ...f.scope, paths: ["another.txt"] } }, { tips: { [branch]: "a".repeat(64) } }, { archiveDigest: "a".repeat(64) }]) {
    refused(() => importChangeBundle(f.receiver, changed(f.bytes, patch, false), f.policy, { [branch]: null }), "bundle_signature_refused");
  }
  const value = wire(f.bytes); value.archive += "garbage";
  refused(() => inspectChangeBundle(f.receiver.objects, seal(value, false), f.policy), "bundle_signature_refused");
  assert.deepEqual(snapshot(f.receiver), before);
});

test("trust, revocation, algorithm and canonical signature checks fail closed", async () => {
  const f = await fixture();
  for (const policy of [{ ...f.policy, trust: { ...f.policy.trust, keys: [] } },
    { ...f.policy, trust: { ...f.policy.trust, keys: [{ identity: "other", publicKey }] } },
    { ...f.policy, trust: { ...f.policy.trust, revocations: [{ keyId: keyFingerprint(publicKey), effectiveAt: 10 }] } }]) {
    refused(() => importChangeBundle(f.receiver, f.bytes, policy, { [branch]: null }, 10), "bundle_signature_refused");
  }
  const future = { ...f.policy, trust: { ...f.policy.trust, revocations: [{ keyId: keyFingerprint(publicKey), effectiveAt: 20 }] } };
  inspectChangeBundle(f.receiver.objects, f.bytes, future, 10);
  refused(() => inspectChangeBundle(f.receiver.objects, f.bytes, f.policy, NaN), "bundle_signature_refused");
  for (const signature of ["a", Buffer.alloc(64).toString("base64"), wire(f.bytes).signature + "\n"]) {
    const value = wire(f.bytes); value.signature = signature;
    refused(() => inspectChangeBundle(f.receiver.objects, seal(value, false), f.policy), "bundle_signature_refused");
  }
  refused(() => inspectChangeBundle(f.receiver.objects, changed(f.bytes, { publicKey: "broken" }), f.policy), "bundle_signature_refused");
  for (const key of [keys.publicKey, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey]) {
    refused(() => exportChangeBundle(f.repo.objects, f.selected, f.scope, author.email, key), "bundle_signature_refused");
  }
  for (const signer of ["", "line\nbreak", 5]) refused(() => exportChangeBundle(f.repo.objects, f.selected, f.scope, signer as string, keys.privateKey), "bundle_signature_refused");
});

test("unknown omissions forbid completeness even when all selected objects exist", async () => {
  const f = await fixture();
  writePrivateJson(join(f.repo.controlDirectory, "partial.json"), { remote: "origin", shallow: [], promised: ["a".repeat(64)] });
  const bytes = exportChangeBundle(f.repo.objects, f.selected, f.scope, author.email, keys.privateKey);
  const report = importChangeBundle(f.receiver, bytes, f.policy, { [branch]: null });
  assert.equal(report.unknownOmissions, true); assert.equal(report.complete, false); assert.equal(report.scopeComplete, true);
  const unknown = changed(bytes, { excluded: [] });
  assert.equal(inspectChangeBundle(f.receiver.objects, unknown, f.policy).complete, false);
});

test("unrelated terminal erasure prevents source completeness and grants no receiver erasure authority", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "retired.txt"), "Unique independently retired payload");
  f.repo.stage(["retired.txt"]); f.repo.commit({ message: "Unselected retired file", author }, new Date(3));
  configureAuthority(f.repo.controlDirectory, "fixture", "read-fixture", "erase-fixture");
  f.repo.obliterate("retired.txt", "erase-fixture", "fixture-retirement", new Date(4000));
  const bytes = exportChangeBundle(f.repo.objects, f.selected, f.scope, author.email, keys.privateKey);
  assert.equal(wire(bytes).manifest.unknownOmissions, true);
  assert.equal(parseBundle(Buffer.from(wire(bytes).archive, "base64")).header.denials, undefined);
  assert.equal(importChangeBundle(f.receiver, bytes, f.policy, { [branch]: null }).complete, false);
  assert.deepEqual(f.receiver.objects.denials(), []);
});

test("lease mismatches and missing or malformed leases refuse before object storage", async () => {
  const f = await fixture(); const before = snapshot(f.receiver);
  for (const expected of [{ [branch]: "a".repeat(64) }, { [branch]: "bad" }, { [branch]: 1 }]) {
    refused(() => importChangeBundle(f.receiver, f.bytes, f.policy, expected as Record<string, string | null>), "bundle_lease_refused");
  }
  refused(() => importChangeBundle(f.receiver, f.bytes, f.policy, {}), "invalid_change_bundle");
  assert.deepEqual(snapshot(f.receiver), before);
});

test("multiple destination branches require authority and exact leases as one transaction", async () => {
  const f = await fixture(); const second = "refs/heads/second";
  const scope = { ...f.scope, refs: [branch, second] }; const policy = { ...f.policy, scope };
  const bytes = exportChangeBundle(f.repo.objects, { ...f.selected, [second]: f.first }, scope, author.email, keys.privateKey);
  const before = snapshot(f.receiver);
  refused(() => importChangeBundle(f.receiver, bytes, f.policy, { [branch]: null, [second]: null }), "bundle_scope_refused");
  refused(() => importChangeBundle(f.receiver, bytes, policy, { [branch]: null, [second]: f.first }), "bundle_lease_refused");
  assert.deepEqual(snapshot(f.receiver), before);
  assert.equal(importChangeBundle(f.receiver, bytes, policy, { [branch]: null, [second]: null }).refs, 2);
  assert.equal(f.receiver.refs.read(branch), f.last); assert.equal(f.receiver.refs.read(second), f.first);
});

test("strict scope, trust and tip parsers reject unsupported, duplicate and unsafe authority", async () => {
  const f = await fixture();
  for (const scope of [null, [], {}, { ...f.scope, unknown: true }, { ...f.scope, paths: null }, { ...f.scope, paths: [1] }, { ...f.scope, paths: [""] },
    { ...f.scope, paths: ["../escape"] }, { ...f.scope, paths: ["/absolute"] }, { ...f.scope, paths: ["a\\b"] }, { ...f.scope, paths: ["a*", "b"] },
    { ...f.scope, paths: ["b", "a"] }, { ...f.scope, paths: ["a", "a"] }, { ...f.scope, paths: [] }, { ...f.scope, refs: [] },
    { ...f.scope, refs: ["refs/tags/release"] }, { ...f.scope, paths: Array.from({ length: 1001 }, (_, i) => String(i).padStart(6, "0")) },
    { ...f.scope, refs: Array.from({ length: 101 }, (_, i) => "refs/heads/" + String(i).padStart(3, "0")) },
    { ...f.scope, paths: Array.from({ length: 100001 }, () => "a") }]) refused(() => parseChangeBundleScope(scope), "invalid_change_bundle");
  assert.throws(() => parseChangeBundleScope({ ...f.scope, refs: ["refs/heads/../escape"] }), { code: "invalid_ref_name" });
  refused(() => parseChangeBundleAuthorization({ scope: f.scope }), "invalid_change_bundle");
  assert.throws(() => parseChangeBundleAuthorization({ scope: f.scope, trust: {} }), { code: "bad_signature_policy" });
  for (const selected of [{}, { [branch]: "bad" }, { [branch]: null }]) refused(() => exportChangeBundle(f.repo.objects, selected as Record<string, string>, f.scope, author.email, keys.privateKey), "invalid_change_bundle");
});

test("malformed envelopes, unsupported fields and noncanonical encodings refuse with typed remedies", async () => {
  const f = await fixture();
  for (const bytes of [Buffer.alloc(33554433), Buffer.from("wrong\n{}"), Buffer.from("pmvcs-change-bundle-1\n{"), Buffer.from("pmvcs-change-bundle-1\nnull"),
    Buffer.from("pmvcs-change-bundle-1\n[]"), Buffer.from("pmvcs-change-bundle-1\n{}"), Buffer.from(f.bytes.toString("utf8") + "\n")]) {
    refused(() => inspectChangeBundle(f.receiver.objects, bytes, f.policy), "invalid_change_bundle");
  }
  for (const patch of [{ version: 2 }, { unknownOmissions: "yes" }, { archiveDigest: 1 }, { archiveDigest: "bad" }, { signer: null }, { publicKey: null },
    { excluded: [wire(f.bytes).manifest.included[0]] }, { excluded: ["bad"] }, { extra: true }]) refused(() => inspectChangeBundle(f.receiver.objects, changed(f.bytes, patch), f.policy), "invalid_change_bundle");
  for (const patch of [{ signature: 1 }, { archive: 1 }]) {
    const value = { ...wire(f.bytes), ...patch };
    refused(() => inspectChangeBundle(f.receiver.objects, Buffer.from("pmvcs-change-bundle-1\n" + canonical(value).toString("utf8") + "\n"), f.policy), "invalid_change_bundle");
  }
});

test("signed missing, duplicate, extra and hidden prerequisite objects cannot use receiver-held bytes", async () => {
  const f = await fixture(); importChangeBundle(f.receiver, f.bytes, f.policy, { [branch]: null });
  const original = Buffer.from(wire(f.bytes).archive, "base64"); const parsed = parseBundle(original);
  const omitted = parsed.header.objects.filter(id => id !== f.first);
  const missing = serializeBundle(f.repo.objects, { ...parsed.header, objects: omitted });
  refused(() => importChangeBundle(f.receiver, archiveChanged(f.bytes, missing), f.policy, { [branch]: f.last }), "bundle_incomplete");
  const extra = serializeBundle(f.repo.objects, { ...parsed.header, objects: [...parsed.header.objects, f.excluded].sort() });
  refused(() => inspectChangeBundle(f.receiver.objects, archiveChanged(f.bytes, extra), f.policy), "bundle_incomplete");
  for (const archive of [Buffer.from(original.toString("utf8") + original.toString("utf8").split("\n")[2] + "\n"),
    serializeBundle(f.repo.objects, { ...parsed.header, prerequisites: [f.first] }),
    serializeBundle(f.repo.objects, { ...parsed.header, objects: [...parsed.header.objects].reverse() })]) {
    const value = wire(f.bytes); value.archive = archive.toString("base64"); value.manifest = { ...value.manifest, archiveDigest: digest(archive) };
    // Reversed body order is harmless; reversed declared inventory is unsupported and must fail.
    refused(() => inspectChangeBundle(f.receiver.objects, seal(value), f.policy), "bundle_incomplete");
  }
  refused(() => inspectChangeBundle(f.receiver.objects, changed(f.bytes, { included: [] }), f.policy), "bundle_incomplete");
  // Keep header inventory unchanged while replacing one body object with a different valid object.
  const lines = original.toString("utf8").trimEnd().split("\n");
  const object = f.repo.objects.read(f.excluded);
  lines[2] = `${object.type} ${f.excluded} ${object.payload.toString("base64")}`;
  const swapped = Buffer.from(lines.join("\n") + "\n"); const value = wire(f.bytes);
  value.archive = swapped.toString("base64"); value.manifest = { ...value.manifest, archiveDigest: digest(swapped) };
  refused(() => inspectChangeBundle(f.receiver.objects, seal(value), f.policy), "bundle_incomplete");
});

/** Construct a real root history with custom native payload types and entries. */
function native(repo: Repository, entries: readonly TreeEntry[], scope: ChangeBundleScope, patch: Record<string, unknown> = {}) {
  const tree = repo.objects.write("tree", encodeTree(entries));
  const id = repo.objects.write("commit", encodeCommit({ tree, parents: [], author, committer: author, message: "Scoped native root", ...patch }));
  return exportChangeBundle(repo.objects, { [branch]: id }, scope, author.email, keys.privateKey);
}

test("native conflict sides, repeated payloads, absent FileIds and in-scope copy provenance retain closure", async () => {
  const f = await fixture(); const repo = f.repo;
  const blob = repo.objects.write("blob", Buffer.from("text"));
  const conflict = repo.objects.write("conflict", encodeConflict({ kind: "text", start: 0, end: 1, base: blob, ours: blob, theirs: blob }));
  const fileId = "a".repeat(32);
  const scope = { paths: ["a", "b"], refs: [branch] };
  const archive = native(repo, [{ name: "a", mode: "100644", id: blob, fileId, conflicts: [conflict] },
    { name: "b", mode: "100644", id: blob, fileId: "b".repeat(32), copiedFrom: fileId }], scope);
  assert.equal(inspectChangeBundle(f.receiver.objects, archive, { ...f.policy, scope }).scopeComplete, true);
  refused(() => native(repo, [{ name: "a", mode: "100644", id: blob, fileId: "b".repeat(32), copiedFrom: fileId }], scope), "bundle_scope_refused");
  const link = repo.objects.write("link", Buffer.from("not interpreted because external scope is denied"));
  refused(() => native(repo, [{ name: "a", mode: "100644", id: link }], scope), "bundle_scope_refused");
});

test("manifest fragment payloads and manifest pages close over exact carried native objects", async () => {
  const f = await fixture(); const repo = f.repo;
  const blob = repo.objects.write("blob", Buffer.from("text"));
  const manifest = repo.objects.write("manifest", encodeManifest({ totalLength: 4, fragments: [{ id: blob, length: 4 }] }));
  const full = repo.objects.write("manifest", encodeManifest({ totalLength: 512, fragments: Array.from({ length: 128 }, () => ({ id: blob, length: 4 })) }));
  const paged = repo.objects.write("manifest", encodeManifest({ totalLength: 516, fragments: [], height: 1, pages: [{ id: full, length: 512, count: 128 }, { id: manifest, length: 4, count: 1 }] }));
  for (const id of [manifest, paged]) {
    const archive = native(repo, [{ name: "a", mode: "100644", id }], { paths: ["a"], refs: [branch] });
    inspectChangeBundle(f.receiver.objects, archive, { ...f.policy, scope: { paths: ["a"], refs: [branch] } });
  }
});

test("checkpoint references outside the explicit path scope fail before import", async () => {
  const f = await fixture(); const commit = readCommit(f.repo.objects, f.last);
  const claim = { version: 1, id: "scope", scope: [{ path: "policy.json" }], dependencies: [{ path: f.path }], gateId: "quality", assertionId: "ready",
    receipt: { treeId: commit.tree, evaluatedAt: "2026-10-23T00:00:00.000Z" }, changeId: f.last, fingerprint: "a".repeat(64), evidenceDigest: "b".repeat(64) };
  for (const current of [claim, { ...claim, scope: [{ path: f.path }], dependencies: [{ path: "policy.json" }] }]) {
    const id = f.repo.objects.write("commit", encodeCommit({ ...commit, checkpoints: Buffer.from(JSON.stringify([current])).toString("base64") }));
    refused(() => exportChangeBundle(f.repo.objects, { [branch]: id }, f.scope, author.email, keys.privateKey), "bundle_scope_refused");
  }
  const scoped = { ...claim, scope: [{ path: f.path }], dependencies: [{ path: f.path }] };
  const id = f.repo.objects.write("commit", encodeCommit({ ...commit, checkpoints: Buffer.from(JSON.stringify([scoped])).toString("base64") }));
  inspectChangeBundle(f.receiver.objects, exportChangeBundle(f.repo.objects, { [branch]: id }, f.scope, author.email, keys.privateKey), f.policy);
});

test("oversized selected archives refuse without weakening the archive bound", async () => {
  const f = await fixture(); const id = f.repo.objects.write("blob", Buffer.alloc(20000000, 32));
  refused(() => native(f.repo, [{ name: "large", mode: "100644", id }], { paths: ["large"], refs: [branch] }), "invalid_change_bundle");
});

test("receiver change-signature policy remains authoritative even for a trusted manifest signer", async () => {
  const f = await fixture(); updateTrustedKeys(f.receiver.objects, f.receiver.controlDirectory, { publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), identity: author.email });
  assert.throws(() => importChangeBundle(f.receiver, f.bytes, f.policy, { [branch]: null }), { code: "change_signature_refused" });
  assert.equal(f.receiver.objects.has(f.last), false); assert.equal(f.receiver.refs.read(branch), null);
});

test("CLI handlers use explicit input, external signing keys and independent import policy", async () => {
  const f = await fixture(); const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const external = temp(); const keyFile = join(external, "key.pem");
  writeFileSync(keyFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }));
  const request = join(external, "request.json"); const authorization = join(external, "authority.json"); const expected = join(external, "expected.json");
  writeFileSync(request, JSON.stringify({ scope: f.scope, tips: f.selected, signer: author.email }));
  writeFileSync(authorization, JSON.stringify(f.policy)); writeFileSync(expected, JSON.stringify({ [branch]: null }));
  const output = join(external, "selected.bundle");
  const run = (action: string, args: string[], options: Record<string, unknown>, root = f.root) => harness.runCommand({ command: `vcs bundle ${action}`, args, options, pmRoot: join(root, ".agents/pm") });
  assert.equal((await run("export", [output], { input: request, keyFile })).errorMessage, undefined);
  const inspected = await run("inspect", [output], { authorization }, f.receiver.root);
  assert.equal(inspected.errorMessage, undefined); assert.equal((inspected.result as { changes: number }).changes, 2);
  assert.equal((await run("import", [output], { authorization, expected }, f.receiver.root)).errorMessage, undefined);
  assert.equal(f.receiver.refs.read(branch), f.last);
  assert.match((await run("export", [output], { input: request })).errorMessage!, /documented/);
  assert.match((await run("export", [], { input: request, keyFile })).errorMessage!, /output file/);
  assert.match((await run("inspect", [], { authorization })).errorMessage!, /signed change bundle/);
  assert.match((await run("export", [output], {})).errorMessage!, /JSON object/);
  assert.match((await run("inspect", [join(external, "missing")], { authorization })).errorMessage!, /readable input/);
  for (const text of ["{", "null", "[]"]) {
    writeFileSync(request, text); assert.match((await run("export", [output], { input: request, keyFile })).errorMessage!, /JSON object/);
  }
  truncateSync(request, 33554433); assert.match((await run("export", [output], { input: request, keyFile })).errorMessage!, /JSON object/);
});

test("installed CLI emits compact JSON and TOON and imports in non-Git trackers with no git executable", async () => {
  const f = await fixture(); const external = temp(); const bins = temp();
  const env = { ...withoutPmContext(process.env), ...discardChildCoverage(), PATH: bins, GIT_CEILING_DIRECTORIES: dirname(f.receiver.root), PM_AUTHOR: "fixture" };
  const cli = join(packageRoot, "node_modules/@unbrained/pm-cli/dist/cli.js");
  const receiverPm = join(f.receiver.root, ".agents/pm");
  await new PmClient({ cwd: f.receiver.root, pmRoot: receiverPm, noExtensions: true }).init("receiver", { defaults: true, author: "fixture" });
  installPackedExtension(f.receiver.root);
  const archive = join(external, "selected.bundle"); const policy = join(external, "authority.json"); const expected = join(external, "expected.json");
  writeFileSync(archive, f.bytes); writeFileSync(policy, JSON.stringify(f.policy)); writeFileSync(expected, JSON.stringify({ [branch]: null }));
  const run = (args: string[]) => execFileSync(process.execPath, [cli, "vcs", "bundle", ...args], { cwd: f.receiver.root, env, encoding: "utf8" });
  assert.equal((JSON.parse(run(["inspect", archive, "--authorization", policy, "--json"])) as { changes: number }).changes, 2);
  const toon = run(["inspect", archive, "--authorization", policy]); assert.match(toon, /scopeComplete: true/); assert.ok(toon.length < 500);
  run(["import", archive, "--authorization", policy, "--expected", expected, "--json"]);
  assert.equal(f.receiver.refs.read(branch), f.last); assert.equal(existsSync(join(f.receiver.root, ".git")), false);
});
