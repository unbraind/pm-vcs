import "./helpers/isolate-session.ts";
import { testEnvironment } from "./helpers/test-environment.ts";
// Real tests for the self-hosting gate.
//
// The gate's claim is mechanical: a bundle's tip tree must be byte-identical to
// the source tree, every object must hash to its id, and a stale or tampered
// bundle must fail closed. These tests build real object stores, real bundles
// through the engine's own `exportBundle`, and real source trees through
// `buildSourceTree`, then exercise the verdict against honest and tampered
// inputs. Nothing is mocked: the engine that ships is the engine under test.

import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { ModuleMocks } from "./helpers/self-host-mocks.ts";
import { isolatedPathspecEnvironment } from "../git.ts";

import { type ObjectArrival } from "../engine/lifecycle.ts";
import { type ObjectId, ObjectStore } from "../engine/objects.ts";
import { type Signature, readCommit, writeCommit } from "../engine/model.ts";
import { RefStore } from "../engine/refs.ts";
import { exportBundle, importBundleObjects, parseBundle } from "../engine/bundle.ts";
import { destructionBoundary, retireNamespace } from "../engine/destruction.ts";

import {
  buildSourceTree,
  compareTrees,
  errorMessage,
  type SelfHostConfig,
  type SourceFile,
  freshStore,
  headCommitTimestamp,
  isExcluded,
  isMainInvocation,
  listTrackedFiles,
  listTreeEntries,
  loadConfig,
  main,
  readCommittedFile,
  parseBatchResponse,
  type TreeEntry,
  readSourceFiles,
  readTreeBlobs,
  readTreeSnapshot,
  resolveBundleTarget,
  runGit,
  snapshotIsUnchanged,
  sameWorkflowExceptActionRevisions,
  verifySelfHost,
  writeSelfHostBundle,
} from "../scripts/self-host.ts";
import { flattenTree } from "../engine/worktree.ts";

const ref = "refs/heads/self-host";
const signature: Signature = { name: "self-host test", email: "t@t", timestamp: 1000, timezoneOffsetMinutes: 0 };
const mock = new ModuleMocks();

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
/** Temp directories a test created directly, removed with the scratch stores. */
const temps: string[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
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

test("loadConfig accepts the repository's own well-formed configuration", () => {
  const cfg: SelfHostConfig = loadConfig(join(import.meta.dirname, "..", "self-host.json"));
  assert.equal(cfg.bundle, "selfhost.bundle");
  assert.equal(cfg.ref, "refs/heads/self-host");
  assert.deepEqual([...cfg.exclude], [".github/pm-release-candidate.json", "selfhost.bundle", "package.json", "package-lock.json"]);
  assert.equal(isExcluded(".github/pm-release-candidate.json", cfg.exclude), true);
  assert.equal(isExcluded(".github/workflows/release.yml", cfg.exclude), false);
});

// The config is the gate's only tunable, so a malformed one must fail loudly
// rather than degrade into a weaker check. Each row is a shape that would
// otherwise leave the gate comparing against nothing in particular.
test("loadConfig rejects every malformed shape, not merely a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-cfg-"));
  temps.push(dir);
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["not-an-object", '"a string"'],
    ["null-body", "null"],
    ["array-body", "[]"],
    ["missing-bundle", '{"ref":"refs/heads/x","exclude":[]}'],
    ["empty-bundle", '{"bundle":"","ref":"refs/heads/x","exclude":[]}'],
    ["missing-ref", '{"bundle":"selfhost.bundle","exclude":[]}'],
    ["empty-ref", '{"bundle":"selfhost.bundle","ref":"","exclude":[]}'],
    ["exclude-not-array", '{"bundle":"selfhost.bundle","ref":"refs/heads/x","exclude":"nope"}'],
    ["exclude-entry-not-string", '{"bundle":"selfhost.bundle","ref":"refs/heads/x","exclude":[1]}'],
    ["malformed-json", "{not json"],
    // `bundle` is resolved with join(root, ...) before writing, so a path that
    // escapes the repository would let a pull request choose where a
    // maintainer's own `self-host:write` writes.
    ["bundle-absolute-posix", '{"bundle":"/etc/passwd","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-absolute-windows", '{"bundle":"C:\\\\temp\\\\x","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-parent-escape", '{"bundle":"../outside.bundle","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-nested-escape", '{"bundle":"a/../../outside.bundle","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-backslash-escape", '{"bundle":"a\\\\..\\\\..\\\\outside","ref":"refs/heads/x","exclude":[]}'],
    ["exclude-parent-escape", '{"bundle":"selfhost.bundle","ref":"refs/heads/x","exclude":["../elsewhere"]}'],
    // Artifact identity comes from the code, not the data file. These are all
    // lexically relative, non-link, in-repository paths that earlier rounds of
    // guarding accepted: a tracked file, and a not-yet-existing git hook.
    ["bundle-readme", '{"bundle":"README.md","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-git-hook", '{"bundle":".git/hooks/pre-commit","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-plausible-alias", '{"bundle":"self-host.bundle","ref":"refs/heads/x","exclude":[]}'],
    // A bundle cannot contain itself: with an empty exclude set, --write folds
    // the current bundle into the source tree and then overwrites it, so the
    // emitted bundle records the previous bytes and the next check fails.
    ["exclude-omits-the-bundle", '{"bundle":"selfhost.bundle","ref":"refs/heads/x","exclude":[]}'],
    ["exclude-omits-bundle-but-has-others", '{"bundle":"selfhost.bundle","ref":"refs/heads/x","exclude":["dist/"]}'],
  ];
  for (const [name, body] of cases) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, body);
    assert.throws(() => loadConfig(path), new RegExp("self-host|JSON"), `${name} should be rejected`);
  }
  assert.throws(() => loadConfig(join(dir, "definitely-not-present.json")));
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

// Both other tamper tests *change* an object. Removing one is the different
// failure: the bundle stays internally well-formed and every surviving object
// still hashes to its id, so only walking the tip's references catches it.
test("verifySelfHost fails when the bundle omits an object its tree references", () => {
  const { bytes } = bundleFor([["a.txt", "x"], ["b.txt", "y"]]);
  const text = bytes.toString("utf8").split("\n");
  const lineIndex = text.findIndex((line) => line.startsWith("blob "));
  assert.ok(lineIndex >= 0);
  text.splice(lineIndex, 1);
  const pruned = Buffer.from(text.join("\n"), "utf8");
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"]]));
    const result = verifySelfHost(store, pruned, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0, "an omitted object must be reported");
  } finally {
    cleanup();
  }
});

// The sibling case, and a different code path. A missing *blob* is caught by
// asserting presence, because flattening never reads blob content. A missing
// *tree* fails earlier and harder: the walk itself cannot complete.
test("verifySelfHost fails when the bundle omits a tree object the walk needs", () => {
  const { bytes } = bundleFor([["dir/a.txt", "x"], ["dir/b.txt", "y"]]);
  const text = bytes.toString("utf8").split("\n");
  // The last tree line is the subtree; removing the root would only orphan the
  // commit, which the ancestry walk already covers.
  const lineIndex = text.map((line, i) => (line.startsWith("tree ") ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(lineIndex !== undefined && lineIndex >= 0);
  text.splice(lineIndex, 1);
  const pruned = Buffer.from(text.join("\n"), "utf8");
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["dir/a.txt", "x"], ["dir/b.txt", "y"]]));
    const result = verifySelfHost(store, pruned, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0, "an omitted tree must be reported");
  } finally {
    cleanup();
  }
});

