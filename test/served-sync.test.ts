// The HTTP client against the served repository, and the command surface above it.
//
// The claim under test is parity: a served repository answers clone, fetch and
// push exactly as a file remote does — same advertisement, same refusals, same
// receipts — because `cloneFrom`, `fetchFrom` and `pushTo` run unchanged over
// the same `Transport` interface. Every socket here is real: an ephemeral
// loopback listener and `fetch` against it, with no request mocked anywhere.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import type { CloneReport, PushReport } from "../engine/sync.ts";
import { cloneFrom, fetchFrom, pushTo } from "../engine/sync.ts";
import { parseBundle } from "../engine/bundle.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { ObjectStoreError, type ObjectId } from "../engine/objects.ts";
import { readCommit, readSeries, readTree } from "../engine/model.ts";
import { createSeries } from "../engine/series.ts";
import { FileTransport, openTransport, TRANSPORT_CAPABILITIES } from "../engine/transport.ts";
import { readTokenFile, startRepositoryServer, type ServeHandle } from "../engine/serve.ts";
import { Repository } from "../engine/repo.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const handles: Array<{ root: string; cleanup(): void }> = [];
const servers: ServeHandle[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (handles.length > 0) handles.pop()?.cleanup();
});

const author = { name: "A", email: "a@b", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date("2026-09-13T00:00:00.000Z");

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
function commitFile(repository: Repository, path: string, text: string): ObjectId {
  const absolute = join(repository.root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
  repository.stage([path]);
  return repository.commit({ message: `add ${path}\n`, author }, now);
}

/** A served root with one repository already holding one commit. */
interface Served {
  /** The running server. */
  readonly server: ServeHandle;
  /** The served root. */
  readonly root: string;
  /** The served repository. */
  readonly repository: Repository;
  /** Its repository name under the root. */
  readonly name: string;
  /** The URL the repository is served at. */
  readonly url: string;
}

/**
 * Serves one freshly seeded repository, registered for cleanup.
 *
 * @returns The running server and its repository.
 */
async function serveSeededRepo(): Promise<Served> {
  const root = tempRoot();
  const repository = Repository.init(join(root, "repo"));
  commitFile(repository, "a.txt", "one");
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0, grants: null, unauthenticatedWrites: true });
  servers.push(server);
  const name = repository.root.slice(root.length + 1);
  return { server, root, repository, name, url: `http://127.0.0.1:${server.port}/${name}` };
}

/**
 * Reads the harness capabilities this package declares.
 *
 * @returns The manifest's capability list.
 */
function manifestCapabilities(): NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"] {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "manifest.json"), "utf8")) as {
    capabilities: Parameters<typeof createExtensionTestHarness>[1] extends undefined ? never : NonNullable<Parameters<typeof createExtensionTestHarness>[1]>["capabilities"];
  };
  return manifest.capabilities;
}

/**
 * Activates the extension through the host's real loader.
 *
 * @returns The activated harness.
 */
function activate(): ReturnType<typeof createExtensionTestHarness> {
  return createExtensionTestHarness(extension, { capabilities: manifestCapabilities() });
}

test("a served repository advertises itself exactly as a file remote does", async () => {
  const served = await serveSeededRepo();
  const http = new HttpTransport(served.url);
  const advertisement = await http.advertise();
  assert.equal(advertisement.formatVersion, (await new FileTransport(served.url, served.repository.root).advertise()).formatVersion);
  assert.deepEqual(advertisement.capabilities, [...TRANSPORT_CAPABILITIES]);
  assert.deepEqual(advertisement.refs.map((entry) => entry.name), ["refs/heads/main"]);
  assert.equal(advertisement.head, "refs/heads/main");
  // The record configuration is part of the advertisement, which is what makes a
  // clone adopt it and store the same paths the same way.
  assert.deepEqual(advertisement.config, Repository.open(served.repository.root).config);
});

