/** Ed25519 attestations of stable change identity and explicitly versioned content. */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { effectiveChangeId, encodeRecord, compareByteOrder, type Commit } from "./model.ts";
import { ObjectStoreError, type ObjectId } from "./objects.ts";

/** Per-change verification verdict; malformed evidence is distinct from a failed signature. */
export type SignatureStatus = "valid" | "unsigned" | "untrusted" | "revoked" | "malformed" | "tampered";
/** Verification output never contains key material or unvalidated evidence text. */
export interface ChangeSignatureResult {
  readonly commitId: ObjectId;
  readonly changeId: ObjectId;
  readonly status: SignatureStatus;
  readonly keyId?: string;
}
/** Validated receiver policy, with keys identified by their actual SPKI fingerprint. */
export interface TrustedKeys {
  readonly version: 1;
  readonly keys: readonly { readonly identity: string; readonly publicKey: string }[];
  readonly revocations: readonly { readonly keyId: string; readonly effectiveAt: number }[];
}
/** Atomic publication refusal identifying the exact change and verification reason. */
export class ChangeSignatureError extends ObjectStoreError {
  readonly changeId: ObjectId;
  readonly commitId: ObjectId;
  readonly reason: Exclude<SignatureStatus, "valid">;
  /** Build a refusal using only validated object identities and fixed status words. */
  constructor(result: ChangeSignatureResult & { status: Exclude<SignatureStatus, "valid"> }) {
    super("change_signature_refused", `Change ${result.changeId} at commit ${result.commitId}: ${result.status} signature; no refs published.`);
    this.changeId = result.changeId;
    this.commitId = result.commitId;
    this.reason = result.status;
  }
}

/** Canonical UTF-8 bytes: domain + NUL + version + NUL + canonical JSON, without a trailing newline. */
export function changeSigningPayload(id: ObjectId, commit: Commit): Buffer {
  return Buffer.concat([Buffer.from("pm-vcs/change-signature\0v1\0", "utf8"), encodeRecord({
    changeId: effectiveChangeId(id, commit), tree: commit.tree,
    author: { name: commit.author.name, email: commit.author.email, timestamp: commit.author.timestamp,
      timezoneOffsetMinutes: commit.author.timezoneOffsetMinutes },
    message: commit.message, items: [...new Set(commit.items ?? [])].sort(compareByteOrder),
  })]);
}

/** Canonical base64 SPKI DER for an Ed25519 public key. */
export function publicKeyText(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64");
}
/** SHA-256 fingerprint of the actual public key bytes; display aliases have no authority. */
export function keyFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}
/** Decode canonical base64 without accepting truncation, ignored garbage or alternate encodings. */
function decodeBase64(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new Error("Invalid base64.");
  return bytes;
}
/** Import a canonical Ed25519 SPKI, rejecting other algorithms and private key encodings. */
export function parsePublicKey(text: string): KeyObject {
  const key = createPublicKey({ key: decodeBase64(text), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || publicKeyText(key) !== text) throw new Error("Invalid public key.");
  return key;
}
/** Load a private signing key only from outside the working tree, sanitizing every failure. */
export function readSigningKey(path: string, root: string): KeyObject {
  try {
    const offset = relative(realpathSync(root), realpathSync(path));
    if (offset === "" || (!(offset === ".." || offset.startsWith(`..${sep}`)) && !isAbsolute(offset))) throw new Error("Internal key.");
    const key = createPrivateKey(readFileSync(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong algorithm.");
    return key;
  } catch {
    throw new ObjectStoreError("invalid_signing_key", "Signing requires an external Ed25519 private key file.");
  }
}
/** Create one canonical attestation; signing is explicit and never writes private key bytes. */
export function signChange(id: ObjectId, commit: Commit, key: KeyObject): string {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new ObjectStoreError("invalid_signing_key", "Signing requires an Ed25519 private key.");
  }
  return Buffer.from(JSON.stringify({ version: 1, publicKey: publicKeyText(createPublicKey(key)),
    signature: sign(null, changeSigningPayload(id, commit), key).toString("base64") })).toString("base64");
}
/** Keep evidence only when a rewrite preserves every signed byte; otherwise invalidate it to unsigned. */
export function retainedAttestation(id: ObjectId, original: Commit, replacement: Commit): { attestation?: string } {
  return original.attestation !== undefined && changeSigningPayload(id, original).equals(changeSigningPayload(id, replacement))
    ? { attestation: original.attestation } : {};
}
/** Verify cryptographic integrity before applying current receiver trust and effective-time revocation. */
export function verifyChangeSignature(id: ObjectId, commit: Commit, policy: TrustedKeys, now: number): ChangeSignatureResult {
  const base = { commitId: id, changeId: effectiveChangeId(id, commit) };
  if (commit.attestation === undefined) return { ...base, status: "unsigned" };
  let key: KeyObject;
  let signature: Buffer;
  let publicKey: string;
  try {
    const raw: unknown = JSON.parse(decodeBase64(commit.attestation).toString("utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid envelope.");
    const fields = raw as Record<string, unknown>;
    if (Object.keys(fields).sort().join(",") !== "publicKey,signature,version" || fields.version !== 1
      || typeof fields.publicKey !== "string" || typeof fields.signature !== "string") throw new Error("Invalid envelope.");
    publicKey = fields.publicKey;
    key = parsePublicKey(publicKey);
    signature = decodeBase64(fields.signature);
    if (signature.length !== 64) throw new Error("Invalid signature length.");
  } catch { return { ...base, status: "malformed" }; }
  const keyId = keyFingerprint(publicKey);
  if (!verify(null, changeSigningPayload(id, commit), key, signature)) return { ...base, keyId, status: "tampered" };
  if (!policy.keys.some(entry => entry.publicKey === publicKey && entry.identity === commit.author.email)) {
    return { ...base, keyId, status: "untrusted" };
  }
  if (policy.revocations.some(entry => entry.keyId === keyId && entry.effectiveAt <= now)) return { ...base, keyId, status: "revoked" };
  return { ...base, keyId, status: "valid" };
}
