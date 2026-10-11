/** Explicit test-consumer lease acquisition against real receiver transports. */
import { parseBundle, exportBundle } from "../../engine/bundle.ts";
import { decodeCommit, decodeTree } from "../../engine/model.ts";
import { HttpTransport, type HttpTransportOptions } from "../../engine/http-transport.ts";
import { FileTransport, openTransport, type Transport, type PushUpdate, type TransferObject } from "../../engine/transport.ts";
import { pushTo } from "../../engine/sync.ts";
import { changeRemoteLease } from "../../engine/lease-workflows.ts";
import { type LeaseProof, type FileLease } from "../../engine/publication-leases.ts";
import type { Repository } from "../../engine/repo.ts";

/** Acquire appropriate receiver generations for every attributed tree in an actual bundle or held publication. */
export async function acquirePublicationLeases(wire: Transport, updates: readonly PushUpdate[], bundle?: Buffer): Promise<LeaseProof[]> {
  if (wire.lease === undefined || updates.length === 0) return [];
  const ids = new Set<string>();
  /** Read identity metadata without treating path or content addresses as authority. */
  const collect = (type: string, payload: Buffer): void => {
    if (type === "tree") for (const entry of decodeTree(payload)) if (entry.fileId !== undefined && entry.mode !== "40000") ids.add(entry.fileId);
  };
  if (bundle !== undefined) {
    try { for (const object of parseBundle(bundle).lines) collect(object.type, object.payload); } catch { return []; }
  }
  if (wire.fetchObjects !== undefined) {
    const pending = updates.flatMap(update => [update.next, ...(update.expected === null ? [] : [update.expected])]);
    const seen = new Set<string>();
    try {
      while (pending.length > 0) {
        const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
        for (const object of parseBundle(await wire.fetchObjects([id])).lines) {
          collect(object.type, object.payload);
          if (object.type === "commit") { const commit = decodeCommit(object.payload); pending.push(commit.tree, ...commit.parents); }
          if (object.type === "tree") for (const entry of decodeTree(object.payload)) if (entry.mode === "40000") pending.push(entry.id);
        }
      }
    } catch { /* Invalid or not-yet-uploaded closure remains the production receiver's refusal to make. */ }
  }
  const refs = [...new Set(updates.map(update => update.ref))];
  const proofs: LeaseProof[] = [];
  for (const fileId of ids) proofs.push(await leaseForPublication(wire, fileId, refs));
  return proofs;
}

/** Explicitly acquire a fixture generation, sharing a concurrently acquired same-principal generation. */
async function leaseForPublication(wire: Transport, fileId: string, refs: readonly string[]): Promise<FileLease> {
  const held = await wire.lease!({ action: "inspect", fileId });
  if (held?.active === true && held.expiry > Date.now()) {
    if (refs.every(ref => held.refs.includes(ref))) return held;
    await wire.lease!({ action: "release", fileId, token: held.token });
  }
  try { return (await wire.lease!({ action: "acquire", fileId, refs, ttlMs: 86_400_000 }))!; } catch (error) {
    if ((error as { code?: string }).code !== "lease_held") throw error;
    return (await wire.lease!({ action: "inspect", fileId }))!;
  }
}

/** Filesystem test consumer explicitly acquires leases before exercising ordinary transport publication. */
export class LeasedFileTransport extends FileTransport {
  /** Obtain fencing proofs before a real bundle push. */
  async push(bundle: Buffer, updates: readonly PushUpdate[], force: boolean, now: Date, proofs?: readonly LeaseProof[]) {
    return super.push(bundle, updates, force, now, proofs ?? await acquirePublicationLeases(this, updates, bundle));
  }
  /** Obtain fencing proofs before publishing previously uploaded objects. */
  async publish(updates: readonly PushUpdate[], force: boolean, now: Date, proofs?: readonly LeaseProof[]) {
    return super.publish(updates, force, now, proofs ?? await acquirePublicationLeases(this, updates));
  }
}

/** HTTP test consumer explicitly uses the authenticated receiver lease endpoint. */
export class LeasedHttpTransport extends HttpTransport {
  /** Preserve normal HTTP options and credential resolution. */
  constructor(url: string, options: HttpTransportOptions = {}) { super(url, options); }
  /** Obtain fencing proofs before a real wire push. */
  async push(bundle: Buffer, updates: readonly PushUpdate[], force: boolean, now: Date, proofs?: readonly LeaseProof[]) {
    return super.push(bundle, updates, force, now, proofs ?? await acquirePublicationLeases(this, updates, bundle));
  }
  /** Obtain fencing proofs before a real resumable publication. */
  async publish(updates: readonly PushUpdate[], force: boolean, now: Date, proofs?: readonly LeaseProof[]) {
    return super.publish(updates, force, now, proofs ?? await acquirePublicationLeases(this, updates));
  }
}

/** Existing sync tests explicitly prepare receiver leases while preserving the real sync implementation. */
export async function leasedPushTo(repository: Repository, remote: string, branches: readonly string[], force: boolean, now: Date, supplied?: Transport) {
  const configured = repository.remotes.require(remote);
  const wire = supplied ?? openTransport(configured.url, repository.root, /^https?:/i.test(configured.url) ? repository.remotes.token(remote) : null);
  let proofs: LeaseProof[] = [];
  if (wire.lease !== undefined) {
    const refs = branches.length > 0 ? branches.map(branch => `refs/heads/${branch}`) : repository.refs.readHead().kind === "branch" ? [repository.refs.readHead().kind === "branch" ? (repository.refs.readHead() as { ref: string }).ref : ""] : [];
    if (refs.some(ref => repository.refs.read(ref) === null)) return pushTo(repository, remote, branches, force, now, wire, proofs);
    const advertised = await wire.advertise();
    const updates = refs.flatMap(ref => { const next = repository.refs.read(ref); return next === null ? [] : [{ ref, expected: advertised.refs.find(entry => entry.name === ref)?.target ?? null, next }]; });
    proofs = await acquirePublicationLeases(wire, updates, exportBundle(repository.objects, repository.refs, refs));
  }
  return pushTo(repository, remote, branches, force, now, wire, proofs);
}

/** Save explicit receiver proofs for tests invoking the real extension or installed CLI. */
export async function grantRemoteLeases(repository: Repository, remote = "origin"): Promise<void> {
  const configured = repository.remotes.require(remote);
  const wire = openTransport(configured.url, repository.root, /^https?:/i.test(configured.url) ? repository.remotes.token(remote) : null);
  const refs = repository.refs.list("refs/heads/");
  const advertised = await wire.advertise();
  const proofs = await acquirePublicationLeases(wire, refs.map(entry => ({ ref: entry.name, expected: advertised.refs.find(held => held.name === entry.name)?.target ?? null, next: entry.target })), exportBundle(repository.objects, repository.refs, refs.map(entry => entry.name)));
  for (const proof of proofs) await changeRemoteLease(repository, remote, { action: "renew", fileId: proof.fileId, token: proof.token, ttlMs: 86_400_000 });
}
