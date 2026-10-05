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
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { parseBundle } from "./bundle.ts";
import { ObjectStoreError } from "./objects.ts";
import { FileTransport } from "./transport.ts";
import { isServableRepositoryDirectory, ServedRepositoryDirectories } from "./served-repositories.ts";
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
  OBJECT_FETCH_ENDPOINT,
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
    if (typeof token !== "string" || !/^[!-~]+$/.test(token)) return null;
    if (typeof repository !== "string" || (repository !== "" && !isServedRepositoryName(repository))) return null;
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
  return match === null ? null : match[1];
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
  /** Repository directory, or a parent holding immediate and nested repositories. */
  readonly root: string;
  /** Host to bind. */
  readonly host: string;
  /** Port to bind; `0` chooses an ephemeral one. */
  readonly port: number;
  /** Token grants, or null to serve every repository readable and writable. */
  readonly grants?: TokenGrants | null;
  /** Bounds to apply; defaults to {@link DEFAULT_SERVE_LIMITS}. */
  readonly limits?: ServeLimits;
  /** Response hooks; defaults to none. */
  readonly hooks?: ServeHooks | null;
}

/**
 * Observability hooks a server caller can attach to a running server.
 *
 * They see what a request was answered with, not what it asked for: the push has
 * already landed by the time the hook runs, which is exactly the window real
 * concurrency lives in — the remote has accepted, and its answer is still in
 * flight. Tests use the hook to hold one answer open while the world moves on
 * around it; an operator's monitoring can use it to observe the same window.
 */
export interface ServeHooks {
  /**
   * Called after a request's outcome is decided and before it is written.
   *
   * The repository operation has already completed, so awaiting this hook
   * delays the response — never the work — and never changes what the caller
   * receives.
   *
   * @param repository - The repository name the request addressed.
   * @param endpoint - The endpoint the request addressed.
   */
  holdResponse(repository: string, endpoint: string): Promise<void> | void;
}

/**
 * One upload session: the transport that reports its receipts, and what it has
 * been charged with since its last publication.
 *
 * The charge is cumulative rather than per request, because the memory it
 * bounds is too: a reused session keeps every receipt it accepted until it
 * publishes, so per-request bounds alone would leave its delivery receipts free
 * to grow without end while every individual request passes them.
 */
interface UploadSession {
  /** The transport whose receipts this session reports. */
  readonly transport: FileTransport;
  /** Objects accepted across every upload since the last publication. */
  objects: number;
  /** Decoded object bytes accepted across every upload since the last publication. */
  bytes: number;
}

/**
 * One repository being served, holding the upload sessions it has open.
 *
 * A session is a `FileTransport` — the same object a local push holds — so the
 * resumable-upload semantics are the transport's own: objects a session
 * verified and the receiver lacked are reported by that session's publication,
 * and cleared on every publication attempt, refused ones included, exactly as
 * a local connection would clear them. The cumulative charge below is cleared
 * with them, because the memory it bounds is the receipts themselves.
 */
class ServedRepository {
  /** Transport for ordinary, connectionless requests. */
  private readonly main: FileTransport;

  /** Absolute path to the repository, kept for opening session transports. */
  private readonly path: string;

