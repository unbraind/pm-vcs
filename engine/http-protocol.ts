// The wire vocabulary shared by the served repository and the HTTP client.
//
// Both sides of the socket speak the same JSON envelopes, so a refusal read by
// an agent pushing over HTTP names the same error code with the same message it
// would have seen against a file remote, and a served repository answers a
// well-formed request exactly the way `FileTransport` would have. This module
// owns that vocabulary once: endpoint suffixes, request and response shapes, the
// error body, the one denial answer, repository-name rules and the transfer
// bounds. The server and the client both import it, which is also what keeps
// the two from drifting into dialects that agree only by accident.

import { redactUserinfo } from "./credentials.ts";
import { isObjectId, type ObjectId, type ObjectType, OBJECT_TYPES, ObjectStoreError } from "./objects.ts";

/** One repository's advertisement endpoint, answering refs, HEAD, configuration and capabilities. */
export const ADVERTISE_ENDPOINT = "advertise";

/** The endpoint answering a negotiated bundle of reachable history. */
export const FETCH_ENDPOINT = "fetch";

/** The endpoint accepting a whole push: one bundle plus the ref moves it asks for. */
export const PUSH_ENDPOINT = "push";

/** The endpoint returning verified objects, including standalone patch series. */
export const OBJECT_FETCH_ENDPOINT = "objects/fetch";

/** The endpoint answering which offered objects a receiver still lacks. */
export const MISSING_ENDPOINT = "objects/missing";

/** The endpoint accepting streamed objects, each verified on arrival. */
export const UPLOAD_ENDPOINT = "objects/upload";

/** The endpoint publishing ref moves after a resumable upload. */
export const PUBLISH_ENDPOINT = "publish";

/** Endpoint suffixes an HTTP request path may end with, longest first so nested ones match. */
const ENDPOINT_SUFFIXES = [
  UPLOAD_ENDPOINT,
  OBJECT_FETCH_ENDPOINT,
  MISSING_ENDPOINT,
  PUBLISH_ENDPOINT,
  ADVERTISE_ENDPOINT,
  FETCH_ENDPOINT,
  PUSH_ENDPOINT,
] as const;

/**
 * Whether an endpoint is a write as far as authorization is concerned.
 *
 * `missing` is a read: it discloses which objects the receiver holds, so it
 * takes the read grant. Upload and publish change the receiver's store and
 * refs, so they take the write grant.
 *
 * @param endpoint - Endpoint suffix that the request path ended with.
 * @returns True when only a write grant may perform it.
 */
export function isWriteEndpoint(endpoint: string): boolean {
  return endpoint === PUSH_ENDPOINT || endpoint === UPLOAD_ENDPOINT || endpoint === PUBLISH_ENDPOINT;
}

/**
 * The one answer a request that has not been authorized may receive.
 *
 * Status, content type and body bytes are fixed for every refusal that happens
 * before authorization succeeds — missing repository, wrong tenant, unknown
 * token, absent token, a malformed Authorization header, a repository name
 * shaped like a traversal — so no two refusal causes can be told apart from the
 * wire. Existence of a repository the caller may not read is the fact this
 * answer protects.
 */
export const DENIED_STATUS = 404;

/** Content type every JSON response, denial included, is served with. */
export const JSON_CONTENT_TYPE = "application/json";

/** Content type a fetched bundle's bytes are served with. */
export const BUNDLE_CONTENT_TYPE = "application/octet-stream";

/**
 * The denial body as the exact bytes written to the wire.
 *
 * A constant rather than a function so the server cannot accidentally vary it
 * per cause, and so the adversarial test can assert against one shared value.
 */
export const DENIED_BODY = Buffer.from(
  `${JSON.stringify({ error: { code: "denied", message: "The requested repository is not available." } })}\n`,
  "utf8",
);

/** Status answering a caller who may read a repository but not write it. */
export const FORBIDDEN_STATUS = 403;

/**
 * The body answering a read grant used on a write endpoint.
 *
 * Distinct from the denial on purpose: this caller can already prove the
 * repository exists by advertising it, so the distinction hides nothing and
 * tells the agent which of the two things to fix — the token or the operation.
 */
export const FORBIDDEN_BODY = Buffer.from(
  `${JSON.stringify({ error: { code: "forbidden", message: "This token may read the repository but not write it." } })}\n`,
  "utf8",
);

/** Status answering a request body that exceeds the configured bound. */
export const BODY_TOO_LARGE_STATUS = 413;

/** Status answering a request the server cannot or will not interpret. */
export const BAD_REQUEST_STATUS = 400;

/** Status answering an unexpected server-side failure. */
export const INTERNAL_ERROR_STATUS = 500;