test("cloning over HTTP reproduces the same commits and configuration as cloning over a file remote", async () => {
  const served = await serveSeededRepo();
  commitFile(served.repository, "records/one.toon", "fields\n");
  const servedTip = served.repository.refs.read("refs/heads/main");

  const overFile = await cloneFrom(served.repository.root, join(tempRoot(), "file-clone"), now);
  const overHttp = await cloneFrom(served.url, join(tempRoot(), "http-clone"), now);

  assert.equal(overHttp.branch, overFile.branch);
  assert.deepEqual(overHttp.fetched.added, overFile.fetched.added);
  const httpClone = Repository.open(overHttp.root);
  assert.equal(httpClone.refs.read("refs/heads/main"), servedTip);
  // The clone remembers the wire location it came from, not a path.
  assert.equal(httpClone.remotes.require("origin").url, served.url);
  assert.equal(readFileSync(join(overHttp.root, "a.txt"), "utf8"), "one");
});

test("fetch and push over HTTP answer exactly as they do against a file remote", async () => {
  const served = await serveSeededRepo();
  const cloneRoot = join(tempRoot(), "clone");
  await cloneFrom(served.url, cloneRoot, now);
  const clone = Repository.open(cloneRoot);

  // Nothing new: an up-to-date fetch transfers nothing, over the wire too.
  const empty = await fetchFrom(clone, "origin", now);
  assert.equal(empty.upToDate, true);

  // A push over HTTP lands, moves the tracking ref, and is recorded on the
  // receiving side like any push.
  const tip = commitFile(clone, "b.txt", "two");
  const report = await pushTo(clone, "origin", [], false, now);
  assert.equal(report.upToDate, false);
  assert.equal(served.repository.refs.read("refs/heads/main"), tip);
  assert.equal(clone.refs.read("refs/remotes/origin/main"), tip);
  assert.equal(Repository.open(served.repository.root).operations.read().at(-1)?.command, "push");

  // A move that would discard commits the served repository has is refused with
  // the same code and the same remediation-shaped message as a local refusal.
  const diverged = await cloneFrom(served.url, join(tempRoot(), "second"), now);
  const remoteMovedTo = commitFile(served.repository, "c.txt", "three");
  commitFile(Repository.open(diverged.root), "d.txt", "four");
  await assert.rejects(pushTo(Repository.open(diverged.root), "origin", [], false, now), (error: ObjectStoreError) => {
    assert.equal(error.code, "non_fast_forward");
    assert.match(error.message, /would discard commits .* already has/);
    return true;
  });
  assert.equal(served.repository.refs.read("refs/heads/main"), remoteMovedTo);
});

