// Serving a repository over HTTP: the same transport, on a socket.
//
// Every policy a repository enforces lives in `FileTransport` — the fast-forward
// refusal, `--force`, compare-and-swap publication, re-hashing every arriving
// object — and this server adds none of its own. What it adds is the wire:
// authorization before any repository byte is touched, a bound on what it will
// buffer, and the tenancy rule that every refusal a caller may not learn from
// is the same bytes. The engine functions this module calls are the same ones
// `pm vcs push` runs against a directory.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { ObjectStoreError } from "./objects.ts";
import { FileTransport } from "./transport.ts";
import {
  ADVERTISE_ENDPOINT,
  BAD_REQUEST_STATUS,
  BODY_TOO_LARGE_STATUS,
  BUNDLE_CONTENT_TYPE,
  decodeFetchRequest,
  decodeMissingRequest,
  decodePushUpdates,
  decodeUploadRequest,
  decodeWireDate,
  decodeWireObject,
  DEFAULT_SERVE_LIMITS,
  DENIED_BODY,
  DENIED_STATUS,
  encodeErrorBody,
  encodeMissingResponse,
  encodePushReceipt,
  FETCH_ENDPOINT,
  FORBIDDEN_BODY,
  FORBIDDEN_STATUS,
  INTERNAL_ERROR_STATUS,
  isServedRepositoryName,
  isWriteEndpoint,
  JSON_CONTENT_TYPE,
  MISSING_ENDPOINT,
  PUBLISH_ENDPOINT,
  PUSH_ENDPOINT,
  type ServeLimits,
  splitServedPath,
  UPLOAD_ENDPOINT,
} from "./http-protocol.ts";

/** Access levels a token may hold for one repository. */
export type TokenAccess = "read" | "write";

/** One granted entry from the tokens file, in the shape it is filed in. */
interface StoredToken {
  /** The bearer secret. */
  readonly token: string;
  /** The repository name it reaches. */
  readonly repository: string;
  /** What it may do there. */
  readonly access: TokenAccess;
}

/**
 * Bearer tokens and what each may reach.
 *
 * Grants are read once when the server starts, so a served repository answers
 * from one snapshot rather than re-reading a file on every request: an edited
 * tokens file takes effect at the next start, which is also the one moment the
 * operator knows the answer for every connection still open.
 */
export class TokenGrants {
  /** Token to repository to access. */
  private readonly scopes: Map<string, Map<string, TokenAccess>>;

  /**
   * @param tokens - The grants to hold.
   */
  constructor(tokens: readonly StoredToken[] = []) {
    this.scopes = new Map();
    for (const entry of tokens) {
      const repositories = this.scopes.get(entry.token) ?? new Map();
      // Write is the wider of the two grants, so a token filed twice for one
      // repository keeps the union of what it was given rather than whichever
      // entry a map iteration happened to visit last.
      if (repositories.get(entry.repository) !== "write") repositories.set(entry.repository, entry.access);
      this.scopes.set(entry.token, repositories);
    }
  }

  /**
   * What one token may do to one repository.
   *
   * The answer is computed from the grant alone, never from whether the
   * repository exists, which is what keeps a missing repository and a
   * wrong-tenant one indistinguishable from the wire.
   *
   * @param token - The bearer secret as presented.
   * @param repository - The repository name being addressed.
   * @returns The access granted, or null when the token reaches nothing there.
   */
  scope(token: string, repository: string): TokenAccess | null {
    return this.scopes.get(token)?.get(repository) ?? null;
  }

  /**
   * Whether any token is held at all.
   *
   * @returns True when no grant exists, which is how a served root with an
   *   empty tokens file is detected and refused rather than silently open.
   */
  isEmpty(): boolean {
    return this.scopes.size === 0;
  }
}

/**
 * Reads the tokens file a served repository authorizes with.
 *
 * The file is operator-owned configuration, so a malformed one is refused at
 * startup rather than at the first request: a server that started and then
 * denied everything would look healthy while serving nothing.
 *
 * @param path - The tokens file to read.
 * @returns The grants it describes.
 * @throws ObjectStoreError With code `bad_auth_file` when the file cannot be
 *   read, or holds an entry that is not a token grant.
 */
export function readTokenFile(path: string): TokenGrants {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ObjectStoreError(
      "bad_auth_file",
      `The tokens file at ${path} cannot be read. Serve with a readable file, or without --auth.`,
    );
  }
  const tokens = parseTokenText(text);
  if (tokens === null) {
    throw new ObjectStoreError("bad_auth_file", `The tokens file at ${path} is not a valid token list.`);
  }
  return new TokenGrants(tokens);
}

