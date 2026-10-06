// The HTTP client transport: a remote repository on the other end of a socket.
//
// This class adds no policy of its own. It turns the `Transport` operations into
// the wire vocabulary from `engine/http-protocol.ts` and turns the answers back,
// so `fetchFrom`, `pushTo` and `cloneFrom` — which negotiate capabilities, build
// bundles and move tracking refs — run against a served repository without
// knowing it is one. Bearer credentials are passed separately from printable URLs.

import { redactRemoteUrl, redactUserinfo, splitRemoteCredentials } from "./credentials.ts";
import { parseBundle } from "./bundle.ts";

import { randomBytes } from "node:crypto";

import { parseConfig, type RepositoryConfig } from "./config.ts";

import { type ObjectId, isObjectId, ObjectStoreError } from "./objects.ts";
import type { Advertisement, PushReceipt, PushUpdate, TransferObject, Transport } from "./transport.ts";
import {
  ADVERTISE_ENDPOINT,
  assertWireSuccess,
  decodePushReceipt,
  decodeWireObject,
  encodeFetchRequest,
  encodeMissingRequest,
  encodePublishRequest,
  encodePushRequest,
  encodeUploadRequest,
  FETCH_ENDPOINT,
  isLoopbackHostname,
  MISSING_ENDPOINT,
  OBJECT_FETCH_ENDPOINT,
  PUBLISH_ENDPOINT,
  PUSH_ENDPOINT,
  UPLOAD_ENDPOINT,
} from "./http-protocol.ts";

/** Round-trip deadlines used when connecting to a served peer. */
export interface HttpTransportOptions {
  /** Milliseconds to wait for one round trip before giving up on the remote. */
  readonly timeoutMs?: number;
  /** Bearer credential resolved by the caller; overrides URL userinfo. */
  readonly token?: string | null;
}

/** A successful round trip's raw answer. */
interface WireAnswer {
  /** HTTP status the server answered with. */
  readonly status: number;
  /** The response body as received. */
  readonly payload: Buffer;
}

/**
 * A remote repository served over HTTP.
 *
 * @throws ObjectStoreError From every operation, with the code the receiver
 *   chose — so a served refusal carries the same code and message a local one
 *   would, and an unreachable or slow server is reported as an unreachable
 *   remote rather than as a network exception.
 */
export class HttpTransport implements Transport {
  /** The URL the remote was configured with, kept for messages. */
  readonly url: string;

  /** The origin the requests go to, `scheme://host:port`. */
  private readonly origin: string;

  /** The repository path every endpoint hangs off, no trailing slash. */
  private readonly base: string;

  /** The bearer secret from the URL's userinfo, or null when there is none. */
  private readonly token: string | null;

  /** Milliseconds one round trip may take. */
  private readonly timeoutMs: number;

  /** The session id resumable uploads are grouped under. */
  private readonly session: string;

  /**
   * @param url - The remote's configured location: `http://…` or `https://…`.
   * @param options - Construction options, all optional.
   * @throws ObjectStoreError When the URL is not an HTTP(S) URL, or when a
   *   non-empty bearer token would travel over plain `http://` to a host that
   *   is not loopback.
   */
  constructor(url: string, options: HttpTransportOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ObjectStoreError(
        "unsupported_transport",
        `${redactRemoteUrl(url)} is not a URL this build can reach. Use http://host:port/repository.`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ObjectStoreError(
        "unsupported_transport",
        `${redactRemoteUrl(url)} names the protocol "${parsed.protocol.replace(":", "")}", which the HTTP transport does not speak. Use http or https.`,
      );
    }
    this.token = options.token ?? splitRemoteCredentials(url).token;
    // A bearer token sent over plain `http://` is a credential handed to every
    // observer on the wire between this machine and the remote, so the one host
    // set for which cleartext is acceptable is loopback — this machine talking
    // to itself. Everywhere else the token travels only under TLS.
    if (this.token !== null && this.token !== "" && parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      throw new ObjectStoreError(
        "unsupported_transport",
        `${redactRemoteUrl(url)} would send a bearer token in cleartext over plain http to a host that is not loopback. Use https:// for this remote, or a tokenless http:// remote.`,
      );
    }
    parsed.username = "";
    parsed.password = "";
    this.url = parsed.href;
    this.origin = parsed.origin;
    this.base = parsed.pathname.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 300_000;
    // One id per transport, so a resumed upload reports the same session's
    // deliveries and a second transport is a second session — the same shape a
    // local connection has, where a second FileTransport reports its own arrivals.
    this.session = randomBytes(16).toString("hex");
  }