test("a late push answer cannot overwrite the newer tip a concurrent fetch recorded", async () => {
  const root = tempRoot();
  const repository = Repository.init(join(root, "repo"));
  const base = commitFile(repository, "a.txt", "one");
  // The server holds the first push's answer after it has been accepted: the
  // remote has moved and the client has not heard. Only the answer is delayed,
  // never the work, and the socket underneath is real — no request is mocked.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let pushLanded: () => void = () => {};
  const landed = new Promise<void>((resolveLanded) => { pushLanded = resolveLanded; });
  let holding = true;
  const server = await startRepositoryServer({
    root,
    host: "127.0.0.1",
    port: 0,
    grants: null,
    // This test races two real pushes on the open server; the read-only guard
    // has its own tests, so the open-writes override restores the old behaviour.
    unauthenticatedWrites: true,
    hooks: {
      holdResponse: (addressed, endpoint) => {
        if (endpoint !== "push" || !holding) return;
        holding = false;
        assert.equal(addressed, "repo");
        pushLanded();
        return gate;
      },
    },
  });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}/repo`;

  // The pusher clones, commits A, and pushes; the server accepts A and holds
  // its answer in flight.
  const pusherRoot = join(tempRoot(), "pusher");
  await cloneFrom(url, pusherRoot, now);
  const pusher = Repository.open(pusherRoot);
  const commitA = commitFile(pusher, "b.txt", "two");
  const pushA = pushTo(pusher, "origin", ["main"], false, now);
  await landed;
  assert.equal(repository.refs.read("refs/heads/main"), commitA);

  // While A's answer is in flight, a second client pushes B on top of it and
  // the pusher fetches: the fetch records B on the tracking ref — exactly the
  // newer value the late answer must not overwrite.
  const secondRoot = join(tempRoot(), "second");
  await cloneFrom(url, secondRoot, now);
  const commitB = commitFile(Repository.open(secondRoot), "c.txt", "three");
  await pushTo(Repository.open(secondRoot), "origin", ["main"], false, now);
  assert.equal(repository.refs.read("refs/heads/main"), commitB);
  await fetchFrom(pusher, "origin", now);
  assert.equal(pusher.refs.read("refs/remotes/origin/main"), commitB);

  release();
  const report = await pushA;
  assert.equal(report.upToDate, false);
  assert.deepEqual(report.updated, [{ ref: "refs/heads/main", before: base, after: commitA }]);
  // The completion kept the newer tip: the tracking ref still names what the
  // fetch recorded, not the commit A's late answer would have written over it,
  // and the remote keeps B.
  assert.equal(pusher.refs.read("refs/remotes/origin/main"), commitB);
  assert.equal(repository.refs.read("refs/heads/main"), commitB);
});

test("a throwing or rejecting holdResponse hook never withholds the decided answer", async () => {
  const root = tempRoot();
  const repository = Repository.init(join(root, "repo"));
  const tip = commitFile(repository, "a.txt", "one");
  // The first answered request meets a hook that throws synchronously, every
  // later one a hook that rejects; neither may cost the client its answer or
  // escape as an unhandled rejection that stops the server.
  let calls = 0;
  const server = await startRepositoryServer({
    root,
    host: "127.0.0.1",
    port: 0,
    grants: null,
    hooks: {
      holdResponse: () => {
        calls += 1;
        if (calls === 1) throw new Error("monitor failed synchronously");
        return Promise.reject(new Error("monitor failed asynchronously"));
      },
    },
  });
  servers.push(server);
  // A bounded client: without the guard the answer never comes, and the
  // abort both fails the test and frees the socket so teardown can close.
  const wire = new HttpTransport(`http://127.0.0.1:${server.port}/repo`, { timeoutMs: 5_000 });
  for (const expectedCalls of [1, 2]) {
    const advertised = await wire.advertise();
    assert.equal(advertised.refs.find((entry) => entry.name === "refs/heads/main")?.target, tip);
    assert.equal(calls, expectedCalls);
  }
});

test("a resumable upload over HTTP verifies every object and refuses a tampered one", async () => {
  const served = await serveSeededRepo();
  const sender = freshRepo();
  commitFile(sender, "base.txt", "base");
  const tip = commitFile(sender, "next.txt", "next");
  const wire = new HttpTransport(served.url);

  // Every object the tip reaches, commits included, so a publication has a
  // complete closure to check.
  const closure: ObjectId[] = [];
  const seen = new Set<ObjectId>();
  const walkTree = (treeId: ObjectId): void => {
    if (seen.has(treeId)) return;
    seen.add(treeId);
    closure.push(treeId);
    const tree = readTree(sender.objects, treeId);
    for (const entry of tree) {
      if (entry.mode === "40000") walkTree(entry.id);
      else if (!seen.has(entry.id)) {
        seen.add(entry.id);
        closure.push(entry.id);
      }
    }
  };
  const seenCommits = new Set<ObjectId>();
  const walkCommit = (commitId: ObjectId): void => {
    if (seenCommits.has(commitId)) return;
    seenCommits.add(commitId);
    const entry = readCommit(sender.objects, commitId);
    closure.push(commitId);
    walkTree(entry.tree);
    for (const parent of entry.parents) walkCommit(parent);
  };
  walkCommit(tip);

  // Ask first: the served receiver names the whole closure as missing.
  const missing = await wire.missingObjects(closure);
  assert.deepEqual(missing, closure);
  // A tampered pair — content that does not hash to its claimed id — is refused
  // on arrival, and nothing is stored under the name that does not describe it.
  const stored = sender.objects.read(tip);
  await assert.rejects(
    wire.uploadObjects([{ id: tip, type: stored.type, payload: Buffer.from("tampered", "utf8") }]),
    (error: ObjectStoreError) => error.code === "corrupt_object",
  );
  assert.equal(served.repository.objects.has(tip), false);
  // Uploading the tip alone leaves the closure incomplete, so publication is
  // refused and moves nothing — the same rule a local publish enforces.
  await wire.uploadObjects([{ id: tip, type: stored.type, payload: stored.payload }]);
  await assert.rejects(
    wire.publish([{ ref: "refs/heads/feature", expected: null, next: tip }], false, now),
    (error: ObjectStoreError) => error.code === "incomplete_bundle",
  );
  assert.equal(served.repository.refs.read("refs/heads/feature"), null);
  // Completing the upload lets the same publication through, and the receipt
  // names exactly the objects the completing batch delivered.
  const rest = closure.filter((id) => id !== tip);
  await wire.uploadObjects(rest.map((id) => {
    const object = sender.objects.read(id);
    return { id, type: object.type, payload: object.payload };
  }));
  const receipt = await wire.publish([{ ref: "refs/heads/feature", expected: null, next: tip }], false, now);
  assert.deepEqual([...receipt.added].sort(), [...rest].sort());
  assert.equal(served.repository.refs.read("refs/heads/feature"), tip);
});