/**
 * Serializes one error body for the wire.
 *
 * @param code - The `ObjectStoreError` code the client will re-raise.
 * @param message - The message the client will re-raise it with.
 * @returns The response bytes.
 */
export function encodeErrorBody(code: string, message: string): Buffer {
  return Buffer.from(`${JSON.stringify({ error: { code, message } })}\n`, "utf8");
}

/**
 * Parses an error body received over the wire.
 *
 * The body is untrusted input, so the shape is validated rather than assumed:
 * a response that does not carry the error shape is reported as an
 * `unreachable_remote` failure rather than crashing on a missing property.
 *
 * @param payload - The received body.
 * @returns The code and message, or null when the body is not an error body.
 */
export function decodeErrorBody(payload: Buffer): { code: string; message: string } | null {
  const parsed = decodeWireObject(payload);
  if (parsed === null) return null;
  const error = (parsed as Record<string, unknown>).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") return null;
  return { code: record.code, message: record.message };
}

/**
 * Splits a served request path into repository name and endpoint suffix.
 *
 * The repository name is everything before the endpoint suffix, so a served
 * root may hold nested names such as `tenant/project`. A path that ends with
 * no known suffix names no repository this server serves, and is answered the
 * same way an unauthorized repository is — before authorization has anything
 * to say about the name.
 *
 * @param path - The request path, with any query string already stripped.
 * @returns The repository name and the endpoint it addresses, or null when the
 *   path names no endpoint.
 */
export function splitServedPath(path: string): { repository: string; endpoint: string } | null {
  for (const suffix of ENDPOINT_SUFFIXES) {
    const separator = `/${suffix}`;
    if (!path.endsWith(separator)) continue;
    const repository = path.slice(1, path.length - separator.length);
    return { repository, endpoint: suffix };
  }
  return null;
}

/** Characters a repository name segment may contain. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Maximum length a served repository name may have. */
export const MAX_REPOSITORY_NAME_LENGTH = 128;

/**
 * Whether a repository name is safe to join onto the served root.
 *
 * Each segment must start with an alphanumeric and contain only name
 * characters, which admits no `.` or `..`, no separators, no percent escapes and
 * no absolute or Windows-rooted spelling — so the joined path cannot leave the
 * root. A single segment is the ordinary shape; slashes between validated
 * segments allow a root organized by tenant.
 *
 * @param name - The repository name taken from the request path.
 * @returns True when the name may be joined onto the root.
 */
export function isServedRepositoryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_REPOSITORY_NAME_LENGTH) return false;
  if (name.endsWith("/") || name.includes("//") || name.includes("\\")) return false;
  return name.split("/").every((segment) => SEGMENT_PATTERN.test(segment));
}

/**
 * Bounds a served repository applies to every request.
 *
 * A server that buffers a request body cannot also accept bodies of any size,
 * and one that tracks upload sessions cannot accept any number of them — or,
 * once one session can be reused indefinitely, any amount of retained receipt
 * memory from it. Every bound here is a ceiling the server refuses past rather
 * than a hint it trusts, and each has a test that pushes past it and asserts the
 * refusal left the repository untouched.
 */
export interface ServeLimits {
  /** Maximum bytes of one request body. */
  readonly maxBodyBytes: number;
  /** Maximum refs one fetch may name. */
  readonly maxFetchRefs: number;
  /** Maximum haves one fetch may offer. */
  readonly maxFetchHaves: number;
  /** Maximum ref moves one push or publish may request. */
  readonly maxUpdates: number;
  /** Maximum objects one upload may carry. */
  readonly maxUploadObjects: number;
  /** Maximum concurrent upload sessions held per repository. */
  readonly maxSessions: number;
  /** Maximum objects one upload session may accept between publications. */
  readonly maxSessionObjects: number;
  /** Maximum decoded object bytes one upload session may accept between publications. */
  readonly maxSessionBytes: number;
}

/** The bounds a served repository applies when the caller configures none. */
export const DEFAULT_SERVE_LIMITS: ServeLimits = {
  maxBodyBytes: 512 * 1024 * 1024,
  maxFetchRefs: 10_000,
  maxFetchHaves: 100_000,
  maxUpdates: 10_000,
  maxUploadObjects: 100_000,
  maxSessions: 4_096,
  maxSessionObjects: 1_000_000,
  maxSessionBytes: 4 * 1024 * 1024 * 1024,
};

/** One ref move a push or publish asks for, in the shape it crosses the wire in. */
export interface WirePushUpdate {
  /** Full ref name on the receiver. */
  readonly ref: string;
  /** The value the sender observed, or null when it expects the ref to be absent. */
  readonly expected: ObjectId | null;
  /** The commit the ref should end up at. */
  readonly next: ObjectId;
}

