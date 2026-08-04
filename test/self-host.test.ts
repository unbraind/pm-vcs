// Real tests for the self-hosting gate.
//
// The gate's claim is mechanical: a bundle's tip tree must be byte-identical to
// the source tree, every object must hash to its id, and a stale or tampered
// bundle must fail closed. These tests build real object stores, real bundles
// through the engine's own `exportBundle`, and real source trees through
// `buildSourceTree`, then exercise the verdict against honest and tampered
// inputs. Nothing is mocked: the engine that ships is the engine under test.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStore } from "../engine/objects.ts";
import { type Signature, readCommit, writeCommit } from "../engine/model.ts";
import { RefStore } from "../engine/refs.ts";
import { exportBundle, importBundleObjects, parseBundle } from "../engine/bundle.ts";

import {
  buildSourceTree,
  compareTrees,
  errorMessage,
  type SelfHostConfig,
  type SourceFile,
  extractHead,
  freshStore,
  headCommitTimestamp,
  isExcluded,
  isMainInvocation,
  listTrackedFiles,
  loadConfig,
  main,
  readCommittedFile,
  resolveBundleTarget,
  readSourceFiles,
  runGit,
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
  assert.deepEqual([...cfg.exclude], ["selfhost.bundle"]);
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
    ["missing-ref", '{"bundle":"b","exclude":[]}'],
    ["empty-ref", '{"bundle":"b","ref":"","exclude":[]}'],
    ["exclude-not-array", '{"bundle":"b","ref":"refs/heads/x","exclude":"nope"}'],
    ["exclude-entry-not-string", '{"bundle":"b","ref":"refs/heads/x","exclude":[1]}'],
    ["malformed-json", "{not json"],
    // `bundle` is resolved with join(root, ...) before writing, so a path that
    // escapes the repository would let a pull request choose where a
    // maintainer's own `self-host:write` writes.
    ["bundle-absolute-posix", '{"bundle":"/etc/passwd","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-absolute-windows", '{"bundle":"C:\\\\temp\\\\x","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-parent-escape", '{"bundle":"../outside.bundle","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-nested-escape", '{"bundle":"a/../../outside.bundle","ref":"refs/heads/x","exclude":[]}'],
    ["bundle-backslash-escape", '{"bundle":"a\\\\..\\\\..\\\\outside","ref":"refs/heads/x","exclude":[]}'],
    ["exclude-parent-escape", '{"bundle":"b","ref":"refs/heads/x","exclude":["../elsewhere"]}'],
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

// Silently continuing here would destroy history: the new commit would be
// parentless, `exportBundle` walks only from the new tip, and every prior
// snapshot would vanish. The verify gate compares tip trees, so it would call
// the truncated result byte-identical and nothing downstream would notice.
test("writeSelfHostBundle refuses to restart history when the bundle lacks the ref", () => {
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
      /does not advertise|Refusing to restart history/,
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

test("writeSelfHostBundle appends against a fresh scratch ref store", () => {
  // Mirrors the real script: the existing bundle's objects are imported into the
  // store, but its ref is never published into the scratch ref store. The append
  // must still succeed and the ref must end up at the new tip.
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

import { execFileSync as _execFileSync } from "node:child_process";
import { mkdirSync, readFileSync as _readFileSync, writeFileSync as _writeFileSync } from "node:fs";
import { join as _join } from "node:path";

/** A disposable git repo with one commit and a self-host config. */
interface Fixture {
  readonly root: string;
  cleanup(): void;
}

/** Creates a real git repo, commits some source files, and writes a self-host.json. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-self-host-fixture-"));
  const git = (args: string[]): string => _execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@pm-vcs.local"]);
  git(["config", "user.name", "self-host test"]);
  git(["config", "commit.gpgsign", "false"]);
  _writeFileSync(_join(root, "README.md"), "hello\n");
  mkdirSync(_join(root, "src"), { recursive: true });
  _writeFileSync(_join(root, "src", "app.ts"), "export const x = 1;\n");
  _writeFileSync(_join(root, "self-host.json"), JSON.stringify({
    bundle: "selfhost.bundle",
    ref: "refs/heads/self-host",
    exclude: ["selfhost.bundle"],
  }));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);
  return {
    root,
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

test("extractHead materializes the committed tree in a fresh directory", () => {
  const f = fixture();
  const into = mkdtempSync(join(tmpdir(), "pm-vcs-extract-test-"));
  let cleanupWorktree: () => void = () => {};
  try {
    cleanupWorktree = extractHead(f.root, into);
    assert.equal(_readFileSync(_join(into, "README.md"), "utf8"), "hello\n");
    assert.equal(_readFileSync(_join(into, "src", "app.ts"), "utf8"), "export const x = 1;\n");
  } finally {
    cleanupWorktree();
    rmSync(into, { recursive: true, force: true });
    f.cleanup();
  }
});

test("readCommittedFile returns the bytes of a tracked file at HEAD", () => {
  const f = fixture();
  try {
    const bytes = readCommittedFile(f.root, "README.md");
    assert.ok(bytes !== null);
    assert.equal(bytes!.toString("utf8"), "hello\n");
  } finally {
    f.cleanup();
  }
});

test("readCommittedFile returns null for a path absent from HEAD", () => {
  const f = fixture();
  try {
    assert.equal(readCommittedFile(f.root, "nonexistent.txt"), null);
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
      /phantom\.txt.*uncommitted addition/,
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

test("main --write generates a bundle in a real git repo", () => {
  const f = fixture();
  try {
    const origLog = console.log;
    let logged = "";
    console.log = (msg: string) => { logged = msg; };
    try {
      main({ root: f.root, args: ["node", "self-host.ts", "--write"] });
    } finally {
      console.log = origLog;
    }
    assert.match(logged, /wrote selfhost\.bundle/);
    const bundleStat = _readFileSync(_join(f.root, "selfhost.bundle"));
    assert.ok(bundleStat.length > 0);
    _execFileSync("git", ["add", "-A"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    _execFileSync("git", ["commit", "-q", "-m", "add bundle"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    main({ root: f.root, args: ["node", "self-host.ts"] });
  } finally {
    f.cleanup();
  }
});

test("main --check fails when the bundle is missing from HEAD", () => {
  const f = fixture();
  try {
    assert.throws(
      () => main({ root: f.root, args: ["node", "self-host.ts"] }),
      /no committed bundle/,
    );
  } finally {
    f.cleanup();
  }
});

test("main --check fails when the bundle does not match the source", () => {
  const f = fixture();
  try {
    main({ root: f.root, args: ["node", "self-host.ts", "--write"] });
    _execFileSync("git", ["add", "-A"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    _execFileSync("git", ["commit", "-q", "-m", "add bundle"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    _writeFileSync(_join(f.root, "README.md"), "changed\n");
    _execFileSync("git", ["add", "-A"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    _execFileSync("git", ["commit", "-q", "-m", "change source"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    const origExit = process.exitCode;
    process.exitCode = undefined;
    const origErr = console.error;
    let errs = "";
    console.error = (msg: string) => { errs += msg + "\n"; };
    try {
      main({ root: f.root, args: ["node", "self-host.ts"] });
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

test("isMainInvocation returns true when argv[1] resolves to the module URL", () => {
  const url = pathToFileURL(_join("/tmp", "self-host.ts")).href;
  assert.equal(isMainInvocation(["node", "/tmp/self-host.ts"], url), true);
});

test("isMainInvocation returns false when argv[1] is a different script", () => {
  const url = pathToFileURL(_join("/tmp", "self-host.ts")).href;
  assert.equal(isMainInvocation(["node", "/tmp/other.ts"], url), false);
});

test("isMainInvocation returns false when argv[1] is undefined", () => {
  assert.equal(isMainInvocation(["node"], "file:///tmp/self-host.ts"), false);
});

test("readCommittedFile throws when git cannot be launched", () => {
  const f = fixture();
  const origPath = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    assert.throws(
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
    // Create an executable file, commit it.
    _writeFileSync(_join(f.root, "run.sh"), "#!/bin/sh\necho hi\n");
    _execFileSync("chmod", ["+x", _join(f.root, "run.sh")], { encoding: "utf8" });
    _execFileSync("git", ["add", "-A"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    _execFileSync("git", ["update-index", "--chmod=+x", "run.sh"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    _execFileSync("git", ["commit", "-q", "-m", "add executable"], {
      cwd: f.root, encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: "/dev/null", GIT_PAGER: "cat" },
    });
    const tracked = listTrackedFiles(f.root);
    const files = readSourceFiles(f.root, tracked, ["selfhost.bundle"]);
    assert.equal(files.get("run.sh")?.mode, "100755");
  } finally {
    f.cleanup();
  }
});

test("main without options runs the real self-host check on the package", () => {
  // This covers the default-parameter branches (options?.root and options?.args
  // falling through to import.meta.dirname and process.argv). The package's own
  // self-host bundle is committed and should match the committed source.
  const origLog = console.log;
  let logged = "";
  console.log = (msg: string) => { logged = msg; };
  try {
    main();
  } finally {
    console.log = origLog;
  }
  assert.match(logged, /byte-identical/);
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