// The ref exists but points at the wrong *kind* of object. The tip is read as a
// commit, so this is the branch where that read throws rather than returning a
// commit whose tree happens to disagree.
test("verifySelfHost fails when the advertised ref points at a non-commit object", () => {
  // `exportBundle` refuses to build this: it walks reachability from the tip and
  // needs a commit. So the bundle is assembled honestly and then its header is
  // repointed at a blob that is already carried inside it — every object still
  // hashes to its id, and only reading the tip as a commit exposes the problem.
  const { bytes } = bundleFor([["a.txt", "x"]]);
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as { refs: Record<string, string>; objects: string[] };
  const blobLine = lines.find((line) => line.startsWith("blob "));
  assert.ok(blobLine, "the bundle should carry at least one blob");
  header.refs[ref] = blobLine.split(" ")[1];
  lines[1] = JSON.stringify(header);
  const repointed = Buffer.from(lines.join("\n"), "utf8");
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const result = verifySelfHost(store, repointed, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0, result.problems.join("\n"));
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

// The writer is bounded: a regeneration replaces the snapshot, it never adds to
// a history. These are the invariants that fail closed if the writer ever
// regresses to appending — each one asserts a property the append form cannot
// satisfy.
test("writeSelfHostBundle replaces the snapshot with a fresh parentless commit when the source tree changes", () => {
  const { store, refs, cleanup } = own();
  try {
    const treeA = buildSourceTree(store, files([["a.txt", "x"]]));
    const first = writeSelfHostBundle(store, refs, null, ref, treeA, signature, "first\n");
    const supersededTip = refs.read(ref);
    assert.ok(supersededTip !== null);
    const treeB = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"]]));
    const second = writeSelfHostBundle(store, refs, first, ref, treeB, signature, "second\n");
    assert.notEqual(second, first);
    const newTip = refs.read(ref);
    assert.ok(newTip !== null);
    assert.notEqual(newTip, supersededTip);
    const commit = readCommit(store, newTip!);
    assert.deepEqual(commit.parents, []);
    assert.equal(commit.tree, treeB);
    // Bounded: exactly one commit, no prerequisites, and no trace of the
    // superseded snapshot. An appending writer carries the old tip commit (and,
    // with it, its whole tree) inside every later bundle.
    const parsed = parseBundle(second);
    assert.equal(parsed.lines.filter((line) => line.type === "commit").length, 1);
    assert.deepEqual(parsed.header.prerequisites, []);
    assert.equal(parsed.lines.some((line) => line.id === supersededTip), false);
    // The new bundle verifies against the new source tree.
    const result = verifySelfHost(store, second, ref, treeB);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle stays bounded across repeated source changes", () => {
  const { store, refs, cleanup } = own();
  try {
    // A large file dominates the bundle, so accumulated history would be
    // unmistakable: an appending writer carries one 64 KiB blob per round.
    const big = "z".repeat(64 * 1024);
    let tree = buildSourceTree(store, files([["a.txt", big]]));
    let bytes = writeSelfHostBundle(store, refs, null, ref, tree, signature, "first\n");
    const firstSize = bytes.length;
    for (let round = 0; round < 10; round += 1) {
      tree = buildSourceTree(store, files([["a.txt", big + round]]));
      bytes = writeSelfHostBundle(store, refs, bytes, ref, tree, signature, `round ${round}\n`);
    }
    const parsed = parseBundle(bytes);
    assert.equal(parsed.lines.filter((line) => line.type === "commit").length, 1);
    assert.equal(parsed.header.prerequisites.length, 0);
    // Ten regenerations later the artifact is the size of one snapshot of one
    // file, not eleven of them.
    assert.ok(
      bytes.length < firstSize * 2,
      `the bundle grew to ${bytes.length} bytes after ten regenerations (first snapshot: ${firstSize})`,
    );
    const result = verifySelfHost(store, bytes, ref, tree);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle regenerates a pre-bounding history bundle even when its tip tree matches", () => {
  // Migration: the committed artifact from before the bound could be a full
  // multi-commit history whose tip tree equals the source tree. Reusing it
  // would keep an unbounded artifact committed forever, so a matching tip is
  // not enough — the *shape* must be a single-commit snapshot too.
  const { store, refs, cleanup } = own();
  try {
    const treeA = buildSourceTree(store, files([["a.txt", "x"]]));
    const root = writeCommit(store, {
      tree: treeA, parents: [], author: signature, committer: signature, message: "root\n",
    });
    refs.compareAndSwap(ref, null, root);
    const treeB = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"]]));
    const second = writeCommit(store, {
      tree: treeB, parents: [root], author: signature, committer: signature, message: "second\n",
    });
    refs.compareAndSwap(ref, root, second);
    const legacy = exportBundle(store, refs, [ref]);
    const bounded = writeSelfHostBundle(store, refs, legacy, ref, treeB, signature, "snapshot\n");
    assert.notEqual(bounded, legacy);
    const parsed = parseBundle(bounded);
    assert.equal(parsed.lines.filter((line) => line.type === "commit").length, 1);
    assert.equal(parsed.lines.some((line) => line.id === root), false);
    const result = verifySelfHost(store, bounded, ref, treeB);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle regenerates rather than reuses a thin bundle that declares prerequisites", () => {
  // A thin bundle is not a bounded snapshot: it leans on history the reader is
  // expected to already have. The gate's verify path would reject it as
  // non-self-contained, and the writer must not launder it into a no-op either.
  const { bytes } = bundleFor([["a.txt", "x"]]);
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as { refs: Record<string, string>; prerequisites?: string[] };
  header.prerequisites = [header.refs[ref]];
  lines[1] = JSON.stringify(header);
  const thin = Buffer.from(lines.join("\n"), "utf8");
  const { store, refs, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const bounded = writeSelfHostBundle(store, refs, thin, ref, sourceTreeId, signature, "snapshot\n");
    assert.notEqual(bounded, thin);
    const result = verifySelfHost(store, bounded, ref, sourceTreeId);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle regenerates rather than reuses a bundle whose advertised tip is not the snapshot commit", () => {
  // The ref exists but points elsewhere (here: a blob the bundle carries), so
  // the bundle is not interpretable as a snapshot of this source and the writer
  // builds a fresh one from the source rather than trusting a repointed header.
  const { bytes } = bundleFor([["a.txt", "x"]]);
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as { refs: Record<string, string> };
  const blobLine = lines.find((line) => line.startsWith("blob "));
  assert.ok(blobLine, "the bundle should carry at least one blob");
  header.refs[ref] = blobLine.split(" ")[1];
  lines[1] = JSON.stringify(header);
  const repointed = Buffer.from(lines.join("\n"), "utf8");
  const { store, refs, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const bounded = writeSelfHostBundle(store, refs, repointed, ref, sourceTreeId, signature, "snapshot\n");
    assert.notEqual(bounded, repointed);
    const result = verifySelfHost(store, bounded, ref, sourceTreeId);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle fails loudly when the committed bundle is malformed", () => {
  // A garbage file at the bundle path is an anomaly about the repository, not
  // an input to interpret; the writer surfaces the parse failure instead of
  // quietly replacing whatever it was.
  const { store, refs, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    assert.throws(() =>
      writeSelfHostBundle(store, refs, Buffer.from("not a bundle\n", "utf8"), ref, sourceTreeId, signature, "snapshot\n"));
  } finally {
    cleanup();
  }
});

// The bundle path holds the gate's own artifact. A bundle advertising a foreign
// ref — or nothing at all — is not that artifact, and overwriting it silently
// would bury the anomaly instead of surfacing it, whatever writer sits behind
// the regeneration.
test("writeSelfHostBundle refuses to overwrite a bundle that does not advertise the gate's ref", () => {
  const other = "refs/heads/some-other-ref";
  const { store: writeStore, refs: writeRefs, cleanup: writeCleanup } = own();
  const foreignTree = buildSourceTree(writeStore, files([["a.txt", "x"]]));
  const foreign = writeSelfHostBundle(writeStore, writeRefs, null, other, foreignTree, signature, "other\n");
  writeCleanup();

  const { store, refs, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    assert.throws(
      () => writeSelfHostBundle(store, refs, foreign, ref, sourceTreeId, signature, "snapshot\n"),
      /does not advertise|not this gate's artifact/,
    );

    // And the degenerate case: a bundle that advertises nothing at all. The
    // message has to say "(none)" rather than name an empty list, because
    // "advertised: " with nothing after it reads like a truncated error.
    const lines = foreign.toString("utf8").split("\n");
    const header = JSON.parse(lines[1]) as { refs: Record<string, string> };
    header.refs = {};
    lines[1] = JSON.stringify(header);
    assert.throws(
      () => writeSelfHostBundle(
        store,
        refs,
        Buffer.from(lines.join("\n"), "utf8"),
        ref,
        sourceTreeId,
        signature,
        "snapshot\n",
      ),
      /\(none\)/,
    );
  } finally {
    cleanup();
  }
});

test("writeSelfHostBundle publishes the snapshot against a fresh scratch ref store", () => {
  // Mirrors the real script: the writer never imports the committed bundle, so
  // its objects and its ref are absent from the scratch stores and the fresh
  // snapshot must still publish and verify.
  const write = own();
  const treeA = buildSourceTree(write.store, files([["a.txt", "x"]]));
  const first = writeSelfHostBundle(write.store, write.refs, null, ref, treeA, signature, "first\n");
  const verify = own();
  const treeB = buildSourceTree(verify.store, files([["a.txt", "x"], ["b.txt", "y"]]));
  const bytes = writeSelfHostBundle(verify.store, verify.refs, first, ref, treeB, signature, "second\n");
  assert.equal(verify.refs.read(ref) !== null, true);
  const result = verifySelfHost(verify.store, bytes, ref, treeB);
  assert.equal(result.ok, true, result.problems.join("\n"));
  write.cleanup();
  verify.cleanup();
});

test("snapshotIsUnchanged treats a header without prerequisites as a bounded snapshot", () => {
  // `prerequisites` is validated by `parseBundle` only when present, so a
  // header may legitimately omit it. Absence means the bundle leans on no
  // base history — the bounded shape — so a matching snapshot must be reused,
  // not crashed on and not pointlessly regenerated.
  const { bytes, treeId } = bundleFor([["a.txt", "x"]]);
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as { prerequisites?: unknown };
  delete header.prerequisites;
  lines[1] = JSON.stringify(header);
  const sparse = Buffer.from(lines.join("\n"), "utf8");
  assert.equal(snapshotIsUnchanged(sparse, ref, treeId), true);
});

test("snapshotIsUnchanged reports an already-bounded matching bundle", () => {
  const { bytes, treeId } = bundleFor([["a.txt", "x"]]);
  assert.equal(snapshotIsUnchanged(bytes, ref, treeId), true);
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
// --- Private-function coverage: real git repos, no mocks ---
//
// The functions below are the script's git-facing plumbing. They were private
// when the gate reported 100% on the exported API alone, which meant the gate
// never exercised the code that actually runs in CI. Exporting them lets the
// suite drive each one against a disposable real git repository, so the coverage
// percentage reflects what ships, not just what the unit tests import.

/** A disposable git repo with one commit and a self-host config. */
interface Fixture {
  readonly root: string;
  /** Runs git in the fixture repo with the pinned env overrides. */
  git(args: string[]): string;
  cleanup(): void;
}

/** Creates a real git repo, commits some source files, and writes a self-host.json. */
function fixture(objectFormat = "sha1"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-fixture-"));
  const git = (args: string[]): string => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...testEnvironment(), NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  git(["init", "-q", "-b", "main", `--object-format=${objectFormat}`]);
  git(["config", "user.email", "test@pm-vcs.local"]);
  git(["config", "user.name", "self-host test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "README.md"), "hello\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "self-host.json"), JSON.stringify({
    bundle: "selfhost.bundle",
    ref: "refs/heads/self-host",
    exclude: ["selfhost.bundle"],
  }));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  return {
    root,
    git,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("runGit returns trimmed stdout from a real git command", () => {
  const f = fixture();
  try {
    assert.equal(runGit(f.root, ["rev-parse", "--show-toplevel"]).length > 0, true);
  } finally {
    f.cleanup();
  }
});

test("runGit propagates a non-zero exit as an error", () => {
  const f = fixture();
  try {
    assert.throws(() => runGit(f.root, ["show", "nonexistent-ref"]));
  } finally {
    f.cleanup();
  }
});

test("listTrackedFiles returns NUL-delimited tracked paths", () => {
  const f = fixture();
  try {
    const tracked = listTrackedFiles(f.root);
    assert.ok(tracked.includes("README.md"));
    assert.ok(tracked.includes("src/app.ts"));
    assert.ok(tracked.includes("self-host.json"));
  } finally {
    f.cleanup();
  }
});

/** Reads every file a bundle carries, keyed by path, from a scratch import. */
function bundledFiles(bytes: Buffer): Map<string, { content: Buffer; mode: string }> {
  const { store, cleanup } = own();
  try {
    const imported = importBundleObjects(store, bytes);
    const tip = imported.header.refs[ref];
    const flat = flattenTree(store, readCommit(store, tip).tree);
    const files = new Map<string, { content: Buffer; mode: string }>();
    for (const [path, entry] of flat) {
      files.set(path, { content: store.readTyped(entry.id, "blob"), mode: entry.mode });
    }
    return files;
  } finally {
    cleanup();
  }
}

/** Asserts the read-only gate passes on `root`, restoring the process exit code. */
async function assertCheckPasses(root: string): Promise<void> {
  const exitBefore = process.exitCode;
  const origErr = console.error;
  let errs = "";
  console.error = (msg: string) => { errs += `${msg}\n`; };
  process.exitCode = 0;
  try {
    await main(root, ["node", "self-host.ts"]);
    assert.equal(process.exitCode, 0, errs);
  } finally {
    process.exitCode = exitBefore;
    console.error = origErr;
  }
}

test("readTreeSnapshot returns raw committed bytes, modes and the committed bundle", async () => {
  const f = fixture();
  try {
    // The mode is what the tree records — not what a checkout wrote — so the
    // executable bit needs no filesystem materialization at all.
    writeFileSync(join(f.root, "run.sh"), "#!/bin/sh\necho hi\n");
    f.git(["add", "-A"]);
    f.git(["update-index", "--chmod=+x", "run.sh"]);
    f.git(["commit", "-qm", "add executable"]);
    await main(f.root, ["node", "self-host.ts", "--write"]);
    // Stage the bundle explicitly: `git add -A` would re-read `run.sh` from
    // the working tree and reset the executable mode the tree records.
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "add bundle"]);
    // A conversion-enabled host must not move one byte of the snapshot.
    f.git(["config", "core.autocrlf", "true"]);
    const snapshot = await readTreeSnapshot(f.root, "HEAD");
    assert.equal(snapshot.files.get("run.sh")?.mode, "100755");
    assert.deepEqual(snapshot.files.get("run.sh")?.content, await readCommittedFile(f.root, "run.sh"));
    assert.deepEqual(snapshot.files.get("README.md")?.content, await readCommittedFile(f.root, "README.md"));
    assert.equal(snapshot.files.has("selfhost.bundle"), false, "exclusions apply to the source files");
    assert.deepEqual(snapshot.blobs.get("selfhost.bundle"), await readCommittedFile(f.root, "selfhost.bundle"));
  } finally {
    f.cleanup();
  }
});

test("listTreeEntries keeps a path that contains a newline", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "lead\ning.md"), "newline in path\n");
    f.git(["add", "-A"]);
    const entries = listTreeEntries(f.root, f.git(["write-tree"]));
    assert.ok(entries.some((entry) => entry.path === "lead\ning.md"));
    const blobs = await readTreeBlobs(f.root, entries);
    assert.deepEqual(blobs.get("lead\ning.md"), Buffer.from("newline in path\n", "utf8"));
  } finally {
    f.cleanup();
  }
});

test("readTreeBlobs reads no objects for an empty listing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-vcs-empty-listing-"));
  temps.push(dir);
  assert.deepEqual([...await readTreeBlobs(dir, [])], []);
});

test("readTreeSnapshot refuses a tree that carries a gitlink", async () => {
  const f = fixture();
  try {
    const sha = f.git(["rev-parse", "HEAD"]);
    f.git(["update-index", "--add", "--cacheinfo", `160000,${sha},vendor/sub`]);
    await assert.rejects(() => readTreeSnapshot(f.root, f.git(["write-tree"])), /commit entry|gitlink/);
  } finally {
    f.cleanup();
  }
});

test("parseBatchResponse parses a well-formed batch stream", () => {
  const entries: readonly TreeEntry[] = [
    { mode: "100644", sha: "a".repeat(40), path: "first.md" },
    { mode: "100755", sha: "b".repeat(40), path: "run.sh" },
  ];
  const first = Buffer.from("hello\nworld", "utf8");
  const second = Buffer.from("#!/bin/sh\n", "utf8");
  const stream = Buffer.concat([
    Buffer.from(`${entries[0].sha} blob ${first.length}\n`, "utf8"), first, Buffer.from("\n", "utf8"),
    Buffer.from(`${entries[1].sha} blob ${second.length}\n`, "utf8"), second, Buffer.from("\n", "utf8"),
  ]);
  const blobs = parseBatchResponse(stream, entries);
  assert.deepEqual(blobs.get("first.md"), first);
  assert.deepEqual(blobs.get("run.sh"), second);
});

test("parseBatchResponse refuses every malformed answer", () => {
  const sha = "c".repeat(40);
  const entry: TreeEntry = { mode: "100644", sha, path: "one.txt" };
  // Every refusal names the object and the path it was requested for.
  assert.throws(
    () => parseBatchResponse(Buffer.from(`${sha} blob 5`, "utf8"), [entry]),
    /ended before answering for one\.txt/,
  );
  const cases: ReadonlyArray<[string, Buffer]> = [
    ["missing object", Buffer.from(`${sha} missing\n`, "utf8")],
    ["non-numeric size", Buffer.from(`${sha} blob five\nhello\n`, "utf8")],
    ["mismatched sha", Buffer.from(`${"d".repeat(40)} blob 5\nhello\n`, "utf8")],
    ["non-blob answer", Buffer.from(`${sha} tree 5\nhello\n`, "utf8")],
    ["short payload", Buffer.from(`${sha} blob 5\nhel\n`, "utf8")],
  ];
  for (const [label, stream] of cases) {
    assert.throws(() => parseBatchResponse(stream, [entry]), new RegExp(sha), `${label} must name the object`);
  }
});

test("readTreeBlobs throws when git cannot be launched", async () => {
  const f = fixture();
  const origPath = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    await assert.rejects(
      () => readTreeBlobs(f.root, [{ mode: "100644", sha: "a".repeat(40), path: "x" }]),
      /could not run git/,
    );
  } finally {
    process.env.PATH = origPath;
    f.cleanup();
  }
});

test("readTreeBlobs refuses a directory without a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-vcs-no-repo-"));
  temps.push(dir);
  await assert.rejects(
    () => readTreeBlobs(dir, [{ mode: "100644", sha: "a".repeat(40), path: "x" }]),
    /git cat-file --batch failed/,
  );
});

test("readTreeSnapshot refuses a staged tree that drops the configuration", async () => {
  const f = fixture();
  try {
    f.git(["rm", "--cached", "--", "self-host.json"]);
    await assert.rejects(() => readTreeSnapshot(f.root, f.git(["write-tree"])), /does not carry self-host\.json/);
  } finally {
    f.cleanup();
  }
});


test("the staged snapshot keeps a tracked symlink's historical bundle bytes", async () => {
  const f = fixture();
  try {
    symlinkSync("README.md", join(f.root, "link.md"));
    f.git(["add", "--", "link.md"]);
    await main(f.root, ["node", "self-host.ts", "--write", "--staged"]);
    const bundled = bundledFiles(readFileSync(join(f.root, "selfhost.bundle")));
    // A link records its target text as blob content; the working-tree reader
    // has always bundled exactly those bytes as a non-executable file.
    assert.deepEqual(bundled.get("link.md")?.content, Buffer.from("README.md", "utf8"));
    assert.equal(bundled.get("link.md")?.mode, "100644");
  } finally {
    f.cleanup();
  }
});