test("a series object transfers through the served repository's verified-arrival path", async () => {
  const served = await serveSeededRepo();
  const source = freshRepo();
  const base = commitFile(source, "base.txt", "base");
  const tip = commitFile(source, "next.txt", "next");
  const seriesId = createSeries(source.objects, base, tip, { description: "a served series", author });

  const wire = new HttpTransport(served.url);
  assert.deepEqual(await wire.missingObjects([seriesId]), [seriesId]);
  const seriesObject = source.objects.read(seriesId);
  await wire.uploadObjects([{ id: seriesId, type: seriesObject.type, payload: seriesObject.payload }]);
  assert.equal((await wire.missingObjects([seriesId])).length, 0);

  // The served repository now holds the series under the same id, byte-identical
  // — the receiver re-hashed it on arrival, so the id is a fact it verified.
  assert.deepEqual(readSeries(served.repository.objects, seriesId), readSeries(source.objects, seriesId));
  const downloaded = parseBundle(await wire.fetchObjects([seriesId]));
  assert.equal(downloaded.lines[0]?.id, seriesId);
  assert.deepEqual(downloaded.lines[0]?.payload, seriesObject.payload);
  assert.deepEqual(await new FileTransport("local", served.repository.root).fetchObjects([seriesId]), await wire.fetchObjects([seriesId]));
});

test("an HTTP transport reports an unreachable, timed-out or unrecognizable remote as unreachable", async () => {
  // A port with no listener: the remote went away.
  const orphan = await startRepositoryServer({ root: tempRoot(), host: "127.0.0.1", port: 0, grants: null, unauthenticatedWrites: true });
  const orphanPort = orphan.port;
  await orphan.close();
  await assert.rejects(
    new HttpTransport(`http://127.0.0.1:${orphanPort}/repo`).advertise(),
    (error: ObjectStoreError) => {
      assert.equal(error.code, "unreachable_remote");
      assert.match(error.message, /the connection failed/);
      return true;
    },
  );

  // A listener that accepts and never answers: the remote is there and slow.
  const silent = createServer(() => {});
  await new Promise<void>((resolveListening) => { silent.listen(0, "127.0.0.1", resolveListening); });
  const silentAddress = silent.address();
  assert.ok(typeof silentAddress === "object" && silentAddress !== null);
  await assert.rejects(
    new HttpTransport(`http://127.0.0.1:${silentAddress.port}/repo`, { timeoutMs: 100 }).advertise(),
    (error: ObjectStoreError) => {
      assert.equal(error.code, "unreachable_remote");
      assert.match(error.message, /the remote timed out/);
      return true;
    },
  );
  await new Promise<void>((resolveClosing) => { silent.close(() => resolveClosing()); });

  // A responder that answers an error with no error body: this build reports the
  // shape, not a crash on a missing property.
  const terse = createServer((request, response) => {
    response.statusCode = 500;
    response.end("not json");
    request.resume();
  });
  await new Promise<void>((resolveListening) => { terse.listen(0, "127.0.0.1", resolveListening); });
  const terseAddress = terse.address();
  assert.ok(typeof terseAddress === "object" && terseAddress !== null);
  await assert.rejects(
    new HttpTransport(`http://127.0.0.1:${terseAddress.port}/repo`).advertise(),
    (error: ObjectStoreError) => {
      assert.equal(error.code, "unreachable_remote");
      assert.match(error.message, /without an error body/);
      return true;
    },
  );
  await new Promise<void>((resolveClosing) => { terse.close(() => resolveClosing()); });
});

