/** Receiver-owned trust policy, serialized with publication by the shared store write lease. */
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, writeConfig } from "./config.ts";
import { writePrivateJson } from "./composition.ts";
import { ObjectStoreError, type ObjectId, type ObjectStore } from "./objects.ts";
import type { Commit } from "./model.ts";
import { ChangeSignatureError, keyFingerprint, parsePublicKey, publicKeyText, verifyChangeSignature, type TrustedKeys } from "./signatures.ts";

/** Fixed control-directory policy name; never resolved from an incoming bundle or remote advertisement. */
export const TRUSTED_KEYS_FILE = "trusted-keys.json";
/** Unconfigured verification trusts nobody; publication stays opt-in for legacy repositories. */
export const EMPTY_TRUST: TrustedKeys = { version: 1, keys: [], revocations: [] };
/** Validate every policy entry before granting trust; errors never echo file contents. */
export function parseTrustedKeys(raw: unknown): TrustedKeys {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid policy.");
    const source = raw as Record<string, unknown>;
    if (source.version !== 1 || !Array.isArray(source.keys) || !Array.isArray(source.revocations)) throw new Error("Invalid policy.");
    const keys = source.keys as TrustedKeys["keys"];
    const revocations = source.revocations as TrustedKeys["revocations"];
    const seen = new Set<string>();
    for (const entry of keys) {
      if (entry === null || typeof entry !== "object" || typeof entry.identity !== "string" || entry.identity.length === 0
        || /[\r\n]/.test(entry.identity) || typeof entry.publicKey !== "string") throw new Error("Invalid key entry.");
      parsePublicKey(entry.publicKey);
      const fingerprint = keyFingerprint(entry.publicKey);
      if (seen.has(fingerprint)) throw new Error("Duplicate key.");
      seen.add(fingerprint);
    }
    for (const entry of revocations) {
      if (entry === null || typeof entry !== "object" || typeof entry.keyId !== "string" || !/^[0-9a-f]{64}$/.test(entry.keyId)
        || !Number.isSafeInteger(entry.effectiveAt) || entry.effectiveAt < 0) throw new Error("Invalid revocation.");
    }
    return { version: 1, keys, revocations };
  } catch { throw new ObjectStoreError("bad_signature_policy", "Trusted-key policy is malformed; publication refused."); }
}
/** Reload configuration and policy on every call, including publication through an already-open server. */
export function readTrustedKeys(control: string): TrustedKeys | null {
  if (readConfig(join(control, "config.json")).trustedKeysFile === undefined) return null;
  try { return parseTrustedKeys(JSON.parse(readFileSync(join(control, TRUSTED_KEYS_FILE), "utf8"))); }
  catch { throw new ObjectStoreError("bad_signature_policy", "Trusted-key policy is unavailable or malformed; publication refused."); }
}
/** Positive receipts cover complete ancestry under one exact receiver policy and clock interval. */
interface VerifiedHistory {
  readonly policy: string;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  readonly commits: Set<ObjectId>;
}
/** Process-local acceleration only: at most 16 receivers and 4,096 complete-history boundaries each. */
const verifiedHistories = new Map<string, VerifiedHistory>();
/** Never infer signature trust from structural validation, uploaded objects or sender-provided metadata. */
function verifiedHistory(control: string, policy: TrustedKeys): VerifiedHistory {
  const encoded = JSON.stringify(policy);
  const now = Date.now();
  let history = verifiedHistories.get(control);
  if (history === undefined || history.policy !== encoded || now < history.verifiedAt || now >= history.expiresAt) {
    history = { policy: encoded, verifiedAt: now, commits: new Set(), expiresAt: policy.revocations.reduce(
      (deadline, entry) => entry.effectiveAt > now ? Math.min(deadline, entry.effectiveAt) : deadline, Infinity) };
    verifiedHistories.delete(control);
    if (verifiedHistories.size >= 16) verifiedHistories.delete(verifiedHistories.keys().next().value!);
    verifiedHistories.set(control, history);
  }
  return history;
}
/**
 * Verify requested ancestry, stopping only at locally signature-verified complete-history boundaries.
 * Metadata must come from an independently hash-validated complete closure under the held store lease;
 * cached signatures never replace object integrity validation. Return a final receiver-clock recheck.
 */