test("readCommittedFile returns the bytes of a tracked file at HEAD", async () => {
  const f = fixture();
  try {
    const bytes = await readCommittedFile(f.root, "README.md");
    assert.ok(bytes !== null);
    assert.equal(bytes!.toString("utf8"), "hello\n");
  } finally {
    f.cleanup();
  }
});

test("readCommittedFile returns null for a path absent from HEAD", async () => {
  const f = fixture();
  try {
    assert.equal(await readCommittedFile(f.root, "nonexistent.txt"), null);
  } finally {
    f.cleanup();
  }
});

test("readSourceFiles reads non-excluded tracked files from a directory", () => {
  const f = fixture();
  try {
    const tracked = listTrackedFiles(f.root);
    const files = readSourceFiles(f.root, tracked, ["selfhost.bundle"]);
    assert.ok(files.has("README.md"));
    assert.ok(files.has("src/app.ts"));
    assert.equal(files.has("selfhost.bundle"), false);
  } finally {
    f.cleanup();
  }
});

test("readSourceFiles throws when a tracked non-excluded path is missing", () => {
  const f = fixture();
  try {
    assert.throws(
      () => readSourceFiles(f.root, ["phantom.txt"], []),
      /phantom\.txt.*deleted from the working tree/,
    );
  } finally {
    f.cleanup();
  }
});

test("freshStore creates a usable object store and ref store", () => {
  const { store, refs, dir, cleanup } = freshStore();
  try {
    const id = store.write("blob", Buffer.from("test"));
    assert.equal(store.read(id).payload.toString("utf8"), "test");
    assert.equal(refs.read("refs/heads/test"), null);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headCommitTimestamp returns the HEAD commit timestamp in ms", () => {
  const f = fixture();
  try {
    const ts = headCommitTimestamp(f.root);
    assert.ok(ts > 0, `expected a positive timestamp, got ${ts}`);
  } finally {
    f.cleanup();
  }
});

test("main --write generates a bundle in a real git repo", async () => {
  const f = fixture();
  try {
    const origLog = console.log;
    let logged = "";
    console.log = (msg: string) => { logged = msg; };
    try {
      await main(f.root, ["node", "self-host.ts", "--write"]);
    } finally {
      console.log = origLog;
    }
    assert.match(logged, /wrote selfhost\.bundle/);
    const bundleStat = readFileSync(join(f.root, "selfhost.bundle"));
    assert.ok(bundleStat.length > 0);
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "add bundle"]);
    await main(f.root, ["node", "self-host.ts"]);
  } finally {
    f.cleanup();
  }
});

test("staged self-host writing snapshots the pending config, blobs, paths and modes", async () => {
  const f = fixture();
  try {
    const archive = join(f.root, "selfhost.bundle");
    const args = ["node", "self-host.ts", "--write", "--staged"];
    await main(f.root, ["node", "self-host.ts", "--write"]);
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "baseline bundle"]);
    const readme = join(f.root, "README.md");
    writeFileSync(readme, "staged\n");
    writeFileSync(join(f.root, "new.txt"), "new path\n");
    writeFileSync(join(f.root, "self-host.json"), JSON.stringify({
      bundle: "selfhost.bundle", ref, exclude: ["selfhost.bundle", "excluded.txt"],
    }));
    writeFileSync(join(f.root, "excluded.txt"), "excluded by the staged configuration\n");
    f.git(["rm", "src/app.ts"]);
    f.git(["add", "--", "README.md", "new.txt", "self-host.json", "excluded.txt"]);
    f.git(["update-index", "--chmod=+x", "README.md"]);
    writeFileSync(readme, "unstaged\n");
    writeFileSync(join(f.root, "private.txt"), "untracked\n");
    writeFileSync(join(f.root, "self-host.json"), "unstaged, invalid configuration\n");
    const candidate = f.git(["write-tree"]);
    const base = f.git(["rev-parse", "HEAD"]);

    await main(f.root, args);
    assert.equal(f.git(["write-tree"]), candidate, "writing must preserve the caller's index");
    assert.equal(f.git(["rev-parse", "HEAD"]), base, "writing must preserve HEAD");
    assert.equal(readFileSync(readme, "utf8"), "unstaged\n");
    assert.equal(readFileSync(join(f.root, "self-host.json"), "utf8"), "unstaged, invalid configuration\n");
    const bytes = readFileSync(archive);
    utimesSync(archive, 1, 1);
    await main(f.root, args);
    assert.equal(statSync(archive).mtimeMs, 1000, "an identical pending snapshot must not be rewritten");

    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "commit exactly the staged candidate"]);
    const exitBefore = process.exitCode;
    await main(f.root, ["node", "self-host.ts"]);
    assert.equal(process.exitCode, exitBefore);
    await main(f.root, args);
    assert.deepEqual(readFileSync(archive), bytes);
    assert.equal(statSync(archive).mtimeMs, 1000, "a committed matching snapshot must not be rewritten");
  } finally {
    f.cleanup();
  }
});

test("staged self-host publication honors intent-to-add and refuses a late index removal", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = "selfhost.bundle";
  const archive = join(f.root, path);
  const index = join(f.root, ".git", "index");
  const args = ["--write", "--staged"];
  writeFileSync(archive, "intent-to-add placeholder\n");
  f.git(["add", "-N", "--", path]);
  assert.equal(f.git(["ls-tree", f.git(["write-tree"]), "--", path]), "");
  const indexBefore = readFileSync(index);
  await main(f.root, args);
  const original = readFileSync(archive);
  assert.ok(bundledFiles(original).has("README.md"));
  assert.deepEqual(readFileSync(index), indexBefore);

  f.git(["add", "--", path]);
  writeFileSync(join(f.root, "README.md"), "staged replacement\n");
  f.git(["add", "--", "README.md"]);
  const open = fs.openSync;
  let removed = false;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (!removed && typeof args[0] === "string" && args[0].startsWith(join(f.root, ".selfhost.bundle.pm-vcs-"))) {
      removed = true;
      f.git(["rm", "-f", "--cached", "--", path]);
    }
    return open(...args);
  });
  try {
    await assert.rejects(() => main(f.root, args), /not tracked by git/);
  } finally {
    mock.restoreAll();
  }
  assert.ok(removed);
  assert.equal(f.git(["ls-files", "--", path]), "");
  assert.deepEqual(readFileSync(archive), original);
  assert.ok(!readdirSync(f.root).some(entry => entry.startsWith(".selfhost.bundle.pm-vcs-")));
  rmSync(index);
  assert.throws(() => resolveBundleTarget(f.root, path), /not tracked by git/);
});

test("bundle regeneration preserves its existing mode across different umasks", { skip: process.platform === "win32" }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  const previousMask = process.umask(0o022);
  const rename = fs.renameSync;
  let publishingMode: number | undefined;
  mock.method(fs, "renameSync", (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]) => {
    if (target === path) publishingMode = statSync(source).mode & 0o777;
    rename(source, target);
  });
  try {
    await main(f.root, ["--write"]);
    assert.equal(statSync(path).mode & 0o777, 0o644, "a new bundle uses the default creation mode");
    f.git(["add", "--", "selfhost.bundle"]);
    for (const [mode, mask, args] of [
      [0o600, 0o022, ["--write"]],
      [0o640, 0o077, ["--write", "--staged"]],
      [0o444, 0o022, ["--write", "--staged"]],
    ] as const) {
      chmodSync(path, mode);
      process.umask(mask);
      const content = `source under ${mode.toString(8)}\n`;
      writeFileSync(join(f.root, "README.md"), content);
      f.git(["add", "--", "README.md"]);
      publishingMode = undefined;
      await main(f.root, args);
      assert.equal(publishingMode, mode, "the existing mode must be set before publication");
      assert.equal(statSync(path).mode & 0o777, mode);
      assert.deepEqual(bundledFiles(readFileSync(path)).get("README.md")?.content, Buffer.from(content));
    }

    const original = readFileSync(path);
    writeFileSync(join(f.root, "README.md"), "unpublished replacement\n");
    const open = fs.openSync;
    let changedMode = false;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (!changedMode && typeof args[0] === "string" && args[0].startsWith(join(f.root, ".selfhost.bundle.pm-vcs-"))) {
        changedMode = true;
        chmodSync(path, 0o400);
      }
      return open(...args);
    });
    await assert.rejects(() => main(f.root, ["--write"]), /permissions changed before publication/);
    assert.ok(changedMode);
    assert.equal(statSync(path).mode & 0o777, 0o400);
    assert.deepEqual(readFileSync(path), original);
  } finally {
    mock.restoreAll();
    process.umask(previousMask);
  }
});

test("bundle regeneration preserves its group before applying the mode", { skip: process.platform === "win32" }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  await main(f.root, ["--write"]);
  f.git(["add", "--", "selfhost.bundle"]);
  const { gid: defaultGroup, uid } = statSync(path);
  const alternateGroup = process.getgroups?.().find(gid => gid !== defaultGroup);
  const group = alternateGroup ?? defaultGroup;
  if (alternateGroup !== undefined) fs.chownSync(path, uid, group);
  chmodSync(path, 0o640);
  const original = readFileSync(path);
  writeFileSync(join(f.root, "README.md"), "regenerated for the existing group\n");

  const open = fs.openSync;
  const stat = fs.fstatSync;
  const chown = fs.fchownSync;
  const chmod = fs.fchmodSync;
  const denied = Object.assign(new Error("group change denied"), { code: "EPERM" });
  const calls: string[] = [];
  let temporary: number | undefined;
  let reportedDifferentGroup = false;
  let refuse = true;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (typeof args[0] === "string" && args[0].startsWith(join(f.root, ".selfhost.bundle.pm-vcs-"))) {
      temporary = fd;
      reportedDifferentGroup = false;
    }
    return fd;
  });
  mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    const result = stat(...args);
    // A runner with only one available group still exercises the reassignment.
    if (alternateGroup === undefined && args[0] === temporary && !reportedDifferentGroup) {
      reportedDifferentGroup = true;
      return Object.assign(result, { gid: BigInt(group) + 1n });
    }
    return result;
  });
  mock.method(fs, "fchownSync", (fd: number, owner: number, gid: number) => {
    assert.deepEqual([fd, owner, gid], [temporary, uid, group]);
    calls.push("group");
    if (refuse) throw denied;
    chown(fd, uid, gid);
  });
  mock.method(fs, "fchmodSync", (fd: number, mode: number) => {
    if (fd === temporary) calls.push("mode");
    chmod(fd, mode);
  });
  try {
    await assert.rejects(() => main(f.root, ["--write"]), error => error === denied);
    assert.deepEqual(calls, ["group"]);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(statSync(path).gid, group);
    assert.ok(!readdirSync(f.root).some(entry => entry.startsWith(".selfhost.bundle.pm-vcs-")));

    calls.length = 0;
    refuse = false;
    await main(f.root, ["--write"]);
    const published = statSync(path);
    assert.deepEqual(calls, ["group", "mode"]);
    assert.equal(published.gid, group);
    assert.equal(published.mode & 0o777, 0o640);
    assert.notDeepEqual(readFileSync(path), original);
  } finally {
    mock.restoreAll();
  }
});

test("bundle regeneration preserves its owner before applying the mode", { skip: process.platform === "win32" }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  await main(f.root, ["--write"]);
  f.git(["add", "--", "selfhost.bundle"]);
  const { uid, gid } = statSync(path);
  chmodSync(path, 0o600);
  const original = readFileSync(path);
  writeFileSync(join(f.root, "README.md"), "regenerated for the existing owner\n");

  const open = fs.openSync;
  const stat = fs.fstatSync;
  const chown = fs.fchownSync;
  const chmod = fs.fchmodSync;
  const denied = Object.assign(new Error("owner change denied"), { code: "EPERM" });
  const calls: string[] = [];
  let temporary: number | undefined;
  let reportedForeignOwner = false;
  let refuse = true;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (typeof args[0] === "string" && args[0].startsWith(join(f.root, ".selfhost.bundle.pm-vcs-"))) {
      temporary = fd;
      reportedForeignOwner = false;
    }
    return fd;
  });
  mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    const result = stat(...args);
    // A privileged regenerator writes the temporary under its own identity, so
    // the first observation reports a foreign owner that must be replaced.
    if (args[0] === temporary && !reportedForeignOwner) {
      reportedForeignOwner = true;
      return Object.assign(result, { uid: BigInt(uid) + 1n });
    }
    return result;
  });
  mock.method(fs, "fchownSync", (fd: number, owner: number, group: number) => {
    assert.deepEqual([fd, owner, group], [temporary, uid, gid]);
    calls.push("owner");
    if (refuse) throw denied;
    chown(fd, owner, group);
  });
  mock.method(fs, "fchmodSync", (fd: number, mode: number) => {
    if (fd === temporary) calls.push("mode");
    chmod(fd, mode);
  });
  try {
    await assert.rejects(() => main(f.root, ["--write"]), error => error === denied);
    assert.deepEqual(calls, ["owner"]);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(statSync(path).uid, uid);
    assert.ok(!readdirSync(f.root).some(entry => entry.startsWith(".selfhost.bundle.pm-vcs-")));

    calls.length = 0;
    refuse = false;
    await main(f.root, ["--write"]);
    const published = statSync(path);
    assert.deepEqual(calls, ["owner", "mode"]);
    assert.equal(published.uid, uid);
    assert.equal(published.gid, gid);
    assert.equal(published.mode & 0o777, 0o600);
    assert.notDeepEqual(readFileSync(path), original);
  } finally {
    mock.restoreAll();
  }
});

