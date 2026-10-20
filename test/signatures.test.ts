/** Real native changes, adversarial signatures and atomic receiver policy enforcement. */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { fork } from "node:child_process";
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, test } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { exportBundle, parseBundle } from "../engine/bundle.ts";
import { parseConfig, writeConfig } from "../engine/config.ts";
import { createSeries, exportSeriesBundle } from "../engine/series.ts";
import { Repository } from "../engine/repo.ts";
import { decodeCommit, encodeCommit, effectiveChangeId, readCommit, writeCommit, writeTree, type Commit } from "../engine/model.ts";
import { PublicationLeases } from "../engine/publication-leases.ts";
import { FileTransport } from "../engine/transport.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { startRepositoryServer, TokenGrants } from "../engine/serve.ts";
import { assertWireSuccess, encodeErrorBody } from "../engine/http-protocol.ts";
import { EMPTY_TRUST, TRUSTED_KEYS_FILE, assertTrustedChanges, parseTrustedKeys, readTrustedKeys, updateTrustedKeys } from "../engine/signature-policy.ts";
import { ChangeSignatureError, changeSigningPayload, keyFingerprint, parsePublicKey, publicKeyText, readSigningKey, retainedAttestation, signChange, verifyChangeSignature, type ChangeSignatureResult, type TrustedKeys } from "../engine/signatures.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const directories: ReturnType<typeof makeTempDir>[] = [];
afterEach(() => { for (const dir of directories.splice(0)) dir.cleanup(); });
const author = { name: "Agent", email: "agent@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };
/** Fresh real repository and in-memory ephemeral keys; no fixture private material is committed. */
function fixture() {
  const dir = makeTempDir(); directories.push(dir);
  const repository = Repository.init(join(dir.root, "source"));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyText(keys.publicKey);
  const policy: TrustedKeys = { version: 1, keys: [{ identity: author.email, publicKey }], revocations: [] };
  const commit: Commit = { tree: writeTree(repository.objects, []), parents: [], author, committer: author, message: "change\n" };
  const original = writeCommit(repository.objects, commit);
  repository.refs.compareAndSwap("refs/heads/main", null, original);
  const signed = { ...commit, changeId: original, attestation: signChange(original, commit, keys.privateKey) };
  const id = writeCommit(repository.objects, signed);
  return { dir, repository, keys, publicKey, policy, commit, original, signed, id };
}
/** Replace only the encoded envelope to construct attacks the signing API correctly refuses to create. */
function envelope(commit: Commit, updates: Record<string, unknown>): Commit {
  const fields = JSON.parse(Buffer.from(commit.attestation!, "base64").toString()) as Record<string, unknown>;
  return { ...commit, attestation: Buffer.from(JSON.stringify({ ...fields, ...updates })).toString("base64") };
}
/** Enable the actual receiver policy through the same lock-taking API as its admin CLI. */
function trust(repository: Repository, publicKey: KeyObject): string {
  return updateTrustedKeys(repository.objects, repository.controlDirectory, {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), identity: author.email,
  });
}

