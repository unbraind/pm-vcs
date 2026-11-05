// Working-tree codecs for structured records.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseItemDocument,
  resolveRuntimeStatusRegistry,
  type PmSettings,
  serializeItemDocument,
  splitFrontMatter,
  type ItemDocument,
  type ItemMetadata,
} from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";

import { decodeRecord, encodeRecord, type RecordDocument } from "./model.ts";
import { ObjectStoreError } from "./objects.ts";

/** Required fields that distinguish a native PM item from an arbitrary JSON record. */
const PM_ITEM_FIELDS = ["id", "title", "description", "type", "status", "priority", "created_at", "updated_at"] as const;

/** Preserve tracker-specific status IDs as opaque native data, without assigning lifecycle roles.
 * Existing default-schema documents keep their released normalization. Admission separately
 * verifies the canonical document against its actual SDK workspace schema before publication.
 */
function parseNativeItem(text: string, pmRoot: string | undefined, format: "toon" | "json_markdown"): ItemDocument {
  try { return parseItemDocument(text, { format, schema: pmRoot === undefined ? undefined : workingSchema(pmRoot) }); }
  catch (original) {
    const raw: unknown = format === "toon" ? decodeToon(text) : JSON.parse(splitFrontMatter(text).frontMatter);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw original;
    const row = raw as Record<string, unknown>;
    const metadata = Object.hasOwn(row, "front_matter") ? row.front_matter : row;
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || typeof (metadata as Record<string, unknown>).status !== "string") throw original;
    return parseItemDocument(text, { format, schema: { version: 1, files: {}, statuses: [{ id: (metadata as Record<string, string>).status }], fields: [], workflow: {}, unknown_field_policy: "allow" } });
  }
}

/** Read optional SDK schema arrays without inventing field or status normalization rules. */
function schemaDefinitions<T>(file: string, section: "statuses" | "fields"): T[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(raw)) return raw as T[];
    if (raw === null || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const definitions = Array.isArray(row[section]) ? row[section] : row.definitions;
    return Array.isArray(definitions) ? definitions as T[] : [];
  } catch { return []; }
}

const workingSchemaCache = new Map<string, { sources: Array<[string, string]>; schema: PmSettings["schema"] }>();

/** Track replacement, resizing and nanosecond edits, including creation of an optional source. */
function schemaSourceSignature(file: string): string {
  const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? "-" : `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

/** Hydrate codec definitions for the synchronous native staging API; SDK codecs own their meaning.
 * Invalid/missing configuration retains the released opaque-status codec so historical records
 * never depend on today's schema. File-backed custom fields accompany strict unknown-field policy.
 */
function workingSchema(pmRoot: string): PmSettings["schema"] | undefined {
  try {
    const root = resolve(pmRoot);
    const cached = workingSchemaCache.get(root);
    if (cached?.sources.every(([file, signature]) => schemaSourceSignature(file) === signature)) return cached.schema;
    const settingsPath = resolve(root, "settings.json");
    const sources: Array<[string, string]> = [[settingsPath, schemaSourceSignature(settingsPath)]];
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { schema?: PmSettings["schema"] };
    const inline = settings.schema;
    const statusesPath = resolve(root, inline?.files?.statuses?.trim() || "schema/statuses.json");
    const fieldsPath = resolve(root, inline?.files?.fields?.trim() || "schema/fields.json");
    sources.push([statusesPath, schemaSourceSignature(statusesPath)], [fieldsPath, schemaSourceSignature(fieldsPath)]);
    const base = { version: 1, files: {}, statuses: [], fields: [], workflow: {}, unknown_field_policy: "allow" as const, ...inline };
    const statuses = schemaDefinitions<PmSettings["schema"]["statuses"][number]>(statusesPath, "statuses");
    const fields = schemaDefinitions<PmSettings["schema"]["fields"][number]>(fieldsPath, "fields");
    const schema = { ...base, statuses: [...resolveRuntimeStatusRegistry(base).definitions, ...statuses], fields: [...base.fields, ...fields] };
    workingSchemaCache.set(root, { sources, schema });
    return schema;
  } catch { return undefined; }
}

/**
 * Decodes a configured working-tree record through its native format.
 *
 * Native `.toon` and JSON-markdown PM items use the pm SDK's canonical parser and are flattened
 * into top-level fields so independent metadata edits merge independently. JSON
 * remains the fallback for every record path, including legacy `.toon` paths
 * that deliberately stored JSON before native TOON support existed.
 *
 * @param path - Canonical repository-relative path.
 * @param content - Working-tree bytes.
 * @returns Canonical record fields for object storage and merging.
 * @throws ObjectStoreError When neither the PM TOON nor JSON codec accepts the document.
 */
export function parseWorkingRecord(path: string, content: Buffer, pmRoot?: string): RecordDocument {
  let toonError: unknown;
  let toonParseFailed = false;
  if (path.endsWith(".toon") || path.endsWith(".md")) {
    try {
      const item = parseNativeItem(content.toString("utf8"), pmRoot, path.endsWith(".toon") ? "toon" : "json_markdown");
      return decodeRecord(Buffer.from(JSON.stringify({ ...item.metadata, body: item.body }), "utf8"));
    } catch (error) {
      toonParseFailed = true;
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
      `Record path ${path} is neither a valid native PM item nor a valid JSON object.`
      + (!toonParseFailed
        ? ""
        : ` Native item parser: ${String(toonError).replace(/^[^:]+: /, "")}`),
    );
  }
}

/**
 * Renders canonical record fields back into the path's working-tree format.
 *
 * @param path - Canonical repository-relative path.
 * @param document - Canonical stored record.
 * @returns Native PM TOON or JSON-markdown for PM item paths, canonical JSON otherwise.
 */
export function renderWorkingRecord(path: string, document: RecordDocument): Buffer {
  if ((path.endsWith(".toon") || path.endsWith(".md")) && PM_ITEM_FIELDS.every((field) => document[field] !== undefined)) {
    const metadata = Object.fromEntries(Object.entries(document).filter(([field]) => field !== "body"));
    const item: ItemDocument = {
      metadata: metadata as ItemMetadata,
      body: typeof document.body === "string" ? document.body : "",
    };
    return Buffer.from(serializeItemDocument(item, { format: path.endsWith(".toon") ? "toon" : "json_markdown" }), "utf8");
  }
  return encodeRecord(document);
}
