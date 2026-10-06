// The served repository's own rules: one denial for everything a caller may
// not learn from, bounds that leave the repository untouched, and a name rule
// that keeps a request inside the served root.
//
// Every request here goes over a real socket on an ephemeral loopback port —
// `fetch` and `node:http` against a listening server, never a mock of either —
// because the properties under test are wire properties: which bytes leave the
// server, and what they can and cannot tell apart.

import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { exportBundle } from "../engine/bundle.ts";
import { afterEach, test } from "node:test";

import { hashObject, ObjectStoreError } from "../engine/objects.ts";
import {
  bearerToken,
  isAcceptableHost,
  parseTokenText,
  readTokenFile,
  startRepositoryServer,
  TokenGrants,
  type ServeHandle,
} from "../engine/serve.ts";
import {
  DEFAULT_SERVE_LIMITS,
  DENIED_BODY,
  DENIED_STATUS,
  FORBIDDEN_BODY,
  FORBIDDEN_STATUS,
  isServedRepositoryName,
  splitServedPath,
} from "../engine/http-protocol.ts";
import { Repository } from "../engine/repo.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const handles: Array<{ root: string; cleanup(): void }> = [];
const servers: ServeHandle[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (handles.length > 0) handles.pop()?.cleanup();
});

const author = { name: "A", email: "a@b", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date("2026-09-01T00:00:00.000Z");

/**
 * Creates an empty temporary directory that is cleaned up after the test.
 *
 * @returns Its absolute path.
 */
function tempRoot(): string {
  const handle = makeTempDir();
  handles.push(handle);
  return handle.root;
}

/**
 * Initialises a repository in a fresh temporary directory.
 *
 * @returns The repository.
 */
function freshRepo(): Repository {
  return Repository.init(tempRoot(), "main");
}

/**
 * Writes a file, stages it and commits, returning the new commit.
 *
 * @param repository - Repository to commit in.
 * @param path - Repository-relative path to write.
 * @param text - Contents to write.
 * @returns The commit id.
 */
function commitFile(repository: Repository, path: string, text: string): string {
  const absolute = join(repository.root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
  repository.stage([path]);
  return repository.commit({ message: `add ${path}\n`, author }, now);
}

/**
 * Starts a server for a freshly seeded repository root.
 *
 * @param options - Grants, limits and the open-writes override to serve with,
 * over an open loopback server. Writes stay open by default because these
 * tests exercise the dispatch and bounds machinery, not the read-only guard —
 * which has its own tests below.
 * @returns The running server and the root it serves.
 */
async function serveRoot(
  options: {
    grants?: TokenGrants | null;
    limits?: Parameters<typeof startRepositoryServer>[0]["limits"];
    unauthenticatedWrites?: boolean;
  } = {},
): Promise<{ server: ServeHandle; root: string; repository: Repository }> {
  const root = tempRoot();
  const repository = Repository.init(join(root, "repo"));
  commitFile(repository, "a.txt", "one");
  const server = await startRepositoryServer({
    root,
    host: "127.0.0.1",
    port: 0,
    grants: options.grants ?? null,
    limits: options.limits,
    unauthenticatedWrites: options.unauthenticatedWrites ?? true,
  });
  servers.push(server);
  return { server, root, repository };
}

/**
 * Performs one raw HTTP request against the served server.
 *
 * @param server - Where to send the request.
 * @param path - The request path exactly as it will appear on the wire, so
 *   traversal spellings survive the client's URL normalization.
 * @param options - Method, authorization header, and body. `chunked` sends the
 *   body in pieces with no content-length, the way a client that lies about
 *   size does.
 * @returns The status and the raw response bytes.
 */
function rawRequest(
  server: ServeHandle,
  path: string,
  options: {
    method?: string;
    authorization?: string;
    body?: string;
    chunked?: readonly string[];
    headers?: Record<string, string>;
    connectHost?: string;
  } = {},
): Promise<{ status: number; body: Buffer; wire: Buffer }> {
  // Raw TCP preserves hostile request-target bytes under both Node and Bun.
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect({ host: options.connectHost ?? server.host, port: server.port });
    const chunks: Buffer[] = [];
    socket.on("error", rejectRequest);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const wire = Buffer.concat(chunks);
      const separator = wire.indexOf("\r\n\r\n");
      resolveRequest({ status: Number(wire.toString("utf8", 0, separator).split(" ")[1]), body: wire.subarray(separator + 4), wire });
    });
    socket.on("connect", () => {
      const headers: Record<string, string> = { host: `127.0.0.1:${server.port}`, connection: "close", ...options.headers };
      // The real client always declares JSON, so a request carrying a body does
      // too; a test may still override the header to shape a hostile request.
      if ((options.body !== undefined || options.chunked !== undefined) && headers["content-type"] === undefined) {
        headers["content-type"] = "application/json";
      }
      if (options.authorization !== undefined) headers.authorization = options.authorization;
      let body: string;
      if (options.chunked === undefined) {
        body = options.body ?? "";
        headers["content-length"] = String(Buffer.byteLength(body));
      } else {
        headers["transfer-encoding"] = "chunked";
        body = options.chunked.map((chunk) => `${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`).join("") + "0\r\n\r\n";
      }
      // A test may name a header with an empty value to omit it entirely — the
      // one way to send a request with no Host header, which raw sockets allow.
      const written = Object.entries(headers).filter(([, value]) => value !== "");
      socket.write(`${options.method ?? "POST"} ${path} HTTP/1.1\r\n${written.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${body}`);
    });
  });
}