test("canonical domain/version and content binding resist replay, tampering, truncation and other versions", () => {
  const { id, original, signed, commit, keys, policy } = fixture();
  assert.equal(verifyChangeSignature(id, signed, policy, 0).status, "valid");
  assert.equal(verifyChangeSignature(original, commit, policy, 0).status, "unsigned");
  assert.equal(verifyChangeSignature(id, signed, EMPTY_TRUST, 0).status, "untrusted");
  assert.equal(changeSigningPayload(id, signed).subarray(0, 27).toString(), "pm-vcs/change-signature\0v1\0");
  for (const changed of [
    { ...signed, changeId: "f".repeat(64) }, { ...signed, tree: "a".repeat(64) }, { ...signed, message: "other" },
    { ...signed, items: ["pm-vcs-synthetic"] }, { ...signed, author: { ...author, email: "other@example.invalid" } },
  ]) assert.equal(verifyChangeSignature(id, changed, policy, 0).status, "tampered");
  assert.equal(verifyChangeSignature(id, { ...signed, parents: [original], committer: { ...author, timestamp: 99 } }, policy, 0).status, "valid");
  assert.deepEqual(changeSigningPayload(id, { ...signed, items: ["b", "a", "a"] }), changeSigningPayload(id, { ...signed, items: ["a", "b"] }));
  assert.equal(verifyChangeSignature(id, envelope(signed, { signature: Buffer.alloc(63).toString("base64") }), policy, 0).status, "malformed");
  assert.equal(verifyChangeSignature(id, envelope(signed, { version: 2 }), policy, 0).status, "malformed");
  const otherVersion = Buffer.from(changeSigningPayload(id, signed).toString().replace("v1\0", "v2\0"));
  assert.equal(verifyChangeSignature(id, envelope(signed, { signature: sign(null, otherVersion, keys.privateKey).toString("base64") }), policy, 0).status, "tampered");
  const wrongIdentity = { ...policy, keys: [{ ...policy.keys[0]!, identity: "other@example.invalid" }] };
  assert.equal(verifyChangeSignature(id, signed, wrongIdentity, 0).status, "untrusted");
  const revoked = { ...policy, revocations: [{ keyId: keyFingerprint(policy.keys[0]!.publicKey), effectiveAt: 100 }] };
  assert.equal(verifyChangeSignature(id, signed, revoked, 99).status, "valid");
  assert.equal(verifyChangeSignature(id, signed, revoked, 100).status, "revoked");
});

test("malformed envelopes and algorithms fail closed without echoing input", () => {
  const { id, signed, policy, keys } = fixture();
  for (const attestation of ["!", "e30", ...[null, [], {}, { version: 1, publicKey: 7, signature: "" },
    { version: 1, publicKey: "!", signature: "" }, { version: 1, publicKey: policy.keys[0]!.publicKey, signature: "!" }]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64"))]) {
    assert.equal(verifyChangeSignature(id, { ...signed, attestation }, policy, 0).status, "malformed");
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => parsePublicKey(publicKeyText(rsa.publicKey)));
  assert.throws(() => signChange(id, signed, rsa.privateKey), { code: "invalid_signing_key" });
  assert.throws(() => signChange(id, signed, keys.publicKey), { code: "invalid_signing_key" });
  assert.throws(() => encodeCommit({ ...signed, attestation: "bad\nheader" }), { code: "invalid_attestation" });
  assert.throws(() => decodeCommit(Buffer.from(encodeCommit(signed).toString().replace("\n\n", "\nattestation duplicate\n\n"))), { code: "malformed_object" });
  assert.equal(decodeCommit(encodeCommit({ ...signed, attestation: "" })).attestation, "");
});

test("trust cannot be replaced by a display alias and revocations remain effective across key rotation", () => {
  const { repository, keys, id, signed, dir } = fixture();
  assert.equal(readTrustedKeys(repository.controlDirectory), null);
  const fingerprint = trust(repository, keys.publicKey);
  assert.equal(verifyChangeSignature(id, signed, readTrustedKeys(repository.controlDirectory)!, 0).status, "valid");
  assert.throws(() => trust(repository, keys.publicKey), { code: "bad_signature_policy" });
  const replacement = generateKeyPairSync("ed25519");
  const swapped = { version: 1, keys: [{ identity: author.email, publicKey: publicKeyText(replacement.publicKey) }], revocations: [] };
  writeFileSync(join(repository.controlDirectory, TRUSTED_KEYS_FILE), JSON.stringify(swapped));
  assert.equal(verifyChangeSignature(id, signed, readTrustedKeys(repository.controlDirectory)!, 0).status, "untrusted");
  trust(repository, keys.publicKey);
  updateTrustedKeys(repository.objects, repository.controlDirectory, { keyId: fingerprint, effectiveAt: 50 });
  updateTrustedKeys(repository.objects, repository.controlDirectory, { keyId: fingerprint, effectiveAt: 100 });
  assert.equal(verifyChangeSignature(id, signed, readTrustedKeys(repository.controlDirectory)!, 50).status, "revoked");
  writeFileSync(join(repository.controlDirectory, TRUSTED_KEYS_FILE), "bad JSON");
  assert.throws(() => readTrustedKeys(repository.controlDirectory), { code: "bad_signature_policy" });
  assert.throws(() => updateTrustedKeys(repository.objects, repository.controlDirectory, { keyId: fingerprint, effectiveAt: 0 }), { code: "bad_signature_policy" });
  assert.throws(() => parseConfig({ trustedKeysFile: "other.json" }), { code: "bad_config" });
  assert.throws(() => updateTrustedKeys(Repository.init(join(dir.root, "empty")).objects, join(dir.root, "empty", ".pm-vcs"),
    { publicKey: "secret", identity: author.email }), { code: "bad_signature_policy" });
});

test("policy validates every shape and key before granting trust", () => {
  const { policy, repository } = fixture();
  const invalid = [null, [], {}, { ...policy, keys: null }, { ...policy, revocations: null },
    ...[null, {}, { identity: "", publicKey: "bad" }, { identity: "a\nb", publicKey: "bad" }, { identity: "a", publicKey: 1 },
      { identity: "a", publicKey: "!" }].map(entry => ({ ...policy, keys: [entry] })),
    { ...policy, keys: [policy.keys[0], policy.keys[0]] },
    ...[null, {}, { keyId: "f".repeat(64), effectiveAt: -1 }, { keyId: "f".repeat(64), effectiveAt: 0.1 }].map(entry => ({ ...policy, revocations: [entry] })),
  ];
  for (const value of invalid) assert.throws(() => parseTrustedKeys(value), { code: "bad_signature_policy" });
  assert.deepEqual(parseTrustedKeys(policy), policy);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => updateTrustedKeys(repository.objects, repository.controlDirectory, {
    identity: author.email, publicKey: rsa.publicKey.export({ format: "pem", type: "spki" }).toString(),
  }), { code: "bad_signature_policy" });
});