test("bundle publication refuses a temporary with silently altered permissions", { skip: process.platform === "win32" }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  await main(f.root, ["--write"]);
  f.git(["add", "--", "selfhost.bundle"]);
  chmodSync(path, 0o640);
  const original = readFileSync(path);
  writeFileSync(join(f.root, "README.md"), "new source with unchanged bundle permissions\n");

  const chmod = fs.fchmodSync;
  const fstat = fs.fstatSync;
  for (const changed of ["mode", "uid", "gid"] as const) {
    let temporary: number | undefined;
    mock.method(fs, "fchmodSync", (fd: number, mode: number) => {
      chmod(fd, changed === "mode" && mode === 0o640 ? 0o600 : mode);
      if (mode === 0o640) temporary = fd;
    });
    mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
      const observed = fstat(...args);
      if (args[0] === temporary && changed !== "mode") {
        temporary = undefined;
        return Object.assign(observed, { [changed]: BigInt(observed[changed]) + 1n });
      }
      return observed;
    });
    try {
      await assert.rejects(() => main(f.root, ["--write"]), /could not preserve the permissions of selfhost\.bundle/, changed);
      assert.deepEqual(readFileSync(path), original);
      assert.equal(statSync(path).mode & 0o777, 0o640);
      assert.ok(!readdirSync(f.root).some(name => name.startsWith(".selfhost.bundle.pm-vcs-")));
    } finally {
      mock.restoreAll();
    }
  }
});

test("a completed retirement without a move fails the write and keeps the previous bundle", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  await main(f.root, ["--write"]);
  f.git(["add", "--", "selfhost.bundle"]);
  const original = readFileSync(path);
  writeFileSync(join(f.root, "README.md"), "an edit that must not be reported as written\n");
  // The journal has captured the temporary when the engine reaches the rename
  // boundary: a cleanup that removes the temporary exactly there leaves the old
  // bundle in place, and the receipt records an absent source with no move.
  let removed = false;
  destructionBoundary.visit = (step: string, entryPath: string) => {
    if (step === "before-delete" && !removed && entryPath.startsWith(".selfhost.bundle.pm-vcs-")) {
      removed = true;
      rmSync(join(f.root, entryPath));
    }
  };
  try {
    await assert.rejects(() => main(f.root, ["--write"]), /publication of selfhost\.bundle did not complete/);
    assert.ok(removed);
    assert.deepEqual(readFileSync(path), original);
    assert.ok(!readdirSync(f.root).some(entry => entry.startsWith(".selfhost.bundle.pm-vcs-")));
  } finally {
    destructionBoundary.visit = () => {};
  }
});

test("first publication refuses an untracked bundle that appears during recovery", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  const foreign = Buffer.from("another process owns this untracked file\n");
  const lstat = fs.lstatSync;
  let appeared = false;
  mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const observed = lstat(...args);
    if (!appeared && observed === undefined && args[0] === path && args[1]?.bigint) {
      writeFileSync(path, foreign, { flag: "wx" });
      appeared = true;
    }
    return observed;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => main(f.root, ["--write"]), /selfhost\.bundle exists but is not tracked/);
    assert.ok(appeared);
    assert.deepEqual(readFileSync(path), foreign);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }

  for (const peer of ["regular", "directory", "hardlink"] as const) {
    rmSync(path, { recursive: true });
    const stale = join(f.root, `.selfhost.bundle.pm-vcs-recovery-${peer}`);
    const candidateBytes = Buffer.from("interrupted bootstrap bytes\n");
    writeFileSync(stale, candidateBytes);
    const peerPath = join(f.root, "peer.bundle");
    if (peer === "hardlink") fs.linkSync(stale, peerPath);
    else if (peer === "regular") writeFileSync(peerPath, foreign);
    destructionBoundary.visit = (step: string, entryPath: string) => {
      if (step === "before-delete" && entryPath === basename(stale)) {
        throw Object.assign(new Error("interrupt before bootstrap rename"), { code: "EINJECTED" });
      }
    };
    try {
      const expected = lstatSync(stale, { bigint: true });
      assert.throws(() => retireNamespace({ path: stale, destination: path, expected }), /interrupt before bootstrap rename/);
    } finally {
      destructionBoundary.visit = () => {};
    }
    let displaced = false;
    destructionBoundary.visit = (step: string) => {
      if (peer === "hardlink" || step !== "receipt-persisted" || displaced
        || lstatSync(path, { throwIfNoEntry: false }) === undefined) return;
      if (peer === "regular") renameSync(peerPath, path);
      else {
        rmSync(path);
        mkdirSync(path);
        writeFileSync(join(path, "peer.txt"), foreign);
      }
      displaced = true;
    };
    try {
      await assert.rejects(() => main(f.root, ["--write"]), /selfhost\.bundle exists but is not tracked/, peer);
      if (peer === "hardlink") {
        assert.equal(statSync(path).ino, statSync(peerPath).ino);
        assert.deepEqual(readFileSync(path), candidateBytes);
      } else {
        assert.ok(displaced);
        assert.deepEqual(readFileSync(peer === "directory" ? join(path, "peer.txt") : path), foreign);
      }
    } finally {
      destructionBoundary.visit = () => {};
    }
  }
});

test("a retry completes a pending bootstrap publication without writing a second candidate", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  // A Git checkout can also carry engine metadata. Recovery must look for
  // the journal in the native scope that originally recorded the move.
  const control = join(f.root, ".pmvcs");
  mkdirSync(control);
  writeFileSync(join(control, "format"), "pmvcs-1\n");
  // Produce the exact bytes a retry would request again from the same HEAD.
  await main(f.root, ["--write"]);
  const requested = readFileSync(path);
  // Simulate the interrupted write: the journal recorded the rename, the file
  // never moved, and the earlier candidate is still on disk under the
  // temporary name while the bundle path itself stays absent.
  const stale = join(f.root, ".selfhost.bundle.pm-vcs-00000000000000000000000000000000");
  renameSync(path, stale);
  const expected = lstatSync(stale, { bigint: true });
  const recorded = join("..", basename(stale));
  destructionBoundary.visit = (step: string, entryPath: string) => {
    if (step === "before-delete" && entryPath === recorded) {
      throw Object.assign(new Error("interrupt the first publication"), { code: "EINJECTED" });
    }
  };
  try {
    assert.throws(() => retireNamespace({ path: stale, destination: path, expected }), /interrupt the first publication/);
  } finally {
    destructionBoundary.visit = () => {};
  }
  assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined);
  const recoveredInode = statSync(stale).ino;
  await main(f.root, ["--write"]);
  // The retry reports the recovered candidate itself rather than refusing the
  // now-untracked bundle: the published file is the recovered inode, not a
  // freshly written replacement.
  const published = statSync(path);
  assert.equal(published.ino, recoveredInode);
  assert.deepEqual(readFileSync(path), requested);
  assert.ok(!readdirSync(f.root).some(entry => entry.startsWith(".selfhost.bundle.pm-vcs-")));
});

test("a retry replaces a recovered stale candidate with the current bytes", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "selfhost.bundle");
  await main(f.root, ["--write"]);
  const stale = join(f.root, ".selfhost.bundle.pm-vcs-00000000000000000000000000000001");
  renameSync(path, stale);
  const expected = lstatSync(stale, { bigint: true });
  const recorded = basename(stale);
  destructionBoundary.visit = (step: string, entryPath: string) => {
    if (step === "before-delete" && entryPath === recorded) {
      throw Object.assign(new Error("interrupt the first publication"), { code: "EINJECTED" });
    }
  };
  try {
    assert.throws(() => retireNamespace({ path: stale, destination: path, expected }), /interrupt the first publication/);
  } finally {
    destructionBoundary.visit = () => {};
  }
  // The source moves on after the interruption, so the pending candidate is stale.
  writeFileSync(join(f.root, "README.md"), "a fresher snapshot\n");
  const staleInode = statSync(stale).ino;
  await main(f.root, ["--write"]);
  const published = statSync(path);
  assert.notEqual(published.ino, staleInode);
  assert.deepEqual(bundledFiles(readFileSync(path)).get("README.md")?.content, Buffer.from("a fresher snapshot\n"));
  assert.ok(!readdirSync(f.root).some(entry => entry.startsWith(".selfhost.bundle.pm-vcs-")));
});

test("staged self-host writing repairs a bundle path that was a gitlink in HEAD", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const commit = f.git(["rev-parse", "HEAD"]);
  f.git(["update-index", "--add", "--cacheinfo", `160000,${commit},selfhost.bundle`]);
  f.git(["commit", "-qm", "record a gitlink at the bundle path"]);
  await assert.rejects(() => main(f.root, ["--check"]), /unsupported mode 160000 for selfhost\.bundle/);

  f.git(["rm", "--cached", "--", "selfhost.bundle"]);
  await main(f.root, ["--write", "--staged"]);
  f.git(["add", "--", "selfhost.bundle"]);
  f.git(["commit", "-qm", "replace the gitlink with a bundle"]);
  await main(f.root, ["--check"]);
});

test("staged self-host writing refuses an unresolved index before replacing the bundle", async () => {
  const f = fixture();
  try {
    const archive = join(f.root, "selfhost.bundle");
    const readme = join(f.root, "README.md");
    await main(f.root, ["node", "self-host.ts", "--write"]);
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "add the bundle"]);
    const bytes = readFileSync(archive);
    f.git(["switch", "-qc", "other"]);
    writeFileSync(readme, "other\n");
    f.git(["commit", "-qam", "other edit"]);
    f.git(["switch", "-q", "main"]);
    writeFileSync(readme, "main\n");
    f.git(["commit", "-qam", "main edit"]);
    assert.throws(() => f.git(["merge", "other"]), /Command failed/);
    assert.match(f.git(["ls-files", "--unmerged"]), /README\.md/);
    await assert.rejects(() => main(f.root, ["node", "self-host.ts", "--write", "--staged"]), /unmerged/);
    assert.deepEqual(readFileSync(archive), bytes);
  } finally {
    f.cleanup();
  }
});

test("staged self-host writing reports that a plain directory has no Git index", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-no-git-"));
  try {
    await assert.rejects(() => main(root, ["node", "self-host.ts", "--write", "--staged"]), /not a git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged self-host writing bundles raw object bytes under core.autocrlf=true", async () => {
  const f = fixture();
  try {
    // The blocking re-review finding: materializing the frozen tree through a
    // checkout (read-tree -u) smudges LF blobs into CRLF on a conversion-enabled
    // host, so the writer archived bytes the tree never stored and the committed
    // bundle failed the gate on a default checkout of the same commit.
    f.git(["config", "core.autocrlf", "true"]);
    writeFileSync(join(f.root, "README.md"), "staged\nsecond\r\n");
    f.git(["add", "--", "README.md"]);
    await main(f.root, ["node", "self-host.ts", "--write", "--staged"]);
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "staged candidate"]);
    // Byte-level proof against the object database: the bundle carries exactly
    // what the tree stores, whatever this host would check out.
    const bundled = bundledFiles(readFileSync(join(f.root, "selfhost.bundle")));
    assert.deepEqual(bundled.get("README.md")?.content, await readCommittedFile(f.root, "README.md"));
    // A default (no-conversion) checkout of the same commit must verify …
    f.git(["config", "core.autocrlf", "false"]);
    await assertCheckPasses(f.root);
    // … and so must the conversion-enabled host that wrote it.
    f.git(["config", "core.autocrlf", "true"]);
    await assertCheckPasses(f.root);
  } finally {
    f.cleanup();
  }
});

test("staged snapshots carry exactly the frozen tree's bytes under every conversion vector", async () => {
  // Property: whatever conversion rules the host would apply on checkout —
  // core.autocrlf, eol attributes — the bundle's bytes for every path equal
  // the frozen tree's stored bytes, because they are read from the object
  // database and never materialized. Both conversion vectors are active at
  // once in the second case, so any checkout-based reader fails this.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["core.autocrlf", "true", ""],
    ["core.autocrlf", "true", "README.md eol=crlf\n* text=auto\n"],
  ];
  for (const [key, value, attribute] of cases) {
    const label = `${key}=${value} + ${JSON.stringify(attribute)}`;
    const f = fixture();
    try {
      f.git(["config", key, value]);
      writeFileSync(join(f.root, ".gitattributes"), attribute);
      writeFileSync(join(f.root, "README.md"), "one\ntwo\r\nthree\n");
      writeFileSync(join(f.root, "note.txt"), "crlf\r\nonly\n");
      f.git(["add", "-A"]);
      await main(f.root, ["node", "self-host.ts", "--write", "--staged"]);
      f.git(["add", "--", "selfhost.bundle"]);
      f.git(["commit", "-qm", "conversion candidate"]);
      const bundled = bundledFiles(readFileSync(join(f.root, "selfhost.bundle")));
      for (const path of ["README.md", "src/app.ts", "note.txt", ".gitattributes", "self-host.json"]) {
        assert.deepEqual(bundled.get(path)?.content, await readCommittedFile(f.root, path), `${label}: ${path}`);
      }
      await assertCheckPasses(f.root);
    } finally {
      f.cleanup();
    }
  }
});

test("main --check passes under core.autocrlf=true because committed bytes are read raw", async () => {
  const f = fixture();
  try {
    // The consumer side of the same class: a conversion-enabled host must not
    // fail a clean repository. The verify path reads HEAD through git's object
    // database, never through a checkout, so the host's line-ending preference
    // cannot move what the gate compares.
    await main(f.root, ["node", "self-host.ts", "--write"]);
    f.git(["add", "-A"]);
    f.git(["commit", "-qm", "add bundle"]);
    f.git(["config", "core.autocrlf", "true"]);
    await assertCheckPasses(f.root);
  } finally {
    f.cleanup();
  }
});


test("main --check fails when the bundle is missing from HEAD", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => main(f.root, ["node", "self-host.ts"]),
      /no committed bundle/,
    );
  } finally {
    f.cleanup();
  }
});