test("the grants file parser refuses what it cannot honor", () => {
  // Valid entries parse, in both access levels.
  assert.notEqual(parseTokenText(JSON.stringify([
    { token: "secret-a", repository: "repo", access: "write" },
    { token: "secret-b", repository: "tenant/repo", access: "read" },
  ])), null);
  // Every field is validated: a malformed file must fail at startup rather than
  // at the first request it wrongly answers.
  // An empty list is a valid file — the serve command refuses it as an open
  // server with a closed intent, and the parser's job is only the shape.
  assert.deepEqual(parseTokenText("[]"), []);
  for (const bad of [
    "not json",
    "{}",
    JSON.stringify([{ token: "", repository: "repo", access: "read" }]),
    JSON.stringify([{ token: "a b", repository: "repo", access: "read" }]),
    JSON.stringify([{ token: "secret", repository: "..", access: "read" }]),
    JSON.stringify([{ token: "secret", repository: "repo", access: "admin" }]),
    JSON.stringify([{ token: "secret", repository: "repo" }]),
    JSON.stringify(["unexpected"]),
  ]) {
    assert.equal(parseTokenText(bad), null, bad);
  }
  // A token filed twice keeps the wider grant, so one entry cannot quietly
  // downgrade another.
  const grants = new TokenGrants(parseTokenText(JSON.stringify([
    { token: "secret", repository: "repo", access: "write" },
    { token: "secret", repository: "repo", access: "read" },
  ])) ?? []);
  assert.equal(grants.scope("secret", "repo"), "write");
  assert.equal(grants.scope("secret", "other"), null);
  assert.equal(grants.isEmpty(), false);
});

test("a bearer header accepts exactly one spelling", () => {
  assert.equal(bearerToken("Bearer secret"), "secret");
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken("secret"), null);
  assert.equal(bearerToken("bearer secret"), null);
  assert.equal(bearerToken("Bearer  secret"), null);
  assert.equal(bearerToken("Bearer secret extra"), null);
});

test("repository names are canonical catalogue keys or are refused", () => {
  assert.equal(isServedRepositoryName("repo"), true);
  assert.equal(isServedRepositoryName("tenant/repo"), true);
  assert.equal(isServedRepositoryName("repo-1.2_3"), true);
  for (const refused of [
    "",
    "..",
    ".",
    "a/../b",
    "a//b",
    "a/",
    "/a",
    "a\\b",
    "a b",
    "..%2f",
    "%2e%2e",
    "a/b/../c",
    ".hidden",
    "x".repeat(129),
  ]) {
    assert.equal(isServedRepositoryName(refused), false, refused);
  }
});

test("a served path names a repository and an endpoint, or nothing", () => {
  assert.deepEqual(splitServedPath("/repo/advertise"), { repository: "repo", endpoint: "advertise" });
  assert.deepEqual(splitServedPath("/tenant/repo/objects/missing"), { repository: "tenant/repo", endpoint: "objects/missing" });
  assert.deepEqual(splitServedPath("/repo/push"), { repository: "repo", endpoint: "push" });
  assert.equal(splitServedPath("/repo/unknown"), null);
  assert.equal(splitServedPath("/"), null);
});