test("explicit signing replays descendants and retains signatures only for unchanged signed bytes", () => {
  const { repository, original, keys, policy, id, signed } = fixture();
  const descendant = writeCommit(repository.objects, { ...signed, parents: [original], changeId: "a".repeat(64), attestation: undefined, message: "child" });
  repository.refs.compareAndSwap("refs/heads/main", original, descendant);
  repository.sign("HEAD", keys.privateKey, new Date());
  const childBefore = repository.refs.resolveHead()!;
  const childSignature = readCommit(repository.objects, childBefore).attestation;
  repository.sign(original, keys.privateKey, new Date());
  const childAfter = readCommit(repository.objects, repository.refs.resolveHead()!);
  assert.equal(childAfter.attestation, childSignature);
  assert.equal(verifyChangeSignature(repository.refs.resolveHead()!, childAfter, policy, 0).status, "valid");
  const parent = readCommit(repository.objects, childAfter.parents[0]);
  assert.equal(effectiveChangeId(childAfter.parents[0], parent), original);
  assert.equal(verifyChangeSignature(childAfter.parents[0], parent, policy, 0).status, "valid");
  repository.describe("HEAD", "new message", author, new Date());
  assert.equal(readCommit(repository.objects, repository.refs.resolveHead()!).attestation, undefined);
  assert.deepEqual(retainedAttestation(original, { ...signed, attestation: undefined }, signed), {});
  assert.deepEqual(retainedAttestation(id, signed, { ...signed, tree: "b".repeat(64) }), {});
  assert.deepEqual(retainedAttestation(id, signed, { ...signed, parents: [] }), { attestation: signed.attestation });
  repository.undo(null, new Date());
  assert.equal(readCommit(repository.objects, repository.refs.resolveHead()!).attestation, childSignature);
});