for (const changedPath of ["README.md", ".agents/pm/tasks/fixture.toon"]) test(`main --check fails when the bundle does not match ${changedPath}`, async () => {
  const f = fixture();
  try {
    await main(f.root, ["node", "self-host.ts", "--write"]);
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "add bundle"]);
    mkdirSync(join(f.root, changedPath, ".."), { recursive: true });
    writeFileSync(join(f.root, changedPath), "changed\n");
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "change source"]);
    const origExit = process.exitCode;
    process.exitCode = undefined;
    const origErr = console.error;
    let errs = "";
    console.error = (msg: string) => { errs += msg + "\n"; };
    try {
      await main(f.root, ["node", "self-host.ts"]);
    } finally {
      console.error = origErr;
    }
    assert.equal(process.exitCode, 1);
    process.exitCode = origExit;
    assert.match(errs, /not byte-identical/);
  } finally {
    f.cleanup();
  }
});

test("main --check passes when only an excluded dependency manifest changes", async () => {
  // Regression for the dependabot red-CI defect (pm-vcs-8y72): the bundle
  // versions pm-vcs source, not git-owned dependency manifests. A commit that
  // touches only a manifest listed in `exclude` must pass the gate with no
  // manual regeneration, while the next test proves real drift still fails.
  const f = fixture();
  try {
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(
      join(f.root, "self-host.json"),
      JSON.stringify({
        bundle: "selfhost.bundle",
        ref: "refs/heads/self-host",
        exclude: ["selfhost.bundle", "package.json", "package-lock.json"],
      }),
    );
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "track manifest and exclude it"]);
    await main(f.root, ["node", "self-host.ts", "--write"]);
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "add bundle"]);
    writeFileSync(
      join(f.root, "package.json"),
      JSON.stringify({ name: "fixture", version: "2.0.0" }, null, 2) + "\n",
    );
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "bump manifest only"]);
    const origExit = process.exitCode;
    const origLog = console.log;
    let logged = "";
    console.log = (msg: string) => { logged += msg + "\n"; };
    try {
      process.exitCode = undefined;
      await main(f.root, ["node", "self-host.ts"]);
    } finally {
      console.log = origLog;
      process.exitCode = origExit;
    }
    assert.match(logged, /byte-identical/);
  } finally {
    f.cleanup();
  }
});

test("main --check still fails when a non-excluded source file changes after an excluded manifest bump", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n");
    writeFileSync(
      join(f.root, "self-host.json"),
      JSON.stringify({
        bundle: "selfhost.bundle",
        ref: "refs/heads/self-host",
        exclude: ["selfhost.bundle", "package.json", "package-lock.json"],
      }),
    );
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "track manifest and exclude it"]);
    await main(f.root, ["node", "self-host.ts", "--write"]);
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "add bundle"]);
    writeFileSync(join(f.root, "README.md"), "drifted\n");
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "drift real source"]);
    const origExit = process.exitCode;
    let exitAfterMain: string | number | null | undefined;
    const origErr = console.error;
    let errs = "";
    console.error = (msg: string) => { errs += msg + "\n"; };
    try {
      process.exitCode = undefined;
      await main(f.root, ["node", "self-host.ts"]);
    } finally {
      exitAfterMain = process.exitCode;
      console.error = origErr;
      process.exitCode = origExit;
    }
    assert.equal(exitAfterMain, 1);
    assert.match(errs, /not byte-identical/);
    assert.match(errs, /README\.md/);
  } finally {
    f.cleanup();
  }
});

test("isMainInvocation returns true when argv[1] resolves to the module URL", () => {
  const script = join(import.meta.dirname, "../scripts/self-host.ts");
  const url = pathToFileURL(script).href;
  assert.equal(isMainInvocation(["node", script], url), true);
});

test("isMainInvocation returns false when argv[1] is a different script", () => {
  const url = pathToFileURL(join(import.meta.dirname, "../scripts/self-host.ts")).href;
  assert.equal(isMainInvocation(["node", import.meta.filename], url), false);
});

test("isMainInvocation returns false when argv[1] is undefined", () => {
  assert.equal(isMainInvocation(["node"], import.meta.url), false);
});

test("readCommittedFile throws when git cannot be launched", async () => {
  const f = fixture();
  const origPath = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    await assert.rejects(
      () => readCommittedFile(f.root, "README.md"),
      /could not run git/,
    );
  } finally {
    process.env.PATH = origPath;
    f.cleanup();
  }
});

test("errorMessage returns the message for an Error", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
});

test("errorMessage returns String(value) for a non-Error throw", () => {
  assert.equal(errorMessage("string thrown"), "string thrown");
  assert.equal(errorMessage(42), "42");
});

test("compareTrees catches a missing tree object in the bundle store", () => {
  // Build a source tree with a nested directory, then write only the root tree
  // object to a fresh isolated store. flattenTree on the isolated store will
  // fail trying to read the missing subtree, which is the catch block in
  // compareTrees.
  const { store, cleanup } = own();
  try {
    const treeId = buildSourceTree(store, files([["a.txt", "x"], ["sub/b.txt", "y"]]));
    const freshIsolated = freshStore();
    try {
      const rootPayload = store.readTyped(treeId, "tree");
      freshIsolated.store.write("tree", rootPayload);
      const result = compareTrees(store, freshIsolated.store, treeId, treeId);
      assert.equal(result.ok, false);
      assert.ok(
        result.problems.some((p) => p.includes("does not carry")),
        result.problems.join("\n"),
      );
    } finally {
      freshIsolated.cleanup();
    }
  } finally {
    cleanup();
  }
});