  /**
   * Performs one POST round trip.
   *
   * @param endpoint - The endpoint suffix under the repository base.
   * @param body - The JSON request body.
   * @returns The status and body the server answered with.
   * @throws ObjectStoreError With code `unreachable_remote` when the server
   *   cannot be reached or does not answer in time.
   */
  private async roundTrip(endpoint: string, body: string): Promise<WireAnswer> {
    let response: Response;
    let payload: Buffer;
    try {
      response = await fetch(`${this.origin}${this.base}/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      payload = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // A timeout and a refused connection are both "the remote did not
      // answer", but naming which one saves the next agent a round of guessing.
      throw new ObjectStoreError(
        "unreachable_remote",
        `${this.url} did not answer a request for ${endpoint}: `
        + `${(error as Error).name === "TimeoutError" ? "the remote timed out" : "the connection failed"}. `
        + "Check the remote's URL, or whether the repository is being served.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      let message = redactUserinfo(payload.toString("utf8"));
      if (this.token !== null && this.token !== "") {
        for (const secret of new Set([this.token, encodeURIComponent(this.token)])) message = message.split(secret).join("[redacted]");
      }
      payload = Buffer.from(message);
    }
    return { status: response.status, payload };
  }

  /**
   * Reads the remote's advertisement.
   *
   * @returns Its refs, the branch its HEAD names, its record configuration,
   *   format version and capabilities.
   */
  async advertise(): Promise<Advertisement> {
    const answer = await this.roundTrip(ADVERTISE_ENDPOINT, "{}\n");
    assertWireSuccess(answer.status, answer.payload, this.url);
    const decoded = decodeWireObject(answer.payload);
    const refs = decoded === null ? null : decoded.refs;
    const head = decoded === null ? undefined : decoded.head;
    const config = decoded === null ? undefined : decoded.config;
    const formatVersion = decoded === null ? undefined : decoded.formatVersion;
    const capabilities = decoded === null ? undefined : decoded.capabilities;
    if (
      decoded === null || !Array.isArray(refs)
      || refs.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry)
        || typeof (entry as Record<string, unknown>).name !== "string"
        || typeof (entry as Record<string, unknown>).target !== "string"
        || !isObjectId((entry as Record<string, unknown>).target as string))
      || (head !== null && typeof head !== "string")
      || config === null || typeof config !== "object" || Array.isArray(config)
      || typeof formatVersion !== "string"
      || !Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string")
    ) {
      throw new ObjectStoreError(
        "unreachable_remote",
        `${this.url} advertised itself with a shape this build cannot read. Check the remote's URL, or whether the server is a served repository.`,
      );
    }
    // Clone stores the advertised config verbatim, so it is normalized and
    // validated here exactly as a config read from disk would be: `{}` gains
    // its defaults, and a malformed field is refused before anything is cloned.
    let normalized: RepositoryConfig;
    try {
      normalized = parseConfig(config);
    } catch (error) {
      throw new ObjectStoreError(
        "unreachable_remote",
        `${this.url} advertised a repository configuration this build cannot use: ${(error as Error).message}`,
      );
    }
    return {
      refs: refs.map((entry) => {
        const record = entry as Record<string, unknown>;
        return { name: record.name as string, target: record.target as string };
      }),
      head,
      config: normalized,
      formatVersion,
      capabilities: capabilities as readonly string[],
    };
  }

  /**
   * Fetches the history behind some of the remote's refs.
   *
   * @param refNames - Full ref names to transfer. Empty means every branch and tag.
   * @param haves - Commits the caller offers as already held.
   * @returns A bundle carrying the objects the caller is missing.
   */
  async fetch(refNames: readonly string[], haves: readonly ObjectId[]): Promise<Buffer> {
    const answer = await this.roundTrip(FETCH_ENDPOINT, encodeFetchRequest(refNames, haves));
    assertWireSuccess(answer.status, answer.payload, this.url);
    parseBundle(answer.payload);
    return answer.payload;
  }