for (const mode of ["push", "publish"] as const) test(`${mode} rejects an entire multi-ref batch for every invalid signature status before publication`, async () => {
  const { repository, dir, keys, id, signed, original } = fixture();
  const receiver = Repository.init(join(dir.root, "receiver"));
  const fingerprint = trust(receiver, keys.publicKey);
  const wire = new FileTransport("receiver", receiver.root);
  const attacks = [
    ["unsigned", original], ["untrusted", writeCommit(repository.objects, { ...signed, attestation: signChange(id, signed, generateKeyPairSync("ed25519").privateKey) })],
    ["malformed", writeCommit(repository.objects, { ...signed, attestation: "bad" })],
    ["tampered", writeCommit(repository.objects, { ...signed, message: "tampered" })],
  ] as const;
  for (const [reason, next] of attacks) {
    repository.refs.compareAndSwap("refs/heads/attack", repository.refs.read("refs/heads/attack"), next);
    repository.refs.compareAndSwap("refs/heads/signed", repository.refs.read("refs/heads/signed"), id);
    const bundle = exportBundle(repository.objects, repository.refs, []);
    const updates = [{ ref: "refs/heads/good", expected: null, next: id }, { ref: "refs/heads/bad", expected: null, next }];
    if (mode === "publish") await wire.uploadObjects(parseBundle(bundle).lines);
    await assert.rejects(mode === "push" ? wire.push(bundle, updates, true, new Date("1900-01-01")) : wire.publish(updates, true, new Date("1900-01-01")),
      (error: unknown) => { assert.ok(error instanceof ChangeSignatureError); assert.equal(error.reason, reason); assert.equal(error.commitId, next); return true; });
    assert.deepEqual(receiver.refs.list("refs/heads/"), []);
    assert.equal(receiver.operations.read().length, 0);
  }
  updateTrustedKeys(receiver.objects, receiver.controlDirectory, { keyId: fingerprint, effectiveAt: 0 });
  await assert.rejects(wire.publish([{ ref: "refs/heads/main", expected: null, next: id }], true, new Date()), { code: "change_signature_refused", reason: "revoked" });
  assert.deepEqual(receiver.refs.list("refs/heads/"), []);
});

test("HTTP serve preserves typed signature refusals and reloads trust/revocation for resumable publication", async () => {
  const { repository, dir, keys, original } = fixture();
  const receiver = Repository.init(join(dir.root, "receiver"));
  const server = await startRepositoryServer({ root: receiver.root, host: "127.0.0.1", port: 0,
    grants: new TokenGrants([{ token: "synthetic-token", repository: "", access: "write" }]) });
  try {
    const wire = new HttpTransport(`http://${server.host}:${server.port}`, { token: "synthetic-token" });
    await wire.advertise(); // server already has an open repository before configuration changes.
    const fingerprint = trust(receiver, keys.publicKey);
    const updates = [{ ref: "refs/heads/main", expected: null, next: original }];
    await assert.rejects(wire.push(exportBundle(repository.objects, repository.refs, []), updates, false, new Date()),
      (error: unknown) => { assert.ok(error instanceof ChangeSignatureError); assert.equal(error.reason, "unsigned"); assert.equal(error.changeId, original); return true; });
    const signedId = repository.sign("HEAD", keys.privateKey, new Date())!;
    await wire.uploadObjects(parseBundle(exportBundle(repository.objects, repository.refs, [])).lines);
    updateTrustedKeys(receiver.objects, receiver.controlDirectory, { keyId: fingerprint, effectiveAt: Date.now() });
    await assert.rejects(wire.publish([{ ...updates[0], next: signedId }], false, new Date(0)), { code: "change_signature_refused", reason: "revoked" });
    assert.equal(receiver.refs.resolveHead(), null);
    const rotated = generateKeyPairSync("ed25519"); trust(receiver, rotated.publicKey);
    const rotatedId = repository.sign("HEAD", rotated.privateKey, new Date())!;
    await wire.push(exportBundle(repository.objects, repository.refs, []), [{ ...updates[0], next: rotatedId }], false, new Date());
    assert.equal(receiver.refs.resolveHead(), rotatedId);
  } finally { await server.close(); }
});

test("served forge series cannot bypass configured change signature policy", async () => {
  const { repository, dir, keys, original } = fixture();
  const next = writeCommit(repository.objects, { ...readCommit(repository.objects, original), parents: [original], message: "patch" });
  const series = createSeries(repository.objects, original, next, { description: "proposal", author });
  const receiver = Repository.init(join(dir.root, "receiver")); trust(receiver, keys.publicKey);
  const wire = new FileTransport("receiver", receiver.root);
  await assert.rejects(wire.forge({ action: "publish", kind: "series", name: "proposal", expected: null, branch: "refs/heads/main", series,
    bundle: exportSeriesBundle(repository.objects, series).toString("base64"), proofs: [] }), { code: "change_signature_refused" });
  assert.deepEqual(receiver.refs.list("refs/forge-series/"), []);
});