/**
 * Parses tokens-file text.
 *
 * The accepted shape is a JSON array of
 * `{ "token": "…", "repository": "…", "access": "read" | "write" }` entries.
 * Every field is validated rather than trusted, and a repository name that
 * could not exist under a served root is refused here — a grant that can never
 * match is a typo, and a typo in an authorization file is worth a startup
 * failure rather than a silent lack of access.
 *
 * @param text - The file's contents.
 * @returns The grants, or null when the text is not a valid token list.
 */
export function parseTokenText(text: string): readonly StoredToken[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const tokens: StoredToken[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const token = record.token;
    const repository = record.repository;
    const access = record.access;
    if (typeof token !== "string" || token.length === 0 || token.includes(" ")) return null;
    if (typeof repository !== "string" || !isServedRepositoryName(repository)) return null;
    if (access !== "read" && access !== "write") return null;
    tokens.push({ token, repository, access });
  }
  return tokens;
}

/**
 * Extracts the bearer secret from an Authorization header.
 *
 * Only the one spelling is accepted — `Bearer` with exactly one space — because
 * every other spelling is a client this server did not authorize, and the
 * answer to an unauthorized client must not depend on how close it got.
 *
 * @param header - The Authorization header as presented, or its absence.
 * @returns The token, or null when the header is not a bearer token.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([^ ]+)$/.exec(header);
  return match === null ? null : match[1] ?? null;
}

/** A running served repository root. */
export interface ServeHandle {
  /** The host the server bound. */
  readonly host: string;
  /** The port the server bound; `0` was replaced by an ephemeral one. */
  readonly port: number;
  /** Stops the server and forgets every upload session. */
  close(): Promise<void>;
}

/** Everything `startRepositoryServer` needs to serve one root. */
export interface ServeOptions {
  /** Directory whose immediate and nested subdirectories are the repositories. */
  readonly root: string;
  /** Host to bind. */
  readonly host: string;
  /** Port to bind; `0` chooses an ephemeral one. */
  readonly port: number;
  /** Token grants, or null to serve every repository readable and writable. */
  readonly grants?: TokenGrants | null;
  /** Bounds to apply; defaults to {@link DEFAULT_SERVE_LIMITS}. */
  readonly limits?: ServeLimits;
}

/**
 * One repository being served, holding the upload sessions it has open.
 *
 * A session is a `FileTransport` — the same object a local push holds — so the
 * resumable-upload semantics are the transport's own: objects a session
 * verified and the receiver lacked are reported by that session's publication,
 * and cleared on every publication attempt, refused ones included, exactly as
 * a local connection would clear them.
 */
class ServedRepository {
  /** Transport for ordinary, connectionless requests. */
  private readonly main: FileTransport;

  /** Absolute path to the repository, kept for opening session transports. */
  private readonly path: string;

  /** Transport per upload session, insertion-ordered so the oldest evicts first. */
  private readonly sessions: Map<string, FileTransport> = new Map();

  /**
   * @param url - Token-free URL for messages and the operation log.
   * @param path - Absolute path to the repository's working tree root.
   */
  constructor(url: string, path: string) {
    this.main = new FileTransport(url, path);
    this.path = path;
  }

  /**
   * The transport serving requests that carry their objects with them.
   *
   * @returns The repository's shared transport.
   */
  transport(): FileTransport {
    return this.main;
  }

  /**
   * The transport one upload session should use, opening a session on demand.
   *
   * The session count is bounded rather than trusted: a client that opened
   * sessions without publishing would otherwise grow the map without end, and
   * the memory a server commits to one caller is a bound the server owns.
   *
   * @param session - The session id the client presented. An absent or empty
   *   one opens a session that will be reported by no receipt, which is also
   *   how a publication after a server restart reads.
   * @param maxSessions - Bound on open sessions for this repository.
   * @returns The session's transport.
   */
  uploadSession(session: string, maxSessions: number): FileTransport {
    const existing = this.sessions.get(session);
    if (existing !== undefined) {
      // Re-inserting moves the key to the end, so eviction order is
      // least-recently-used rather than first-opened.
      this.sessions.delete(session);
      this.sessions.set(session, existing);
      return existing;
    }
    while (this.sessions.size >= maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) break;
      this.sessions.delete(oldest.value);
    }
    const fresh = new FileTransport(this.main.url, this.path);
    this.sessions.set(session, fresh);
    return fresh;
  }
}