test("every refusal a caller may not learn from answers with the same bytes", async () => {
  // Two tenants: the served root holds tenant-a's repository and tenant-b's,
  // and each token reaches exactly one.
  const root = tempRoot();
  const tenantA = Repository.init(join(root, "tenant-a"));
  commitFile(tenantA, "a.txt", "one");
  const tenantB = Repository.init(join(root, "tenant-b"));
  commitFile(tenantB, "b.txt", "one");
  const nameA = tenantA.root.slice(root.length + 1);
  const nameB = tenantB.root.slice(root.length + 1);
  const grants = new TokenGrants(parseTokenText(JSON.stringify([
    { token: "secret-a", repository: nameA, access: "write" },
    { token: "secret-b", repository: nameB, access: "read" },
    { token: "secret-a", repository: "absent-scoped", access: "read" },
  ])) ?? []);
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0, grants });
  servers.push(server);

  // The control: with the right token, the repository answers. Everything
  // below refuses, and the point of the test is that no two of them differ.
  const allowed = await rawRequest(server, `/${nameA}/advertise`, { authorization: "Bearer secret-a" });
  assert.equal(allowed.status, 200);

  const cases: Array<[string, string, Parameters<typeof rawRequest>[2]]> = [
    ["no token", `/${nameA}/advertise`, {}],
    ["malformed header", `/${nameA}/advertise`, { authorization: "Bearer" }],
    ["unknown token", `/${nameA}/advertise`, { authorization: "Bearer not-a-token" }],
    ["wrong tenant", `/${nameB}/advertise`, { authorization: "Bearer secret-a" }],
    ["absent scoped repository", "/absent-scoped/advertise", { authorization: "Bearer secret-a" }],
    ["absent scoped write", "/absent-scoped/push", { authorization: "Bearer secret-a" }],
    ["missing repository", "/no-such-repo/advertise", { authorization: "Bearer secret-a" }],
    ["raw dot-dot traversal", "/../outside/advertise", { authorization: "Bearer secret-a" }],
    ["mid-path traversal", `/${nameA}/../outside/advertise`, { authorization: "Bearer secret-a" }],
    ["encoded traversal", "/%2e%2e/outside/advertise", { authorization: "Bearer secret-a" }],
    ["encoded slash traversal", "/%2e%2e%2foutside/advertise", { authorization: "Bearer secret-a" }],
    ["absolute target", "http://example.invalid/tenant-a/advertise", { authorization: "Bearer secret-a" }],
    ["absolute filesystem path", "/%2foutside/advertise", { authorization: "Bearer secret-a" }],
    ["encoded NUL", "/tenant-a%00/advertise", { authorization: "Bearer secret-a" }],
    ["encoded backslash", "/tenant-a%5coutside/advertise", { authorization: "Bearer secret-a" }],
    ["double slash", `//${nameA}/advertise`, { authorization: "Bearer secret-a" }],
    ["backslash name", "/a\\b/advertise", { authorization: "Bearer secret-a" }],
    ["get method", `/${nameA}/advertise`, { method: "GET", authorization: "Bearer secret-a" }],
    ["unknown endpoint", `/${nameA}/not-an-endpoint`, { authorization: "Bearer secret-a" }],
    ["no path", "/", { authorization: "Bearer secret-a" }],
  ];
  for (const endpoint of ["fetch", "push", "objects/missing", "objects/upload", "objects/fetch", "publish"]) {
    cases.push([`wrong tenant ${endpoint}`, `/${nameB}/${endpoint}`, { authorization: "Bearer secret-a", body: "invalid" }]);
  }
  const answers = await Promise.all(cases.map(([, path, options]) => rawRequest(server, path, options)));
  for (const [index, [label]] of cases.entries()) {
    assert.equal(answers[index]?.status, DENIED_STATUS, `${label}: wrong status`);
    assert.ok(answers[index]?.body.equals(DENIED_BODY), `${label}: wrong body bytes`);
    assert.deepEqual(answers[index]?.wire, answers[0]?.wire, `${label}: unequal response bytes`);
  }

  // The traversal attempts reached nothing outside the served root: the
  // sibling repository's branch is where it started, and an "outside" path the
  // URL seemed to name was never opened.
  assert.equal(tenantA.refs.read("refs/heads/main") !== null, true);
  assert.equal(tenantB.refs.read("refs/heads/main") !== null, true);
});

test("a read grant may fetch but not write, and the refusal names the token not the repository", async () => {
  const root = tempRoot();
  const tenantA = Repository.init(join(root, "tenant-a"));
  commitFile(tenantA, "a.txt", "one");
  const name = tenantA.root.slice(root.length + 1);
  const grants = new TokenGrants(parseTokenText(JSON.stringify([
    { token: "reader", repository: name, access: "read" },
  ])) ?? []);
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0, grants });
  servers.push(server);

  const read = await rawRequest(server, `/${name}/advertise`, { authorization: "Bearer reader" });
  assert.equal(read.status, 200);
  const written = await rawRequest(server, `/${name}/objects/upload`, {
    authorization: "Bearer reader",
    body: JSON.stringify({ session: "s", objects: [] }),
  });
  // The caller can already prove the repository exists by advertising it, so
  // this answer is allowed to say which of the two things to fix — and must
  // still be distinct from the denial, or a caller could not tell a read-only
  // token from a wrong one.
  assert.equal(written.status, FORBIDDEN_STATUS);
  assert.ok(written.body.equals(FORBIDDEN_BODY));
});

