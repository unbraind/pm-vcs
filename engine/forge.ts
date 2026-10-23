import { assertCheckpointPublication } from "./checkpoints.ts";
import { assertTrustedChanges } from "./signature-policy.ts";
/** Native forge catalogs and review history, rooted in ordinary refs and objects. */
import { exportBundle, importBundleObjects } from "./bundle.ts";
import { requireClosure } from "./closure.ts";
import { canonicalRecordValue, decodeRecord, encodeRecord, readCommit, readSeries, readTree, writeCommit, writeTree, type RecordDocument } from "./model.ts";
import { isAncestor } from "./merge.ts";
import { isObjectId, ObjectStoreError } from "./objects.ts";
import { parseLeaseProofs, PublicationLeases, type ReceiverPrincipal } from "./publication-leases.ts";
import { mergeRecords } from "./records.ts";
import { assertRefName } from "./refs.ts";
import type { Repository } from "./repo.ts";
import { createReviewRecord, REVIEW_FIELDS, REVIEW_MERGE_POLICY, REVIEW_STATUSES } from "./review.ts";
import { exportSeriesBundle } from "./series.ts";

/** Read requests share the receiver's read grant and small body bound. */
export const FORGE_READ_ENDPOINT = "forge/read";
/** Publication requests require the receiver's write grant. */
export const FORGE_WRITE_ENDPOINT = "forge/write";

/** Validated operation vocabulary; publication also updates an existing named series or review. */
export interface ForgeRequest {
  readonly action: "list" | "fetch" | "publish";
  readonly kind: "series" | "review";
  readonly name?: string;
  readonly expected?: string | null;
  readonly series?: string;
  readonly branch?: string;
  readonly bundle?: string;
  readonly fields?: RecordDocument;
  readonly proofs?: ReturnType<typeof parseLeaseProofs>;
}

/** Refuse unknown actions and unsafe names before accessing catalog state. */
export function parseForgeRequest(value: Record<string, unknown>): ForgeRequest {
  if (!["list", "fetch", "publish"].includes(String(value.action)) || !["series", "review"].includes(String(value.kind))) {
    throw new ObjectStoreError("bad_request", "Unknown forge operation.");
  }
  const action = value.action as ForgeRequest["action"];
  const kind = value.kind as ForgeRequest["kind"];
  if (action === "list") return { action, kind };
  if (typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.name)) {
    throw new ObjectStoreError("bad_request", "A forge name must be one safe catalog segment.");
  }
  const name = value.name;
  if (action === "fetch") return { action, kind, name };
  if (value.expected !== null && (typeof value.expected !== "string" || !isObjectId(value.expected))) {
    throw new ObjectStoreError("bad_request", "Publication requires an explicit expected revision or null.");
  }
  const expected = value.expected as string | null;
  if (kind === "series") {
    if (typeof value.series !== "string" || !isObjectId(value.series) || typeof value.branch !== "string"
      || !value.branch.startsWith("refs/heads/") || (value.bundle !== undefined && typeof value.bundle !== "string")) {
      throw new ObjectStoreError("bad_request", "Series publication needs a series id and branch scope.");
    }
    assertRefName(value.branch);
    return { action, kind, name, expected, series: value.series, branch: value.branch,
      bundle: value.bundle as string | undefined, proofs: parseLeaseProofs(value.proofs) };
  }
  const fields = decodeRecord(Buffer.from(JSON.stringify(value.fields ?? null)));
  if (Object.keys(fields).some(field => !REVIEW_FIELDS.includes(field as typeof REVIEW_FIELDS[number]) || field === "series")
    || (fields.status !== undefined && !REVIEW_STATUSES.includes(fields.status as typeof REVIEW_STATUSES[number]))) {
    throw new ObjectStoreError("bad_request", "Review updates may change only review fields and a valid status; series is receiver-owned.");
  }
  return { action, kind, name, expected, fields };
}

/** Resolve one validated catalog name into its immutable object root. */
function catalogRef(kind: ForgeRequest["kind"], name: string): string {
  return `refs/forge-${kind}/${name}`;
}

