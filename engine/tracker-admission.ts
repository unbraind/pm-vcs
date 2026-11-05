/** Optimistic admission of explicit tracker pairs; SDK codecs own all tracker semantics. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type * as Sdk from "@unbrained/pm-cli/sdk";
import type { CommitOptions, Repository } from "./repo.ts";
import { ObjectStoreError, type ObjectId } from "./objects.ts";
import { parseWorkingRecord } from "./record-format.ts";
import { isRecordPath } from "./config.ts";
import { decodeRecord, type RecordDocument } from "./model.ts";

/** Selection and expected native parent, validated before reading tracker state. */
export interface TrackerAdmissionRequest {
  readonly items: readonly string[];
  readonly expectedTip: ObjectId | null;
}
/** One compact retry coordinate; no documents, patches or private source text. */
export interface TrackerRetryWitness {
  readonly id: string;
  readonly reason: "pair_unavailable" | "history_mismatch" | "transaction_unverified" | "outside_workspace" | "record_unrepresentable";
}
/** Bounded admission receipt rendered by the host as TOON or JSON. */
export type TrackerAdmissionResult = {
  readonly ok: true; readonly revision: ObjectId; readonly checked: number; readonly reused: number;
} | {
  readonly ok: false; readonly code: "tracker_capture_retry"; readonly checked: number; readonly reused: number;
  readonly retry: readonly TrackerRetryWitness[]; readonly remedy: string;
};
/** Strict input or publication refusal with a machine-readable remedy. */
export class TrackerAdmissionRefusal extends ObjectStoreError {
  /** Action an agent can take before retrying this refused operation. */
  readonly remedy: string;
  /** Preserve a stable refusal code without including source contents. */
  constructor(code: "invalid_tracker_admission" | "tracker_tip_changed" | "tracker_capture_consumed" | "tracker_capture_busy", remedy: string) {
    super(code, `[${code}] Tracker admission refused. ${remedy}`);
    this.remedy = remedy;
  }
}
/** Parse the single strict boundary schema shared by CLI and SDK consumers. */
export function parseTrackerAdmissionRequest(raw: unknown): TrackerAdmissionRequest {
  const bad = (): never => { throw new TrackerAdmissionRefusal("invalid_tracker_admission", "Supply only items (1..100 unique canonical item IDs, at most 128 ASCII letters, digits, dots, underscores or hyphens) and expectedTip (a native SHA-256 ID or null)."); };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "items") || !Object.hasOwn(row, "expectedTip")) return bad();
  if (!Array.isArray(row.items) || row.items.length < 1 || row.items.length > 100) return bad();
  for (let i = 0; i < row.items.length; i++) {
    if (!Object.hasOwn(row.items, i) || typeof row.items[i] !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(row.items[i])) return bad();
  }
  if (new Set(row.items).size !== row.items.length || (row.expectedTip !== null && (typeof row.expectedTip !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedTip)))) return bad();
  return { items: [...row.items] as string[], expectedTip: row.expectedTip as ObjectId | null };
}
const require = createRequire(import.meta.url);
/** Acquire public SDK capabilities lazily through Node's supported package loader. */
function sdk(): typeof Sdk { return require("@unbrained/pm-cli/sdk") as typeof Sdk; }
interface Pair {
  readonly files: readonly { readonly path: string; readonly content: Buffer; readonly record?: RecordDocument; readonly itemId?: string; readonly itemRoot?: string }[];
  readonly transactions: ReadonlyMap<string, readonly string[]>;
}
/** Test observer for real competing writers at every asynchronous capture boundary. @internal */
export const trackerAdmissionBoundary: { visit: (step: string, id: string) => Promise<void> } = { async visit() {} };
/** Hash only for detecting SDK-resolved settings changes across one attempt, never as a tracker codec. */
function settingsKey(settings: Sdk.PmSettings): string { return createHash("sha256").update(JSON.stringify(settings)).digest("hex"); }
/** Check SDK item-transaction markers against the SDK's retained, committed result membership. */
async function transactionMembership(pmRoot: string, id: string, entries: readonly Sdk.HistoryStreamSnapshot["entries"][number][]): Promise<ReadonlyMap<string, readonly string[]> | null> {
  const markers = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const value of [entry.context?.item_transaction_step, entry.message]) {
      if (typeof value !== "string" || !value.startsWith("bulk-item-transaction ")) continue;
      const match = /^bulk-item-transaction ([A-Za-z0-9._-]+) ([A-Za-z0-9._-]+) (apply|compensate)(?: \| [^\r\n]*)?$/.exec(value);
      if (match === null) return null;
      const steps = markers.get(match[1]) ?? new Set<string>(); steps.add(match[2]); markers.set(match[1], steps);
    }
  }
  const membership = new Map<string, readonly string[]>();
  for (const [transactionId, steps] of markers) {
    const receipt = await sdk().readItemTransaction(pmRoot, transactionId);
    await trackerAdmissionBoundary.visit("transaction", id);
    // Compensated/retired transactions remain readable history but cannot certify admission.
    if (receipt === undefined || receipt.journal.status !== "committed") return null;
    for (const step of steps) {
      const result = Object.hasOwn(receipt.journal.results, step) ? receipt.journal.results[step] : undefined;
      if (!receipt.journal.completedStepIds.includes(step) || result === null || typeof result !== "object" || Array.isArray(result) || result.id !== id) return null;
    }
    const members = new Set<string>([id]);
    const plan = receipt.journal.recoveryData;
    const itemSteps = plan !== null && typeof plan === "object" && !Array.isArray(plan) && plan.kind === "item-mutations-v1"
      ? receipt.journal.stepIds : [];
    for (const [step, result] of Object.entries(receipt.journal.results)) {
      // SDK create/adopted close/release steps need not append history. Only prepared
      // item mutations require markers; arbitrary workspace results do not certify membership.
      if (result === null || typeof result !== "object" || Array.isArray(result) || typeof result.id !== "string"
        || !itemSteps.includes(step) || !["update", "close", "release"].includes(String(result.op)) || !Object.hasOwn(receipt.journal.compensationData, step)) continue;
      if (!receipt.journal.completedStepIds.includes(step) || (result.id === id && !steps.has(step))) return null;
      members.add(result.id);
    }
    membership.set(transactionId, [...members]);
  }
  return membership;
}
/** One resumable capture, retaining immutable verified bytes while retrying only affected records.
 * No frozen mutation plan is replayed: each pending target is resolved and verified afresh through
 * the SDK. A session is local to one process and native parent; CLI invocations start fresh sessions.
 */
