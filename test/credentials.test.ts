import { Writable } from "node:stream";
import { guardCredentialOutput } from "../credential-output.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { environmentToken, readCredentials, redactRemoteUrl, redactUserinfo, splitRemoteCredentials, writeRemoteMap } from "../engine/credentials.ts";
import { RemoteStore } from "../engine/remotes.ts";
import { HttpTransport } from "../engine/http-transport.ts";
import { resolveRemoteLocation } from "../engine/transport.ts";
import { createServer } from "node:http";
import { makeTempDir } from "./helpers/tmp.ts";

const token = "adversarial-secret%with-encoding";

test("userinfo is stripped from valid, malformed, unsupported and embedded URLs", () => {
  assert.equal(redactUserinfo(`failed http://${token}:password@host/a https://second@host/b`), "failed http://host/a https://host/b");
  assert.equal(redactRemoteUrl("http://secret with\twhitespace:password@host"), "http://host");
  assert.deepEqual(splitRemoteCredentials("http://secret with\twhitespace@host"), { url: "http://host", token: "secret withwhitespace" });
  assert.deepEqual(splitRemoteCredentials("relative/file"), { url: "relative/file", token: null });
  assert.deepEqual(splitRemoteCredentials(`http://${encodeURIComponent(token)}@host/a`), { url: "http://host/a", token });
  assert.deepEqual(splitRemoteCredentials("http://:password@host/a"), { url: "http://host/a", token: "password" });
  for (const url of [`http://${token}@[`, `file://${token}@host/a`, `ftp://${token}@host/a`, `http://%ZZ@host`]) {
    for (const operation of [() => new HttpTransport(url), () => resolveRemoteLocation(url, ".")]) {
      try { operation(); } catch (error) { assert.equal(String(error).includes(token), false); }
    }
  }
  assert.throws(() => splitRemoteCredentials(`http://${token}@[`), /not a usable remote URL/);
  assert.throws(() => splitRemoteCredentials("http://%ZZ@host"), /not a usable remote URL/);
});

test("environment overrides per remote, then globally, then uses the stored secret", () => {
  assert.equal(environmentToken("up-stream.2", "stored", { PM_VCS_TOKEN_UP_STREAM_2: "remote", PM_VCS_TOKEN: "general" }), "remote");
  assert.equal(environmentToken("origin", "stored", { PM_VCS_TOKEN: "general" }), "general");
  assert.equal(environmentToken("origin", "stored", {}), "stored");
  assert.equal(environmentToken("origin", "stored", { PM_VCS_TOKEN_ORIGIN: "" }), "");
});

test("remote secrets migrate, stay private, survive reopen and are removed with their remote", () => {
  const fixture = makeTempDir();
  try {
    const path = join(fixture.root, "remotes.json");
    const secretPath = join(fixture.root, "credentials.json");
    const store = new RemoteStore(path);
    assert.equal(store.token("origin"), null);
    writeFileSync(path, JSON.stringify({ origin: `http://${encodeURIComponent(token)}@host/a`, upstream: "http://host/b" }));
    assert.deepEqual(store.list(), [{ name: "origin", url: "http://host/a" }, { name: "upstream", url: "http://host/b" }]);
    assert.equal(readFileSync(path, "utf8").includes(token), false);
    assert.equal(readFileSync(path, "utf8").includes(encodeURIComponent(token)), false);
    assert.equal(store.token("origin"), token);
    if (process.platform !== "win32") assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    store.add("second", "https://second-secret:discarded-password@host");
    assert.equal(new RemoteStore(path).token("second"), "second-secret");
    assert.equal(store.token("origin"), token);
    store.remove("second");
    assert.equal(store.token("second"), null);
    store.remove("upstream");
    assert.equal(store.token("origin"), token);
    const saved = process.env.PM_VCS_TOKEN_ORIGIN;
    process.env.PM_VCS_TOKEN_ORIGIN = "override";
    try { assert.equal(store.token("origin"), "override"); }
    finally { if (saved === undefined) delete process.env.PM_VCS_TOKEN_ORIGIN; else process.env.PM_VCS_TOKEN_ORIGIN = saved; }
    chmodSync(secretPath, 0o666);
    readCredentials(secretPath);
    if (process.platform !== "win32") assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    store.remove("origin");
    assert.deepEqual(readCredentials(secretPath), {});
  } finally { fixture.cleanup(); }
});

test("unusable secret maps fail without printing any secret and failed atomic publication cleans up", () => {
  const fixture = makeTempDir();
  try {
    const path = join(fixture.root, "credentials.json");
    for (const contents of [token, "null", "[]", JSON.stringify({ origin: { token } })]) {
      writeFileSync(path, contents);
      assert.throws(() => readCredentials(path), (error: Error) => {
        assert.equal(error.message.includes(token), false);
        return true;
      });
    }
    assert.throws(() => readCredentials(fixture.root));
    const target = join(fixture.root, "directory");
    mkdirSync(target);
    assert.throws(() => writeRemoteMap(target, { origin: token }, true));
    assert.equal(readdirSync(fixture.root).some((file) => file.endsWith(".tmp")), false);
  } finally { fixture.cleanup(); }
});

test("an HTTP peer echoing the bearer secret cannot leak it in its error", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400);
    response.end(JSON.stringify({ error: { code: "refused", message: `http://${encodeURIComponent(token)}@host failed with ${token}` } }));
  });
  await new Promise<void>((ready) => { server.listen(0, "127.0.0.1", ready); });
  try {
    const address = server.address() as { port: number };
    await assert.rejects(new HttpTransport(`http://127.0.0.1:${address.port}`, { token }).advertise(), (error: Error) => {
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(encodeURIComponent(token)), false);
      assert.match(error.message, /redacted/);
      return true;
    });
  } finally { await new Promise<void>((done) => { server.close(() => done()); }); }
});

test("the CLI output guard preserves callbacks, buffers, clean output and backpressure", () => {
  let output = "";
  let callbacks = 0;
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const original = stream.write;
  guardCredentialOutput(["node", "cli", "get", `http://${token}@host`], [stream]);
  assert.equal(stream.write, original);
  guardCredentialOutput(["node", "cli", "vcs", "remote"], [stream]);
  assert.equal(stream.write, original);
  guardCredentialOutput(["node", "cli", "vcs", "remote", `http://${token}@host`], [stream]);
  stream.write(`http://${token}@host`, "utf8", () => { callbacks += 1; });
  stream.write(Buffer.from(`https://${token}@host`));
  assert.equal(stream.write("clean", () => { callbacks += 1; }), true);
  stream.write(Buffer.from("buffer"));
  assert.equal(output, "http://hosthttps://hostcleanbuffer");
  // Writable schedules successful write callbacks on the next turn.
  return new Promise<void>((done) => { setImmediate(() => { assert.equal(callbacks, 2); done(); }); });
});


test("the output guard scrubs control-whitespace URLs in text and JSON recovery arguments", () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const raw = `http://${token}\t@host`;
  guardCredentialOutput(["node", "cli", "vcs", "clone", raw], [stream]);
  stream.write(JSON.stringify({ args: [raw] }));
  assert.deepEqual(JSON.parse(output), { args: ["http://host"] });
  output = "";
  stream.write(raw);
  assert.equal(output, "http://host");
});