/** Read a native review's document and recorded resolution from its history commit. */
export function readForgeReview(repository: Repository, revision: string): { document: RecordDocument; outcome: RecordDocument } {
  const entries = readTree(repository.objects, readCommit(repository.objects, revision).tree);
  /** Refuse malformed review commits instead of interpreting arbitrary record trees. */
  const record = (name: string): RecordDocument => {
    const entry = entries.find(item => item.name === name && item.mode === "100644");
    if (entry === undefined) throw new ObjectStoreError("invalid_review", "Review history is missing a required record.");
    return decodeRecord(repository.objects.readTyped(entry.id, "record"));
  };
  return { document: record("review.json"), outcome: record("outcome.json") };
}

/** Store the review and outcome as native records with reachable append-only commit history. */
function writeReview(repository: Repository, document: RecordDocument, outcome: RecordDocument, parent: string | null, principal: ReceiverPrincipal): string {
  const store = repository.objects;
  const tree = writeTree(store, [
    { name: "review.json", mode: "100644", id: store.write("record", encodeRecord(document)) },
    { name: "outcome.json", mode: "100644", id: store.write("record", encodeRecord(outcome)) },
  ]);
  const author = { name: principal.principal.replace(/[<>]/g, "_"), email: "review@example.invalid", timestamp: Date.now(), timezoneOffsetMinutes: 0 };
  return writeCommit(store, { tree, parents: parent === null ? [] : [parent], author, committer: author, message: "Forge review update\n" });
}

/** Merge stale reviewer patches per field; scalar disagreements choose canonical minimum and retain both values. */
export function mergeServedReview(base: RecordDocument, current: RecordDocument, proposed: RecordDocument): { document: RecordDocument; outcome: RecordDocument } {
  // Stable side ordering also makes sequence additions independent of HTTP arrival order.
  const ordered = Buffer.compare(encodeRecord(current), encodeRecord(proposed)) <= 0 ? [current, proposed] : [proposed, current];
  const merged = mergeRecords(base, ordered[0]!, ordered[1]!, REVIEW_MERGE_POLICY);
  const document = { ...merged.document };
  const resolutions = merged.conflicts.map(/** Persist the disagreement as data, alongside the chosen deterministic value. */ conflict => {
    const values = [conflict.ours!, conflict.theirs!].sort((left, right) => Buffer.compare(Buffer.from(canonicalRecordValue(left)), Buffer.from(canonicalRecordValue(right))));
    document[conflict.field] = values[0]!;
    return { field: conflict.field, base: conflict.base ?? null, values, chosen: values[0]!, rule: "canonical-min" };
  });
  return { document, outcome: { clean: merged.clean, resolutions, changedFields: [...merged.changedFields] } };
}