test("a body past the bound is refused with nothing buffered or stored", async () => {
  const { server, repository } = await serveRoot({
    limits: { maxBodyBytes: 512, maxFetchRefs: 4, maxFetchHaves: 4, maxUpdates: 2, maxUploadObjects: 2, maxSessions: 2, maxSessionObjects: 8, maxSessionBytes: 1024 * 1024 },
  });
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  const before = repository.refs.read("refs/heads/main");

  // Declared length past the bound: refused before the first byte is read.
  const declared = await rawRequest(server, `/${name}/fetch`, {
    body: JSON.stringify({ refs: [`refs/heads/${"branch-".repeat(80)}`], haves: [] }),
  });
  assert.equal(declared.status, 413);
  assert.match(declared.body.toString("utf8"), /body_too_large/);
  assert.equal(repository.refs.read("refs/heads/main"), before);

  // A count bound past its ceiling is refused with the count named.
  const tooManyRefs = await rawRequest(server, `/${name}/fetch`, {
    body: JSON.stringify({ refs: ["r1", "r2", "r3", "r4", "r5"], haves: [] }),
  });
  assert.equal(tooManyRefs.status, 400);
  assert.match(tooManyRefs.body.toString("utf8"), /limit_exceeded/);

  const tooManyHaves = await rawRequest(server, `/${name}/fetch`, {
    body: JSON.stringify({ refs: [], haves: ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)] }),
  });
  assert.equal(tooManyHaves.status, 400);
  assert.match(tooManyHaves.body.toString("utf8"), /limit_exceeded/);

  const tooManyUpdates = await rawRequest(server, `/${name}/publish`, {
    body: JSON.stringify({
      session: "s",
      updates: [
        { ref: "refs/heads/one", expected: null, next: "a".repeat(64) },
        { ref: "refs/heads/two", expected: null, next: "b".repeat(64) },
        { ref: "refs/heads/three", expected: null, next: "c".repeat(64) },
      ],
      force: false,
      now: 0,
    }),
  });
  assert.equal(tooManyUpdates.status, 400);
  assert.match(tooManyUpdates.body.toString("utf8"), /limit_exceeded/);

  const tooManyObjects = await rawRequest(server, `/${name}/objects/upload`, {
    body: JSON.stringify({
      session: "s",
      objects: [
        { id: "a".repeat(64), type: "blob", payload: "eHg=" },
        { id: "b".repeat(64), type: "blob", payload: "eXk=" },
        { id: "c".repeat(64), type: "blob", payload: "eno=" },
      ],
    }),
  });
  assert.equal(tooManyObjects.status, 400);
  assert.match(tooManyObjects.body.toString("utf8"), /limit_exceeded/);

  // A chunked body with no declared length meets the same ceiling while it
  // arrives — the bound cannot depend on the client's honesty about size.
  const oversizedRef = `refs/heads/${"branch-".repeat(80)}`;
  const chunked = await rawRequest(server, `/${name}/fetch`, {
    chunked: [JSON.stringify({ refs: [oversizedRef], haves: [] }).slice(0, 100), "x".repeat(500)],
  });
  assert.equal(chunked.status, 413);
  assert.match(chunked.body.toString("utf8"), /body_too_large/);

  // A malformed body on an authorized request names the request, not the tenant.
  const malformed = await rawRequest(server, `/${name}/fetch`, { body: "not json" });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.toString("utf8"), /bad_request/);

  // Nothing above wrote a ref or an object.
  assert.equal(repository.refs.read("refs/heads/main"), before);
});

test("an upload session is bounded and its oldest eviction reports an empty receipt, not a lost one", async () => {
  const { server, repository } = await serveRoot({
    limits: { maxBodyBytes: 1024 * 1024, maxFetchRefs: 4, maxFetchHaves: 4, maxUpdates: 2, maxUploadObjects: 100, maxSessions: 1, maxSessionObjects: 100, maxSessionBytes: 1024 * 1024 },
  });
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  const tip = repository.refs.read("refs/heads/main");

  const first = await rawRequest(server, `/${name}/objects/upload`, {
    body: JSON.stringify({ session: "one", objects: [] }),
  });
  assert.equal(first.status, 200);
  // Opening a second session evicts the first, so a later publication under
  // the first session id reports what the surviving session delivered — the
  // same answer a restart would give, and never objects someone else sent.
  const second = await rawRequest(server, `/${name}/objects/upload`, {
    body: JSON.stringify({ session: "two", objects: [] }),
  });
  assert.equal(second.status, 200);
  const publish = await rawRequest(server, `/${name}/publish`, {
    body: JSON.stringify({
      session: "one",
      updates: [{ ref: "refs/heads/main", expected: tip, next: tip }],
      force: true,
      now: 0,
    }),
  });
  assert.equal(publish.status, 200);
  assert.deepEqual(JSON.parse(publish.body.toString("utf8")).added, []);
  assert.equal(repository.refs.read("refs/heads/main"), tip);
});

test("one reused upload session's receipts are bounded cumulatively and released past the bound", async () => {
  // Every individual request below is legal: one object, well inside every
  // per-request bound. The adversarial caller reuses one session so it never
  // evicts, and never publishes, so its delivery receipts would grow without
  // end without the cumulative charge.
  const { server, repository } = await serveRoot({
    limits: {
      maxBodyBytes: 1024 * 1024, maxFetchRefs: 4, maxFetchHaves: 4, maxUpdates: 2, maxUploadObjects: 4, maxSessions: 4,
      maxSessionObjects: 3, maxSessionBytes: 24,
    },
  });
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  const tip = repository.refs.read("refs/heads/main");

  /** Hashes one fresh blob and encodes it exactly as the wire expects. */
  const freshBlob = (text: string) => {
    const payload = Buffer.from(text, "utf8");
    return { id: hashObject("blob", payload), type: "blob" as const, payload: payload.toString("base64") };
  };
  const upload = (session: string, objects: ReturnType<typeof freshBlob>[]) =>
    rawRequest(server, `/${name}/objects/upload`, { body: JSON.stringify({ session, objects }) });

  // Two legal requests charge the session past its cumulative object bound; the
  // third is refused with the count bound named, and nothing it carried landed.
  const one = freshBlob("one");
  const two = freshBlob("two");
  const three = freshBlob("three");
  const four = freshBlob("four");
  assert.equal((await upload("session", [one, two])).status, 200);
  const objectRefusal = await upload("session", [three, four]);
  assert.equal(objectRefusal.status, 400);
  assert.match(objectRefusal.body.toString("utf8"), /limit_exceeded/);
  assert.equal(repository.objects.has(three.id), false, "the refused upload stored nothing");
  assert.equal(repository.objects.has(four.id), false, "the refused upload stored nothing");

  // The refusal released the session's receipts with the session: publishing
  // under the same id answers as a fresh session — an empty receipt — so the
  // two delivered objects are not held anywhere for a later receipt to name.
  const publish = await rawRequest(server, `/${name}/publish`, {
    body: JSON.stringify({
      session: "session",
      updates: [{ ref: "refs/heads/main", expected: tip, next: tip }],
      force: true,
      now: 0,
    }),
  });
  assert.equal(publish.status, 200);
  assert.deepEqual(JSON.parse(publish.body.toString("utf8")).added, []);

  // A second session runs the byte bound aground the same way: fresh objects,
  // each request legal alone, and the charge passing the byte ceiling is
  // refused with the same shape.
  const five = freshBlob("f".repeat(10));
  const six = freshBlob("s".repeat(10));
  const seven = freshBlob("v".repeat(10));
  assert.equal((await upload("wide", [five, six])).status, 200);
  const byteRefusal = await upload("wide", [seven]);
  assert.equal(byteRefusal.status, 400);
  assert.match(byteRefusal.body.toString("utf8"), /limit_exceeded/);
  assert.equal(repository.objects.has(seven.id), false);

  // Publication clears the charge with the receipts, so a session that
  // publishes is not one the cumulative bound strands: the same id accepts a
  // full charge again afterwards.
  const eight = freshBlob("eight");
  const nine = freshBlob("nine");
  assert.equal((await upload("reset", [eight])).status, 200);
  const settle = await rawRequest(server, `/${name}/publish`, {
    body: JSON.stringify({
      session: "reset",
      updates: [{ ref: "refs/heads/main", expected: tip, next: tip }],
      force: true,
      now: 0,
    }),
  });
  assert.equal(settle.status, 200);
  assert.deepEqual(JSON.parse(settle.body.toString("utf8")).added, [eight.id]);
  assert.equal((await upload("reset", [nine])).status, 200);
});

