import { writePrivateJson } from "./composition.ts";
/** Explicit remote lease workflows and instance-private fencing proof storage. */
import { join } from "node:path";
import { readControlJson, ObjectStoreError } from "./objects.ts";
import { parseLeaseProofs, type LeaseProof, type LeaseRequest, type FileLease } from "./publication-leases.ts";
import type { Repository } from "./repo.ts";
import { openTransport } from "./transport.ts";

/** Read private saved proofs; corrupt control metadata fails closed. */
function proofRegistry(repository: Repository): Record<string, unknown> {
  const value: unknown = readControlJson(join(repository.controlDirectory, "lease-proofs.json"), "corrupt_lease_proofs", "lease proofs", {});
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ObjectStoreError("corrupt_lease_proofs", "Invalid lease proof registry.");
  return Object.assign(Object.create(null) as Record<string, unknown>, value);
}

/** Read the proofs explicitly acquired for one configured remote. */
export function remoteLeaseProofs(repository: Repository, remote: string): readonly LeaseProof[] {
  const registry = proofRegistry(repository);
  return parseLeaseProofs(Object.hasOwn(registry, remote) ? registry[remote] : undefined);
}

/** Perform an authenticated remote operation, persisting only the resulting fencing proof locally. */
export async function changeRemoteLease(repository: Repository, remote: string, request: LeaseRequest): Promise<FileLease | null> {
  const configured = repository.remotes.require(remote);
  const wire = openTransport(configured.url, repository.root, /^https?:/i.test(configured.url) ? repository.remotes.token(remote) : null);
  const existing = remoteLeaseProofs(repository, remote);
  const result = await wire.lease({ ...request, token: request.token ?? existing.find(/** Renewal and release use the explicitly acquired generation. */ (proof) => proof.fileId === request.fileId)?.token });
  if (request.action === "inspect") return result;
  repository.objects.withWriteLock(/** Preserve proofs acquired concurrently for other stable identities. */ () => {
    const registry = proofRegistry(repository);
    const proofs = parseLeaseProofs(Object.hasOwn(registry, remote) ? registry[remote] : undefined).filter(/** Retire the preceding generation's local capability. */ (proof) => proof.fileId !== request.fileId);
    if (result?.active === true) proofs.push({ fileId: result.fileId, token: result.token });
    Object.defineProperty(registry, remote, { value: proofs, enumerable: true, writable: true, configurable: true });
    writePrivateJson(join(repository.controlDirectory, "lease-proofs.json"), registry);
  });
  return result;
}