test("an HTTP transport refuses a location that is not an HTTP URL", () => {
  for (const [url, pattern] of [
    ["ftp://host/repo", /does not speak/],
    ["not a url at all", /not a URL/],
  ] as const) {
    assert.throws(() => new HttpTransport(url), (error: ObjectStoreError) => {
      assert.equal(error.code, "unsupported_transport");
      assert.match(error.message, pattern);
      return true;
    }, url);
  }
});

test("an HTTP transport refuses to carry a bearer token over plain http beyond loopback", () => {
  // A token on the wire is a credential handed to every observer between this
  // machine and the remote; only loopback is this machine talking to itself.
  for (const url of [
    "http://example.invalid/repo",
    "http://192.168.1.10:43210/repo",
    "http://user:secret@example.invalid/repo",
    // URL userinfo is a token too, wherever the credential was resolved.
    "http://secret@example.invalid/repo",
    "http://secret@[::ffff:8.8.8.8]/repo",
  ] as const) {
    assert.throws(() => new HttpTransport(url, { token: "bearer-secret" }), (error: ObjectStoreError) => {
      assert.equal(error.code, "unsupported_transport", url);
      assert.match(error.message, /Use https:/, url);
      // The refusal names the remote, never the credential it refused to send.
      assert.equal(error.message.includes("bearer-secret"), false, url);
      assert.equal(error.message.includes("secret"), false, url);
      return true;
    }, url);
  }
  // A userinfo token is refused even without the options token.
  assert.throws(() => new HttpTransport("http://secret@example.invalid/repo"), /Use https:/);
  // Loopback, tokenless http and https all keep working, with or without a token.
  assert.doesNotThrow(() => new HttpTransport("http://127.0.0.1:43210/repo", { token: "bearer-secret" }));
  assert.doesNotThrow(() => new HttpTransport("http://[::1]:43210/repo", { token: "bearer-secret" }));
  assert.doesNotThrow(() => new HttpTransport("http://[::ffff:127.0.0.1]:43210/repo", { token: "bearer-secret" }));
  assert.doesNotThrow(() => new HttpTransport("http://127.42.1.2:43210/repo", { token: "bearer-secret" }));
  assert.doesNotThrow(() => new HttpTransport("http://localhost:43210/repo", { token: "bearer-secret" }));
  assert.doesNotThrow(() => new HttpTransport("http://example.invalid/repo"));
  assert.doesNotThrow(() => new HttpTransport("https://example.invalid/repo", { token: "bearer-secret" }));
  // An empty token is no credential: a tokenless http remote to any host stays usable.
  assert.doesNotThrow(() => new HttpTransport("http://example.invalid/repo", { token: "" }));
});

