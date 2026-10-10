/** Real failure contracts and a guard against suppressing production coverage. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { readInstances } from "../engine/instances.ts";
import { CONTROL_DIRECTORY, Repository } from "../engine/repo.ts";
import { startRepositoryServer } from "../engine/serve.ts";
import { makeTempDir, packageRoot } from "./helpers/tmp.ts";

const author = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };

test("production coverage contains no ignore directives", /** Check every production file without narrowing the configured inventory. */ () => {
  const sources = globSync(["*.ts", "engine/**/*.ts", "scripts/**/*.ts"], { cwd: packageRoot });
  assert.equal(sources.length, 53, "the measured production inventory must be updated explicitly when source files change");
  for (const source of sources) {
    const ignored = /(?:(?:c8|istanbul|v8)\s+ignore\b|node:coverage\s+(?:ignore|disable)\b)/.test(readFileSync(join(packageRoot, source), "utf8"));
    assert.equal(ignored, false, `${source} must not suppress production coverage`);
  }
});

test("instance creation preserves its mkdir error when cleanup cannot read a regular file as a directory", /** Exercise native creation and cleanup faults while preserving caller data and recovery. */ () => {
  const fixture = makeTempDir();
  try {
    const hub = Repository.init(join(fixture.root, "hub"));
    writeFileSync(join(hub.root, "readme.txt"), "hub contents\n");
    hub.stage(["readme.txt"]);
    const tip = hub.commit({ message: "base", author }, new Date(1_000));
    // A caller can mistake an existing notes file for an instance directory.
    // mkdir fails first; best-effort cleanup then reaches readdir on that file.
    const destination = join(fixture.root, "notes.txt");
    const contents = "Existing working notes must survive a mistaken directory argument.\n";
    writeFileSync(destination, contents);
    let creationError: NodeJS.ErrnoException | undefined;
    assert.throws(/** Observe the actual platform's creation failure on this fixture. */ () => mkdirSync(join(destination, CONTROL_DIRECTORY), { recursive: true }), /** Record the native error without assuming a platform-specific code. */ (error: unknown) => {
      assert.ok(error instanceof Error);
      creationError = error;
      return true;
    });
    assert.ok(creationError);
    const expectedCreationError = creationError;
    assert.equal(expectedCreationError.syscall, "mkdir");
    assert.equal(expectedCreationError.path, join(destination, CONTROL_DIRECTORY));
    assert.throws(/** Verify the cleanup operation also fails on the existing file. */ () => readdirSync(destination), /** Ensure this fixture distinguishes the cleanup error from creation. */ (error: unknown) => {
      assert.ok(error instanceof Error);
      const cleanupError = error as NodeJS.ErrnoException;
      assert.notEqual(cleanupError.syscall, expectedCreationError.syscall);
      assert.equal(cleanupError.path, destination);
      return true;
    });
    assert.throws(/** Attempt the supported instance mutation with the mistaken destination. */ () => hub.linkInstance("notes", destination), /** Assert that the observed creation failure survives best-effort cleanup. */ (error: unknown) => {
      assert.ok(error instanceof Error);
      const filesystemError = error as NodeJS.ErrnoException;
      assert.equal(filesystemError.code, expectedCreationError.code);
      assert.equal(filesystemError.message, expectedCreationError.message);
      assert.equal(filesystemError.syscall, "mkdir", "the cleanup readdir error must not replace the creation error");
      assert.equal(filesystemError.path, join(destination, CONTROL_DIRECTORY));
      return true;
    });
    assert.equal(readFileSync(destination, "utf8"), contents);
    assert.deepEqual(readInstances(hub.controlDirectory), []);
    // Cleanup stops on its first fault: the newly installed branch survives,
    // while the shared-store lease is still released and the hub stays usable.
    assert.equal(hub.refs.read("refs/heads/notes"), tip);
    assert.equal(existsSync(join(hub.controlDirectory, "objects.lock")), false);
    const instance = hub.linkInstance("recovered", join(fixture.root, "recovered"), { branch: "notes" });
    assert.equal(instance.head, tip);
    assert.equal(readFileSync(join(instance.path, "readme.txt"), "utf8"), "hub contents\n");
    assert.equal(hub.status().clean, true);
  } finally {
    fixture.cleanup();
  }
});

test("a socket ending an incomplete HTTP body rejects the request and leaves the service usable", /** Observe parser rejection and a subsequent real service request. */ async (t) => {
  const fixture = makeTempDir();
  t.after(/** Remove only the disposable repository fixture. */ () => fixture.cleanup());
  const repository = Repository.init(join(fixture.root, "repo"));
  writeFileSync(join(repository.root, "readme.txt"), "served contents\n");
  repository.stage(["readme.txt"]);
  const tip = repository.commit({ message: "base", author }, new Date(1_000));
  const outcomes: string[] = [];
  let bodyRejected!: () => void;
  const settled = new Promise<void>(/** Install the real observation callback synchronously. */ (resolveSettled, rejectSettled) => {
    const deadline = setTimeout(/** Fail when the real aborted request never settles. */ () => rejectSettled(new Error("the aborted body reader never settled")), 3_000);
    t.after(/** Clear the original observation deadline after any outcome. */ () => clearTimeout(deadline));
    bodyRejected = /** Settle the actual response outcome and cancel its original deadline. */ () => { clearTimeout(deadline); resolveSettled(); };
  });
  const server = await startRepositoryServer({
    root: fixture.root, host: "127.0.0.1", port: 0,
    hooks: { holdResponse(repositoryName, endpoint) {
      outcomes.push(`${repositoryName}/${endpoint}`);
      if (endpoint === "fetch") bodyRejected();
    } },
  });
  t.after(/** Close the service after the real request observations. */ () => server.close());
  const socket = connect({ host: server.host, port: server.port, allowHalfOpen: true });
  t.after(/** Release the socket after completion or failure. */ () => socket.destroy());
  await once(socket, "connect");
  const continued = once(socket, "data");
  socket.write(`POST /repo/fetch HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: 80\r\nExpect: 100-continue\r\n\r\n`);
  const [continuation] = await continued;
  assert.match(String(continuation), /^HTTP\/1\.1 100 Continue/);
  assert.deepEqual(outcomes, [], "an incomplete body must not reach dispatch");
  const closed = once(socket, "close");
  socket.resume();
  // EOF before Content-Length is a real HTTP parser abort, not an emitted
  // request error. The response hook runs only after the body promise rejects.
  socket.end('{"refs":');
  await settled;
  await closed;
  assert.deepEqual(outcomes, ["repo/fetch"]);
  assert.equal(repository.refs.resolveHead(), tip);
  assert.equal(repository.status().clean, true);
  const response = await fetch(`http://${server.host}:${server.port}/repo/advertise`, { method: "POST" });
  assert.equal(response.status, 200);
  const advertisement = await response.json() as { refs: Array<{ name: string; target: string }> };
  assert.ok(advertisement.refs.some(/** Confirm the original branch is still advertised. */ (ref) => ref.name === "refs/heads/main" && ref.target === tip));
});
