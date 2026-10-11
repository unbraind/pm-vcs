/** Receiver-owned stable FileId leases, fenced generations and durable audit. */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ClosureMetadata } from "./closure.ts";
import { syncDirectory } from "./composition.ts";
import { readCommit, readTree, type FileId } from "./model.ts";
import { ObjectStoreError, type ObjectStore } from "./objects.ts";
import { assertRefName } from "./refs.ts";
import type { PushUpdate } from "./transport.ts";

/** Identity and administrative capability established by the receiver, never by request JSON. */
export interface ReceiverPrincipal {
  /** Stable authenticated owner in this repository partition. */
  readonly principal: string;
  /** Explicit operator grant permitting a forced lease break. */
  readonly breakLeases: boolean;
}

/** Fencing proof carried by a publisher independently of the claimed owner. */
export interface LeaseProof {
  readonly fileId: FileId;
  readonly token: string;
}

/** Durable generation state, including terminal released or broken generations. */
export interface FileLease extends LeaseProof {
  readonly holder: string;
  readonly expiry: number;
  readonly generation: number;
  readonly refs: readonly string[];
  readonly active: boolean;
}

/** Explicit lease operation; renewal and release require the current fencing token. */
export interface LeaseRequest {
  readonly action: "acquire" | "renew" | "release" | "break" | "inspect";
  readonly fileId: FileId;
  readonly token?: string;
  readonly refs?: readonly string[];
  readonly ttlMs?: number;
}

/** Four publication refusal reasons, plus an explicit stale-generation refusal. */
export type LeaseRefusal = "missing" | "expired" | "wrong_principal" | "out_of_scope" | "fenced";

/** Typed refusal preserving FileId, holder and authoritative expiry, including explicit absence. */
export class PublicationLeaseError extends ObjectStoreError {
  /** Typed discriminator for each named receiver refusal. */
  declare readonly code: `lease_${LeaseRefusal}`;
  /** Stable identity whose publication was refused. */
  readonly fileId: FileId;
  /** Receiver-recorded holder, explicitly null when absent. */
  readonly holder: string | null;
  /** Authoritative expiry in epoch milliseconds, explicitly null when absent. */
  readonly expiry: number | null;
  /** Named refusal distinct from unrelated storage or CAS failures. */
  readonly reason: LeaseRefusal;

  /** Capture authoritative diagnostic metadata without exposing credentials. */
  constructor(reason: LeaseRefusal, fileId: FileId, lease: Pick<FileLease, "holder" | "expiry"> | null) {
    super(`lease_${reason}`, `Publication refused: ${reason}; FileId=${fileId}; holder=${lease?.holder ?? "absent"}; expiry=${lease?.expiry ?? "absent"}.`);
    this.reason = reason;
    this.fileId = fileId;
    this.holder = lease?.holder ?? null;
    this.expiry = lease?.expiry ?? null;
  }
}

/** Filesystem access identifies the operating-system principal; direct store access is administrative authority. */
export function filesystemPrincipal(): ReceiverPrincipal {
  return { principal: `filesystem:${process.getuid === undefined ? "local" : process.getuid()}`, breakLeases: true };
}

/** Reject an unsafe FileId before constructing a durable audit path. */
function assertFileId(fileId: string): void {
  if (!/^[0-9a-f]{32}$/.test(fileId)) throw new ObjectStoreError("invalid_file_id", "A lease needs a stable 128-bit FileId.");
}

/** Validate a receiver lease response or audit state at an untrusted JSON boundary. */
export function parseFileLease(value: unknown): FileLease | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const lease = value as FileLease;
  if (typeof lease.fileId !== "string" || !/^[0-9a-f]{32}$/.test(lease.fileId) || typeof lease.holder !== "string"
    || typeof lease.active !== "boolean" || !Number.isSafeInteger(lease.expiry) || !Number.isSafeInteger(lease.generation)
    || lease.generation < 1 || typeof lease.token !== "string" || !/^[0-9]+:[0-9a-f]{32}$/.test(lease.token)
    || !lease.token.startsWith(`${lease.generation}:`) || !Array.isArray(lease.refs) || lease.refs.length === 0
    || lease.refs.length > 128 || lease.refs.some(/** Ref scopes must be usable names. */ (ref) => typeof ref !== "string")) return null;
  try { for (const ref of lease.refs) assertRefName(ref); } catch { return null; }
  return lease;
}