test("remote add, fetch, push and clone reach a served repository through the command surface", async () => {
  const served = await serveSeededRepo();
  const harness = await activate();

  // A clone through the command surface, so the rest of the flow works against
  // a history the two sides share the way real work does.
  const cloned = await harness.runCommand({ command: "vcs clone", args: [served.url], pmRoot: tempRoot() });
  assert.equal(cloned.errorMessage, undefined, String(cloned.errorMessage));
  const root = (cloned.result as { clone: CloneReport }).clone.root;

  // A second wire remote, added through the command surface: the location is
  // stored as typed, so the fetch after it resolves the same URL.
  const added = await harness.runCommand({
    command: "vcs remote",
    args: ["add", "wire", served.url],
    pmRoot: root,
  });
  assert.equal(added.errorMessage, undefined, String(added.errorMessage));
  assert.equal(
    (added.result as { added: { name: string; url: string } }).added.url,
    served.url,
    "the wire location is stored as typed",
  );

  const fetched = await harness.runCommand({ command: "vcs fetch", args: ["wire"], pmRoot: root });
  assert.equal(fetched.errorMessage, undefined, String(fetched.errorMessage));
  const branches = await harness.runCommand({ command: "vcs branch", options: { remotes: true }, pmRoot: root });
  const listed = (branches.result as { remoteBranches: Array<{ name: string; target: string }> }).remoteBranches;
  assert.deepEqual(listed.map((entry) => entry.name), ["origin/main", "wire/main"]);

  // A remote may itself be named "add": the alias only applies to the exact
  // `add <name> <url>` shape, so the two-argument form adds a remote called
  // "add" and `--remove` removes it instead of the alias swallowing the name.
  const named = await harness.runCommand({ command: "vcs remote", args: ["add", served.url], pmRoot: root });
  assert.equal(named.errorMessage, undefined, String(named.errorMessage));
  assert.equal((named.result as { added: { name: string } }).added.name, "add");
  const removed = await harness.runCommand({ command: "vcs remote", args: ["add"], options: { remove: true }, pmRoot: root });
  assert.equal((removed.result as { removed?: string }).removed, "add");

  writeFileSync(join(root, "pushed.txt"), "over the wire\n");
  await harness.runCommand({ command: "vcs add", pmRoot: root });
  await harness.runCommand({ command: "vcs commit", options: { message: "wire" }, global: { author: "A <a@b>" }, pmRoot: root });
  const pushed = await harness.runCommand({ command: "vcs push", args: ["wire"], pmRoot: root });
  assert.equal(pushed.errorMessage, undefined, String(pushed.errorMessage));
  const report = (pushed.result as { push: PushReport }).push;
  assert.equal(report.remote, "wire");
  assert.equal(served.repository.refs.read("refs/heads/main") !== null, true);

  // And the pushed content is what the next clone over the wire receives.
  const second = await harness.runCommand({ command: "vcs clone", args: [served.url], pmRoot: tempRoot() });
  assert.equal(second.errorMessage, undefined, String(second.errorMessage));
  const cloneReport = (second.result as { clone: CloneReport }).clone;
  assert.equal(readFileSync(join(cloneReport.root, "pushed.txt"), "utf8"), "over the wire\n");
});

test("vcs serve refuses the arguments it cannot honor without binding anything", async () => {
  const harness = await activate();
  const root = tempRoot();

  const badListen = await harness.runCommand({
    command: "vcs serve", options: { listen: "127.0.0.1:not-a-port" }, pmRoot: root,
  });
  assert.equal(badListen.handled, false);
  assert.match(String(badListen.errorMessage), /--listen accepts host:port/);

  const badRoot = await harness.runCommand({
    command: "vcs serve", options: { root: join(root, "absent") }, pmRoot: root,
  });
  assert.equal(badRoot.handled, false);
  assert.match(String(badRoot.errorMessage), /cannot be read as a directory/);

  const missingAuth = await harness.runCommand({
    command: "vcs serve", options: { auth: join(root, "absent.json") }, pmRoot: root,
  });
  assert.equal(missingAuth.handled, false);
  assert.match(String(missingAuth.errorMessage), /tokens file .* cannot be read/);

  const emptyAuth = join(root, "empty.json");
  writeFileSync(emptyAuth, "[]");
  const emptyAuthRun = await harness.runCommand({
    command: "vcs serve", options: { auth: emptyAuth }, pmRoot: root,
  });
  assert.equal(emptyAuthRun.handled, false);
  assert.match(String(emptyAuthRun.errorMessage), /grants no token access/);
});