test("verifySelfHost covers the ancestry deduplication branch", () => {
  // A bundle with a merge commit (two parents) that share a common ancestor
  // exercises the `seen.has(id) -> continue` branch in the ancestry walk.
  const { store, refs, cleanup } = own();
  try {
    // Root commit with file a.txt
    const treeA = buildSourceTree(store, files([["a.txt", "x"]]));
    const root = writeCommit(store, {
      tree: treeA, parents: [], author: signature, committer: signature, message: "root\n",
    });
    // Two branches each adding a file
    const treeB = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"]]));
    const branch1 = writeCommit(store, {
      tree: treeB, parents: [root], author: signature, committer: signature, message: "b1\n",
    });
    const treeC = buildSourceTree(store, files([["a.txt", "x"], ["c.txt", "z"]]));
    const branch2 = writeCommit(store, {
      tree: treeC, parents: [root], author: signature, committer: signature, message: "b2\n",
    });
    // Merge commit with both parents
    const treeM = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"], ["c.txt", "z"]]));
    const merge = writeCommit(store, {
      tree: treeM, parents: [branch1, branch2], author: signature, committer: signature, message: "merge\n",
    });
    refs.compareAndSwap(ref, null, merge);
    const bytes = exportBundle(store, refs, [ref]);
    // Verify: the ancestry walk visits root twice (once via each parent) and
    // deduplicates it with the seen set.
    const result = verifySelfHost(store, bytes, ref, treeM);
    assert.equal(result.ok, true, result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("readSourceFiles detects an executable file's mode", () => {
  const f = fixture();
  try {
    // Create an executable file, commit it. The mode is derived from git
    // (`update-index --chmod=+x`), not from the filesystem, so no `chmod` spawn
    // is needed — the gate depends only on `git`. `git checkout HEAD -- run.sh`
    // lets git restore the executable bit onto the working tree, which the
    // legacy `--write` mode then reads through `readSourceFiles`.
    writeFileSync(join(f.root, "run.sh"), "#!/bin/sh\necho hi\n");
    f.git(["add", "-A"]);
    f.git(["update-index", "--chmod=+x", "run.sh"]);
    f.git(["commit", "-q", "-m", "add executable"]);
    f.git(["checkout", "HEAD", "--", "run.sh"]);
    const tracked = listTrackedFiles(f.root);
    const files = readSourceFiles(f.root, tracked, ["selfhost.bundle"]);
    assert.equal(files.get("run.sh")?.mode, "100755");
  } finally {
    f.cleanup();
  }
});

test("verifySelfHost reports '(none)' when the bundle advertises no refs", () => {
  const { bytes } = bundleFor([["a.txt", "x"]]);
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as { refs: Record<string, string>; objects: string[] };
  header.refs = {};
  lines[1] = JSON.stringify(header);
  const emptyRefs = Buffer.from(lines.join("\n"), "utf8");
  const { store, cleanup } = own();
  try {
    const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"]]));
    const result = verifySelfHost(store, emptyRefs, ref, sourceTreeId);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("(none)")), result.problems.join("\n"));
  } finally {
    cleanup();
  }
});

test("compareTrees truncates the absent-blob list when more than 5 are missing", () => {
  // Build a source tree with 7 files in 7 directories, export a bundle, then
  // create a fresh store carrying only the TREE objects (no blobs). flattenTree
  // succeeds because all trees are present, but the absentBlobs check finds all
  // 7 blobs missing and truncates the list with "…".
  const { store, refs, cleanup } = own();
  try {
    const entries: ReadonlyArray<[string, string]> = [
      ["d1/f.txt", "1"], ["d2/f.txt", "2"], ["d3/f.txt", "3"],
      ["d4/f.txt", "4"], ["d5/f.txt", "5"], ["d6/f.txt", "6"],
      ["d7/f.txt", "7"],
    ];
    const treeId = buildSourceTree(store, files(entries));
    const bundleBytes = writeSelfHostBundle(store, refs, null, ref, treeId, signature, "snap\n");
    const parsed = parseBundle(bundleBytes);
    const fresh = freshStore();
    try {
      // Write only tree objects to the fresh store; skip blobs and commits.
      for (const line of parsed.lines) {
        if (line.type === "tree") fresh.store.write("tree", line.payload);
      }
      const result = compareTrees(store, fresh.store, treeId, treeId);
      assert.equal(result.ok, false);
      assert.ok(
        result.problems.some((p) => p.includes("…")),
        `expected truncation marker in: ${result.problems.join("\n")}`,
      );
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

// The lexical rule in loadConfig is necessary but not sufficient: git tracks
// symbolic links, so a pull request can commit a lexically innocent
// `selfhost.bundle` that points outside the tree, or make an ancestor a link
// and keep an ordinary-looking nested path. writeFileSync follows both.
test("resolveBundleTarget refuses a symlinked bundle and a symlinked ancestor", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pm-vcs-symlink-outside-"));
  temps.push(root, outside);

  // An honest path resolves and is returned unchanged.
  assert.equal(resolveBundleTarget(root, "selfhost.bundle"), join(root, "selfhost.bundle"));

  // The bundle itself is a link to a file outside the repository.
  writeFileSync(join(outside, "target"), "x");
  symlinkSync(join(outside, "target"), join(root, "linked.bundle"));
  assert.throws(() => resolveBundleTarget(root, "linked.bundle"), /symbolic link/);

  // An ancestor directory is a link; the leaf name looks entirely ordinary.
  symlinkSync(outside, join(root, "generated"));
  assert.throws(() => resolveBundleTarget(root, "generated/selfhost.bundle"), /outside the repository/);

  // A directory that does not exist is named as such rather than as an escape.
  assert.throws(() => resolveBundleTarget(root, "absent/selfhost.bundle"), /does not exist/);
});

// Staying inside the repository is not enough: `.git/config` and `.env` are
// lexically relative, not links, and comfortably inside the tree. The invariant
// that rules them out is what the bundle IS — tracked source.
test("resolveBundleTarget refuses to overwrite an existing untracked file", () => {
  const repo = mkdtempSync(join(tmpdir(), "pm-vcs-untracked-"));
  temps.push(repo);
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["config", "user.email", "harness@example.invalid"]);
  runGit(repo, ["config", "user.name", "pm-vcs harness"]);
  writeFileSync(join(repo, "selfhost.bundle"), "tracked bundle");
  runGit(repo, ["add", "selfhost.bundle"]);
  runGit(repo, ["commit", "-q", "-m", "track the bundle"]);

  // The tracked bundle is a legitimate target.
  assert.equal(resolveBundleTarget(repo, "selfhost.bundle"), join(repo, "selfhost.bundle"));

  // A path that does not exist yet is the bootstrap case, also legitimate.
  assert.equal(resolveBundleTarget(repo, "new.bundle"), join(repo, "new.bundle"));

  // Git's own configuration exists, is untracked, and is inside the repository.
  assert.throws(() => resolveBundleTarget(repo, ".git/config"), /not tracked by git/);

  // So is an ignored local secret.
  writeFileSync(join(repo, ".env"), "SECRET=1");
  assert.throws(() => resolveBundleTarget(repo, ".env"), /not tracked by git/);
});

test("self-host verification reports physical history loss after a validated import", /** Actual loose-object disappearance still fails verification after publication preflight succeeded. */ () => {
  const { bytes } = bundleFor([["a.txt", "x"]]); const { store } = own(); const sourceTree = buildSourceTree(store, files([["a.txt", "x"]]));
  const original = ObjectStore.prototype.accept;
  /** Keep the real verified import and remove one actual isolated commit only after it publishes. */
  ObjectStore.prototype.accept = function (objects: readonly ObjectArrival[], attributed: boolean): void {
    original.call(this, objects, attributed);
    const commit = objects.find(/** Select one real commit carried by this archive. */ (object) => object.type === "commit")!;
    const physical = this.inventory().find(/** Locate the verified loose file through the public inventory. */ (entry) => entry.id === commit.id)!;
    rmSync(physical.path);
  };
  try { const result = verifySelfHost(store, bytes, ref, sourceTree); assert.equal(result.ok, false); assert.ok(result.problems.some(/** Classify a post-import history read failure explicitly. */ (problem) => problem.includes("history") && problem.includes("not fully carried"))); }
  finally { ObjectStore.prototype.accept = original; }
});

test("self-host comparison names one missing payload without truncating its diagnostic", /** Validate a physically incomplete comparison store separately from complete-bundle publication. */ () => {
  const { store } = own(); const tree = buildSourceTree(store, files([["one.txt", "payload"]])); const target = own(); target.store.write("tree", store.readTyped(tree, "tree"));
  const result = compareTrees(store, target.store, tree, tree); assert.equal(result.ok, false); assert.ok(result.problems.some(/** A short missing-path list must remain complete and readable. */ (problem) => problem.includes("one.txt") && !problem.includes("…")));
});

/** Drop the object lines (and header entries) for the given ids, as a truncated or hand-edited bundle would. */
function withoutObjects(bytes: Buffer, ids: ReadonlySet<string>): Buffer {
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as { objects?: string[] };
  header.objects = (header.objects ?? []).filter((id) => !ids.has(id));
  lines[1] = JSON.stringify(header);
  return Buffer.from(lines.filter((line, index) => index < 2 || !ids.has(line.split(" ")[1] ?? "")).join("\n"), "utf8");
}

test("snapshotIsUnchanged refuses a sole commit that still names a parent, even with a matching tree", () => {
  const { store, refs } = own();
  const treeId = buildSourceTree(store, files([["a.txt", "x"]]));
  const parent = writeCommit(store, { tree: treeId, parents: [], author: signature, committer: signature, message: "parent\n" });
  const child = writeCommit(store, { tree: treeId, parents: [parent], author: signature, committer: signature, message: "child\n" });
  refs.compareAndSwap(ref, refs.read(ref), child);
  const orphaned = withoutObjects(exportBundle(store, refs, [ref]), new Set([parent]));
  assert.equal(parseBundle(orphaned).lines.filter((line) => line.type === "commit").length, 1);
  assert.equal(snapshotIsUnchanged(orphaned, ref, treeId), false);
});

test("writeSelfHostBundle rebuilds a parentless snapshot that is missing a reachable object", () => {
  const { bytes } = bundleFor([["a.txt", "x"], ["b.txt", "y"]]);
  const blob = parseBundle(bytes).lines.find((line) => line.type === "blob");
  assert.ok(blob, "the bundle should carry a blob");
  const incomplete = withoutObjects(bytes, new Set([blob.id]));
  const { store, refs } = own();
  const sourceTreeId = buildSourceTree(store, files([["a.txt", "x"], ["b.txt", "y"]]));
  assert.equal(snapshotIsUnchanged(incomplete, ref, sourceTreeId), true, "shape alone looks reusable");
  const rebuilt = writeSelfHostBundle(store, refs, incomplete, ref, sourceTreeId, signature, "snapshot\n");
  assert.notEqual(rebuilt, incomplete);
  const result = verifySelfHost(store, rebuilt, ref, sourceTreeId);
  assert.equal(result.ok, true, result.problems.join("\n"));
});


test("self-host comparison tolerates only pinned action revisions and preserves the archive bytes", () => {
  const path = ".github/workflows/ci.yml";
  const before = `jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@${"a".repeat(40)} # v7.0.0\n        with:\n          node-version: 22\n`;
  const after = before.replace("a".repeat(40), "b".repeat(40)).replace("v7.0.0", "v7.1.0");
  const { bytes } = bundleFor([[path, before], ["engine/value.ts", "export const value = 1;\n"]]);
  const { store } = own();
  const tree = buildSourceTree(store, files([[path, after], ["engine/value.ts", "export const value = 1;\n"]]));
  assert.equal(verifySelfHost(store, bytes, ref, tree).ok, true);
  assert.equal(sameWorkflowExceptActionRevisions(path, Buffer.from(before), Buffer.from(after)), true);
  assert.equal(sameWorkflowExceptActionRevisions("README.md", Buffer.from(before), Buffer.from(after)), false);
  for (const changed of [
    after.replace("node-version: 22", "node-version: 26"),
    after.replace("actions/setup-node", "actions/checkout"),
    after.replace("actions/setup-node", "unknown/setup-node"),
    after.replace("b".repeat(40), "main"),
    after.replace("b".repeat(40), "abcdef0"),
    after.replace(" # v7.1.0", ""),
    after.replace("# v7.1.0", "# not-a-version"),
    after.replace("b".repeat(40), "<commit>").replace("v7.1.0", "<version>"),
    after + "permissions: write-all\n",
  ]) {
    const changedTree = buildSourceTree(store, files([[path, changed], ["engine/value.ts", "export const value = 1;\n"]]));
    assert.equal(verifySelfHost(store, bytes, ref, changedTree).ok, false, changed);
  }
  const changedSource = buildSourceTree(store, files([[path, after], ["engine/value.ts", "export const value = 2;\n"]]));
  assert.equal(verifySelfHost(store, bytes, ref, changedSource).ok, false);
});

test("action revision exceptions never cover shell scalars, inputs or malformed YAML", () => {
  const path = ".github/workflows/ci.yml";
  const pin = `uses: actions/setup-node@${"a".repeat(40)} # v7.0.0`;
  for (const body of [
    `jobs:\n  test:\n    steps:\n      - run: |\n          ${pin}\n`,
    `jobs:\n  test:\n    steps:\n      - run: >-\n          ${pin}\n`,
    `jobs:\n  test:\n    steps:\n      - run: '\n          ${pin}\n          '\n`,
    `jobs:\n  test:\n    steps:\n      - with:\n          ${pin}\n`,
    `jobs:\n  test:\n    with:\n      ${pin}\n`,
    `jobs:\n  test:\n    steps:\n      - uses: [actions/setup-node@${"a".repeat(40)}]\n`,
    `${pin}\n`,
    `jobs:\n  test:\n    ${pin}\n    uses: ./duplicate\n`,
    `? [complex, key]\n: nested:\n    ${pin}\n`,
  ]) {
    assert.equal(sameWorkflowExceptActionRevisions(path, Buffer.from(body), Buffer.from(body.replace("a".repeat(40), "b".repeat(40)))), false, body);
  }
  const job = `jobs:\n  reusable:\n    ${pin}\n`;
  assert.equal(sameWorkflowExceptActionRevisions(path, Buffer.from(job), Buffer.from(job.replace("a".repeat(40), "b".repeat(40)))), true);
  const caller = job.replace("actions/setup-node", "unbraind/pm-github/.github/workflows/pm-github-sync.yml").replace("v7.0.0", "pm-github 2026.10.16");
  assert.equal(sameWorkflowExceptActionRevisions(path, Buffer.from(caller), Buffer.from(caller.replace("a".repeat(40), "b".repeat(40)).replace("2026.10.16", "2026.10.17"))), true);
});


test("source snapshots publish every blob and tree under one uninterrupted native writer", () => {
 const f = freshStore(); const leases = new Set<bigint>(); const original = f.store.write.bind(f.store);
 f.store.write = (type, payload, fileId) => { leases.add(statSync(join(dirname(f.store.storageRoot()), "objects.lock"), { bigint: true }).ino); return original(type, payload, fileId); };
 try {
  const files = new Map<string, SourceFile>(["first", "second", "nested/third"].map(path => [path, { content: Buffer.from(path), mode: "100644" }]));
  const tree = buildSourceTree(f.store, files); assert.equal(leases.size, 1);
  assert.equal(f.store.read(tree).type, "tree");
  for (const file of files.values()) assert.ok(f.store.inventory().some(entry => entry.object.payload.equals(file.content)));
 } finally { f.cleanup(); }
});

test("snapshot paths preserve valid UTF-8", () => {
  const f = fixture();
  try {
    const valid = "\uFEFFcafé-�";
    writeFileSync(join(f.root, valid), "ordinary source");
    f.git(["add", "--", valid]);
    const tree = f.git(["write-tree"]);
    assert.ok(listTrackedFiles(f.root).includes(valid));
    assert.ok(listTreeEntries(f.root, tree).some(entry => entry.path === valid));
  } finally {
    f.cleanup();
  }
});

test("snapshot paths keep control characters and reject an unrepresentable name", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const marker = "\x01ordinary-path";
    writeFileSync(join(f.root, marker), "record marker in a path");
    f.git(["add", "--", marker]);
    const tree = f.git(["write-tree"]);
    assert.ok(listTrackedFiles(f.root).includes(marker));
    assert.ok(listTreeEntries(f.root, tree).some(entry => entry.path === marker));

    for (const suffix of [0x80, 0x81]) {
      const name = Buffer.concat([Buffer.from(join(f.root, "name-")), Buffer.from([suffix])]);
      writeFileSync(name, `distinct source byte ${suffix}`);
    }
    f.git(["add", "--", "name-*"]);
    assert.throws(() => listTreeEntries(f.root, f.git(["write-tree"])), /UTF-8/);
    assert.throws(() => listTrackedFiles(f.root), /UTF-8/);
  } finally {
    f.cleanup();
  }
});

test("batch framing requires an unsigned safe size, exact fields, separators and EOF", () => {
  const sha = "a".repeat(40);
  const entry: TreeEntry = { mode: "100644", sha, path: "sample" };
  for (const answer of [
    "blob -1\n", "blob \n\n", "blob +1\nx\n", "blob 1.0\nx\n",
    "blob 1e0\nx\n", "blob 0x1\nx\n", "blob 9007199254740992\n",
    "blob 1 extra\nx\n", "blob 1\nx!", "blob 1\nx\nextra",
  ]) {
    assert.throws(() => parseBatchResponse(Buffer.from(`${sha} ${answer}`), [entry]), /git cat-file/, answer);
  }
  assert.deepEqual(parseBatchResponse(Buffer.from(`${sha} blob 0\n\n`), [entry]).get(entry.path), Buffer.alloc(0));
});

test("tree snapshots fetch only configuration, included source and the verification bundle", async () => {
  const f = fixture();
  try {
    const config = { bundle: "selfhost.bundle", ref, exclude: ["selfhost.bundle", "omitted/"] };
    mkdirSync(join(f.root, "omitted"));
    writeFileSync(join(f.root, "omitted", "first"), "excluded object one");
    writeFileSync(join(f.root, "omitted", "second"), "excluded object two");
    writeFileSync(join(f.root, "self-host.json"), JSON.stringify(config));
    f.git(["add", "--", "self-host.json", "omitted"]);
    const tree = f.git(["write-tree"]);
    const snapshot = await readTreeSnapshot(f.root, tree);
    assert.deepEqual([...snapshot.blobs.keys()].sort(), ["README.md", "self-host.json", "src/app.ts"]);
    // Make both excluded blobs unavailable. Any attempt to fetch them fails, even if later discarded.
    for (const name of ["first", "second"]) {
      const sha = f.git(["rev-parse", `${tree}:omitted/${name}`]);
      rmSync(join(f.root, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    }
    await main(f.root, ["--write", "--staged"]);
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "candidate"]);
    await assertCheckPasses(f.root);
  } finally {
    f.cleanup();
  }
});

test("working writer handles converted bytes before publishing a bundle", async () => {
  const f = fixture();
  try {
    f.git(["config", "core.autocrlf", "true"]);
    writeFileSync(join(f.root, "README.md"), "working edit\r\n");
    const archive = join(f.root, "selfhost.bundle");
    await assert.rejects(() => main(f.root, ["--write"]), /Git converts README.md.*--staged/);
    assert.equal(statSync(archive, { throwIfNoEntry: false }), undefined);
    f.git(["add", "--", "README.md"]);
    await main(f.root, ["--write", "--staged"]);
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "working snapshot"]);
    await assertCheckPasses(f.root);
  } finally {
    f.cleanup();
  }
});

test("explicitly excluded gitlinks permit staged writing and committed verification", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "self-host.json"), JSON.stringify({ bundle: "selfhost.bundle", ref, exclude: ["selfhost.bundle", "vendor/"] }));
    f.git(["add", "--", "self-host.json"]);
    f.git(["update-index", "--add", "--cacheinfo", `160000,${f.git(["rev-parse", "HEAD"])},vendor/sub`]);
    await main(f.root, ["--write", "--staged"]);
    f.git(["add", "--", "selfhost.bundle"]);
    f.git(["commit", "-qm", "excluded gitlink"]);
    await assertCheckPasses(f.root);
  } finally {
    f.cleanup();
  }
});

test("freezing a staged edit leaves the original index byte-identical", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "README.md"), "index edit\n");
    f.git(["add", "--", "README.md"]);
    const index = join(f.root, ".git", "index");
    const before = readFileSync(index);
    await main(f.root, ["--write", "--staged"]);
    assert.deepEqual(readFileSync(index), before);
  } finally {
    f.cleanup();
  }
});

test("configuration must be a regular file in every selected snapshot", async () => {
  const f = fixture();
  try {
    f.git(["mv", "self-host.json", "config-data.json"]);
    symlinkSync("config-data.json", join(f.root, "self-host.json"));
    f.git(["add", "--", "self-host.json"]);
    f.git(["commit", "-qm", "configuration link"]);
    for (const args of [["--write"], ["--write", "--staged"], ["--check"]]) {
      await assert.rejects(() => main(f.root, args), /configuration.*regular/);
    }
    assert.equal(statSync(join(f.root, "selfhost.bundle"), { throwIfNoEntry: false }), undefined);
  } finally {
    f.cleanup();
  }
});


test("batch framing is independent of transport chunk boundaries", () => {
  const entry: TreeEntry = { mode: "100644", sha: "a".repeat(40), path: "binary" };
  const bytes = Buffer.from([0, 10, 128, 255]);
  const response = Buffer.concat([Buffer.from(`${entry.sha} blob 4\n`), bytes, Buffer.from("\n")]);
  const chunks = Array.from(response, byte => Buffer.from([byte]));
  assert.deepEqual(parseBatchResponse(chunks, [entry]).get(entry.path), bytes);
});

test("working content checks honor excluded configuration", () => {
  const f = fixture();
  try {
    const selected = readSourceFiles(f.root, ["README.md", "self-host.json"], ["self-host.json"]);
    assert.deepEqual([...selected.keys()], ["README.md"]);
    assert.throws(() => listTreeEntries(f.root, "unknown-tree"), /git ls-tree failed/);
  } finally {
    f.cleanup();
  }
});