  /** Upload session state per session id, insertion-ordered so the oldest evicts first. */
  private readonly sessions: Map<string, UploadSession> = new Map();

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
   * The session one upload should use, opening a session on demand.
   *
   * The session count is bounded rather than trusted: a client that opened
   * sessions without publishing would otherwise grow the map without end, and
   * the memory a server commits to one caller is a bound the server owns.
   *
   * @param session - The session id the client presented. An absent or empty
   *   one opens a session that will be reported by no receipt, which is also
   *   how a publication after a server restart reads.
   * @param maxSessions - Bound on open sessions for this repository.
   * @returns The session's state, transport and charge.
   */
  uploadSession(session: string, maxSessions: number): UploadSession {
    const existing = this.sessions.get(session);
    if (existing !== undefined) {
      // Re-inserting moves the key to the end, so eviction order is
      // least-recently-used rather than first-opened — reuse alone cannot
      // release what a session has been charged with, which is why the
      // cumulative bounds below exist.
      this.sessions.delete(session);
      this.sessions.set(session, existing);
      return existing;
    }
    while (this.sessions.size >= maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value as string);
    }
    const fresh: UploadSession = { transport: new FileTransport(this.main.url, this.path), objects: 0, bytes: 0 };
    this.sessions.set(session, fresh);
    return fresh;
  }

  /**
   * Charges one upload to a session's cumulative bounds.
   *
   * Every uploaded object counts, whether or not the receiver already held it:
   * the charge bounds what a session may ask the server to hold at its next
   * publication, and the request has already asked for all of it.
   *
   * @param session - The session id the upload named.
   * @param state - The session's state, from {@link ServedRepository.uploadSession}.
   * @param objects - Object count the upload carries.
   * @param bytes - Decoded object bytes the upload carries.
   * @param limits - Bounds in force.
   * @returns True when the upload fits. False past either bound, with the
   *   session released so its receipts — the memory the bound is for — are
   *   dropped rather than held by a caller that has just been told to stop.
   */
  chargeUpload(session: string, state: UploadSession, objects: number, bytes: number, limits: ServeLimits): boolean {
    if (state.objects + objects > limits.maxSessionObjects || state.bytes + bytes > limits.maxSessionBytes) {
      this.sessions.delete(session);
      return false;
    }
    state.objects += objects;
    state.bytes += bytes;
    return true;
  }

  /**
   * Clears a session's charge when publication clears its receipts.
   *
   * Publication reports and drops the session's delivery receipts on every
   * attempt, refused ones included, so the memory the cumulative bound guards
   * is already gone — and the charge with it.
   *
   * @param state - The session that just attempted a publication.
   */
  settlePublication(state: UploadSession): void {
    state.objects = 0;
    state.bytes = 0;
  }
}

/**
 * Starts serving the repositories under one root.
 *
 * The server is the transport, not a second implementation of it: every
 * repository operation is delegated to a `FileTransport` opened on a discovered
 * catalogue directory, so the fast-forward rules, compare-and-swap publication and
 * verified arrival of objects are the receiving side's own code — the same code
 * that answers a local push.
 *
 * @param options - Root to serve, address to bind, grants and bounds.
 * @returns The bound server.
 * @throws ObjectStoreError When the root is not a directory.
 */
