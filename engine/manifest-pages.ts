/** Canonical bounded-fanout fragment metadata; v1 remains the leaf format. */
import type { FileId, FragmentEntry, FragmentManifest, ManifestPage } from "./model.ts";
import { decodeManifest, encodeManifest } from "./model.ts";
import { hashObject, isObjectId, ObjectStoreError, type ObjectId, type ObjectStore } from "./objects.ts";

/** Maximum references resident in one canonical node. */
export const MANIFEST_FANOUT = 128;
/** Version marker for interior manifest nodes. */
export const PAGED_MANIFEST_FORMAT = "pm-vcs-manifest 2";
/** Safe integer lengths impose a fixed bound on hierarchy depth. */
const MAX_HEIGHT = 7;

/** Refuse a malformed or noncanonical page descriptor before address calculation. */
export function encodePagedManifest(manifest: FragmentManifest): Buffer {
  const pages = manifest.pages;
  const height = manifest.height;
  if (pages === undefined || height === undefined || !Number.isSafeInteger(height) || height < 1 || height > MAX_HEIGHT
    || manifest.fragments.length !== 0 || pages.length < 1 || pages.length > MANIFEST_FANOUT
    || !Number.isSafeInteger(manifest.totalLength) || manifest.totalLength < 1
    || (manifest.mode !== undefined && manifest.mode !== "fixed" && manifest.mode !== "cdc")) {
    throw new ObjectStoreError("invalid_manifest", "Invalid bounded manifest node.");
  }
  let total = 0;
  let count = 0;
  const capacity = Math.min(Number.MAX_SAFE_INTEGER, MANIFEST_FANOUT ** height);
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!isObjectId(page.id) || !Number.isSafeInteger(page.length) || page.length < page.count
      || !Number.isSafeInteger(page.count) || page.count < 1 || page.count > capacity
      || (i < pages.length - 1 && page.count !== capacity)) {
      throw new ObjectStoreError("invalid_manifest", "Invalid or noncanonical manifest page reference.");
    }
    total += page.length;
    count += page.count;
  }
  if (total !== manifest.totalLength || !Number.isSafeInteger(count) || count > manifest.totalLength) {
    throw new ObjectStoreError("invalid_manifest", "Manifest page totals do not match the node.");
  }
  return Buffer.from([PAGED_MANIFEST_FORMAT, `total ${total}`, `height ${height}`,
    ...(manifest.mode === "cdc" ? ["mode cdc"] : []),
    ...pages.map(/** Emit fixed bounded references in logical byte order. */ (page) => `page ${page.id} ${page.length} ${page.count}`), ""].join("\n"));
}

/** Decode at most one bounded node and prove byte-exact canonical re-encoding. */
export function decodePagedManifest(payload: Buffer): FragmentManifest {
  if (payload.length > 16_384) throw new ObjectStoreError("malformed_object", "Manifest node exceeds its metadata bound.");
  const lines = payload.toString("utf8").split("\n");
  const totalLength = Number(lines[1]?.slice(6));
  const height = Number(lines[2]?.slice(7));
  const mode = lines[3] === "mode cdc" ? "cdc" : undefined;
  const pages: ManifestPage[] = [];
  for (const line of lines.slice(mode === "cdc" ? 4 : 3, -1)) {
    const fields = line.split(" ");
    pages.push({ id: fields[1], length: Number(fields[2]), count: Number(fields[3]) });
  }
  const node: FragmentManifest = { totalLength, height, fragments: [], pages, ...(mode === undefined ? {} : { mode }) };
  try {
    if (!encodePagedManifest(node).equals(payload)) throw new ObjectStoreError("invalid_manifest", "Noncanonical manifest bytes.");
  } catch (error) {
    throw new ObjectStoreError("malformed_object", (error as Error).message);
  }
  return node;
}

/** Incremental canonical writer retaining at most fanout entries at each of eight bounded levels. */
export class ManifestWriter {
  /** Partial nodes; safe integer content lengths bound the number of levels. */
  private readonly levels: ManifestPage[][] = [[]];
  /** Total bytes accepted so far. */
  private total = 0;
  /** A finalized writer cannot silently discard earlier pages on reuse. */
  private finished = false;
  /** Last root encoding, used only when finalizing. */
  private root: FragmentManifest = { totalLength: 0, fragments: [] };
  /** Sink writing or merely hashing one canonical node. */
  private readonly sink: (payload: Buffer) => ObjectId;
  /** Chunking mode carried by every node. */
  private readonly mode: "fixed" | "cdc";