  /** Fetch standalone objects and verify every claimed id before returning bytes. */
  async fetchObjects(ids: readonly ObjectId[]): Promise<Buffer> {
    const answer = await this.roundTrip(OBJECT_FETCH_ENDPOINT, encodeMissingRequest(ids));
    assertWireSuccess(answer.status, answer.payload, this.url);
    parseBundle(answer.payload);
    return answer.payload;
  }

  /**
   * Sends history and asks the remote to move refs onto it.
   *
   * @param bundle - Objects the remote may be missing.
   * @param updates - The ref moves being requested.
   * @param force - Whether to allow a move that discards commits the remote has.
   * @param now - Timestamp recorded in the remote's operation log.
   * @returns What moved and what was stored.
   */
  async push(bundle: Buffer, updates: readonly PushUpdate[], force: boolean, now: Date): Promise<PushReceipt> {
    const answer = await this.roundTrip(PUSH_ENDPOINT, encodePushRequest(bundle, updates, force, now));
    assertWireSuccess(answer.status, answer.payload, this.url);
    return this.receipt(answer.payload, PUSH_ENDPOINT);
  }

  /**
   * Asks the receiver which of the offered objects it still lacks.
   *
   * @param ids - Object ids the sender intends to transfer.
   * @returns The subset the receiver does not hold, in the order offered.
   */
  async missingObjects(ids: readonly ObjectId[]): Promise<readonly ObjectId[]> {
    const answer = await this.roundTrip(MISSING_ENDPOINT, encodeMissingRequest(ids));
    assertWireSuccess(answer.status, answer.payload, this.url);
    const decoded = decodeWireObject(answer.payload);
    const missing = decoded === null ? undefined : decoded.missing;
    if (!Array.isArray(missing) || missing.some((id) => typeof id !== "string" || !isObjectId(id))) {
      throw new ObjectStoreError(
        "unreachable_remote",
        `${this.url} answered a missing-objects request with a shape this build cannot read.`,
      );
    }
    return missing as readonly ObjectId[];
  }

  /**
   * Streams objects into the receiver's store, each verified on arrival.
   *
   * Verification is the receiver's job, so this side sends the claimed id and the
   * bytes and lets the receiver refuse the pair when they disagree.
   *
   * @param objects - The objects to transfer.
   */
  async uploadObjects(objects: readonly TransferObject[]): Promise<void> {
    const answer = await this.roundTrip(UPLOAD_ENDPOINT, encodeUploadRequest(this.session, objects));
    assertWireSuccess(answer.status, answer.payload, this.url);
  }

  /**
   * Publishes ref moves after an object upload, refusing until the closure is complete.
   *
   * @param updates - The ref moves being requested.
   * @param force - Whether to allow a move that discards commits the remote has.
   * @param now - Timestamp recorded in the remote's operation log.
   * @returns What moved and what was stored.
   */
  async publish(updates: readonly PushUpdate[], force: boolean, now: Date): Promise<PushReceipt> {
    const answer = await this.roundTrip(PUBLISH_ENDPOINT, encodePublishRequest(this.session, updates, force, now));
    assertWireSuccess(answer.status, answer.payload, this.url);
    return this.receipt(answer.payload, PUBLISH_ENDPOINT);
  }

  /**
   * Reads a push receipt the server answered with.
   *
   * @param payload - The received response body.
   * @param endpoint - The endpoint it came from, for the failure message.
   * @returns The receipt, with wire-shaped updates restored to `PushUpdate`s.
   * @throws ObjectStoreError When the receipt's shape is unreadable.
   */
  private receipt(payload: Buffer, endpoint: string): PushReceipt {
    const decoded = decodeWireObject(payload);
    const receipt = decoded === null ? null : decodePushReceipt(decoded);
    if (receipt === null) {
      throw new ObjectStoreError(
        "unreachable_remote",
        `${this.url} answered a ${endpoint} with a shape this build cannot read.`,
      );
    }
    return { updated: receipt.updated, added: receipt.added };
  }
}