/** Decode an explicit request while excluding sender-supplied principal and expiry authority. */
export function parseLeaseRequest(value: Record<string, unknown>): LeaseRequest {
  if (!["acquire", "renew", "release", "break", "inspect"].includes(String(value.action))
    || typeof value.fileId !== "string" || (value.token !== undefined && typeof value.token !== "string")
    || (value.ttlMs !== undefined && typeof value.ttlMs !== "number")
    || (value.refs !== undefined && (!Array.isArray(value.refs) || value.refs.some(/** Reject malformed wire scope entries. */ (ref) => typeof ref !== "string")))) {
    throw new ObjectStoreError("bad_request", "Invalid lease request.");
  }
  return { action: value.action as LeaseRequest["action"], fileId: value.fileId,
    token: value.token as string | undefined, ttlMs: value.ttlMs as number | undefined, refs: value.refs as string[] | undefined };
}

/** Decode a bounded list of fencing proofs; absence is an explicit empty list. */
export function parseLeaseProofs(value: unknown): readonly LeaseProof[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100_000) throw new ObjectStoreError("bad_request", "Invalid lease proofs.");
  const result: LeaseProof[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || typeof entry.fileId !== "string" || typeof entry.token !== "string") {
      throw new ObjectStoreError("bad_request", "Invalid lease proof.");
    }
    assertFileId(entry.fileId);
    result.push({ fileId: entry.fileId, token: entry.token });
  }
  return result;
}

/** Receiver authority serializes lease changes with object writes and atomic ref publication. */
export class PublicationLeases {
  private readonly store: ObjectStore;
  private readonly principal: ReceiverPrincipal;
  private readonly directory: string;

  /** Bind the immutable store's shared control directory and receiver-authenticated principal. */
  constructor(store: ObjectStore, controlDirectory: string, principal: ReceiverPrincipal = filesystemPrincipal()) {
    this.store = store;
    this.principal = principal;
    this.directory = join(controlDirectory, "leases");
  }