/**
 * Starts serving the repositories under one root.
 *
 * The server is the transport, not a second implementation of it: every
 * repository operation is delegated to a `FileTransport` opened on the joined
 * path, so the fast-forward rules, the compare-and-swap publication and the
 * verified arrival of objects are the receiving side's own code — the same code
 * that answers a local push.
 *
 * @param options - Root to serve, address to bind, grants and bounds.
 * @returns The bound server.
 * @throws ObjectStoreError When the root is not a directory.
 */
export function startRepositoryServer(options: ServeOptions): Promise<ServeHandle> {
  const root = resolve(options.root);
  try {
    if (!statSync(root).isDirectory()) {
      throw new ObjectStoreError(
        "not_a_serve_root",
        `${root} is not a directory, so no repository can be served under it. Pass a directory with --root.`,
      );
    }
  } catch (error) {
    // An absent or unreadable root is the operator's --root spelled wrong, and a
    // raw filesystem error would name the syscall rather than the decision.
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError(
      "not_a_serve_root",
      `${root} cannot be read as a directory, so no repository can be served under it. Pass a directory with --root.`,
    );
  }
  const limits = options.limits ?? DEFAULT_SERVE_LIMITS;
  const grants = options.grants ?? null;
  const repositories = new Map<string, ServedRepository>();
  const server = createServer((request, response) => {
    void handleServedRequest(request, response, { root, grants, limits, repositories });
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", (error) => rejectListen(error));
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolveListen({
        host: options.host,
        port,
        close: () => closeServer(server, repositories),
      } satisfies ServeHandle);
    });
  });
}

/**
 * Stops a served root, forgetting its sessions before its socket.
 *
 * @param server - The bound server.
 * @param repositories - The per-repository holders to forget.
 * @returns Resolves once the server no longer accepts connections.
 */
async function closeServer(server: Server, repositories: Map<string, ServedRepository>): Promise<void> {
  repositories.clear();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      // A second close of an already-closed server reports `ERR_SERVER_NOT_RUNNING`,
      // which is the caller's double-stop and reaches it as a rejection.
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

/** Everything one request needs, shared between the server and its handlers. */
interface ServeContext {
  /** The served root, already resolved absolute. */
  readonly root: string;
  /** Token grants, or null when serving without authorization. */
  readonly grants: TokenGrants | null;
  /** Bounds in force. */
  readonly limits: ServeLimits;
  /** One repository holder per repository name, holding its upload sessions. */
  readonly repositories: Map<string, ServedRepository>;
}

/** The outcome one served request is answered with. */
interface ServedResponse {
  /** HTTP status to answer with. */
  readonly status: number;
  /** Exact bytes to answer with. */
  readonly body: Buffer;
  /** Content type the bytes carry. */
  readonly contentType: string;
}

/**
 * Answers one served request, or the one denial answer.
 *
 * Order is the security property: the path names a repository and an endpoint
 * first; then authorization decides; only then is the body read and any
 * repository touched. A request that fails before authorization succeeds is
 * answered with the fixed denial bytes and its body is never read, so neither
 * a repository's existence nor anything about its content can be learned from
 * the difference between two refusals.
 *
 * @param request - The incoming request.
 * @param response - The response the outcome is written to.
 * @param context - The server's shared state.
 */
async function handleServedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServeContext,
): Promise<void> {
  let outcome: ServedResponse;
  try {
    outcome = await routeServedRequest(request, context);
  } catch (error) {
    outcome = error instanceof ObjectStoreError
      ? {
        // A body past the bound is refused with the status that names it, so a
        // client sizing its retries can distinguish "send less" from "send right".
        status: error.code === "body_too_large" ? BODY_TOO_LARGE_STATUS : BAD_REQUEST_STATUS,
        body: encodeErrorBody(error.code, error.message),
        contentType: JSON_CONTENT_TYPE,
      }
      : {
        status: INTERNAL_ERROR_STATUS,
        body: encodeErrorBody("internal_error", "The server failed to answer the request."),
        contentType: JSON_CONTENT_TYPE,
      };
  }
  response.statusCode = outcome.status;
  response.setHeader("content-type", outcome.contentType);
  response.setHeader("content-length", String(outcome.body.length));
  // A request whose body was refused is never drained: Node closes its
  // connection once the response is flushed, so a refused client cannot hold a
  // slot by streaming a body nobody will read.
  response.end(outcome.body);
}

/**
 * Routes one request to authorization, bounds and the transport.
 *
 * @param request - The incoming request.
 * @param context - The server's shared state.
 * @returns The status, body and content type to answer with.
 */