  /** Bind a store sink, or a pure hashing sink for content identity calculation. */
  constructor(store?: ObjectStore, fileId?: FileId, mode: "fixed" | "cdc" = "fixed") {
    this.mode = mode;
    this.sink = store === undefined
      ? /** Hash a bounded node without retaining its payload. */ (payload) => hashObject("manifest", payload)
      : /** Publish one attributed immutable node. */ (payload) => store.write("manifest", payload, fileId);
  }

  /** Accept one logical fragment without retaining preceding fragments. */
  add(fragment: FragmentEntry): void {
    if (this.finished) throw new ObjectStoreError("invalid_manifest", "Manifest writer is already finalized.");
    if (!isObjectId(fragment.id) || !Number.isSafeInteger(fragment.length) || fragment.length < 1) throw new ObjectStoreError("invalid_manifest", "Invalid logical fragment.");
    const total = this.total + fragment.length;
    if (!Number.isSafeInteger(total)) throw new ObjectStoreError("invalid_manifest", "Manifest length exceeds safe integer addressing.");
    this.total = total;
    this.append(0, { ...fragment, count: 1 });
  }

  /** Append one child and immediately promote complete nodes. */
  private append(level: number, entry: ManifestPage): void {
    this.levels[level] ??= [];
    this.levels[level].push(entry);
    if (this.levels[level].length === MANIFEST_FANOUT) this.append(level + 1, this.flush(level));
  }

  /** Encode and retire one bounded node, returning its parent reference. */
  private flush(level: number): ManifestPage {
    const entries = this.levels[level];
    const totalLength = entries.reduce(/** Sum only this bounded node. */ (sum, entry) => sum + entry.length, 0);
    const count = entries.reduce(/** Count descendants without enumerating them. */ (sum, entry) => sum + entry.count, 0);
    this.root = { totalLength, fragments: level === 0 ? entries.map(/** Leaf entries keep the byte-identical v1 encoding. */ ({ id, length }) => ({ id, length })) : [],
      ...(level === 0 ? {} : { pages: entries, height: level }), ...(this.mode === "cdc" ? { mode: this.mode } : {}) };
    const id = this.sink(encodeManifest(this.root));
    this.levels[level] = [];
    return { id, length: totalLength, count };
  }

  /** Finish the minimal-height tree, collapsing a singleton promoted root. */
  finish(): { manifestId: ObjectId; manifest: FragmentManifest } {
    if (this.finished) throw new ObjectStoreError("invalid_manifest", "Manifest writer is already finalized.");
    this.finished = true;
    let level = 0;
    while (level < this.levels.length - 1) {
      if (this.levels[level].length > 0) this.append(level + 1, this.flush(level));
      level++;
    }
    const entries = this.levels[level];
    if (level > 0 && entries.length === 1) {
      // A full node was already written and remains the minimal root.
      return { manifestId: entries[0].id, manifest: this.root };
    }
    return { manifestId: this.flush(level).id, manifest: this.root };
  }
}

/** Read one node; every address is rehashed by the ordinary object store. */
export function readManifestNode(store: ObjectStore, id: ObjectId): FragmentManifest {
  return decodeManifest(store.readBoundedTyped(id, "manifest"));
}

/** Bounded traversal header; legacy streams contain no resident logical entry array. */
export interface ManifestHeader extends FragmentManifest {
  /** The large v1 payload must be traversed through the verified streaming decoder. */
  readonly legacyStream?: boolean;
}

/** Obtain bounded root metadata, selecting the compatibility stream for a large flat v1 object. */
export function manifestHeader(store: ObjectStore, id: ObjectId): ManifestHeader {
  try {
    const node = readManifestNode(store, id);
    assertManifestRoot(node);
    return node;
  } catch (error) {
    if (!(error instanceof ObjectStoreError) || error.code !== "object_payload_limit") throw error;
  }
  const lines = store.readLines(id, "manifest");
  try {
    if (lines.next().value !== "pm-vcs-manifest 1") throw new ObjectStoreError("malformed_object", "Only legacy v1 metadata may exceed the node bound.");
    const total = lines.next().value as string | undefined;
    if (total === undefined || !/^total (0|[1-9][0-9]*)$/.test(total) || !Number.isSafeInteger(Number(total.slice(6)))) {
      throw new ObjectStoreError("malformed_object", "Legacy manifest has an invalid total.");
    }
    const mode = lines.next().value === "mode cdc" ? "cdc" : undefined;
    return { totalLength: Number(total.slice(6)), fragments: [], legacyStream: true, ...(mode === undefined ? {} : { mode }) };
  } finally { lines.return(undefined); }
}