  /** Read the authoritative append-only audit, refusing truncation or invalid generations. */
  inspect(fileId: FileId): FileLease | null {
    assertFileId(fileId);
    let text: string;
    try { text = readFileSync(join(this.directory, `${fileId}.jsonl`), "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let last: FileLease | null = null;
    try {
      if (!text.endsWith("\n")) throw new Error("Truncated audit.");
      for (const line of text.trimEnd().split("\n")) {
        const record = JSON.parse(line) as { lease: FileLease; actor: string; action: string; at: number };
        const lease = record.lease;
        if (parseFileLease(lease) === null || lease.fileId !== fileId
          || typeof record.actor !== "string" || !Number.isSafeInteger(record.at)
          || !["acquire", "renew", "release", "break"].includes(record.action)
          || (last !== null && (lease.generation < last.generation || lease.generation > last.generation + 1))) throw new Error("Invalid audit.");
        last = lease;
      }
    } catch { throw new ObjectStoreError("corrupt_lease_audit", "Lease audit is invalid; no generation may be revived."); }
    return last;
  }

  /** Persist an event before reporting success; the audit itself is the sole generation authority. */
  private record(action: string, lease: FileLease, at: number): FileLease {
    mkdirSync(this.directory, { recursive: true });
    const fd = openSync(join(this.directory, `${lease.fileId}.jsonl`), "a", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ action, actor: this.principal.principal, at, lease }) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(this.directory, false);
    return lease;
  }

  /** Acquire, renew, release, break or inspect using the receiver clock and explicit authority. */
  change(request: LeaseRequest): FileLease | null {
    const valid = parseLeaseRequest({ ...request });
    return this.store.withWriteLock(/** Lease generations and publications use exactly the same interprocess lock. */ () => {
      const current = this.inspect(valid.fileId);
      if (valid.action === "inspect") return current;
      const now = Date.now();
      if (valid.action === "acquire") {
        if (current?.active === true && current.expiry > now) throw new ObjectStoreError("lease_held", "An active generation already holds this FileId; renew it or obtain explicit break authority.");
        const refs = valid.refs;
        if (refs === undefined || refs.length === 0 || refs.length > 128) throw new ObjectStoreError("invalid_lease_scope", "Acquisition needs one to 128 explicit ref scopes.");
        for (const ref of refs) assertRefName(ref);
        const generation = (current?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) throw new ObjectStoreError("lease_generation_exhausted", "Lease generations cannot wrap.");
        return this.record("acquire", { fileId: valid.fileId, holder: this.principal.principal, expiry: now + this.duration(valid),
          token: `${generation}:${randomBytes(16).toString("hex")}`, generation, refs: [...new Set(refs)].sort(), active: true }, now);
      }
      if (current === null || !current.active) throw new PublicationLeaseError("missing", valid.fileId, current);
      if (valid.action === "break") {
        if (!this.principal.breakLeases) throw new ObjectStoreError("lease_break_forbidden", "The receiver has not granted this principal lease break authority.");
        return this.record("break", { ...current, active: false }, now);
      }
      this.validate(current, valid.fileId, valid.token, undefined, now);
      return this.record(valid.action, valid.action === "renew"
        ? { ...current, expiry: now + this.duration(valid) } : { ...current, active: false }, now);
    });
  }

  /** Require a bounded positive lifetime; callers never supply an authoritative expiry. */
  private duration(request: LeaseRequest): number {
    const ttl = request.ttlMs;
    if (ttl === undefined || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86_400_000) {
      throw new ObjectStoreError("invalid_lease_duration", "Lease lifetime must be between one millisecond and one day.");
    }
    return ttl;
  }

  /** Refuse expired ownership, scope violations and stale fences in deterministic order. */
  private validate(lease: FileLease | null, fileId: FileId, token: string | undefined, ref: string | undefined, now: number): void {
    if (lease === null || !lease.active) throw new PublicationLeaseError("missing", fileId, lease);
    if (lease.expiry <= now) throw new PublicationLeaseError("expired", fileId, lease);
    if (lease.holder !== this.principal.principal) throw new PublicationLeaseError("wrong_principal", fileId, lease);
    if (ref !== undefined && !lease.refs.includes(ref)) throw new PublicationLeaseError("out_of_scope", fileId, lease);
    if (token === undefined) throw new PublicationLeaseError("missing", fileId, lease);
    if (token !== lease.token) throw new PublicationLeaseError("fenced", fileId, lease);
  }

  /** Validate every FileId in old and newly introduced history immediately before the receiver ref CAS writes; reuse receiver closure metadata only under its uninterrupted store write lease. */
  assertPublication(updates: readonly PushUpdate[], proofs: readonly LeaseProof[], metadata: ClosureMetadata): void {
    const fences = new Map(proofs.map(/** A publisher must carry the current generation proof for each stable identity. */ (proof) => [proof.fileId, proof.token]));
    const checks: { fileId: FileId; ref: string; lease: FileLease | null }[] = [];
    for (const update of updates) {
      const seen = new Set<string>();
      const pending = [update.next, ...(update.expected === null ? [] : [update.expected])];
      const fileIds = new Set<FileId>();
      /** Walk directory structure without treating paths as lease identities. */
      const walk = (id: string): void => {
        const tree = metadata.trees.get(id) ?? readTree(this.store, id);
        metadata.trees.set(id, tree);
        for (const entry of tree) {
          if (entry.mode === "40000") walk(entry.id);
          else if (entry.fileId !== undefined) fileIds.add(entry.fileId);
        }
      };
      while (pending.length > 0) {
        const id = pending.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const commit = metadata.commits.get(id) ?? readCommit(this.store, id);
        metadata.commits.set(id, commit);
        walk(commit.tree);
        // Historical payloads introduced and deleted before the tip are still published.
        if (id !== update.expected) pending.push(...commit.parents);
      }
      for (const fileId of [...fileIds].sort()) checks.push({ fileId, ref: update.ref, lease: this.inspect(fileId) });
    }
    const now = Date.now();
    for (const check of checks) this.validate(check.lease, check.fileId, fences.get(check.fileId), check.ref, now);
  }
}