async function routeServedRequest(request: IncomingMessage, context: ServeContext): Promise<ServedResponse> {
  const parsed = request.url === undefined ? null : splitServedPath(request.url.split("?")[0] ?? "");
  if (request.method !== "POST" || parsed === null || !isServedRepositoryName(parsed.repository)) {
    return denial();
  }
  const repository = parsed.repository;
  const access = context.grants === null
    ? "write" as TokenAccess
    : context.grants.scope(bearerToken(request.headers.authorization) ?? "", repository);
  if (access === null) return denial();
  if (isWriteEndpoint(parsed.endpoint) && access !== "write") {
    return { status: FORBIDDEN_STATUS, body: FORBIDDEN_BODY, contentType: JSON_CONTENT_TYPE };
  }
  const served = openServedRepository(context, repository);
  const body = await readBoundedBody(request, context.limits.maxBodyBytes);
  return dispatchServedRequest(served, parsed.endpoint, body, context);
}

/**
 * The one denial answer, with its fixed status, type and bytes.
 *
 * @returns The response to every refusal a caller may not learn from.
 */
function denial(): ServedResponse {
  return { status: DENIED_STATUS, body: DENIED_BODY, contentType: JSON_CONTENT_TYPE };
}

/**
 * Opens the served repository a request addressed.
 *
 * The repository is opened lazily per request by the transport, so a directory
 * that appears after the server started is served without a restart, and one
 * that is not a repository is reported by the transport as unreachable — the
 * same answer a configured path that holds none produces locally.
 *
 * @param context - The server's shared state.
 * @param repository - The validated repository name.
 * @returns The repository holder.
 */
function openServedRepository(context: ServeContext, repository: string): ServedRepository {
  const existing = context.repositories.get(repository);
  if (existing !== undefined) return existing;
  const path = join(context.root, ...repository.split("/"));
  const served = new ServedRepository(`http://served/${repository}`, path);
  context.repositories.set(repository, served);
  return served;
}

/**
 * Reads one request body up to the configured bound.
 *
 * The bound is checked before the first byte is buffered when the client stated
 * a length, and again while the bytes arrive, so a client that lies about its
 * length — or omits it — meets the same ceiling.
 *
 * @param request - The request whose body is being read.
 * @param maxBytes - The bound in force.
 * @returns The body bytes.
 * @throws ObjectStoreError With code `body_too_large` when the bound is exceeded.
 */
function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) {
    return Promise.reject(new ObjectStoreError("body_too_large", "The request body exceeds the bound this server accepts."));
  }
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        // The rest of the body is left unread on purpose: draining it would
        // commit the server's memory to a size the bound just refused, and the
        // response flush below ends the connection either way.
        rejectBody(new ObjectStoreError("body_too_large", "The request body exceeds the bound this server accepts."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", (error) => rejectBody(error));
  });
}

/**
 * Performs the transport operation one authorized request asks for.
 *
 * Every branch delegates to a `FileTransport`, so the policies — closure checks,
 * fast-forward, compare-and-swap, re-hashing on arrival — are the same code a
 * local push runs, and a refusal reads the same over the wire.
 *
 * @param served - The repository being addressed.
 * @param endpoint - The endpoint suffix the request path ended with.
 * @param body - The authorized, bounded request body.
 * @param context - The server's shared state.
 * @returns The status, body and content type to answer with.
 * @throws ObjectStoreError With code `bad_request` when the body does not hold
 *   the endpoint's request; with code `limit_exceeded` when a count bound is
 *   exceeded; with the transport's own codes when the operation is refused.
 */
