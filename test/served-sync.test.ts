// The HTTP client against the served repository, and the command surface above it.
//
// The claim under test is parity: a served repository answers clone, fetch and
// push exactly as a file remote does — same advertisement, same refusals, same
// receipts — because `cloneFrom`, `fetchFrom` and `pushTo` run unchanged over
// the same `Transport` interface. Every socket here is real: an ephemeral
// loopback listener and `fetch` against it, with no request mocked anywhere.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import type { CloneReport, PushReport } from "../engine/sync.ts";
import { cloneFrom, fetchFrom, pushTo } from "../engine/sync.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { ObjectStoreError, type ObjectId } from "../engine/objects.ts";
import { readCommit, readSeries, readTree } from "../engine/model.ts";
import { createSeries } from "../engine/series.ts";
import { FileTransport, openTransport, TRANSPORT_CAPABILITIES } from "../engine/transport.ts";
import { startRepositoryServer, type ServeHandle } from "../engine/serve.ts";
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
  const repository = freshRepo();
  commitFile(repository, "a.txt", "one");
  const root = join(repository.root, "..");
  const server = await startRepositoryServer({ root, host: "127.0.0.1", port: 0, grants: null });
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
});

test("an HTTP transport reports an unreachable, timed-out or unrecognizable remote as unreachable", async () => {
  // A port with no listener: the remote went away.
  const orphan = await startRepositoryServer({ root: tempRoot(), host: "127.0.0.1", port: 0, grants: null });
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
  await new Promise<void>((resolveListening) => silent.listen(0, "127.0.0.1", resolveListening));
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
  await new Promise<void>((resolveClosing) => silent.close(() => resolveClosing()));

  // A responder that answers an error with no error body: this build reports the
  // shape, not a crash on a missing property.
  const terse = createServer((request, response) => {
    response.statusCode = 500;
    response.end("not json");
    request.resume();
  });
  await new Promise<void>((resolveListening) => terse.listen(0, "127.0.0.1", resolveListening));
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
  await new Promise<void>((resolveClosing) => terse.close(() => resolveClosing()));
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
    args: ["wire", served.url],
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
  const serveRoot = mkdtempSync(join(tmpdir(), "pm-vcs-serve-"));
  const served = Repository.init(join(serveRoot, "origin"), "main");
  commitFile(served, "a.txt", "one");
  const name = "origin";
  const worker = spawn(process.execPath, [join(packageRoot, "test", "helpers", "serve-worker.ts"), serveRoot], {
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
        resolveServing(`http://127.0.0.1:${line.slice("SERVE-READY ".length).trim()}/${name}`);
      });
    });

    const cloneRoot = join(tempRoot(), "clone");
    const report = await cloneFrom(url, cloneRoot, now);
    assert.equal(report.branch, "main");
    assert.equal(readFileSync(join(cloneRoot, "a.txt"), "utf8"), "one");

    const wire = new HttpTransport(url);
    const advertisement = await wire.advertise();
    assert.deepEqual(advertisement.refs.map((entry) => entry.name), ["refs/heads/main"]);
  } finally {
    worker.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolveExit) => {
      worker.once("exit", () => resolveExit(true));
      setTimeout(() => resolveExit(false), 10_000);
    });
    assert.equal(exited, true, "the serve process stopped when signaled");
  }
});

test("openTransport builds an HTTP transport for wire locations and a file transport for paths", () => {
  const http = openTransport("http://127.0.0.1:9/repo", "/tmp");
  assert.ok(http instanceof HttpTransport);
  assert.equal(http.url, "http://127.0.0.1:9/repo");
  const file = openTransport("/srv/repo", "/tmp");
  assert.ok(file instanceof FileTransport);
});