test("working content checks honor raw-byte source symlinks", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const target = Buffer.from([0x74, 0x80]);
    symlinkSync(target, join(f.root, "link"));
    const selected = readSourceFiles(f.root, ["link", "self-host.json"], ["self-host.json"]);
    assert.deepEqual([...selected.keys()], ["link"]);
    assert.deepEqual(selected.get("link")?.content, target);
    assert.equal(readSourceFiles(f.root, ["link"], []).size, 1);
  } finally {
    f.cleanup();
  }
});

test("working content checks honor quoted paths", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const name = '"read\nme"';
    writeFileSync(join(f.root, name), "unchanged bytes");
    const selected = readSourceFiles(f.root, [name], []);
    assert.deepEqual([...selected.keys()], [name]);
  } finally {
    f.cleanup();
  }
});


test("required batch payloads stream across the former aggregate output ceiling", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "large");
  const size = 33 * 1024 * 1024;
  writeFileSync(path, "first byte");
  truncateSync(path, size);
  f.git(["add", "--", "large"]);
  const sha = f.git(["rev-parse", ":large"]);
  const paths = ["large", "second copy"];
  const blobs = await readTreeBlobs(f.root, paths.map(path => ({ mode: "100644", sha, path })));
  for (const path of paths) {
    const blob = blobs.get(path)!;
    assert.equal(blob.length, size);
    assert.equal(blob.subarray(0, 10).toString(), "first byte");
    assert.equal(blob.at(-1), 0);
  }
});

test("working writer requires its regular configuration to be tracked", async t => {
  const f = fixture();
  t.after(f.cleanup);
  f.git(["rm", "--cached", "--", "self-host.json"]);
  await assert.rejects(() => main(f.root, ["--write"]), /configuration must be tracked/);
});

test("staged writer preserves an alternate split index", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const index = join(f.root, ".git", "alternate index ");
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    runGit(f.root, ["read-tree", "HEAD"]);
    writeFileSync(join(f.root, "README.md"), "alternate edit");
    runGit(f.root, ["add", "--", "README.md"]);
    runGit(f.root, ["update-index", "--split-index"]);
    const before = readFileSync(index);
    await main(f.root, ["--write", "--staged"]);
    assert.deepEqual(readFileSync(index), before);
    assert.deepEqual(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).get("README.md")?.content, Buffer.from("alternate edit"));
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test("staged writer carries a split index's shared base beside the caller's index", async () => {
  const f = fixture();
  const indexDirectory = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-base-"));
  const index = join(indexDirectory, "index");
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    runGit(f.root, ["read-tree", "HEAD"]);
    writeFileSync(join(f.root, "README.md"), "shared base edit");
    runGit(f.root, ["add", "--", "README.md"]);
    runGit(f.root, ["update-index", "--split-index"]);
    // The selected index is a split index outside `.git`, and its shared base
    // is moved out of the Git directory to sit only beside that index — the
    // arrangement where a scratch copy of the index alone cannot resolve the
    // base and `git write-tree` fails with "index file open failed".
    const bases = readdirSync(join(f.root, ".git")).filter(name => name.startsWith("sharedindex."));
    assert.ok(bases.length > 0, "git update-index --split-index must have written a shared base");
    for (const base of bases) renameSync(join(f.root, ".git", base), join(indexDirectory, base));
    const before = readFileSync(index);
    await main(f.root, ["--write", "--staged"]);
    assert.deepEqual(readFileSync(index), before);
    assert.deepEqual(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).get("README.md")?.content, Buffer.from("shared base edit"));
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    rmSync(indexDirectory, { recursive: true, force: true });
    f.cleanup();
  }
});

test("Git pathspec isolation matches Windows keys case-insensitively and POSIX keys exactly", () => {
  const base = {
    git_glob_pathspecs: "1",
    Git_Literal_Pathspecs: "1",
    git_icase_pathspecs: "1",
    GIT_NOGLOB_PATHSPECS: "1",
    GIT_INDEX_FILE: "fixture-index",
    git_glob_pathspecs_suffix: "keep",
  };
  assert.deepEqual(isolatedPathspecEnvironment(base, "win32"), {
    GIT_INDEX_FILE: "fixture-index",
    git_glob_pathspecs_suffix: "keep",
  });
  const { GIT_NOGLOB_PATHSPECS: _removed, ...posix } = base;
  assert.deepEqual(isolatedPathspecEnvironment(base, "linux"), posix);
  assert.equal(base.GIT_NOGLOB_PATHSPECS, "1");
});

test("tree lookups keep tool-pinned literal matching under ambient pathspec settings", () => {
  const f = fixture();
  try {
    // A metacharacter name cannot exist as a working file on every host, so the
    // tree is assembled straight in Git's object database: the lookup needs the
    // tree entry, not a checkout that some platforms would refuse to create.
    writeFileSync(join(f.root, "safe-name.txt"), "literal\n");
    const blob = f.git(["hash-object", "-w", "--", "safe-name.txt"]);
    rmSync(join(f.root, "safe-name.txt"));
    f.git(["update-index", "--add", "--cacheinfo", `100644,${blob},weird*name.txt`]);
    const tree = f.git(["write-tree"]);
    assert.deepEqual(listTreeEntries(f.root, tree, ["weird*name.txt"]).map(entry => entry.path), ["weird*name.txt"]);
    // The literal lookup is the tool's choice, so a host exporting a global
    // pathspec magic must not reach the git child: git refuses the combination
    // ("global 'literal' pathspec setting is incompatible with all other global
    // pathspec settings") instead of silently preferring either side.
    for (const setting of ["GIT_GLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
      const previous = process.env[setting];
      process.env[setting] = "1";
      try {
        const entries = listTreeEntries(f.root, tree, ["weird*name.txt"]);
        assert.deepEqual(entries.map(entry => entry.path), ["weird*name.txt"]);
      } finally {
        if (previous === undefined) delete process.env[setting];
        else process.env[setting] = previous;
      }
    }
  } finally {
    f.cleanup();
  }
});

/** Run an action after the selected path's bytes are read, including descriptor reads. */
function afterFileRead(path: string, action: () => void): void {
  let descriptor: number | undefined;
  let fired = false;
  const open = fs.openSync;
  const read = fs.readFileSync;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (args[0] === path) descriptor = fd;
    return fd;
  });
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = read(...args);
    if (!fired && (args[0] === path || args[0] === descriptor)) {
      fired = true;
      action();
    }
    return bytes;
  });
  syncBuiltinESMExports();
}

test("working writer refuses bytes captured across a mid-read replacement", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "crlf.txt"), "captured\r\n");
    f.git(["add", "--", "crlf.txt"]);
    // The reader has captured the regular file's bytes when this runs: swap the
    // leaf for a link before any second observation can classify what it read.
    // A split read/classify would bundle the captured (converted) bytes without
    // the hash-object verification, so the refusal is the fail-closed answer.
    afterFileRead(join(f.root, "crlf.txt"), () => {
      rmSync(join(f.root, "crlf.txt"));
      symlinkSync("README.md", join(f.root, "crlf.txt"));
    });
    try {
      assert.throws(() => readSourceFiles(f.root, ["crlf.txt"], []), /changed while it was being read/);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    f.cleanup();
  }
});

test("working capture preserves raw link text and refuses a removed or replaced link", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const path = join(f.root, "source-link");
  const target = Buffer.from([0x61, 0x80]);
  try {
    symlinkSync(target, path);
    assert.deepEqual(readSourceFiles(f.root, ["source-link"], []).get("source-link"), {
      content: target,
      mode: "100644",
    });
    for (const replace of [false, true]) {
      if (replace) symlinkSync(target, path);
      const readlink = fs.readlinkSync;
      mock.method(fs, "readlinkSync", (...args: Parameters<typeof fs.readlinkSync>) => {
        const bytes = readlink(...args);
        if (args[0] === path) {
          rmSync(path);
          if (replace) writeFileSync(path, "replacement");
        }
        return bytes;
      });
      try {
        assert.throws(() => readSourceFiles(f.root, ["source-link"], []), /changed while it was being read/);
      } finally {
        mock.restoreAll();
      }
    }
  } finally {
    f.cleanup();
  }
});

test("configuration bytes are never parsed across a mid-read replacement", () => {
  const f = fixture();
  try {
    // The regular-file check passes, the bytes are read, and then the leaf is
    // swapped for a link: only an identity re-observation can tell that the
    // parsed bytes and the type verdict described different leaves.
    afterFileRead(join(f.root, "self-host.json"), () => {
      rmSync(join(f.root, "self-host.json"));
      symlinkSync("README.md", join(f.root, "self-host.json"));
    });
    try {
      assert.throws(() => loadConfig(join(f.root, "self-host.json")), /changed while it was being read/);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    f.cleanup();
  }
});

test("configuration capture preserves an unexpected descriptor-open error", t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "self-host.json");
  const open = fs.openSync;
  const failure = new Error("opening the selected configuration failed");
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === path) throw failure;
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => loadConfig(path), error => error === failure);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("an unchanged bundle replaced mid-check is rewritten over, never skipped or followed", async () => {
  const f = fixture();
  try {
    await main(f.root, ["--write"]);
    f.git(["add", "--", "selfhost.bundle"]);
    const expected = readFileSync(join(f.root, "selfhost.bundle"));
    // The second write produces identical bytes, so an honest unchanged check
    // would skip. The leaf is swapped for a link after those bytes are read:
    // the decision must observe the replacement (identity re-check) and the
    // write must replace the link rather than follow it into another file.
    afterFileRead(join(f.root, "selfhost.bundle"), () => {
      rmSync(join(f.root, "selfhost.bundle"));
      symlinkSync("README.md", join(f.root, "selfhost.bundle"));
    });
    try {
      await main(f.root, ["--write"]);
      mock.restoreAll();
      syncBuiltinESMExports();
      const leaf = lstatSync(join(f.root, "selfhost.bundle"));
      assert.equal(leaf.isSymbolicLink(), false, "the bundle path must be a regular file after a write");
      assert.equal(leaf.isFile(), true);
      assert.deepEqual(readFileSync(join(f.root, "selfhost.bundle")), expected);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    f.cleanup();
  }
});

for (const name of ["self-host.json", "README.md", "selfhost.bundle"]) {
  test(`working snapshot reads refuse a different opened leaf for ${name}`, async () => {
    const f = fixture();
    try {
      await main(f.root, ["--write"]);
      f.git(["add", "--", "selfhost.bundle"]);
      const target = join(f.root, name);
      const expected = readFileSync(target);
      const lstat = fs.lstatSync;
      const open = fs.openSync;
      const close = fs.closeSync;
      const read = fs.readFileSync;
      let swapped = false;
      let descriptor: number | undefined;
      let unsafeReads = 0;
      mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
        const stat = lstat(...args);
        if (args[0] === target && args[1]?.bigint && !swapped) {
          renameSync(target, join(f.root, "parked"));
          writeFileSync(target, "replacement");
          swapped = true;
        }
        return stat;
      });
      mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const fd = open(...args);
        if (args[0] === target && swapped) {
          descriptor = fd;
          const flags = Number(args[1]);
          assert.equal(flags & (fs.constants.O_NONBLOCK ?? 0), fs.constants.O_NONBLOCK ?? 0);
          assert.equal(flags & (fs.constants.O_NOFOLLOW ?? 0), fs.constants.O_NOFOLLOW ?? 0);
        }
        return fd;
      });
      mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (args[0] === target || args[0] === descriptor) unsafeReads++;
        return read(...args);
      });
      mock.method(fs, "closeSync", (fd: number) => {
        if (fd === descriptor) descriptor = undefined;
        close(fd);
      });
      syncBuiltinESMExports();
      try {
        if (name === "selfhost.bundle") await main(f.root, ["--write"]);
        else await assert.rejects(() => main(f.root, ["--write"]), /changed while it was being read/);
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.ok(swapped, name);
      assert.equal(unsafeReads, 0, name);
      if (name === "selfhost.bundle") assert.deepEqual(readFileSync(target), expected);
    } finally {
      f.cleanup();
    }
  });
}

test("working conversion validates only the captured bytes across a pathname replacement", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "notes.txt");
  writeFileSync(path, "captured\n");
  writeFileSync(join(f.root, ".gitattributes"), "*.txt text eol=lf\n");
  f.git(["add", "--", ".gitattributes", "notes.txt"]);
  const exec = childProcess.execFileSync;
  let changed = false;
  let conversionTimeout: number | undefined;
  mock.method(childProcess, "execFileSync", (...args: Parameters<typeof execFileSync>) => {
    if (args[0] === "git" && args[1]?.[0] === "hash-object" &&
        (args[1].includes("--path=notes.txt") || args[1].includes("--stdin-paths"))) {
      writeFileSync(path, "late replacement\r\n");
      changed = true;
      conversionTimeout = args[2]?.timeout;
    }
    return exec(...args);
  });
  syncBuiltinESMExports();
  try {
    await main(f.root, ["--write"]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(changed);
  assert.ok(conversionTimeout !== undefined && conversionTimeout > 0);
  assert.deepEqual(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).get("notes.txt")?.content, Buffer.from("captured\n"));
});

test("working selection and archive share one configuration observation", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const path = join(f.root, "self-host.json");
  chmodSync(path, 0o755);
  const expectedMode = (statSync(path).mode & 0o100) === 0 ? "100644" : "100755";
  const original = readFileSync(path);
  const replacement = JSON.stringify({ ref, bundle: "selfhost.bundle", exclude: ["selfhost.bundle", "README.md"] });
  const lstat = fs.lstatSync;
  let observations = 0;
  mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const stat = lstat(...args);
    if (args[0] === path && ++observations === 2) writeFileSync(path, replacement);
    return stat;
  });
  syncBuiltinESMExports();
  try {
    await main(f.root, ["--write"]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path, "utf8"), replacement);
  assert.equal(observations, 2);
  const archived = bundledFiles(readFileSync(join(f.root, "selfhost.bundle")));
  assert.deepEqual(archived.get("self-host.json")?.content, original);
  assert.equal(archived.get("self-host.json")?.mode, expectedMode);
  assert.ok(archived.has("README.md"));
});

