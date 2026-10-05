// The served repository's own rules: one denial for everything a caller may
// not learn from, bounds that leave the repository untouched, and a name rule
// that keeps a request inside the served root.
//
// Every request here goes over a real socket on an ephemeral loopback port —
// `fetch` and `node:http` against a listening server, never a mock of either —
// because the properties under test are wire properties: which bytes leave the
// server, and what they can and cannot tell apart.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { exportBundle } from "../engine/bundle.ts";
import { afterEach, test } from "node:test";

import { ObjectStoreError } from "../engine/objects.ts";
import {
  bearerToken,
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
 * @param options - Grants and limits to serve with, over an open loopback server.
 * @returns The running server and the root it serves.
 */
async function serveRoot(
  options: { grants?: TokenGrants | null; limits?: Parameters<typeof startRepositoryServer>[0]["limits"] } = {},
): Promise<{ server: ServeHandle; root: string; repository: Repository }> {
  const repository = freshRepo();
  commitFile(repository, "a.txt", "one");
  const root = join(repository.root, "..");
  const server = await startRepositoryServer({
    root,
    host: "127.0.0.1",
    port: 0,
    grants: options.grants ?? null,
    limits: options.limits,
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
  } = {},
): Promise<{ status: number; body: Buffer; wire: Buffer }> {
  // Raw TCP preserves hostile request-target bytes under both Node and Bun.
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect({ host: server.host, port: server.port });
    const chunks: Buffer[] = [];
    socket.on("error", rejectRequest);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const wire = Buffer.concat(chunks);
      const separator = wire.indexOf("\r\n\r\n");
      resolveRequest({ status: Number(wire.toString("utf8", 0, separator).split(" ")[1]), body: wire.subarray(separator + 4), wire });
    });
    socket.on("connect", () => {
      const headers: Record<string, string> = { host: "127.0.0.1", connection: "close", ...options.headers };
      if (options.authorization !== undefined) headers.authorization = options.authorization;
      let body: string;
      if (options.chunked === undefined) {
        body = options.body ?? "";
        headers["content-length"] = String(Buffer.byteLength(body));
      } else {
        headers["transfer-encoding"] = "chunked";
        body = options.chunked.map((chunk) => `${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`).join("") + "0\r\n\r\n";
      }
      socket.write(`${options.method ?? "POST"} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${body}`);
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

test("repository names join onto the root or are refused before anything is joined", () => {
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
  const tenantA = freshRepo();
  commitFile(tenantA, "a.txt", "one");
  const tenantB = freshRepo();
  commitFile(tenantB, "b.txt", "one");
  const root = join(tenantA.root, "..");
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
  const tenantA = freshRepo();
  commitFile(tenantA, "a.txt", "one");
  const root = join(tenantA.root, "..");
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
    limits: { maxBodyBytes: 512, maxFetchRefs: 4, maxFetchHaves: 4, maxUpdates: 2, maxUploadObjects: 2, maxSessions: 2 },
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
    limits: { maxBodyBytes: 1024 * 1024, maxFetchRefs: 4, maxFetchHaves: 4, maxUpdates: 2, maxUploadObjects: 100, maxSessions: 1 },
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

test("all operation envelopes and object counts are bounded before publication", async () => {
  const { server, repository } = await serveRoot({ limits: { maxBodyBytes: 4096, maxFetchRefs: 2, maxFetchHaves: 2, maxUpdates: 2, maxUploadObjects: 2, maxSessions: 2 } });
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