/** Publish complete series closure only under receiver-owned FileId leases and atomic catalog CAS. */
function publishSeries(repository: Repository, request: ForgeRequest, principal: ReceiverPrincipal): RecordDocument {
  const store = repository.objects;
  const ref = catalogRef("series", request.name!);
  const reviewRef = catalogRef("review", request.name!);
  const previous = repository.refs.read(ref);
  if (previous !== request.expected) throw new ObjectStoreError("publication_race", "The series catalog changed; fetch and retry.");
  if (request.bundle !== undefined) importBundleObjects(store, Buffer.from(request.bundle, "base64"));
  const series = readSeries(store, request.series!);
  if (series.patches.length === 0) throw new ObjectStoreError("empty_series", "Cannot publish an empty series.");
  const tip = series.patches.at(-1)!.commit;
  const roots = [series.base, ...series.patches.map(patch => patch.commit)];
  const oldSeries = previous === null ? null : readSeries(store, previous);
  const oldTip = oldSeries === null ? null : oldSeries.patches.at(-1)!.commit;
  const metadata = requireClosure(store, [...roots, ...(oldTip === null ? [] : [oldTip])], [], undefined, [], null);
  const leases = new PublicationLeases(store, repository.instanceLink?.controlDirectory ?? repository.controlDirectory, principal);
  const leaseUpdates = roots.map(next => ({ ref: request.branch!, expected: oldTip, next }));
  // Refuse before writing review objects; the check inside the ref transaction below stays authoritative.
  assertCheckpointPublication(store, repository.instanceLink?.controlDirectory ?? repository.controlDirectory, metadata.commits, [tip]);
  leases.assertPublication(leaseUpdates, request.proofs!, metadata);
  const oldReview = repository.refs.read(reviewRef);
  const review = writeReview(repository, createReviewRecord(request.series!, "pending"), { action: "propose", principal: principal.principal, series: request.series! }, oldReview, principal);
  // Review history refers to earlier proposal identities; immutable archive refs retain their complete closure.
  const archive = `refs/forge-archive/${request.series!}`;
  const updates = [{ name: ref, expected: previous, next: request.series! }, { name: reviewRef, expected: oldReview, next: review },
    { name: archive, expected: repository.refs.read(archive), next: request.series! }];
  repository.refs.transaction(updates,
    /** Check every patch root, including side histories, at the catalog publication point. */ () => {
      const recheckRevocations = assertTrustedChanges(repository.instanceLink?.controlDirectory ?? repository.controlDirectory, metadata.commits, roots);
      assertCheckpointPublication(store, repository.instanceLink?.controlDirectory ?? repository.controlDirectory, metadata.commits, [tip]);
      leases.assertPublication(leaseUpdates, request.proofs!, metadata);
      recheckRevocations();
    });
  repository.operations.append("forge-series", "Published native proposal and pending review.", updates.map(update => ({ ref: update.name, before: update.expected, after: update.next })), new Date());
  return { id: request.series!, revision: review };
}

/** Apply a review patch only against an ancestor of this proposal's native review history. */
function publishReview(repository: Repository, request: ForgeRequest, principal: ReceiverPrincipal): RecordDocument {
  const ref = catalogRef("review", request.name!);
  const current = repository.refs.read(ref);
  if (current === null) throw new ObjectStoreError("missing_review", "The review is not available.");
  if (request.expected === null || !isAncestor(repository.objects, request.expected!, current)) {
    throw new ObjectStoreError("invalid_review_base", "Review updates require a revision from this review's history.");
  }
  const state = readForgeReview(repository, current);
  const base = readForgeReview(repository, request.expected!).document;
  if (base.series !== state.document.series) throw new ObjectStoreError("stale_review_series", "The proposal changed; fetch its current review before updating.");
  const merged = mergeServedReview(base, state.document, { ...base, ...request.fields! });
  const outcome = { ...merged.outcome, principal: principal.principal, base: request.expected!, previous: current };
  const revision = writeReview(repository, merged.document, outcome, current, principal);
  repository.refs.compareAndSwap(ref, current, revision);
  repository.operations.append("forge-review", "Merged review fields and recorded the outcome.", [{ ref, before: current, after: revision }], new Date());
  return { revision, document: merged.document, outcome };
}

/** Execute a validated forge operation under the same store lease as refs, uploads and erasure. */
export function serveForge(repository: Repository, input: ForgeRequest, principal: ReceiverPrincipal): RecordDocument {
  const request = parseForgeRequest({ ...input });
  return repository.objects.withWriteLock(/** Hold catalog observations, closure validation and native publication together. */ () => {
    if (request.action === "list") return { entries: repository.refs.list(`refs/forge-${request.kind}/`).map(entry => ({ name: entry.name.split("/").at(-1)!, id: entry.target })) };
    if (request.action === "publish") return request.kind === "series" ? publishSeries(repository, request, principal) : publishReview(repository, request, principal);
    const id = repository.refs.read(catalogRef(request.kind, request.name!));
    if (id === null) throw new ObjectStoreError(`missing_${request.kind}`, `The ${request.kind} is not available.`);
    if (request.kind === "review") return { revision: id, ...readForgeReview(repository, id), bundle: exportBundle(repository.objects, repository.refs, [catalogRef("review", request.name!)]).toString("base64") };
    return { id, bundle: exportSeriesBundle(repository.objects, id).toString("base64") };
  });
}