export function startRepositoryServer(options: ServeOptions): Promise<ServeHandle> {
  let root = resolve(options.root);
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
  root = realpathSync(root);
  const limits = options.limits ?? DEFAULT_SERVE_LIMITS;
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ObjectStoreError("bad_limits", "Server limits must be positive safe integers.");
  }
  const grants = options.grants ?? null;
  const hooks = options.hooks ?? null;
  const directories = new ServedRepositoryDirectories(root);
  const repositories = new Map<string, ServedRepository>();
  const server = createServer((request, response) => {
    void handleServedRequest(request, response, { directories, grants, hooks, limits, repositories });
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", (error) => rejectListen(error));
    server.listen(options.port, options.host, () => {
      // A successful TCP listen callback always carries the bound TCP address.
      const port = (server.address() as AddressInfo).port;
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
  /** Repository paths discovered independently of all request names. */
  readonly directories: ServedRepositoryDirectories;
  /** Token grants, or null when serving without authorization. */
  readonly grants: TokenGrants | null;
  /** Response hooks, or null when serving without any. */
  readonly hooks: ServeHooks | null;
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
  const parsed = splitServedPath((request.url as string).split("?")[0]);
  let outcome: ServedResponse;
  try {
    outcome = await routeServedRequest(request, parsed, context);
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
  // The work is done; only the answer is still unsent. Holding here — an
  // observability hook, or a test recreating a slow wire — delays the response
  // without changing it, which is the one window real concurrency can be
  // observed in.
  if (parsed !== null) await context.hooks?.holdResponse(parsed.repository, parsed.endpoint);
  response.sendDate = false;
  response.setHeader("connection", "close");
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
 * @param parsed - The request's repository and endpoint, or null when the
 *   path names neither.
 * @param context - The server's shared state.
 * @returns The status, body and content type to answer with.
 */
async function routeServedRequest(
  request: IncomingMessage,
  parsed: { repository: string; endpoint: string } | null,
  context: ServeContext,
): Promise<ServedResponse> {
  if (request.method !== "POST" || parsed === null || (parsed.repository !== "" && !isServedRepositoryName(parsed.repository))) {
    return denial();
  }
  const repository = parsed.repository;
  const access = context.grants === null
    ? "write" as TokenAccess
    : context.grants.scope(bearerToken(request.headers.authorization) ?? "", repository);
  if (access === null) return denial();
  const served = openServedRepository(context, repository);
  if (served === null) return denial();
  if (isWriteEndpoint(parsed.endpoint) && access !== "write") {
    return { status: FORBIDDEN_STATUS, body: FORBIDDEN_BODY, contentType: JSON_CONTENT_TYPE };
  }
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
 * Request text is only a catalogue key. Unknown names may cause a rate-limited
 * scan, whose filesystem paths are independent of that key. Revalidation uses
 * the catalogue value and refuses stores replaced by aliases after discovery.
 *
 * @param context - The server's shared state.
 * @param repository - The validated repository name.
 * @returns The repository holder, or null for the fixed denial response.
 */
function openServedRepository(context: ServeContext, repository: string): ServedRepository | null {
  const path = context.directories.lookup(repository);
  if (path === undefined || !isServableRepositoryDirectory(path)) {
    context.repositories.delete(repository);
    return null;
  }
  const existing = context.repositories.get(repository);
  if (existing !== undefined) return existing;
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
  if (endpoint === MISSING_ENDPOINT || endpoint === OBJECT_FETCH_ENDPOINT) {
    const request = decodeWireObject(body);
    const ids = request === null ? null : decodeMissingRequest(request);
    if (ids === null) throw new ObjectStoreError("bad_request", "The request does not hold a well-formed object list.");
    if (ids.length > limits.maxUploadObjects) throw limitExceeded(`An object query may name at most ${limits.maxUploadObjects} objects.`);
    if (endpoint === OBJECT_FETCH_ENDPOINT) {
      const bundle = await served.transport().fetchObjects(ids);
      return { status: 200, body: bundle, contentType: BUNDLE_CONTENT_TYPE };
    }
    const missing = await served.transport().missingObjects(ids);
    return { status: 200, body: Buffer.from(encodeMissingResponse(missing), "utf8"), contentType: JSON_CONTENT_TYPE };
  }
  if (endpoint === UPLOAD_ENDPOINT) {
    const request = decodeWireObject(body);
    const upload = request === null ? null : decodeUploadRequest(request);
    if (upload === null) throw new ObjectStoreError("bad_request", "The request does not hold a well-formed object upload.");
    if (upload.objects.length > limits.maxUploadObjects) throw limitExceeded(`An upload may carry at most ${limits.maxUploadObjects} objects.`);
    const objects = upload.objects.map((object) => ({
      id: object.id,
      type: object.type,
      payload: Buffer.from(object.payload, "base64"),
    }));
    const bytes = objects.reduce((total, object) => total + object.payload.length, 0);
    const state = served.uploadSession(upload.session, limits.maxSessions);
    // Cumulative, not per request: a reused session keeps every receipt it has
    // accepted since its last publication, so per-request bounds alone cannot
    // stop one caller growing that memory without end. Past either bound the
    // refusal releases the session's receipts with it, so the caller that is
    // told to stop is not the one left holding them.
    if (!served.chargeUpload(upload.session, state, objects.length, bytes, limits)) {
      throw limitExceeded(
        `An upload session may accept at most ${limits.maxSessionObjects} objects and ${limits.maxSessionBytes} object bytes `
        + "before it publishes, and this session has reached one of them. Publish, then resume with a fresh session.",
      );
    }
    await state.transport.uploadObjects(objects);
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
  // The path splitter admits only known endpoints; the remaining two move refs.
  return await dispatchRefMoves(served, endpoint, request, context);
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
    const bundle = Buffer.from(encoded, "base64");
    if (parseBundle(bundle).header.objects.length > context.limits.maxUploadObjects) throw limitExceeded(`A push may carry at most ${context.limits.maxUploadObjects} objects.`);
    const receipt = await served.transport().push(bundle, updates, force, now);
    return { status: 200, body: Buffer.from(encodePushReceipt(receipt), "utf8"), contentType: JSON_CONTENT_TYPE };
  }
  const session = typeof request.session === "string" ? request.session : "";
  const state = served.uploadSession(session, context.limits.maxSessions);
  try {
    const receipt = await state.transport.publish(updates, force, now);
    return { status: 200, body: Buffer.from(encodePushReceipt(receipt), "utf8"), contentType: JSON_CONTENT_TYPE };
  } finally {
    // Publication clears the session's receipts on every attempt, refused ones
    // included, so the charge that bounds them clears with them.
    served.settlePublication(state);
  }
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