export function assertTrustedChanges(control: string, commits: ReadonlyMap<ObjectId, Commit>, roots: readonly ObjectId[] = [...commits.keys()]): () => void {
  const policy = readTrustedKeys(control);
  if (policy === null) return () => {};
  const history = verifiedHistory(control, policy);
  const pending = [...roots];
  const checked = new Map<ObjectId, ReturnType<typeof verifyChangeSignature>>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (checked.has(id)) continue;
    if (!commits.has(id)) throw new ObjectStoreError("incomplete_bundle", "Signature verification requires complete validated commit metadata.");
    if (history.commits.has(id)) continue;
    const commit = commits.get(id)!;
    const result = verifyChangeSignature(id, commit, policy, -1);
    if (result.status !== "valid") throw new ChangeSignatureError({ ...result, status: result.status });
    checked.set(id, result);
    pending.push(...commit.parents);
  }
  /** Check effective times after crypto, and again after any other expensive publication checks. */
  const recheckRevocations = (): void => {
    const now = Date.now();
    // Even unchanged policy bytes can invalidate all historical receipts when a scheduled revocation begins.
    if (now < history.verifiedAt || now >= history.expiresAt) {
      verifiedHistories.delete(control);
      assertTrustedChanges(control, commits, roots);
      return;
    }
    for (const result of checked.values()) {
      if (policy.revocations.some(entry => entry.keyId === result.keyId && entry.effectiveAt <= now)) {
        throw new ChangeSignatureError({ ...result, status: "revoked" });
      }
    }
  };
  recheckRevocations();
  // Publish no positive receipt until the entire requested closure has passed, including every side parent.
  for (const id of checked.keys()) {
    if (history.commits.size >= 4096) history.commits.delete(history.commits.values().next().value!);
    history.commits.add(id);
  }
  return recheckRevocations;
}
/** Add an immutable fingerprint/identity binding, or append a revocation without deleting earlier effective times. */
export function updateTrustedKeys(store: ObjectStore, control: string,
  update: { publicKey: string; identity: string } | { keyId: string; effectiveAt: number }): string {
  return store.withWriteLock(/** Administrative changes linearize against the same receiver lease as publication. */ () => {
    const current = readTrustedKeys(control) ?? EMPTY_TRUST;
    let next: TrustedKeys;
    let keyId: string;
    if ("publicKey" in update) {
      let publicKey: string;
      try {
        const key = createPublicKey(update.publicKey);
        if (key.asymmetricKeyType !== "ed25519") throw new Error("Wrong algorithm.");
        publicKey = publicKeyText(key);
      } catch { throw new ObjectStoreError("bad_signature_policy", "Trust requires an Ed25519 public key."); }
      keyId = keyFingerprint(publicKey);
      if (current.keys.some(entry => keyFingerprint(entry.publicKey) === keyId)) {
        throw new ObjectStoreError("bad_signature_policy", "This fingerprint already has an identity binding; revoke it rather than replacing it.");
      }
      next = { ...current, keys: [...current.keys, { identity: update.identity, publicKey }] };
    } else {
      keyId = update.keyId;
      if (!current.keys.some(entry => keyFingerprint(entry.publicKey) === keyId)) {
        throw new ObjectStoreError("bad_signature_policy", "This fingerprint is not trusted.");
      }
      next = { ...current, revocations: [...current.revocations, update] };
    }
    parseTrustedKeys(next);
    writePrivateJson(join(control, TRUSTED_KEYS_FILE), next);
    const configPath = join(control, "config.json");
    writeConfig(configPath, { ...readConfig(configPath), trustedKeysFile: TRUSTED_KEYS_FILE });
    return keyId;
  });
}