/** Decode and verify every legacy line while retaining a single fragment and selecting requested overlaps. */
function* legacyFragments(store: ObjectStore, id: ObjectId, start: number, end: number): Generator<{ fragment: FragmentEntry; offset: number }> {
  let lineNumber = 0;
  let total = 0;
  let offset = 0;
  for (const line of store.readLines(id, "manifest")) {
    lineNumber++;
    if (lineNumber === 1) {
      if (line !== "pm-vcs-manifest 1") throw new ObjectStoreError("malformed_object", "Invalid legacy manifest marker.");
    } else if (lineNumber === 2) {
      if (!/^total (0|[1-9][0-9]*)$/.test(line) || !Number.isSafeInteger(Number(line.slice(6)))) throw new ObjectStoreError("malformed_object", "Invalid legacy total.");
      total = Number(line.slice(6));
    } else if (lineNumber === 3 && line === "mode cdc") {
      continue;
    } else {
      const match = /^frag ([0-9a-f]{64}) ([1-9][0-9]*)$/.exec(line);
      if (match === null || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(offset + Number(match[2]))) {
        throw new ObjectStoreError("malformed_object", "Invalid legacy fragment line.");
      }
      const fragment = { id: match[1], length: Number(match[2]) };
      if (start < end && offset + fragment.length > start && offset < end) yield { fragment, offset };
      offset += fragment.length;
    }
  }
  if (lineNumber < 2 || offset !== total) throw new ObjectStoreError("malformed_object", "Legacy fragment totals do not match.");
}

/** Require the writer's minimal height at a logical root while allowing partial interior nodes. */
export function assertManifestRoot(node: FragmentManifest): void {
  if (node.pages !== undefined && node.pages.reduce(/** Count logical entries from bounded descriptors. */ (sum, page) => sum + page.count, 0) <= MANIFEST_FANOUT ** node.height!) {
    throw new ObjectStoreError("invalid_manifest", "Manifest root has a redundant hierarchy level.");
  }
}

/** Validate an interior edge, including child kind, length, count, height and chunking mode. */
export function assertManifestChild(parent: FragmentManifest, page: ManifestPage, child: FragmentManifest): void {
  const count = child.pages === undefined ? child.fragments.length : child.pages.reduce(/** Sum bounded child counts. */ (sum, entry) => sum + entry.count, 0);
  if ((child.height ?? 0) !== (parent.height as number) - 1 || child.totalLength !== page.length || count !== page.count
    || (child.mode ?? "fixed") !== (parent.mode ?? "fixed") || (child.pages === undefined && count > MANIFEST_FANOUT)) {
    throw new ObjectStoreError("invalid_manifest", "Manifest child disagrees with its authenticated parent reference.");
  }
}

/** Traverse a byte interval while retaining only one bounded node per bounded hierarchy level. */
export function* manifestFragments(store: ObjectStore, id: ObjectId, start = 0, end = Number.MAX_SAFE_INTEGER, node: ManifestHeader = manifestHeader(store, id), offset = 0): Generator<{ fragment: FragmentEntry; offset: number }> {
  if (node.legacyStream === true) {
    yield* legacyFragments(store, id, start, end);
  } else if (start === end) {
    return;
  } else if (node.pages !== undefined) {
    for (const page of node.pages) {
      const next = offset + page.length;
      if (next > start && offset < end) {
        const child = readManifestNode(store, page.id);
        assertManifestChild(node, page, child);
        yield* manifestFragments(store, page.id, start, end, child, offset);
      }
      offset = next;
    }
  } else {
    for (const fragment of node.fragments) {
      if (offset + fragment.length > start && offset < end) yield { fragment, offset };
      offset += fragment.length;
    }
  }
}

/** Explicit convenience API materializing a logical fragment list when a caller requests it. */
export function materializeManifest(store: ObjectStore, id: ObjectId): FragmentManifest {
  const node = manifestHeader(store, id);
  return { totalLength: node.totalLength, fragments: [...manifestFragments(store, id, 0, node.totalLength, node)].map(/** Drop traversal offsets in the requested full logical list. */ (entry) => entry.fragment),
    ...(node.mode === undefined ? {} : { mode: node.mode }) };
}
