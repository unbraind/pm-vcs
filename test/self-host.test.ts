// Real tests for the self-hosting gate.
//
// The gate's claim is mechanical: a bundle's tip tree must be byte-identical to
// the source tree, every object must hash to its id, and a stale or tampered
// bundle must fail closed. These tests build real object stores, real bundles
// through the engine's own `exportBundle`, and real source trees through
// `buildSourceTree`, then exercise the verdict against honest and tampered
// inputs. Nothing is mocked: the engine that ships is the engine under test.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore } from "../engine/objects.ts";
import { type Signature, readCommit, writeCommit } from "../engine/model.ts";
import { RefStore } from "../engine/refs.ts";
import { exportBundle, importBundleObjects } from "../engine/bundle.ts";

import {
  buildSourceTree,
  type SelfHostConfig,
  type SourceFile,
  isExcluded,
  loadConfig,
  verifySelfHost,
  writeSelfHostBundle,
} from "../scripts/self-host.ts";

const ref = "refs/heads/self-host";
const signature: Signature = { name: "self-host test", email: "t@t", timestamp: 1000, timezoneOffsetMinutes: 0 };

/** A scratch object store and ref store sharing a temp directory. */
interface Scratch {
  readonly store: ObjectStore;
  readonly refs: RefStore;
  cleanup(): void;
}

/** Creates a fresh store/ref pair backed by a real temp directory. */
function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-test-"));
  return {
    store: new ObjectStore(join(dir, "objects")),
    refs: new RefStore(dir),
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Builds a path→source-file map from literal string contents. */
function files(entries: ReadonlyArray<[string, string]>): Map<string, SourceFile> {
  const map = new Map<string, SourceFile>();
  for (const [path, content] of entries) {
    map.set(path, { content: Buffer.from(content, "utf8"), mode: "100644" });
  }
  return map;
}

/** Writes a bundle for the given source files and returns it with its tree id. */
function bundleFor(
  entries: ReadonlyArray<[string, string]>,
): { bytes: Buffer; treeId: ObjectId } {
  const { store, refs, cleanup } = scratch();
  try {
    const treeId = buildSourceTree(store, files(entries));
    const bytes = writeSelfHostBundle(store, refs, null, ref, treeId, signature, "snapshot\n");
    return { bytes, treeId };
  } finally {
    cleanup();
  }
}

const opened: Scratch[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.cleanup();
});

/** A scratch store that is cleaned up after each test. */
function own(): Scratch {
  const item = scratch();
  opened.push(item);
  return item;
}

test("isExcluded matches exact paths and directory prefixes", () => {
  const exclude = ["selfhost.bundle", "dist/", "build/out/"];
  assert.equal(isExcluded("selfhost.bundle", exclude), true);
  assert.equal(isExcluded("dist/anything", exclude), true);
  assert.equal(isExcluded("dist", exclude), false);
  assert.equal(isExcluded("build/out/x", exclude), true);
  assert.equal(isExcluded("build/out", exclude), false);
  assert.equal(isExcluded("engine/model.ts", exclude), false);
});

test("loadConfig accepts a well-formed configuration and rejects bad shapes", () => {
  const cfg: SelfHostConfig = loadConfig(join(import.meta.dirname, "..", "self-host.json"));
  assert.equal(cfg.bundle, "selfhost.bundle");
  assert.equal(cfg.ref, "refs/heads/self-host");
  assert.deepEqual([...cfg.exclude], ["selfhost.bundle"]);
  assert.throws(() => loadConfig(join(tmpdir(), "definitely-not-present-self-host.json")));
});

test("buildSourceTree is deterministic over content and insertion order", () => {
  const a = own();
  const b = own();
  const one = buildSourceTree(a.store, files([["a.txt", "x"], ["b/c.txt", "y"]]));
  const two = buildSourceTree(b.store, files([["b/c.txt", "y"], ["a.txt", "x"]]));
  assert.equal(one, two);
});