test("vcs serve serves a repository a real process can clone from, until it is stopped", async () => {
  // The command surface itself, in a real child process: the server it starts
  // keeps that process alive, which is the property a foreground serve has.
  const serveRoot = tempRoot();
  const served = Repository.init(join(serveRoot, "origin"), "main");
  commitFile(served, "a.txt", "one");
  const name = "origin";
  const auth = join(serveRoot, "tokens.json");
  writeFileSync(auth, JSON.stringify([{ token: "worker-token", repository: name, access: "write" }]));
  for (const listen of [undefined, "[::1]:0", "127.0.0.1:0"]) {
  const host = listen === "[::1]:0" ? "[::1]" : "127.0.0.1";
  const worker = spawn(process.execPath, [join(packageRoot, "test", "helpers", "serve-worker.ts"), serveRoot, ...(listen === undefined ? [] : [listen, listen === "[::1]:0" ? auth : "-", "allow"])], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const url = await new Promise<string>((resolveServing, rejectServing) => {
      let buffered = "";
      const timer = setTimeout(() => rejectServing(new Error("serve worker did not report a port")), 60_000);
      worker.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const line = buffered.split("\n").find((entry) => entry.startsWith("SERVE-READY "));
        if (line === undefined) return;
        clearTimeout(timer);
        resolveServing(`http://${listen === "[::1]:0" ? "worker-token@" : ""}${host}:${line.slice("SERVE-READY ".length).trim()}/${name}`);
      });
    });

    const cloneRoot = join(tempRoot(), "clone");
    const report = await cloneFrom(url, cloneRoot, now);
    assert.equal(report.branch, "main");
    assert.equal(readFileSync(join(cloneRoot, "a.txt"), "utf8"), "one");

    const wire = new HttpTransport(url);
    const advertisement = await wire.advertise();
    assert.deepEqual(advertisement.refs.map((entry) => entry.name), ["refs/heads/main"]);
    if (listen === undefined) {
      await assert.rejects(wire.publish([], false, now), { code: "forbidden" });
    } else {
      assert.deepEqual((await wire.publish([], false, now)).updated, []);
    }
  } finally {
    worker.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolveExit) => {
      worker.once("exit", () => resolveExit(true));
      setTimeout(() => resolveExit(false), 10_000);
    });
    assert.equal(exited, true, "the serve process stopped when signaled");
  }
  }
});

test("openTransport builds an HTTP transport for wire locations and a file transport for paths", () => {
  const http = openTransport("http://127.0.0.1:9/repo", tempRoot());
  assert.ok(http instanceof HttpTransport);
  assert.equal(http.url, "http://127.0.0.1:9/repo");
  const file = openTransport("repo", tempRoot());
  assert.ok(file instanceof FileTransport);
});
test("one repository root is served at the base URL, with force and review-record parity", async () => {
  const repository = Repository.init(tempRoot(), "main", { recordPaths: ["reviews/*.json"], recordPolicy: {} });
  const base = commitFile(repository, "base.txt", "base");
  commitFile(repository, "reviews/one.json", JSON.stringify({ series: "pending", status: "open", reviewer: "agent" }));
  const server = await startRepositoryServer({ root: repository.root, host: "127.0.0.1", port: 0, unauthenticatedWrites: true });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const clone = Repository.open((await cloneFrom(url, join(tempRoot(), "clone"), now)).root);
  assert.equal(readFileSync(join(clone.root, "reviews/one.json"), "utf8").includes('"reviewer"'), true);
  clone.reset(base, "hard", now);
  const report = await pushTo(clone, "origin", [], true, now);
  assert.equal(report.upToDate, false);
  assert.equal(repository.refs.read("refs/heads/main"), base);
});