test("wire error reconstruction accepts only validated change ids and fixed refusal reasons", () => {
  const { id, original } = fixture();
  for (const status of ["unsigned", "untrusted", "revoked", "malformed", "tampered"] as const) {
    const error = new ChangeSignatureError({ commitId: id, changeId: original, status });
    assert.throws(() => assertWireSuccess(400, encodeErrorBody(error.code, error.message, error), "receiver"), { reason: status, changeId: original });
  }
  for (const fields of [{}, { changeId: original }, { changeId: original, commitId: id, reason: "unknown" },
    { changeId: "bad", commitId: id, reason: "unsigned" }, { changeId: original, commitId: "bad", reason: "unsigned" }]) {
    assert.throws(() => assertWireSuccess(400, Buffer.from(JSON.stringify({ error: { code: "change_signature_refused", message: "fixed", ...fields } })), "receiver"), { code: "change_signature_refused" });
  }
});

test("2,000 native signed changes report measured verification wall time", async () => {
  const { repository, commit, keys } = fixture();
  const commits = new Map<string, Commit>();
  let parent: string | undefined;
  repository.objects.withWriteLock(() => {
    for (let i = 0; i < 2000; i++) {
      const draft = { ...commit, parents: parent === undefined ? [] : [parent], message: `synthetic change ${i}` };
      const identity = writeCommit(repository.objects, draft);
      const signed = { ...draft, changeId: identity, attestation: signChange(identity, draft, keys.privateKey) };
      parent = writeCommit(repository.objects, signed); commits.set(parent, signed);
    }
  });
  repository.refs.compareAndSwap("refs/heads/main", repository.refs.resolveHead(), parent!);
  assertTrustedChanges(repository.controlDirectory, commits); // unconfigured compatibility boundary.
  const fingerprint = trust(repository, keys.publicKey);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const start = performance.now();
  const verified = await harness.runCommand({ command: "vcs verify", options: { signatures: true }, pmRoot: repository.root });
  const elapsed = performance.now() - start;
  assert.equal(verified.handled, true);
  const result = verified.result as { signatures: ChangeSignatureResult[]; corrupt: string[]; missing: string[] };
  assert.deepEqual(result.corrupt, []); assert.deepEqual(result.missing, []);
  assert.equal(result.signatures.length, 2000); assert.ok(result.signatures.every(row => row.status === "valid"));
  console.log(`SIGNATURE-BENCHMARK changes=2000 valid=2000 elapsed_ms=${elapsed.toFixed(3)}`);
  updateTrustedKeys(repository.objects, repository.controlDirectory, { keyId: fingerprint, effectiveAt: Date.now() + 1 });
  assert.throws(() => assertTrustedChanges(repository.controlDirectory, commits), { reason: "revoked" });
});

test("a separate revoker cannot cross a held publication lease and its next successful revocation fences the next push", async () => {
  const { repository, dir, keys, id } = fixture();
  const receiver = Repository.init(join(dir.root, "receiver")); const fingerprint = trust(receiver, keys.publicKey);
  const receipt = join(dir.root, "revocation-receipt.json");
  const worker = fork(join(packageRoot, "test/helpers/signature-policy-worker.ts"), [receiver.root, fingerprint, receipt], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  /** Await a bounded IPC barrier so the race has a controlled, observable ordering. */
  const message = () => new Promise<{ status: string; code?: string }>((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error("revocation worker timeout")), 10000);
    worker.once("message", value => { clearTimeout(timeout); resolveMessage(value as { status: string; code?: string }); });
  });
  try {
    assert.equal((await message()).status, "ready");
    const inFlight = message();
    receiver.objects.withWriteLock(() => {
      worker.send({ action: "revoke" });
      const deadline = performance.now() + 20000;
      while (!existsSync(receipt) && performance.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      assert.ok(existsSync(receipt), "revoker must attempt the real shared lease before its owner releases it");
    });
    assert.deepEqual(await inFlight, { status: "refused", code: "store_locked" });
    const next = message(); worker.send({ action: "revoke" }); assert.equal((await next).status, "revoked");
    repository.refs.compareAndSwap("refs/heads/main", repository.refs.resolveHead(), id);
    const wire = new FileTransport("receiver", receiver.root);
    await assert.rejects(wire.push(exportBundle(repository.objects, repository.refs, []), [{ ref: "refs/heads/main", expected: null, next: id }], false, new Date()), { reason: "revoked" });
    assert.equal(receiver.refs.resolveHead(), null);
  } finally { worker.kill(); }
});

