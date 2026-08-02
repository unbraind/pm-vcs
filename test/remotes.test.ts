import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ObjectStoreError } from "../engine/objects.ts";
import { REMOTE_PREFIX, RemoteStore, assertRemoteName, trackingRef } from "../engine/remotes.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

/**
 * Creates a remote store backed by a fresh temporary file.
 *
 * @returns The store and the path it writes to.
 */
function fresh(): { store: RemoteStore; path: string } {
  dir = makeTempDir();
  const path = join(dir.root, "remotes.json");
  return { store: new RemoteStore(path), path };
}

test("a repository with no remotes file reports no remotes", () => {
  assert.deepEqual(fresh().store.list(), []);
});

test("added remotes read back sorted and survive a reopen", () => {
  const { store, path } = fresh();
  store.add("upstream", "/srv/upstream");
  store.add("origin", "/srv/origin");
  assert.deepEqual(store.list().map((remote) => remote.name), ["origin", "upstream"]);
  // A second instance over the same file, because the store keeps nothing in
  // memory and a test that reused one object would pass even if `write` did not.
  assert.deepEqual(new RemoteStore(path).read("upstream"), { name: "upstream", url: "/srv/upstream" });
});

test("read returns null for a name that is not configured", () => {
  assert.equal(fresh().store.read("origin"), null);
});

test("require names the configured remotes when the one asked for is absent", () => {
  const { store } = fresh();
  assert.throws(() => store.require("origin"), (error: ObjectStoreError) => {
    assert.equal(error.code, "unknown_remote");
    assert.match(error.message, /has no remotes/);
    return true;
  });
  store.add("upstream", "/srv/upstream");
  assert.throws(() => store.require("origin"), (error: ObjectStoreError) => {
    assert.match(error.message, /Configured remotes: upstream/);
    return true;
  });
  assert.equal(store.require("upstream").url, "/srv/upstream");
});

test("adding a name that is already configured is refused rather than repointing it", () => {
  const { store } = fresh();
  store.add("origin", "/srv/one");
  assert.throws(() => store.add("origin", "/srv/two"), (error: ObjectStoreError) => {
    assert.equal(error.code, "remote_exists");
    return true;
  });
  // The refusal has to leave the original in place; a partial write here would
  // send the next push to /srv/two while reporting the add as failed.
  assert.equal(store.require("origin").url, "/srv/one");
});

test("removing a remote leaves the others and refuses an unknown name", () => {
  const { store } = fresh();
  store.add("origin", "/srv/one");
  store.add("upstream", "/srv/two");
  store.remove("origin");
  assert.deepEqual(store.list().map((remote) => remote.name), ["upstream"]);
  assert.throws(() => store.remove("origin"), (error: ObjectStoreError) => {
    assert.equal(error.code, "unknown_remote");
    return true;
  });
});

test("a remotes file that is not JSON is fatal rather than read as no remotes", () => {
  const { store, path } = fresh();
  writeFileSync(path, "{not json");
  assert.throws(() => store.list(), (error: ObjectStoreError) => {
    assert.equal(error.code, "bad_remotes");
    assert.match(error.message, /not valid JSON/);
    return true;
  });
});

test("a remotes file holding a non-object is refused", () => {
  const { store, path } = fresh();
  writeFileSync(path, "[]");
  assert.throws(() => store.list(), (error: ObjectStoreError) => {
    assert.match(error.message, /not a JSON object/);
    return true;
  });
});

test("a remote stored without a usable URL is refused by name", () => {
  const { store, path } = fresh();
  writeFileSync(path, JSON.stringify({ origin: 7 }));
  assert.throws(() => store.list(), (error: ObjectStoreError) => {
    assert.equal(error.code, "bad_remotes");
    assert.match(error.message, /Remote "origin" is stored with "7"/);
    return true;
  });
  writeFileSync(path, JSON.stringify({ origin: null }));
  assert.throws(() => store.list(), /is stored with "null"/);
  writeFileSync(path, "{}");
  assert.throws(() => store.add("other", ""), /is stored with ""/);
});

test("an unreadable remotes file is raised rather than reported as absent", () => {
  dir = makeTempDir();
  // A directory where the file belongs: reading it fails with EISDIR, which is
  // not ENOENT and must not be flattened into "no remotes configured".
  const store = new RemoteStore(dir.root);
  assert.throws(() => store.list(), (error: NodeJS.ErrnoException) => {
    assert.notEqual(error.code, "ENOENT");
    return true;
  });
});

test("remote names that would corrupt the tracking namespace are refused", () => {
  for (const name of ["", ".", "..", "a/b", "a\\b", "with space", "star*", "tilde~"]) {
    assert.throws(() => assertRemoteName(name), (error: ObjectStoreError) => {
      assert.equal(error.code, "invalid_remote_name");
      return true;
    }, `expected ${JSON.stringify(name)} to be refused`);
  }
  assert.doesNotThrow(() => assertRemoteName("origin"));
  assert.doesNotThrow(() => assertRemoteName("up-stream.2"));
});

test("a tracking ref is the remote name under the remotes prefix", () => {
  assert.equal(trackingRef("origin", "main"), `${REMOTE_PREFIX}origin/main`);
  assert.equal(trackingRef("origin", "feature/x"), `${REMOTE_PREFIX}origin/feature/x`);
});

test("a write that cannot be published leaves no temporary file behind", () => {
  dir = makeTempDir();
  // The control directory removed underneath the store: `list` reads this as "no
  // remotes yet", so the failure lands in `write`, between creating the temporary
  // file and renaming it into place.
  const store = new RemoteStore(join(dir.root, "gone", "remotes.json"));
  assert.deepEqual(store.list(), []);

  assert.throws(() => store.add("origin", "/srv/one"), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });
  // A temporary left behind would accumulate one file per failed write, in the
  // directory `list` reads — and `remotes.json.<pid>.<hex>.tmp` is not a remote.
  assert.deepEqual(readdirSync(dir.root), []);
});