test("real responders with malformed successful envelopes fail closed", async () => {
  let answer: unknown = {};
  const responder = createServer((request, response) => { request.resume(); response.end(JSON.stringify(answer)); });
  await new Promise<void>((ready) => { responder.listen(0, "127.0.0.1", ready); });
  const address = responder.address();
  assert.ok(address !== null && typeof address === "object");
  const wire = new HttpTransport(`http://127.0.0.1:${address.port}/repo`);
  try {
    const advertisement = { refs: [], head: null, config: {}, formatVersion: "1", capabilities: [] };
    for (const malformed of [null, [], {}, { ...advertisement, refs: [null] }, { ...advertisement, refs: [[]] }, { ...advertisement, refs: [{}] }, { ...advertisement, refs: [{ name: "main", target: 1 }] }, { ...advertisement, head: 1 }, { ...advertisement, config: null }, { ...advertisement, config: [] }, { ...advertisement, config: "bad" }, { ...advertisement, config: { recordPaths: "x" } }, { ...advertisement, config: { recordPolicy: [] } }, { ...advertisement, formatVersion: 1 }, { ...advertisement, capabilities: [1] }]) {
      answer = malformed;
      await assert.rejects(wire.advertise(), { code: "unreachable_remote" });
    }
    answer = { ...advertisement, refs: [{ name: "refs/heads/main", target: "a".repeat(64) }], head: "refs/heads/main" };
    const advertised = await wire.advertise();
    assert.equal(advertised.refs.length, 1);
    // Clone stores the advertised config verbatim, so an empty one arrives
    // normalized with its defaults rather than missing recordPaths.
    assert.deepEqual(advertised.config.recordPaths, []);
    for (const malformed of [null, {}, { missing: [1] }]) {
      answer = malformed;
      await assert.rejects(wire.missingObjects([]), { code: "unreachable_remote" });
      await assert.rejects(wire.push(Buffer.alloc(0), [], false, now), { code: "unreachable_remote" });
      await assert.rejects(wire.publish([], false, now), { code: "unreachable_remote" });
    }
  } finally { await new Promise<void>((closed) => { responder.close(() => closed()); }); }
});

test("a config refusal never echoes the bearer token a hostile server reflects", async () => {
  // A successful advertisement bypasses error-body scrubbing, so the config
  // refusal must not quote the rejected value the server chose.
  const token = "reflected-bearer-secret";
  let seen = "";
  const responder = createServer((request, response) => {
    seen = request.headers.authorization ?? "";
    request.resume();
    response.end(JSON.stringify({ refs: [], head: null, config: { recordPolicy: { fallback: seen } }, formatVersion: "1", capabilities: [] }));
  });
  await new Promise<void>((ready) => { responder.listen(0, "127.0.0.1", ready); });
  const address = responder.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const wire = new HttpTransport(`http://${token}@127.0.0.1:${address.port}/repo`);
    await assert.rejects(wire.advertise(), (error: ObjectStoreError) => {
      assert.equal(error.code, "unreachable_remote");
      assert.ok(seen.includes(token), "the fixture must really reflect the token");
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    });
  } finally { await new Promise<void>((closed) => { responder.close(() => closed()); }); }
});

test("bearer-scoped clients may read or write only their grants and errors redact secrets", async () => {
  const repository = freshRepo();
  commitFile(repository, "a.txt", "a");
  const authFile = join(tempRoot(), "tokens.json");
  writeFileSync(authFile, JSON.stringify([{ token: "read-secret", repository: "", access: "read" }, { token: "write-secret", repository: "", access: "write" }]));
  const server = await startRepositoryServer({ root: repository.root, host: "127.0.0.1", port: 0, grants: readTokenFile(authFile) });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const reader = new HttpTransport(url.replace("http://", "http://read-secret@"));
  assert.equal((await reader.advertise()).refs.length, 1);
  assert.equal(reader.url.includes("read-secret"), false);
  await assert.rejects(reader.uploadObjects([]), { code: "forbidden" });
  const writer = new HttpTransport(url.replace("http://", "http://write-secret@"));
  await writer.uploadObjects([]);
  await assert.rejects(new HttpTransport(url).advertise(), { code: "denied" });
  await server.close();
  servers.pop();
  await assert.rejects(reader.advertise(), (error: ObjectStoreError) => !error.message.includes("read-secret"));
});


test("malformed wire URLs and occupied listen sockets fail through the command surface", async () => {
  const harness = await activate();
  const served = await serveSeededRepo();
  const rejected = await harness.runCommand({ command: "vcs serve", pmRoot: served.root, options: { listen: `127.0.0.1:${served.server.port}` } });
  assert.equal(rejected.handled, false);
  assert.match(String(rejected.errorMessage), /EADDRINUSE|port \d+ in use/);
  const malformed = await harness.runCommand({ command: "vcs remote", args: ["wire", "http://[broken"], pmRoot: served.repository.root });
  assert.match(String(malformed.errorMessage), /does not parse/);
});