test("verifySelfHost passes when the bundle tip matches the source tree", () => {
  const { bytes, treeId } = bundleFor([["README.md", "hello"], ["engine/x.ts", "y"]]);
  const { store, cleanup } = own();
  try {
    // The source tree is rebuilt in the verifying store so the gate exercises a
    // real import of the bundle rather than sharing the writer's objects.
    const sourceTreeId = buildSourceTree(store, files([["README.md", "hello"], ["engine/x.ts", "y"]]));
    assert.equal(sourceTreeId, treeId);
    const result = verifySelfHost(store, bytes, ref, sourceTreeId);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("verifySelfHost fails when a tracked source path is absent from the bundle", () => {
  const { bytes } = bundleFor([["a.txt", "x"], ["b.txt", "y"]]);
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"], ["c.txt", "z"]]));
    const result = verifySelfHost(store, bytes, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("c.txt")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("verifySelfHost fails when the bundle carries a path the source does not", () => {
  const { bytes } = bundleFor([["a.txt", "x"], ["extra.txt", "z"]]);
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const result = verifySelfHost(store, bytes, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("extra.txt")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("verifySelfHost fails when content differs", () => {
  const { bytes } = bundleFor([["a.txt", "original"]]);
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "modified"]]));
    const result = verifySelfHost(store, bytes, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("content differs")), result.problems.join("\n"));
    assert.ok(result.problems.some((p) => p.includes("not byte-identical")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("verifySelfHost fails when the executable mode differs", () => {
  const { store, refs, cleanup } = own();
  try {
    const treeId = buildSourceTree(store, files([["run.sh", "echo hi"]]));
    const bytes = writeSelfHostBundle(store, refs, null, ref, treeId, signature, "m\n");
    // Build a source tree with the same content but the executable bit set.
    const executable = new Map<string, SourceFile>([["run.sh", { content: Buffer.from("echo hi"), mode: "100755" }]]);
    const sourceTreeId = buildSourceTree(store, executable);
    const result = verifySelfHost(store, bytes, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("mode differs")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("verifySelfHost rejects a bundle whose object id does not match its bytes", () => {
  const { bytes } = bundleFor([["a.txt", "x"]]);
  // Corrupt the first object line: keep the id, change the payload so it no
  // longer hashes to that id. parseBundle must re-hash and reject it.
  const text = bytes.toString("utf8").split("\n");
  const lineIndex = text.findIndex((line) => line.startsWith("blob "));
  assert.ok(lineIndex >= 0);
  const [kind, id] = text[lineIndex].split(" ");
  const tampered = Buffer.from("tampered-content").toString("base64");
  text[lineIndex] = `${kind} ${id} ${tampered}`;
  const corrupted = Buffer.from(text.join("\n"), "utf8");
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const result = verifySelfHost(store, corrupted, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("malformed") || p.includes("hash")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("verifySelfHost fails when the advertised ref is absent", () => {
  const { bytes } = bundleFor([["a.txt", "x"]]);
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const result = verifySelfHost(store, bytes, "refs/heads/missing", sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("refs/heads/missing")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle creates a root commit on the first run", () => {
  const { store, refs, cleanup } = own();
  try {
    const treeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const bytes = writeSelfHostBundle(store, refs, null, ref, treeId, signature, "first\n");
    assert.ok(bytes.length > 0);
    const tip = refs.read(ref);
    assert.ok(tip !== null);
    const commit = readCommit(store, tip);
    assert.deepEqual(commit.parents, []);
    assert.equal(commit.tree, treeId);
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle is a no-op when the source tree is unchanged", () => {
  const { store, refs, cleanup } = own();
  try {
    const treeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const first = writeSelfHostBundle(store, refs, null, ref, treeId, signature, "first\n");
    const second = writeSelfHostBundle(store, refs, first, ref, treeId, signature, "first\n");
    assert.equal(second, first);
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle appends a commit when the source tree changes", () => {
  const { store, refs, cleanup } = own();
  try {
    const treeA = buildSourceTree(store, files([["a.txt", "x"]]));
    const first = writeSelfHostBundle(store, refs, null, ref, treeA, signature, "first\n");
    const rootTip = refs.read(ref);
    assert.ok(rootTip !== null);
    const treeB = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"]]));
    const second = writeSelfHostBundle(store, refs, first, ref, treeB, signature, "second\n");
    assert.notEqual(second, first);
    const newTip = refs.read(ref);
    assert.ok(newTip !== null);
    assert.notEqual(newTip, rootTip);
    const commit = readCommit(store, newTip!);
    assert.deepEqual(commit.parents, [rootTip]);
    assert.equal(commit.tree, treeB);
    // The new bundle verifies against the new source tree.
    const result = verifySelfHost(store, second, ref, treeB);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("a bundle written by exportBundle round-trips through verifySelfHost", () => {
  const { store, refs, cleanup } = own();
  try {
    const treeId = buildSourceTree(store, files([["nested/deep/file.txt", "content"], ["top.txt", "t"]]));
    // Use the engine's exportBundle directly, then verify: the gate must accept
    // a bundle produced by the canonical export path, not only by writeSelfHostBundle.
    const tip = writeCommit(store, {
      tree: treeId,
      parents: [],
      author: signature,
      committer: signature,
      message: "direct\n",
    });
    refs.compareAndSwap(ref, null, tip);
    const bytes = exportBundle(store, refs, [ref]);
    const result = verifySelfHost(store, bytes, ref, treeId);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("importBundleObjects re-verifies every object against its own id", () => {
  // Confirms point 3 directly: a tampered payload under an unchanged id is the
  // exact fault parseBundle exists to refuse, and it must not be admittable.
  const { bytes } = bundleFor([["a.txt", "x"], ["b.txt", "y"]]);
  const text = bytes.toString("utf8").split("\n");
  const lineIndex = text.findIndex((line) => line.startsWith("blob "));
  assert.ok(lineIndex >= 0);
  const [kind, id] = text[lineIndex].split(" ");
  text[lineIndex] = `${kind} ${id} ${Buffer.from("different").toString("base64")}`;
  const corrupted = Buffer.from(text.join("\n"), "utf8");
  const { store, cleanup } = own();
  try {
    assert.throws(() => importBundleObjects(store, corrupted));
  } finally {
    cleanup();
  }
});