test("staged writer never opens a stale or non-file shared-base sibling", async () => {
  const f = fixture();
  const indexDirectory = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-sibling-"));
  const index = join(indexDirectory, "index");
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    runGit(f.root, ["read-tree", "HEAD"]);
    writeFileSync(join(f.root, "README.md"), "sibling filter edit");
    runGit(f.root, ["add", "--", "README.md"]);
    runGit(f.root, ["update-index", "--split-index"]);
    const bases = readdirSync(join(f.root, ".git")).filter(name => name.startsWith("sharedindex."));
    assert.ok(bases.length > 0, "git update-index --split-index must have written a shared base");
    for (const base of bases) renameSync(join(f.root, ".git", base), join(indexDirectory, base));
    const directory = join(indexDirectory, `sharedindex.${"e".repeat(40)}`);
    const stale = join(indexDirectory, `sharedindex.${"f".repeat(40)}`);
    mkdirSync(directory);
    writeFileSync(stale, "stale base\n");
    const attempts: string[] = [];
    /** Simulate garbage collection when an unrelated file is opened. */
    const visit = (path: unknown): void => {
      if (path !== stale && path !== directory) return;
      attempts.push(basename(path));
      if (path === stale) rmSync(stale);
    };
    const copy = fs.copyFileSync;
    mock.method(fs, "copyFileSync", (...args: Parameters<typeof fs.copyFileSync>) => {
      visit(args[0]);
      return copy(...args);
    });
    const open = fs.openSync;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      visit(args[0]);
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      await main(f.root, ["--write", "--staged"]);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(attempts, []);
    assert.deepEqual(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).get("README.md")?.content, Buffer.from("sibling filter edit"));
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    rmSync(indexDirectory, { recursive: true, force: true });
    f.cleanup();
  }
});

test("staged writer fails loudly when a shared base cannot be copied", async () => {
  const f = fixture();
  const indexDirectory = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-sibling-"));
  const index = join(indexDirectory, "index");
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    runGit(f.root, ["read-tree", "HEAD"]);
    runGit(f.root, ["update-index", "--split-index"]);
    const bases = readdirSync(join(f.root, ".git")).filter(name => name.startsWith("sharedindex."));
    assert.ok(bases.length > 0, "git update-index --split-index must have written a shared base");
    for (const base of bases) renameSync(join(f.root, ".git", base), join(indexDirectory, base));
    // An unreadable base is not a stale one: every error other than a vanished
    // file must stop the write instead of silently dropping the base.
    let attempts = 0;
    /** Fail precisely when the selected base is opened. */
    const denyBase = (path: unknown): void => {
      if (typeof path === "string" && bases.includes(basename(path))) {
        attempts++;
        const failure = new Error("EACCES: permission denied, copy the shared base") as NodeJS.ErrnoException;
        failure.code = "EACCES";
        throw failure;
      }
    };
    const copy = fs.copyFileSync;
    mock.method(fs, "copyFileSync", (...args: Parameters<typeof fs.copyFileSync>) => {
      denyBase(args[0]);
      return copy(...args);
    });
    const open = fs.openSync;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      denyBase(args[0]);
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => main(f.root, ["--write", "--staged"]), /EACCES: permission denied, copy the shared base/);
      assert.equal(attempts, 1);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    rmSync(indexDirectory, { recursive: true, force: true });
    f.cleanup();
  }
});

test("staged writer ignores unreadable siblings for an unsplit alternate index", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const index = join(f.root, "alternate-index");
  const stale = join(f.root, `sharedindex.${"f".repeat(40)}`);
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = index;
    runGit(f.root, ["read-tree", "HEAD"]);
    writeFileSync(stale, "unrelated");
    /** Deny both the former pathname copy and any descriptor reads of the stale sibling. */
    const denyStale = (path: unknown): void => {
      if (path === stale) throw Object.assign(new Error("unreadable stale base"), { code: "EACCES" });
    };
    const copy = fs.copyFileSync;
    const open = fs.openSync;
    mock.method(fs, "copyFileSync", (...args: Parameters<typeof fs.copyFileSync>) => {
      denyStale(args[0]);
      return copy(...args);
    });
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      denyStale(args[0]);
      return open(...args);
    });
    syncBuiltinESMExports();
    await main(f.root, ["--write", "--staged"]);
    assert.deepEqual(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).get("README.md")?.content, Buffer.from("hello\n"));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test("Git administrative paths reject invalid UTF-8 and preserve significant whitespace", { skip: process.platform === "win32" }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const gitDir = join(f.root, ".git");
  const index = join(f.root, "shared index é \t\n");
  const previous = process.env.GIT_INDEX_FILE;
  try {
    writeFileSync(index, readFileSync(join(gitDir, "index")));
    process.env.GIT_INDEX_FILE = index;
    await main(f.root, ["--write", "--staged"]);
    runGit(f.root, ["add", "--", "selfhost.bundle"]);
    const rawIndex = Buffer.concat([Buffer.from(join(f.root, "index-")), Buffer.from([0x80])]);
    renameSync(index, rawIndex);
    try {
      symlinkSync(rawIndex, index);
      await main(f.root, ["--write", "--staged"]);
    } finally {
      rmSync(index, { force: true });
      renameSync(rawIndex, index);
    }
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
  const archive = join(f.root, "selfhost.bundle");
  const original = readFileSync(archive);
  f.git(["add", "--", "selfhost.bundle"]);
  const rawGitDir = Buffer.concat([Buffer.from(join(f.root, "git-admin-")), Buffer.from([0x80])]);
  renameSync(gitDir, rawGitDir);
  try {
    writeFileSync(gitDir, Buffer.concat([Buffer.from("gitdir: "), rawGitDir, Buffer.from("\n")]));
    assert.equal(f.git(["ls-files", "--", "README.md"]), "README.md");
    await assert.rejects(() => main(f.root, ["--write", "--staged"]), { code: "invalid_git_path" });
    assert.deepEqual(readFileSync(archive), original);
  } finally {
    rmSync(gitDir);
    renameSync(rawGitDir, gitDir);
  }
});

test("split-index fallback resolves the shared base beside the selected index symlink", { skip: process.platform === "win32" }, async t => {
  const f = fixture();
  t.after(f.cleanup);
  const index = join(f.root, "actual-index", "index");
  const selection = join(f.root, "physical", "selected-index");
  const nested = join(f.root, "physical", "nested");
  const outer = join(f.root, "outer");
  const previous = process.env.GIT_INDEX_FILE;
  mkdirSync(dirname(index));
  mkdirSync(selection, { recursive: true });
  mkdirSync(nested);
  mkdirSync(outer);
  try {
    process.env.GIT_INDEX_FILE = index;
    runGit(f.root, ["read-tree", "HEAD"]);
    runGit(f.root, ["update-index", "--split-index"]);
    const base = basename(runGit(f.root, ["rev-parse", "--shared-index-path"]));
    const shared = join(selection, base);
    renameSync(join(f.root, ".git", base), shared);
    symlinkSync(index, join(selection, "index"));
    symlinkSync(nested, join(outer, "jump"), "dir");
    process.env.GIT_INDEX_FILE = "outer/jump/../selected-index/index";
    assert.equal(runGit(f.root, ["ls-files", "--", "README.md"]), "README.md");
    utimesSync(shared, 1, 1);
    const indexBefore = readFileSync(index);

    await main(f.root, ["--write", "--staged"]);

    const archived = bundledFiles(readFileSync(join(f.root, "selfhost.bundle")));
    assert.deepEqual(archived.get("README.md")?.content, Buffer.from("hello\n"));
    assert.deepEqual(readFileSync(index), indexBefore);
    assert.equal(statSync(shared).mtimeMs, 1000);
    assert.ok(lstatSync(join(selection, "index")).isSymbolicLink());
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test("staged split snapshots select the Git-readable shared base across index formats", async () => {
  for (const [format, version] of [["sha1", "4"], ["sha256", "3"]]) {
    const f = fixture(format);
    const index = join(f.root, "alternate-index");
    const output = join(f.root, "selfhost.bundle");
    const previous = process.env.GIT_INDEX_FILE;
    try {
      await main(f.root, ["--write", "--staged"]);
      f.git(["add", "--", "selfhost.bundle"]);
      process.env.GIT_INDEX_FILE = index;
      runGit(f.root, ["read-tree", "HEAD"]);
      runGit(f.root, ["add", "--", "selfhost.bundle"]);
      runGit(f.root, ["update-index", "--skip-worktree", "src/app.ts"]);
      runGit(f.root, ["update-index", "--index-version", version]);
      runGit(f.root, ["update-index", "--split-index"]);
      writeFileSync(join(f.root, "README.md"), `index ${format} ${version}\n`);
      runGit(f.root, ["add", "--", "README.md"]);
      runGit(f.root, ["update-index", "--skip-worktree", "README.md"]);
      const base = basename(runGit(f.root, ["rev-parse", "--shared-index-path"]));
      assert.match(base, /^sharedindex\.[0-9a-f]+$/u);
      const adjacent = join(f.root, base);
      const primary = join(f.root, ".git", base);
      const payload = join(f.root, "shared-base-payload");
      const before = readFileSync(index);
      assert.equal(before.readUInt32BE(4), Number(version));
      renameSync(primary, payload);
      symlinkSync("shared-base-payload", adjacent);
      // Git accepts the alternate's symlink when the primary is absent.
      const expectedTree = runGit(f.root, ["write-tree"]);
      writeFileSync(index, before);
      await main(f.root, ["--write", "--staged"]);
      const archived = bundledFiles(readFileSync(output));
      assert.deepEqual(archived.get("README.md")?.content, Buffer.from(`index ${format} ${version}\n`));
      assert.deepEqual(archived.get("src/app.ts")?.content, Buffer.from(runGit(f.root, ["show", `${expectedTree}:src/app.ts`]) + "\n"));
      assert.deepEqual(readFileSync(index), before);

      // A valid primary takes precedence over an invalid adjacent name.
      renameSync(payload, primary);
      rmSync(adjacent);
      mkdirSync(adjacent);
      utimesSync(primary, 1, 1);
      await main(f.root, ["--write", "--staged"]);
      assert.equal(statSync(primary).mtimeMs, 1000);
      assert.deepEqual(readFileSync(index), before);
      await main(f.root, ["--write"]);
      assert.equal(statSync(primary).mtimeMs, 1000);
      assert.deepEqual(readFileSync(index), before);

      // An unusable required base keeps the last bundle intact.
      const last = readFileSync(output);
      renameSync(primary, payload);
      rmSync(adjacent, { recursive: true });
      symlinkSync("shared-base-payload", adjacent);
      mkdirSync(primary);
      await assert.rejects(() => main(f.root, ["--write", "--staged"]), /stable, regular Git index file/);
      rmSync(primary, { recursive: true });
      rmSync(adjacent);
      mkdirSync(adjacent);
      await assert.rejects(() => main(f.root, ["--write", "--staged"]), /stable, regular Git index file/);
      rmSync(adjacent, { recursive: true });
      await assert.rejects(() => main(f.root, ["--write", "--staged"]), { code: "ENOENT" });
      assert.deepEqual(readFileSync(output), last);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
      f.cleanup();
    }
  }
});

test("staged index discovery rejects malformed layouts and accepts an empty split link", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const index = join(f.root, ".git", "index");
  const original = readFileSync(index);
  const header = Buffer.from("444952430000000200000000", "hex");
  const oneEntry = Buffer.from(header);
  oneEntry.writeUInt32BE(1, 8);
  const malformed: [Buffer, RegExp][] = [
    [Buffer.concat([Buffer.from("bad!"), header.subarray(4), Buffer.alloc(20)]), /unsupported Git index header/],
    [Buffer.concat([oneEntry, Buffer.alloc(62), Buffer.alloc(20, 0xff)]), /unterminated Git index pathname/],
    [Buffer.concat([oneEntry, Buffer.alloc(82)]), /unterminated Git index pathname/],
    [Buffer.concat([header, Buffer.from("544553540000ffff", "hex"), Buffer.alloc(20)]), /invalid Git index extension length/],
    [Buffer.concat([header, Buffer.from("6c696e6b00000000", "hex"), Buffer.alloc(20)]), /invalid Git index extension length/],
  ];
  for (const [bytes, error] of malformed) {
    writeFileSync(index, bytes);
    await assert.rejects(() => main(f.root, ["--write", "--staged"]), error);
  }
  const indexWithNullLink = Buffer.concat([
    original.subarray(0, -20), Buffer.from("6c696e6b00000014", "hex"), Buffer.alloc(20),
  ]);
  writeFileSync(index, Buffer.concat([indexWithNullLink, createHash("sha1").update(indexWithNullLink).digest()]));
  await main(f.root, ["--write", "--staged"]);
  assert.ok(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).has("README.md"));
});

test("staged index discovery handles multibyte path compression and extended entries", async t => {
  const f = fixture();
  t.after(f.cleanup);
  const long = "a".repeat(170);
  writeFileSync(join(f.root, long), "long path");
  f.git(["add", "--", long]);
  f.git(["update-index", "--skip-worktree", long]);
  f.git(["update-index", "--index-version", "4"]);
  await main(f.root, ["--write", "--staged"]);
  assert.deepEqual(bundledFiles(readFileSync(join(f.root, "selfhost.bundle"))).get(long)?.content, Buffer.from("long path"));
});