test("a server refuses a root that is not a directory and a tokens file it cannot read", async () => {
  assert.throws(
    () => { void startRepositoryServer({ root: join(tempRoot(), "absent"), host: "127.0.0.1", port: 0 }); },
    (error: unknown) => error instanceof ObjectStoreError && error.code === "not_a_serve_root",
  );
  assert.throws(
    () => readTokenFile(join(tempRoot(), "absent-tokens.json")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_auth_file",
  );
  const tokenPath = join(tempRoot(), "tokens.json");
  writeFileSync(tokenPath, "{");
  assert.throws(
    () => readTokenFile(tokenPath),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_auth_file",
  );
});

test("closing a served root stops it, and closing twice reports the double stop", async () => {
  const { server, repository } = await serveRoot();
  servers.pop();
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  const alive = await rawRequest(server, `/${name}/advertise`);
  assert.equal(alive.status, 200);
  await server.close();
  await assert.rejects(
    () => server.close(),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING",
  );
  await assert.rejects(
    () => rawRequest(server, `/${name}/advertise`),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ECONNREFUSED",
  );
});
test("filesystem aliases cannot make one tenant serve another tenant's repository", async () => {
  const root = tempRoot();
  const outside = freshRepo();
  commitFile(outside, "private.txt", "private");
  symlinkSync(outside.root, join(root, "alias"), "junction");
  const local = Repository.init(join(root, "local"));
  symlinkSync(outside.controlDirectory, join(root, "control"), "junction");
  mkdirSync(join(root, "linked"));
  symlinkSync(outside.controlDirectory, join(root, "linked", ".pmvcs"), "junction");
  const instance = join(root, "instance");
  outside.linkInstance("served", instance);
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0 });
  servers.push(server);
  for (const name of ["alias", "linked", "instance", "absent"]) {
    const answer = await rawRequest(server, `/${name}/advertise`);
    assert.ok(answer.body.equals(DENIED_BODY));
  }
  rmSync(join(local.controlDirectory, "HEAD"));
  symlinkSync(join(outside.controlDirectory, "HEAD"), join(local.controlDirectory, "HEAD"));
  assert.ok((await rawRequest(server, "/local/advertise")).body.equals(DENIED_BODY));
  rmSync(join(local.controlDirectory, "HEAD"));
  writeFileSync(join(local.controlDirectory, "HEAD"), "ref: refs/heads/main\n");
  const owned = await rawRequest(server, "/local/advertise");
  assert.equal(owned.status, 200);
  assert.equal(local.refs.read("refs/heads/main"), null);
});

test("new nested repositories are discovered on a bounded miss and replaced paths stay denied", async () => {
  const root = tempRoot();
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0 });
  servers.push(server);
  Repository.init(join(root, "tenant", "new"));
  const absent = await rawRequest(server, "/unknown/advertise");
  assert.equal((await rawRequest(server, "/tenant/new/advertise")).wire.toString(), absent.wire.toString());
  await new Promise<void>((resolve) => { setTimeout(resolve, 1_100); });
  assert.equal((await rawRequest(server, "/tenant/new/advertise")).status, 200);
  renameSync(join(root, "tenant"), join(root, "saved"));
  const outside = freshRepo();
  const privateRepository = Repository.init(join(outside.root, "new"));
  const privateTip = commitFile(privateRepository, "private.txt", "private");
  symlinkSync(outside.root, join(root, "tenant"), "junction");
  const replaced = await rawRequest(server, "/tenant/new/advertise");
  assert.equal(replaced.status, absent.status);
  assert.ok(replaced.body.equals(absent.body));
  assert.equal(privateRepository.refs.read("refs/heads/main"), privateTip);
});

