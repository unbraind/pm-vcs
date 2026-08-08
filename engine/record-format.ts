// Working-tree codecs for structured records.

import {
  parseItemDocument,
  serializeItemDocument,
  type ItemDocument,
  type ItemMetadata,
} from "@unbrained/pm-cli/sdk";

import { decodeRecord, encodeRecord, type RecordDocument } from "./model.ts";
import { ObjectStoreError } from "./objects.ts";

/** Required fields that distinguish a native PM item from an arbitrary JSON record. */
const PM_ITEM_FIELDS = ["id", "title", "description", "type", "status", "priority", "created_at", "updated_at"] as const;

/**
 * Decodes a configured working-tree record through its native format.
 *
 * Native `.toon` PM items use the pm SDK's canonical parser and are flattened
 * into top-level fields so independent metadata edits merge independently. JSON
 * remains the fallback for every record path, including legacy `.toon` paths
 * that deliberately stored JSON before native TOON support existed.
 *
 * @param path - Canonical repository-relative path.
 * @param content - Working-tree bytes.
 * @returns Canonical record fields for object storage and merging.
 * @throws ObjectStoreError When neither the PM TOON nor JSON codec accepts the document.
 */
export function parseWorkingRecord(path: string, content: Buffer): RecordDocument {
  let toonError: unknown;
  if (path.endsWith(".toon")) {
    try {
      const item = parseItemDocument(content.toString("utf8"), { format: "toon" });
      return decodeRecord(Buffer.from(JSON.stringify({ ...item.metadata, body: item.body }), "utf8"));
    } catch (error) {
      toonError = error;
      // A configured .toon path can be a legacy JSON record. Preserve that
      // compatibility by trying the generic record codec before failing closed.
    }
  }
  try {
    return decodeRecord(content);
  } catch {
    throw new ObjectStoreError(
      "malformed_object",
      `Record path ${path} is neither a valid native PM TOON item nor a valid JSON object.`
      + (toonError === undefined
        ? ""
        : ` Native TOON parser: ${String(toonError).replace(/^[^:]+: /, "")}`),
    );
  }
}

/**
 * Renders canonical record fields back into the path's working-tree format.
 *
 * @param path - Canonical repository-relative path.
 * @param document - Canonical stored record.
 * @returns Native PM TOON for PM item paths, canonical JSON otherwise.
 */
export function renderWorkingRecord(path: string, document: RecordDocument): Buffer {
  if (path.endsWith(".toon") && PM_ITEM_FIELDS.every((field) => document[field] !== undefined)) {
    const metadata = Object.fromEntries(Object.entries(document).filter(([field]) => field !== "body"));
    const item: ItemDocument = {
      metadata: metadata as ItemMetadata,
      body: typeof document.body === "string" ? document.body : "",
    };
    return Buffer.from(serializeItemDocument(item, { format: "toon" }), "utf8");
  }
  return encodeRecord(document);
}