test("agent CLI signs, verifies, trusts and revokes while every written repository file and output stays free of private key material", async () => {
  const { repository, dir, keys, original } = fixture();
  const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const privateDer = keys.privateKey.export({ format: "der", type: "pkcs8" });
  const keyPath = join(dir.root, "agent-key.pem"); writeFileSync(keyPath, privatePem, { mode: 0o600 });
  const publicPath = join(dir.root, "agent-public.pem"); writeFileSync(publicPath, keys.publicKey.export({ format: "pem", type: "spki" }));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const outputs: string[] = [];
  /** Capture every command result and error as an agent would receive it. */
  const run = async (command: string, args: string[] = [], options: Record<string, unknown> = {}) => {
    const result = await harness.runCommand({ command, args, options, pmRoot: repository.root });
    outputs.push(JSON.stringify(result)); return result;
  };
  assert.equal((await run("vcs verify", [], { signatures: true })).handled, false);
  assert.match(outputs.at(-1)!, /unsigned/);
  assert.equal((await run("vcs sign", [], { key: keyPath })).handled, true);
  assert.equal((await run("vcs verify", [], { signatures: true })).handled, false);
  assert.match(outputs.at(-1)!, /untrusted/);
  assert.equal((await run("vcs trust-key", [author.email, publicPath])).handled, true);
  const verified = await run("vcs verify", [], { signatures: true });
  assert.equal(verified.handled, true);
  assert.match(JSON.stringify(verified.result), /"status":"valid"/);
  assert.equal(effectiveChangeId(repository.refs.resolveHead()!, readCommit(repository.objects, repository.refs.resolveHead()!)), original);
  const fingerprint = keyFingerprint(publicKeyText(keys.publicKey));
  assert.equal((await run("vcs revoke-key", [fingerprint], { effectiveAt: "2100-01-01T00:00:00Z" })).handled, true);
  assert.equal((await run("vcs revoke-key", [fingerprint])).handled, true);
  await run("vcs verify", [], { signatures: true }); assert.match(outputs.at(-1)!, /revoked/);
  for (const [command, args, options] of [
    ["vcs sign", [], {}], ["vcs sign", [], { key: privatePem }], ["vcs trust-key", [], {}],
    ["vcs trust-key", [author.email], {}], ["vcs trust-key", [author.email, "missing"], {}],
    ["vcs revoke-key", [], {}], ["vcs revoke-key", [fingerprint], { effectiveAt: "bad" }],
  ] as const) assert.equal((await run(command, [...args], options)).handled, false);
  const leaks = [Buffer.from(privatePem), privateDer, Buffer.from(privateDer.toString("base64")),
    ...privatePem.split("\n").filter(line => line.length > 0 && !line.startsWith("-----")).map(line => Buffer.from(line))];
  /** Inspect every file the feature wrote plus decompressed history, exports and all returned output. */
  const scan = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) scan(next);
      else if (next !== keyPath) for (const secret of leaks) assert.equal(readFileSync(next).includes(secret), false, "private material leaked to a written file");
    }
  };
  scan(dir.root);
  const allBytes = [exportBundle(repository.objects, repository.refs, []), ...outputs.map(output => Buffer.from(output)),
    ...repository.objects.inventory().map(entry => entry.object.payload)];
  for (const bytes of allBytes) for (const secret of leaks) assert.equal(bytes.includes(secret), false, "private material leaked to history or output");
});