test("all operation envelopes and object counts are bounded before publication", async () => {
  const { server, repository } = await serveRoot({ limits: { maxBodyBytes: 4096, maxFetchRefs: 2, maxFetchHaves: 2, maxUpdates: 2, maxUploadObjects: 2, maxSessions: 2, maxSessionObjects: 8, maxSessionBytes: 4096 } });
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  const id = "a".repeat(64);
  for (const [endpoint, body] of [
    ["objects/missing", "null"], ["objects/fetch", JSON.stringify({ ids: [id, id, id] })],
    ["objects/upload", "{}"], ["objects/upload", "null"], ["fetch", "[]"], ["fetch", "{}"],
    ["push", JSON.stringify({ updates: [], now: 0 })],
    ["push", JSON.stringify({ updates: [], now: 0, bundle: "bad" })],
    ["publish", JSON.stringify({ updates: [], now: "bad" })],
    ["publish", JSON.stringify({ updates: "bad", now: 0 })],
  ]) {
    const answer = await rawRequest(server, `/${name}/${endpoint}`, { body });
    assert.equal(answer.status, 400, `${endpoint}: ${answer.body}`);
  }
  const oversizedBundle = await rawRequest(server, `/${name}/push`, { body: JSON.stringify({ bundle: exportBundle(repository.objects, repository.refs, []).toString("base64"), updates: [], now: 0 }) });
  assert.equal(oversizedBundle.status, 400);
  assert.match(oversizedBundle.body.toString(), /limit_exceeded/);
  // The header's object list is only the sender's claim; the object lines are
  // what would be stored. A header that declares none cannot smuggle the same
  // objects past the bound.
  const [format, rawHeader, ...objectLines] = exportBundle(repository.objects, repository.refs, []).toString("utf8").split("\n");
  const understated = [format, JSON.stringify({ ...(JSON.parse(rawHeader) as Record<string, unknown>), objects: [] }), ...objectLines].join("\n");
  const smuggled = await rawRequest(server, `/${name}/push`, { body: JSON.stringify({ bundle: Buffer.from(understated, "utf8").toString("base64"), updates: [], now: 0 }) });
  assert.equal(smuggled.status, 400);
  assert.match(smuggled.body.toString(), /limit_exceeded/);
  assert.equal((await rawRequest(server, `/${name}/publish`, { body: JSON.stringify({ updates: [], now: 0 }) })).status, 200);
  assert.throws(() => startRepositoryServer({ root: tempRoot(), host: "127.0.0.1", port: 0, limits: { ...DEFAULT_SERVE_LIMITS, maxSessions: 0 } }), { code: "bad_limits" });
  await assert.rejects(startRepositoryServer({ root: tempRoot(), host: "127.0.0.1", port: server.port }), { code: "EADDRINUSE" });
});

test("non-directory roots, malformed files and unexpected I/O failures fail closed", async () => {
  const fixture = tempRoot();
  const file = join(fixture, "file");
  writeFileSync(file, "file");
  assert.throws(() => startRepositoryServer({ root: file, host: "127.0.0.1", port: 0 }), { code: "not_a_serve_root" });
  const { server, repository } = await serveRoot();
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  rmSync(join(repository.controlDirectory, "oplog.jsonl"));
  mkdirSync(join(repository.controlDirectory, "oplog.jsonl"));
  const answer = await rawRequest(server, `/${name}/publish`, { body: JSON.stringify({ updates: [], now: 0 }) });
  assert.equal(answer.status, 500);
  assert.match(answer.body.toString(), /internal_error/);
});