export class TrackerCapture {
  private readonly request: TrackerAdmissionRequest;
  private readonly verified = new Map<string, Pair>();
  private consumed = false;
  private running = false;
  private settingsRevision: string | undefined;
  private readonly repository: Repository;
  private readonly pmRoot: string;
  private readonly expectedHead: string;
  /** Bind the capture to a native repository, explicit tracker, and expected target revision. */
  constructor(repository: Repository, pmRoot: string, raw: unknown) {
    this.repository = repository; this.pmRoot = pmRoot;
    this.request = parseTrackerAdmissionRequest(raw);
    const head = repository.refs.readHead();
    this.expectedHead = head.kind === "branch" ? head.ref : "HEAD";
  }
  /** Capture one SDK-resolved pair, returning a safe retry coordinate on unreadable or torn state. */
  private async pair(rawId: string, settings: Sdk.PmSettings): Promise<Pair | TrackerRetryWitness> {
    let reason: TrackerRetryWitness["reason"] = "pair_unavailable";
    try {
      const api = sdk();
      const registry = api.resolveItemTypeRegistry(settings, api.getActiveExtensionRegistrations());
      const located = await api.locateItem(this.pmRoot, rawId, settings.id_prefix, settings.item_format, registry.type_to_folder);
      await trackerAdmissionBoundary.visit("located", rawId);
      if (located === null || located.id !== rawId) return { id: rawId, reason };
      const item = await api.readLocatedItem(located, { schema: settings.schema });
      await trackerAdmissionBoundary.visit("item", rawId);
      const historyPath = api.getHistoryPath(this.pmRoot, located.id);
      const history = await api.readHistorySnapshot(historyPath, located.id);
      await trackerAdmissionBoundary.visit("history", rawId);
      reason = "history_mismatch";
      if (history.raw_bytes === null || history.entries.length === 0 || item.document.metadata.id !== located.id
        || !api.verifyHistoryEntries(history.entries, item.document).ok) return { id: rawId, reason };
      reason = "transaction_unverified";
      const transactions = await transactionMembership(this.pmRoot, located.id, history.entries);
      if (transactions === null) return { id: rawId, reason };
      reason = "outside_workspace";
      const files = [{ path: located.itemPath, content: Buffer.from(item.raw), itemId: located.id }, { path: historyPath, content: Buffer.from(history.raw_bytes) }].map(file => {
        const path = relative(this.repository.root, resolve(file.path)).split(sep).join("/");
        if (path === "" || path === ".." || path.startsWith("../") || path.startsWith("/")) throw new Error("External tracker.");
        return { ...file, path, itemRoot: relative(this.repository.root, resolve(this.pmRoot)).split(sep).join("/") };
      });
      reason = "record_unrepresentable";
      const captured = files.map(file => {
        if (file.itemId === undefined || !isRecordPath(file.path, this.repository.config)) return file;
        // Admission cannot create a record representation that ordinary staging cannot read.
        parseWorkingRecord(file.path, file.content, this.pmRoot);
        return { ...file, record: decodeRecord(Buffer.from(JSON.stringify({ ...item.document.metadata, body: item.document.body }))) };
      });
      return { files: captured, transactions };
    } catch { return { id: rawId, reason }; }
  }
  /** Verify pending records and publish exact captured bytes under the native writer lease.
   * Repeated calls after a retry read only failed records; successful calls consume the session.
   * The caller supplies ordinary commit metadata; no tracker item or history is ever mutated.
   */
  async commit(options: CommitOptions, now: Date): Promise<TrackerAdmissionResult> {
    if (this.consumed) throw new TrackerAdmissionRefusal("tracker_capture_consumed", "Start a new capture with the current expected native tip.");
    if (this.running) throw new TrackerAdmissionRefusal("tracker_capture_busy", "Await this session's active attempt before resuming it, or create an independent capture session.");
    this.running = true;
    try { return await this.commitAttempt(options, now); }
    finally { this.running = false; }
  }
  /** Keep local session state exclusive across asynchronous SDK reads; publication has its own native lease. */
  private async commitAttempt(options: CommitOptions, now: Date): Promise<TrackerAdmissionResult> {
    const settings = await sdk().readSettings(this.pmRoot);
    const revision = settingsKey(settings);
    if (this.settingsRevision !== undefined && this.settingsRevision !== revision) this.verified.clear();
    this.settingsRevision = revision;
    const reused = this.verified.size;
    const pending = this.request.items.filter(id => !this.verified.has(id));
    const retry: TrackerRetryWitness[] = [];
    for (const id of pending) {
      const result = await this.pair(id, settings);
      if ("files" in result) this.verified.set(id, result); else retry.push(result);
    }
    // A selected peer captured before a now-certified transaction must be refreshed too.
    // Consult only retained SDK journal results, never scan or silently add unselected items.
    const affected = new Set<string>();
    for (const pair of this.verified.values()) for (const [transaction, members] of pair.transactions) {
      for (const member of members) if (this.request.items.includes(member) && !this.verified.get(member)?.transactions.has(transaction)) affected.add(member);
    }
    for (const id of affected) {
      this.verified.delete(id);
      if (!retry.some(row => row.id === id)) retry.push({ id, reason: "transaction_unverified" });
    }
    await trackerAdmissionBoundary.visit("captured", "");
    // Schema/config races invalidate this attempt, including its reused certificates.
    if (settingsKey(settings) !== settingsKey(await sdk().readSettings(this.pmRoot))) {
      this.verified.clear();
      return { ok: false, code: "tracker_capture_retry", checked: pending.length, reused, retry: this.request.items.map(id => ({ id, reason: "pair_unavailable" })), remedy: "Tracker settings changed; resume to resolve every selected pair under current SDK settings." };
    }
    if (retry.length > 0) return { ok: false, code: "tracker_capture_retry", checked: pending.length, reused, retry,
      remedy: retry.some(row => row.reason === "outside_workspace") ? "Start a new capture in a native workspace containing the selected tracker, then retry the same selection."
        : retry.some(row => row.reason === "record_unrepresentable") ? "The selected item cannot be encoded as a native record; use blob storage for its path or simplify its structured metadata, then start a new capture."
        : "Wait for tracker writers to settle or restore readable committed transaction receipts, then resume this capture; CLI callers retry the same input." };
    const published = this.repository.commitCaptured(options, this.request.items.flatMap(id => this.verified.get(id)!.files), this.request.expectedTip, now, this.expectedHead);
    this.consumed = true;
    return { ok: true, revision: published, checked: pending.length, reused };
  }
}