test("private key files inside a tree, including symlinks, wrong algorithms and invalid data are refused with fixed errors", () => {
  const { repository, dir, keys } = fixture();
  const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const outside = join(dir.root, "external"); writeFileSync(outside, pem);
  assert.equal(readSigningKey(outside, repository.root).asymmetricKeyType, "ed25519");
  const inside = join(repository.root, "private-key"); writeFileSync(inside, pem);
  const linked = join(dir.root, "linked"); symlinkSync(inside, linked);
  const wrong = join(dir.root, "rsa"); writeFileSync(wrong, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const bad = join(dir.root, "bad"); writeFileSync(bad, "bad");
  for (const path of [inside, linked, repository.root, wrong, bad, join(dir.root, "absent")]) {
    assert.throws(() => readSigningKey(path, repository.root), { code: "invalid_signing_key", message: "Signing requires an external Ed25519 private key file." });
  }
});

test("actual rebase retains attestations for the same snapshot and invalidates changed snapshots", () => {
  for (const addContent of [false, true]) {
    const { repository, commit, keys, policy, original } = fixture();
    const signed = repository.sign("HEAD", keys.privateKey, new Date())!;
    let tree = commit.tree;
    if (addContent) {
      const blob = repository.objects.write("blob", Buffer.from("additional snapshot content"));
      tree = writeTree(repository.objects, [{ mode: "100644", name: "additional", id: blob }]);
    }
    const onto = writeCommit(repository.objects, { ...commit, tree, message: "other base" });
    repository.refs.compareAndSwap("refs/heads/onto", null, onto);
    const rewritten = repository.rebase(signed, onto, { ...author, timestamp: 2 }, new Date())!;
    const after = readCommit(repository.objects, rewritten);
    assert.equal(effectiveChangeId(rewritten, after), original);
    assert.equal(verifyChangeSignature(rewritten, after, policy, 0).status, addContent ? "unsigned" : "valid");
  }
});

test("linked instances administer shared trust and reject private keys stored inside their hub", async () => {
  const { repository, dir, keys } = fixture();
  const linked = repository.linkInstance("worker", join(dir.root, "worker"));
  const externalKey = join(dir.root, "external.pem");
  const internalKey = join(repository.root, "internal.pem");
  const publicPath = join(dir.root, "public.pem");
  writeFileSync(externalKey, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(internalKey, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  const run = (command: string, args: string[] = [], options: Record<string, unknown> = {}) => harness.runCommand({ command, args, options, pmRoot: linked.path });
  assert.equal((await run("vcs sign", [], { key: internalKey })).handled, false);
  assert.equal((await run("vcs sign", [], { key: externalKey })).handled, true);
  const trusted = await run("vcs trust-key", [author.email, publicPath]);
  assert.equal(trusted.handled, true);
  assert.equal(readTrustedKeys(repository.controlDirectory)!.keys.length, 1);
  assert.equal((await run("vcs verify", [], { signatures: true })).handled, true);
  assert.equal((await run("vcs revoke-key", [keyFingerprint(publicKeyText(keys.publicKey))])).handled, true);
  assert.match((await run("vcs verify", [], { signatures: true })).errorMessage!, /revoked/);
});

test("a scheduled revocation taking effect during other receiver preflights still refuses publication", async () => {
  const { repository, dir, keys, id } = fixture();
  const receiver = Repository.init(join(dir.root, "receiver")); const fingerprint = trust(receiver, keys.publicKey);
  const effectiveAt = 100;
  updateTrustedKeys(receiver.objects, receiver.controlDirectory, { keyId: fingerprint, effectiveAt });
  repository.refs.compareAndSwap("refs/heads/main", repository.refs.resolveHead(), id);
  const original = PublicationLeases.prototype.assertPublication;
  const clock = Date.now;
  let receiverNow = 0;
  Date.now = () => receiverNow;
  // Run real lease checks, then advance only the receiver clock across the
  // scheduled effective time. Crypto, trust, stores, refs and transport stay real.
  PublicationLeases.prototype.assertPublication = function (...args: Parameters<typeof original>): void {
    original.apply(this, args);
    receiverNow = effectiveAt;
  };
  /** Restore these synchronous test-local preflight controls after the transport settles. */
  const restore = (): void => { PublicationLeases.prototype.assertPublication = original; Date.now = clock; };
  try {
    const wire = new FileTransport("receiver", receiver.root);
    await assert.rejects(wire.push(exportBundle(repository.objects, repository.refs, []), [{ ref: "refs/heads/main", expected: null, next: id }], false, new Date()), { reason: "revoked" });
    assert.equal(receiver.refs.resolveHead(), null);
  } finally { restore(); }
});