async function dispatchServedRequest(
  served: ServedRepository,
  endpoint: string,
  body: Buffer,
  context: ServeContext,
): Promise<ServedResponse> {
  const limits = context.limits;
  if (endpoint === ADVERTISE_ENDPOINT) {
    const advertisement = await served.transport().advertise();
    return { status: 200, body: Buffer.from(`${JSON.stringify(advertisement)}\n`, "utf8"), contentType: JSON_CONTENT_TYPE };
  }
  if (endpoint === MISSING_ENDPOINT) {
    const request = decodeWireObject(body);
    const ids = request === null ? null : decodeMissingRequest(request);
    if (ids === null) throw new ObjectStoreError("bad_request", "The request does not hold a well-formed object list.");
    const missing = await served.transport().missingObjects(ids);
    return { status: 200, body: Buffer.from(encodeMissingResponse(missing), "utf8"), contentType: JSON_CONTENT_TYPE };
  }
  if (endpoint === UPLOAD_ENDPOINT) {
    const request = decodeWireObject(body);
    const upload = request === null ? null : decodeUploadRequest(request);
    if (upload === null) throw new ObjectStoreError("bad_request", "The request does not hold a well-formed object upload.");
    if (upload.objects.length > limits.maxUploadObjects) throw limitExceeded(`An upload may carry at most ${limits.maxUploadObjects} objects.`);
    const session = served.uploadSession(upload.session, limits.maxSessions);
    await session.uploadObjects(upload.objects.map((object) => ({
      id: object.id,
      type: object.type,
      payload: Buffer.from(object.payload, "base64"),
    })));
    return { status: 200, body: Buffer.from(`${JSON.stringify({ received: upload.objects.length })}\n`, "utf8"), contentType: JSON_CONTENT_TYPE };
  }
  const request = decodeWireObject(body);
  if (request === null) throw new ObjectStoreError("bad_request", `The ${endpoint} request body is not a JSON object.`);
  if (endpoint === FETCH_ENDPOINT) {
    const fetchRequest = decodeFetchRequest(request);
    if (fetchRequest === null) throw new ObjectStoreError("bad_request", "The fetch request does not hold a well-formed ref and have list.");
    if (fetchRequest.refs.length > limits.maxFetchRefs) throw limitExceeded(`A fetch may name at most ${limits.maxFetchRefs} refs.`);
    if (fetchRequest.haves.length > limits.maxFetchHaves) throw limitExceeded(`A fetch may offer at most ${limits.maxFetchHaves} haves.`);
    const bundle = await served.transport().fetch(fetchRequest.refs, fetchRequest.haves);
    return { status: 200, body: bundle, contentType: BUNDLE_CONTENT_TYPE };
  }
  if (endpoint === PUSH_ENDPOINT || endpoint === PUBLISH_ENDPOINT) {
    return await dispatchRefMoves(served, endpoint, request, context);
  }
  throw new ObjectStoreError("bad_request", `The server does not serve the endpoint ${endpoint}.`);
}

/**
 * Performs a whole push, or a publication after a resumable upload.
 *
 * The two share every check the transport makes; they differ only in how the
 * objects arrive — inside the request for a push, ahead of it for a publish —
 * and in which transport instance reports the deliveries, which is the session.
 *
 * @param served - The repository being addressed.
 * @param endpoint - `push` or `publish`.
 * @param request - The decoded request object.
 * @param context - The server's shared state.
 * @returns The status, body and content type to answer with.
 * @throws ObjectStoreError With code `bad_request` when the request is malformed,
 *   with code `limit_exceeded` when a count bound is exceeded, or with the
 *   transport's own refusal codes.
 */
async function dispatchRefMoves(
  served: ServedRepository,
  endpoint: string,
  request: Record<string, unknown>,
  context: ServeContext,
): Promise<ServedResponse> {
  const updates = decodePushUpdates(request, "updates");
  const force = request.force === true;
  const now = decodeWireDate(request, "now");
  if (updates === null) throw new ObjectStoreError("bad_request", `The ${endpoint} request does not name well-formed ref moves.`);
  if (now === null) throw new ObjectStoreError("bad_request", `The ${endpoint} request does not carry a timestamp.`);
  if (updates.length > context.limits.maxUpdates) throw limitExceeded(`A ${endpoint} may move at most ${context.limits.maxUpdates} refs.`);
  if (endpoint === PUSH_ENDPOINT) {
    const encoded = request.bundle;
    if (typeof encoded !== "string") throw new ObjectStoreError("bad_request", "The push request does not carry a bundle.");
    const receipt = await served.transport().push(Buffer.from(encoded, "base64"), updates, force, now);
    return { status: 200, body: Buffer.from(encodePushReceipt(receipt), "utf8"), contentType: JSON_CONTENT_TYPE };
  }
  const session = typeof request.session === "string" ? request.session : "";
  const receipt = await served.uploadSession(session, context.limits.maxSessions).publish(updates, force, now);
  return { status: 200, body: Buffer.from(encodePushReceipt(receipt), "utf8"), contentType: JSON_CONTENT_TYPE };
}

/**
 * Builds the refusal a count bound produces.
 *
 * @param message - The bound the request exceeded, in the caller's words.
 * @returns The error to answer with.
 */
function limitExceeded(message: string): ObjectStoreError {
  return new ObjectStoreError("limit_exceeded", `${message} Split the request, or ask the operator to raise the bound.`);
}