test("browser-shaped requests cannot reach an endpoint: no cross-site write, no rebound read", async () => {
  // A served repository is an agent transport, not a web service. Three
  // browser shapes are refused with the fixed denial, before authorization
  // has anything to say, so no two of them can be told apart either.
  const { server, repository } = await serveRoot();
  const name = repository.root.slice(join(repository.root, "..").length + 1);
  const tip = repository.refs.read("refs/heads/main");

  // The control: an ordinary client's request answers.
  const allowed = await rawRequest(server, `/${name}/advertise`, { body: "{}" });
  assert.equal(allowed.status, 200);

  // A page's cross-site POST carries Origin; no legitimate client does.
  const crossSite = await rawRequest(server, `/${name}/advertise`, { body: "{}", headers: { origin: "https://attacker.example" } });
  assert.equal(crossSite.status, DENIED_STATUS);
  assert.ok(crossSite.body.equals(DENIED_BODY));

  // A CORS "simple" request is the only shape a browser can send without a
  // preflight this server never answers — and its content type is not JSON,
  // so a cross-site page cannot write even to a server an operator left open.
  const simpleWrite = await rawRequest(server, `/${name}/push`, {
    body: JSON.stringify({ bundle: "", updates: [{ ref: "refs/heads/main", expected: tip, next: tip }], force: true, now: 0 }),
    headers: { "content-type": "text/plain" },
  });
  assert.equal(simpleWrite.status, DENIED_STATUS);
  assert.ok(simpleWrite.body.equals(DENIED_BODY));
  for (const endpoint of ["push", "objects/upload", "publish"]) {
    const absentType = await rawRequest(server, `/${name}/${endpoint}`);
    assert.equal(absentType.status, DENIED_STATUS);
    assert.ok(absentType.body.equals(DENIED_BODY));
  }

  // A parameterised JSON content type is the same type and is accepted.
  const parameterised = await rawRequest(server, `/${name}/publish`, {
    body: JSON.stringify({ updates: [], force: false, now: 0 }),
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(parameterised.status, 200);

  // A DNS-rebound page reads through a Host this server never bound. Only the
  // bound host's spellings answer: the loopback family on a loopback bind.
  for (const [label, host, expected] of [
    ["rebound name", "attacker.example:1234", DENIED_STATUS],
    // A request with no Host header is refused by the HTTP layer itself, with
    // its own 400; the point is that it never reaches an endpoint.
    ["no host", "", 400],
    ["loopback by name", `localhost:${server.port}`, 200],
    ["loopback by address with port", `127.0.0.1:${server.port}`, 200],
    ["loopback by address without port", "127.0.0.1", DENIED_STATUS],
    ["invalid numeric loopback", `127.999.0.1:${server.port}`, DENIED_STATUS],
    ["mapped loopback", `[::ffff:127.0.0.1]:${server.port}`, 200],
  ] as const) {
    const answer = await rawRequest(server, `/${name}/advertise`, {
      body: "{}",
      headers: { host },
    });
    assert.equal(answer.status, expected, `${label}: wrong status`);
    if (expected === DENIED_STATUS) assert.ok(answer.body.equals(DENIED_BODY), `${label}: wrong body`);
  }

  // Nothing above moved a ref: the refusal came before any repository byte.
  assert.equal(repository.refs.read("refs/heads/main"), tip);
});

test("an unauthenticated server is read-only unless the operator explicitly reopens writes", async () => {
  const readonly = await serveRoot({ unauthenticatedWrites: false });
  const name = readonly.repository.root.slice(join(readonly.repository.root, "..").length + 1);
  const tip = readonly.repository.refs.read("refs/heads/main");

  // Reads stay open: an operator who serves without --auth meant to serve reads.
  const read = await rawRequest(readonly.server, `/${name}/advertise`, { body: "{}" });
  assert.equal(read.status, 200);

  // Every mutating endpoint refuses, naming the reason rather than hiding
  // behind the missing-repository denial — existence is public on this server.
  for (const endpoint of ["push", "objects/upload", "publish"]) {
    const answer = await rawRequest(readonly.server, `/${name}/${endpoint}`, { body: JSON.stringify({ updates: [], now: 0, session: "s", objects: [] }) });
    assert.equal(answer.status, FORBIDDEN_STATUS, `${endpoint}: wrong status`);
    assert.match(answer.body.toString("utf8"), /accepts reads without a token/, `${endpoint}: wrong body`);
    assert.equal(answer.body.equals(DENIED_BODY), false);
  }
  assert.equal(readonly.repository.refs.read("refs/heads/main"), tip);

  // The same server with the override behaves as before the hardening.
  const open = await serveRoot();
  const openName = open.repository.root.slice(join(open.repository.root, "..").length + 1);
  const published = await rawRequest(open.server, `/${openName}/publish`, {
    body: JSON.stringify({ updates: [], force: false, now: 0 }),
  });
  assert.equal(published.status, 200);
});

test("repository names that read like endpoint suffixes resolve by catalogue, deepest first", async () => {
  // `tenant/objects` is a legitimate nested name, and `/tenant/objects/fetch`
  // reads two ways: repository `tenant/objects` with endpoint `fetch`, or
  // repository `tenant` with endpoint `objects/fetch`. Suffix-first matching
  // always picked the shorter repository, so the deeper one was unreachable.
  const root = tempRoot();
  const parent = Repository.init(join(root, "tenant"));
  const parentTip = commitFile(parent, "parent.txt", "parent");
  const nested = Repository.init(join(root, "tenant/objects"));
  const nestedTip = commitFile(nested, "nested.txt", "nested");
  const grants = new TokenGrants(parseTokenText(JSON.stringify([
    { token: "nested-reader", repository: "tenant/objects", access: "read" },
    { token: "parent-reader", repository: "tenant", access: "read" },
  ])) ?? []);
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0, grants });
  servers.push(server);

  // The nested repository answers advertise under its own name.
  const advertised = await rawRequest(server, "/tenant/objects/advertise", { authorization: "Bearer nested-reader", body: "{}" });
  assert.equal(advertised.status, 200, advertised.body.toString("utf8"));
  assert.equal(headTarget(advertised.body), nestedTip);

  // A token scoped to the nested repository reaches its colliding endpoints:
  // `/tenant/objects/fetch` is the nested repository's fetch under catalogue
  // resolution — under suffix-first matching it was the parent's object
  // endpoint, and a nested-scoped token was denied on it.
  const fetched = await rawRequest(server, "/tenant/objects/fetch", {
    authorization: "Bearer nested-reader",
    body: JSON.stringify({ refs: [], haves: [] }),
  });
  assert.equal(fetched.status, 200, fetched.body.toString("utf8"));
  // The nested repository's object endpoint remains reachable too.
  const missing = await rawRequest(server, "/tenant/objects/objects/missing", {
    authorization: "Bearer nested-reader",
    body: JSON.stringify({ ids: [parentTip] }),
  });
  assert.equal(missing.status, 200, missing.body.toString("utf8"));
  assert.deepEqual((JSON.parse(missing.body.toString("utf8")) as { missing: string[] }).missing, [parentTip]);

  // Catalogue selection precedes authorization: a parent-scoped token cannot
  // reinterpret the nested repository's fetch as the parent's object endpoint.
  const parentReach = await rawRequest(server, "/tenant/objects/fetch", {
    authorization: "Bearer parent-reader",
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(parentReach.status, DENIED_STATUS);
  assert.ok(parentReach.body.equals(DENIED_BODY));
  const denied = await rawRequest(server, "/tenant/advertise", {
    authorization: "Bearer nested-reader",
    body: JSON.stringify({ refs: [], haves: [] }),
  });
  assert.equal(denied.status, DENIED_STATUS);
  assert.ok(denied.body.equals(DENIED_BODY));
  // And no token at all reaches the nested repository's neighbour: a name the
  // catalogue does not hold is the fixed denial, whatever the suffix reading.
  const absent = await rawRequest(server, "/tenant/objects/other/objects/missing", {
    authorization: "Bearer nested-reader",
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(absent.status, DENIED_STATUS);
  assert.ok(absent.body.equals(DENIED_BODY));

  // A root-level repository named `objects` is reachable too: catalogue lookup
  // beats the suffix reading that would address the root's object endpoint.
  const objectRoot = tempRoot();
  const base = Repository.init(objectRoot);
  const baseTip = commitFile(base, "base.txt", "base");
  const named = Repository.init(join(objectRoot, "objects"));
  const namedTip = commitFile(named, "named.txt", "named");
  const objectServer = await startRepositoryServer({ root: objectRoot, host: "127.0.0.1", port: 0, grants: null, unauthenticatedWrites: true });
  servers.push(objectServer);
  const nestedAdvertise = await rawRequest(objectServer, "/objects/advertise", { body: "{}" });
  assert.equal(nestedAdvertise.status, 200);
  assert.equal(headTarget(nestedAdvertise.body), namedTip);
  const rootAdvertise = await rawRequest(objectServer, "/advertise", { body: "{}" });
  assert.equal(headTarget(rootAdvertise.body), baseTip);
  // The colliding fetch addresses the `objects` repository's history, not the
  // root repository's object endpoint.
  const nestedFetch = await rawRequest(objectServer, "/objects/fetch", { body: JSON.stringify({ refs: [], haves: [] }) });
  assert.equal(nestedFetch.status, 200);
});

/** The commit an advertisement names for `refs/heads/main`. */
function headTarget(body: Buffer): string {
  const refs = (JSON.parse(body.toString("utf8")) as { refs: { name: string; target: string }[] }).refs;
  return refs.find((entry) => entry.name === "refs/heads/main")?.target ?? "";
}

test("a wildcard bind accepts address literals in Host and refuses names a resolver must answer", async () => {
  // A bind on the wildcard serves addresses this host has; the clients that
  // reach it name one, and a DNS name in Host can only be a rebound page.
  const root = tempRoot();
  const repository = Repository.init(join(root, "repo"));
  commitFile(repository, "a.txt", "one");
  const server = await startRepositoryServer({ root, host: "0.0.0.0", port: 0, grants: null, unauthenticatedWrites: true });
  servers.push(server);
  for (const [label, host, expected] of [
    ["an IPv4 literal", `192.168.1.10:${server.port}`, 200],
    ["an IPv6 literal without port", "[fd00::10]", DENIED_STATUS],
    ["an IPv6 literal with port", `[fd00::10]:${server.port}`, 200],
    ["loopback by name", `localhost:${server.port}`, 200],
    ["a DNS name", "myserver.example", DENIED_STATUS],
    ["an unterminated IPv6 literal", "[::10", DENIED_STATUS],
  ] as const) {
    const answer = await rawRequest(server, "/repo/advertise", { body: "{}", headers: { host }, connectHost: "127.0.0.1" });
    assert.equal(answer.status, expected, `${label}: wrong status`);
    if (expected === DENIED_STATUS) assert.ok(answer.body.equals(DENIED_BODY), `${label}: wrong body`);
  }
});

test("a bind to a named host answers only its own name in Host", () => {
  // A bind to a hostname neither loopback nor wildcard is the one shape a
  // real test socket cannot cheaply produce; the decision table is checked
  // directly instead. The bound name answers, and nothing else does.
  const bound = { host: "serve.internal.example", port: 43210 };
  assert.equal(isAcceptableHost("serve.internal.example:43210", bound), true);
  assert.equal(isAcceptableHost("SERVE.INTERNAL.EXAMPLE:43210", bound), true);
  assert.equal(isAcceptableHost("127.0.0.1", bound), false);
  assert.equal(isAcceptableHost("attacker.example:43210", bound), false);
  assert.equal(isAcceptableHost(undefined, bound), false);
  for (const host of ["serve.internal.example", "serve.internal.example:80", "serve.internal.example:bad", "[::1]junk:43210", "[garbage]:43210", "[::1]:43211", "::1:43210"]) {
    assert.equal(isAcceptableHost(host, bound), false, host);
  }
  assert.equal(isAcceptableHost("serve.internal.example", { host: bound.host, port: 80 }), true);
  assert.equal(isAcceptableHost("serve.internal.example", { host: "127.0.0.1", port: 43210 }), false);
});