/** A receipt as it crosses the wire: what moved, and what the transfer stored. */
export interface WirePushReceipt {
  /** Refs that moved, as requested. */
  readonly updated: readonly WirePushUpdate[];
  /** Objects the receiver stored that it did not already hold. */
  readonly added: readonly ObjectId[];
}

/** One object as it crosses the wire during an upload, payload base64-encoded. */
export interface WireTransferObject {
  /** The id the sender claims the content hashes to. */
  readonly id: ObjectId;
  /** The object's kind. */
  readonly type: ObjectType;
  /** The object's raw content, base64-encoded. */
  readonly payload: string;
}

/** Reads a required string field out of an untrusted object. */
function wireString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === "string" ? value : null;
}

/** Reads a required string array out of an untrusted object. */
function wireStrings(source: Record<string, unknown>, field: string): readonly string[] | null {
  const value = source[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as readonly string[];
}

/** Reads an object id or null field out of an untrusted object. */
function wireObjectId(source: Record<string, unknown>, field: string): ObjectId | null | undefined {
  const value = source[field];
  if (value === null) return null;
  if (typeof value !== "string" || !isObjectId(value)) return undefined;
  return value;
}

/**
 * Validates a JSON object body without trusting its declared shape.
 *
 * @param payload - The received body.
 * @returns The parsed record, or null when the body is not a JSON object.
 */
export function decodeWireObject(payload: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Encodes a fetch request: which refs, and what the caller already holds.
 *
 * @param refs - Full ref names, empty for every branch and tag.
 * @param haves - Object ids the caller offers as already held.
 * @returns The request body.
 */
export function encodeFetchRequest(refs: readonly string[], haves: readonly ObjectId[]): string {
  return `${JSON.stringify({ refs, haves })}\n`;
}

/**
 * Decodes a fetch request.
 *
 * @param body - The received body.
 * @returns The refs and haves, or null when the body does not hold both.
 */
export function decodeFetchRequest(body: Record<string, unknown>): { refs: readonly string[]; haves: readonly ObjectId[] } | null {
  const refs = wireStrings(body, "refs");
  const haves = wireStrings(body, "haves");
  if (refs === null || haves === null || haves.some((id) => !isObjectId(id))) return null;
  return { refs, haves };
}

/**
 * Encodes ref moves in the shape the wire carries them.
 *
 * @param updates - The moves being requested.
 * @returns The wire-shaped moves.
 */
export function encodePushUpdates(
  updates: ReadonlyArray<{ ref: string; expected: ObjectId | null; next: ObjectId }>,
): WirePushUpdate[] {
  return updates.map((update) => ({ ref: update.ref, expected: update.expected, next: update.next }));
}

/**
 * Decodes a list of ref moves, from whichever field carries them.
 *
 * @param body - The received request or response object.
 * @param field - The field the list travels under: `updates` in a request,
 *   `updated` in a receipt.
 * @returns The moves, or null when any of them is malformed.
 */
export function decodePushUpdates(body: Record<string, unknown>, field: string): readonly WirePushUpdate[] | null {
  const value = body[field];
  if (!Array.isArray(value)) return null;
  const updates: WirePushUpdate[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const ref = wireString(record, "ref");
    const expected = wireObjectId(record, "expected");
    const next = wireObjectId(record, "next");
    if (ref === null || ref.length === 0 || expected === undefined || next === null || next === undefined) return null;
    updates.push({ ref, expected, next });
  }
  return updates;
}

/**
 * Encodes a whole-push request: the bundle plus the ref moves it asks for.
 *
 * @param bundle - The bundle bytes, base64 in the JSON envelope.
 * @param updates - The ref moves being requested.
 * @param force - Whether a discarding move is allowed.
 * @param now - Timestamp the receiver records in its operation log.
 * @returns The request body.
 */
export function encodePushRequest(
  bundle: Buffer,
  updates: ReadonlyArray<{ ref: string; expected: ObjectId | null; next: ObjectId }>,
  force: boolean,
  now: Date,
): string {
  return `${JSON.stringify({
    bundle: bundle.toString("base64"),
    updates: encodePushUpdates(updates),
    force,
    now: now.getTime(),
  })}\n`;
}

/**
 * Encodes a which-are-missing request.
 *
 * @param ids - Object ids the sender intends to transfer.
 * @returns The request body.
 */
export function encodeMissingRequest(ids: readonly ObjectId[]): string {
  return `${JSON.stringify({ ids })}\n`;
}

/**
 * Decodes a which-are-missing request.
 *
 * @param body - The received request object.
 * @returns The offered ids, or null when any entry is not an object id.
 */
export function decodeMissingRequest(body: Record<string, unknown>): readonly ObjectId[] | null {
  const ids = wireStrings(body, "ids");
  if (ids === null || ids.some((id) => !isObjectId(id))) return null;
  return ids;
}

/**
 * Encodes the answer to a which-are-missing request.
 *
 * @param missing - The ids the receiver does not hold, in the order offered.
 * @returns The response body.
 */
export function encodeMissingResponse(missing: readonly ObjectId[]): string {
  return `${JSON.stringify({ missing })}\n`;
}

/**
 * Encodes an object upload for the wire.
 *
 * @param session - The upload session id, so a later publish reports what this
 *   session delivered.
 * @param objects - The objects to transfer, payloads base64-encoded.
 * @returns The request body.
 */
export function encodeUploadRequest(
  session: string,
  objects: ReadonlyArray<{ id: ObjectId; type: ObjectType; payload: Buffer }>,
): string {
  return `${JSON.stringify({
    session,
    objects: objects.map((object) => ({ id: object.id, type: object.type, payload: object.payload.toString("base64") })),
  })}\n`;
}

/**
 * Decodes an object upload.
 *
 * @param body - The received request object.
 * @returns The session id and the objects, payloads still encoded, or null
 *   when the session is absent, the object list is malformed, or any object's
 *   id or type is not well-formed.
 */
export function decodeUploadRequest(body: Record<string, unknown>): { session: string; objects: WireTransferObject[] } | null {
  const session = wireString(body, "session");
  const value = body.objects;
  if (session === null || session.length === 0 || !Array.isArray(value)) return null;
  const objects: WireTransferObject[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const id = wireString(record, "id");
    const type = wireString(record, "type");
    const payload = wireString(record, "payload");
    if (id === null || !isObjectId(id) || type === null || !(OBJECT_TYPES as readonly string[]).includes(type) || payload === null) {
      return null;
    }
    objects.push({ id, type: type as ObjectType, payload });
  }
  return { session, objects };
}

/**
 * Encodes a publication request after a resumable upload.
 *
 * @param session - The upload session whose deliveries the receipt should name.
 * @param updates - The ref moves being requested.
 * @param force - Whether a discarding move is allowed.
 * @param now - Timestamp the receiver records in its operation log.
 * @returns The request body.
 */
export function encodePublishRequest(
  session: string,
  updates: ReadonlyArray<{ ref: string; expected: ObjectId | null; next: ObjectId }>,
  force: boolean,
  now: Date,
): string {
  return `${JSON.stringify({ session, updates: encodePushUpdates(updates), force, now: now.getTime() })}\n`;
}

/**
 * Encodes a push receipt for the wire.
 *
 * @param receipt - What moved, and what the transfer stored.
 * @returns The response body.
 */
export function encodePushReceipt(receipt: { updated: readonly WirePushUpdate[]; added: readonly ObjectId[] }): string {
  return `${JSON.stringify({ updated: receipt.updated, added: receipt.added })}\n`;
}

/**
 * Decodes a push receipt received over the wire.
 *
 * @param body - The received response object.
 * @returns The receipt, or null when its shape is wrong.
 */
export function decodePushReceipt(body: Record<string, unknown>): WirePushReceipt | null {
  const updated = decodePushUpdates(body, "updated");
  const added = wireStrings(body, "added");
  if (updated === null || added === null || added.some((id) => !isObjectId(id))) return null;
  return { updated, added };
}

/**
 * Decodes a timestamp that crossed the wire as epoch milliseconds.
 *
 * @param body - The received request object.
 * @param field - The field holding the timestamp.
 * @returns The date, or null when the field is missing or not a finite number.
 */
export function decodeWireDate(body: Record<string, unknown>, field: string): Date | null {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Refuses an HTTP request whose status is not a success.
 *
 * The one place client-side wire failures become `ObjectStoreError`s, so every
 * endpoint reports them the same way: an error body is re-raised with its own
 * code and message — which is how a served refusal reads identically to a
 * local one — and anything else, including an unreachable or timed-out server,
 * is reported as an unreachable remote rather than as a network exception the
 * caller cannot act on.
 *
 * @param status - The HTTP status the server answered with.
 * @param payload - The response body.
 * @param url - The remote as configured, for the message.
 * @throws ObjectStoreError With the wire error's code, or `unreachable_remote`.
 */
export function assertWireSuccess(status: number, payload: Buffer, url: string): void {
  if (status >= 200 && status < 300) return;
  const wireError = decodeErrorBody(payload);
  if (wireError !== null) {
    throw new ObjectStoreError(wireError.code, redactUserinfo(wireError.message));
  }
  throw new ObjectStoreError(
    "unreachable_remote",
    `${redactUserinfo(url)} answered status ${status} without an error body. Check the remote's URL, or whether the server is a served repository.`,
  );
}