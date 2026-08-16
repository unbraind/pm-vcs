// Sparse linked instances over a shared immutable object store.
//
// Every test here runs against real directories and real child processes:
// nothing about the sharing, the laziness or the concurrency can be asserted
// against a mock without the mock answering its own question. The adversarial
// cases — a view that must not change tree identity, a conflict the working
// tree cannot see, a tampered index, a lying hint — each get a test that fails
// by proving the silent path was taken.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { ObjectStoreError } from "../engine/objects.ts";
import {
  HINTS_FILE,
  INSTANCE_REGISTRY_FILE,
  VIEW_FILE,
  assertInstanceName,
  parseInstanceLink,
  parseView,
  readHints,
  readInstances,
  readView,
  viewIncludes,
  writeHints,
} from "../engine/instances.ts";
import { CONTROL_DIRECTORY, Repository } from "../engine/repo.ts";
import { type Signature, decodeTree, readCommit } from "../engine/model.ts";
import { isAncestor } from "../engine/merge.ts";
import { flattenTree } from "../engine/worktree.ts";
import { makeTempDir } from "./helpers/tmp.ts";
import { packageRoot } from "./helpers/sandbox.ts";

const author: Signature = { name: "Instance", email: "instance@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };
const later: Signature = { name: "Instance", email: "instance@local", timestamp: 2_000, timezoneOffsetMinutes: 0 };

let cleaner: { cleanup(): void } | null = null;

/**
 * Creates a fresh directory tree and registers it for teardown.
 *
 * @returns The absolute root path.
 */
function freshDir(): string {
  cleaner = makeTempDir();
  return cleaner.root;
}

afterEach(() => {
  cleaner?.cleanup();
  cleaner = null;
});

/**
 * Writes, stages and commits one file.
 *
 * @param repository - The repository to commit in.
 * @param path - Path relative to the repository root.
 * @param content - The file's new content.
 * @param message - Commit message.
 * @returns The commit id.
 */
function commitFile(repository: Repository, path: string, content: string, message: string): string {
  mkdirSync(dirname(join(repository.root, path)), { recursive: true });
  writeFileSync(join(repository.root, path), content);
  repository.stage([path]);
  return repository.commit({ message: `${message}\n`, author }, new Date());
}

/**
 * The object file an id lives in inside a store directory.
 *
 * @param storeRoot - The `objects` directory.
 * @param id - Object id.
 * @returns The file path holding the object.
 */
function objectFile(storeRoot: string, id: string): string {
  return join(storeRoot, id.slice(0, 2), id.slice(2));
}

test("a linked instance materializes its view, shares objects and keeps private state", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "the hub\n", "base readme");
  commitFile(hub, join("sub", "deep.txt"), "deep content\n", "base deep");

  const instanceRoot = join(parent, "alice-tree");
  const summary = hub.linkInstance("alice", instanceRoot, { include: ["readme.txt"] });

  // The instance sees exactly its view on disk.
  assert.equal(existsSync(join(instanceRoot, "readme.txt")), true);
  assert.equal(existsSync(join(instanceRoot, "sub")), false);
  // Its index carries the out-of-view path as a sparse entry with the committed
  // content, which is what keeps the next commit's tree complete.
  const alice = Repository.open(instanceRoot);
  const aliceEntries = new Map(alice.readIndex().map((entry) => [entry.path, entry]));
  assert.equal(aliceEntries.get("readme.txt")?.sparse, undefined);
  assert.equal(aliceEntries.get("sub/deep.txt")?.sparse, true);
  assert.equal(aliceEntries.get("sub/deep.txt")?.id, hub.readIndex().find((entry) => entry.path === "sub/deep.txt")?.id);
  // Absence of an out-of-view path is not a deletion.
  assert.equal(alice.status().clean, true);
  // The instance shares the hub's objects: it has no store of its own.
  assert.equal(existsSync(join(instanceRoot, CONTROL_DIRECTORY, "objects")), false);
  assert.deepEqual(
    readInstances(join(root, CONTROL_DIRECTORY)).map((entry) => entry.name),
    ["alice"],
  );
  assert.deepEqual(summary.include, ["readme.txt"]);
  assert.equal(summary.branch, "alice");
  assert.equal(summary.head, hub.refs.resolveHead());
});

test("a sparse view never changes committed tree identity", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "the hub\n", "base readme");
  commitFile(hub, join("sub", "deep.txt"), "deep content\n", "base deep");

  const aliceRoot = join(parent, "alice-tree");
  const bobRoot = join(parent, "bob-tree");
  hub.linkInstance("alice", aliceRoot, { include: ["readme.txt"] });
  hub.linkInstance("bob", bobRoot);

  // The same edit, staged and committed through a view and through a full tree.
  const alice = Repository.open(aliceRoot);
  const bob = Repository.open(bobRoot);
  writeFileSync(join(aliceRoot, "readme.txt"), "edited by alice\n");
  alice.stage(["readme.txt"]);
  const aliceCommit = alice.commit({ message: "edit\n", author }, new Date());
  writeFileSync(join(bobRoot, "readme.txt"), "edited by alice\n");
  bob.stage(["readme.txt"]);
  const bobCommit = bob.commit({ message: "edit\n", author }, new Date());

  const aliceTree = readCommit(alice.objects, aliceCommit).tree;
  const bobTree = readCommit(bob.objects, bobCommit).tree;
  assert.equal(aliceTree, bobTree);
  // And the tree really is complete: the out-of-view path is in it.
  assert.equal(existsSync(join(aliceRoot, "sub")), false);
  const flattened = flattenTree(alice.objects, aliceTree);
  assert.equal(flattened.get("sub/deep.txt")?.id, flattenTree(bob.objects, bobTree).get("sub/deep.txt")?.id);
});

test("a merge in a sparse instance evaluates the complete tree", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "the hub\n", "base readme");
  commitFile(hub, join("sub", "deep.txt"), "deep content\n", "base deep");

  const aliceRoot = join(parent, "alice-tree");
  hub.linkInstance("alice", aliceRoot, { include: ["readme.txt"] });
  // The hub moves an out-of-view path forward on main.
  commitFile(hub, join("sub", "deep.txt"), "deep content v2\n", "deep edit on main");

  const alice = Repository.open(aliceRoot);
  const report = alice.merge("main", { message: "take main\n", author }, new Date());
  assert.equal(report.kind, "fast_forward");
  assert.equal(report.head, hub.refs.resolveHead());
  // The merged tree is complete even though the instance never materialized it.
  assert.equal(readCommit(alice.objects, alice.refs.resolveHead() as string).tree, readCommit(hub.objects, report.head).tree);
  assert.equal(existsSync(join(aliceRoot, "sub")), false);
  assert.equal(alice.status().clean, true);
  // Widening the view afterwards materializes the merged content on demand.
  const change = alice.setView(["readme.txt", "sub/*"]);
  assert.deepEqual(change.widened, ["sub/deep.txt"]);
  assert.equal(readFileSync(join(aliceRoot, "sub", "deep.txt"), "utf8"), "deep content v2\n");
  assert.equal(alice.status().clean, true);
});

test("an out-of-view conflict fails visibly and leaves no state behind", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "the hub\n", "base readme");
  commitFile(hub, join("sub", "deep.txt"), "base\n", "base deep");

  const aliceRoot = join(parent, "alice-tree");
  const fullerRoot = join(parent, "fuller-tree");
  hub.linkInstance("alice", aliceRoot, { include: ["readme.txt"] });
  // A full-view instance sits on alice's own branch and edits the path alice
  // cannot see, so alice's branch and main genuinely conflict out of view.
  hub.linkInstance("fuller", fullerRoot, { branch: "alice" });
  const fuller = Repository.open(fullerRoot);
  commitFile(fuller, join("sub", "deep.txt"), "changed on alice branch\n", "edit on alice");
  commitFile(hub, join("sub", "deep.txt"), "changed on main\n", "edit on main");

  const alice = Repository.open(aliceRoot);
  // Alice's branch moved under her; syncing refreshes her index to her branch's
  // tip while the view keeps sub/deep.txt unmaterialized, which is exactly the
  // state a genuine out-of-view conflict needs.
  alice.switchTo("alice", new Date());
  assert.throws(
    () => alice.merge("main", { message: "conflict\n", author }, new Date()),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "conflict_out_of_view");
      // The message names the invisible path and how to make it visible.
      assert.match(error.message, /sub\/deep\.txt/);
      assert.match(error.message, /view/);
      return true;
    },
  );
  // The refusal happened before anything was written: no merge state, no
  // materialized markers, a clean tree, and HEAD where it was.
  assert.equal(existsSync(join(aliceRoot, CONTROL_DIRECTORY, "MERGE_STATE")), false);
  assert.equal(alice.status().clean, true);
  assert.equal(alice.status().merge, undefined);
});

test("committing a staged change outside the view is refused, never silently recorded", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "the hub\n", "base readme");
  commitFile(hub, join("sub", "deep.txt"), "base\n", "base deep");
  const readmeId = hub.readIndex().find((entry) => entry.path === "readme.txt")?.id;
  assert.ok(readmeId !== undefined);

  const aliceRoot = join(parent, "alice-tree");
  hub.linkInstance("alice", aliceRoot, { include: ["readme.txt"] });
  // Tamper: alice's index claims out-of-view content her HEAD does not hold —
  // exactly what a stale or foreign index would leave behind. Committing it
  // would attribute a change no working tree ever saw, so it must be refused.
  const alice = Repository.open(aliceRoot);
  writeFileSync(join(aliceRoot, CONTROL_DIRECTORY, "index"), `${[
    "pm-vcs-index 4",
    JSON.stringify(["100644", "d".repeat(64), "sub/deep.txt", null, null, null, true]),
    JSON.stringify(["100644", readmeId, "readme.txt", "f".repeat(32), null, null, false]),
  ].join("\n")}\n`);
  writeFileSync(join(aliceRoot, "readme.txt"), "edited\n");
  alice.stage(["readme.txt"]);
  assert.throws(
    () => alice.commit({ message: "must refuse\n", author }, new Date()),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "out_of_view_change");
      assert.match(error.message, /sub\/deep\.txt/);
      return true;
    },
  );
});

test("a missing fragment is a typed, actionable error naming how to fetch it", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "the hub\n", "base readme");
  commitFile(hub, join("sub", "deep.txt"), "deep content\n", "base deep");

  const aliceRoot = join(parent, "alice-tree");
  hub.linkInstance("alice", aliceRoot, { include: ["readme.txt"] });
  // Simulate a fragment that was never fetched: remove the out-of-view blob
  // from the shared store. The instance never needed it — until the view widens.
  const deepId = hub.readIndex().find((entry) => entry.path === "sub/deep.txt")?.id;
  assert.ok(deepId !== undefined);
  rmSync(objectFile(join(root, CONTROL_DIRECTORY, "objects"), deepId));

  const alice = Repository.open(aliceRoot);
  assert.throws(
    () => alice.setView(["**"]),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "missing_fragment");
      assert.match(error.message, new RegExp(deepId));
      assert.match(error.message, /pm vcs fetch/);
      assert.match(error.message, /pm vcs import/);
      return true;
    },
  );
});

test("a full scan reconciles lying hints against filesystem truth", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "a.txt", "clean\n", "base a");
  commitFile(hub, "b.txt", "clean\n", "base b");

  // A lying hint file: b.txt is claimed dirty though it is clean, and a.txt is
  // claimed clean though it was just edited. Written directly, as a stale or
  // foreign watcher would leave it.
  writeFileSync(join(root, "a.txt"), "edited behind the hint\n");
  writeHints(join(root, CONTROL_DIRECTORY), ["b.txt"]);
  const hub2 = Repository.open(root);

  // status never trusts the hint: b.txt is forced through a content check and
  // stays clean, a.txt is reported dirty though nothing hinted it.
  const status = hub2.status();
  assert.deepEqual(status.unstaged.map((change) => change.path), ["a.txt"]);
  assert.equal(status.clean, false);

  // The scan is the authority: it corrects both lies and rewrites the hints.
  const report = hub2.scan();
  assert.equal(report.checked, 2);
  assert.deepEqual(report.dirty, ["a.txt"]);
  assert.deepEqual(report.corrections, [
    { path: "a.txt", hinted: false, actual: true },
    { path: "b.txt", hinted: true, actual: false },
  ]);
  assert.deepEqual(readHints(join(root, CONTROL_DIRECTORY)), ["a.txt"]);
  assert.equal(
    readFileSync(join(root, CONTROL_DIRECTORY, HINTS_FILE), "utf8"),
    `${JSON.stringify({ dirty: ["a.txt"] }, null, 2)}\n`,
  );

  // Materializing a tree resets hints, because nothing can be dirty with
  // respect to a tree that was just written.
  hub2.stage(["a.txt"]);
  hub2.commit({ message: "commit a\n", author }, new Date());
  hub2.materialize(hub2.headTree());
  assert.deepEqual(readHints(join(root, CONTROL_DIRECTORY)), []);
});

test("concurrent instances share objects but never overwrite each other's state", async () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "base.txt", "base\n", "base");

  const aliceRoot = join(parent, "concurrent-alice");
  const bobRoot = join(parent, "concurrent-bob");
  hub.linkInstance("alice", aliceRoot);
  hub.linkInstance("bob", bobRoot);

  // A go file is the start barrier: both children spin until it exists, so
  // their commit loops genuinely overlap in time on the shared store.
  const goFile = join(parent, "go");
  const worker = join(packageRoot, "test", "helpers", "instance-worker.ts");
  const child = (instanceRoot: string, label: string) => new Promise<void>((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [worker, instanceRoot, goFile, label, "30"],
      // Child coverage is discarded, as everywhere in this suite: c8 would
      // otherwise merge per-child V8 output and make the gate flaky.
      { env: { ...process.env, NODE_V8_COVERAGE: "" } },
      (error) => (error === null ? resolveRun() : rejectRun(error)),
    );
  });
  const aliceRun = child(aliceRoot, "alice");
  const bobRun = child(bobRoot, "bob");
  writeFileSync(goFile, "");
  await Promise.all([aliceRun, bobRun]);

  const alice = Repository.open(aliceRoot);
  const bob = Repository.open(bobRoot);
  const aliceHead = alice.refs.resolveHead() as string;
  const bobHead = bob.refs.resolveHead() as string;
  assert.notEqual(aliceHead, bobHead);

  // Each instance's HEAD, index and oplog describe only its own commits: the
  // other's work is invisible to it, and nothing was overwritten.
  assert.equal(alice.readIndex().map((entry) => entry.path).includes("bob.txt"), false);
  assert.equal(bob.readIndex().map((entry) => entry.path).includes("alice.txt"), false);
  const aliceOperations = alice.operations.read();
  const bobOperations = bob.operations.read();
  assert.equal(aliceOperations.every((operation) => !operation.summary.includes("bob")), true);
  assert.equal(bobOperations.every((operation) => !operation.summary.includes("alice")), true);
  assert.equal(aliceOperations.length, bobOperations.length, "both workers committed the same number of operations");
  // Both branch tips descend from the shared base commit, through history that
  // only the shared store holds.
  const base = hub.refs.resolveHead() as string;
  assert.equal(isAncestor(alice.objects, base, aliceHead), true);
  assert.equal(isAncestor(bob.objects, base, bobHead), true);

  // The shared store is intact: every object reachable from every branch reads
  // and verifies, and the instance trees hold no private object directory.
  const seen = new Set<string>();
  const queue = [...alice.refs.list("refs/heads/")].map((entry) => entry.target);
  let verified = 0;
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const object = alice.objects.read(id);
    verified += 1;
    if (object.type === "commit") {
      const commit = readCommit(alice.objects, id);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === "tree") {
      for (const entry of decodeTree(object.payload)) queue.push(entry.id);
    }
  }
  // 31 commits per worker plus the base commit's closure, deduplicated across
  // both branches; the identical shared.txt blob is one object both raced to
  // write and both read back intact.
  assert.ok(verified > 60, `expected both workers' history in one shared store, verified ${verified}`);
  assert.equal(existsSync(join(aliceRoot, CONTROL_DIRECTORY, "objects")), false);
  assert.equal(existsSync(join(bobRoot, CONTROL_DIRECTORY, "objects")), false);
});

test("instances list, refuse duplicates, occupied paths, nesting and bad names", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "base\n", "base");
  const hubControl = join(root, CONTROL_DIRECTORY);

  const listing = hub.listInstances();
  assert.deepEqual(listing, []);
  assert.deepEqual(readInstances(hubControl), []);

  const aliceRoot = join(parent, "solo");
  hub.linkInstance("alice", aliceRoot, { include: ["*.txt"] });
  assert.deepEqual(hub.listInstances().map((entry) => entry.name), ["alice"]);
  assert.deepEqual(hub.listInstances()[0]?.include, ["*.txt"]);
  assert.equal(hub.listInstances()[0]?.head, hub.refs.resolveHead());

  // Duplicate name and duplicate path are both refused.
  assert.throws(() => hub.linkInstance("alice", join(parent, "other")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "instance_exists";
  });
  assert.throws(() => hub.linkInstance("other", aliceRoot), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "instance_exists";
  });
  // An occupied directory is refused: linking must never write over files.
  mkdirSync(join(parent, "occupied"), { recursive: true });
  writeFileSync(join(parent, "occupied", "keep.txt"), "mine\n");
  assert.throws(() => hub.linkInstance("occ", join(parent, "occupied")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "instance_path_occupied";
  });
  assert.equal(readFileSync(join(parent, "occupied", "keep.txt"), "utf8"), "mine\n");
  // Nesting in either direction is refused.
  assert.throws(() => hub.linkInstance("inside", join(root, "nested", "deeper")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "instance_nested";
  });
  assert.throws(() => hub.linkInstance("outside", join(parent, "..")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "instance_nested";
  });
  // Invalid names and patterns are refused by name and reason.
  assert.throws(() => hub.linkInstance("bad name", join(parent, "n1")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "invalid_instance_name";
  });
  assert.throws(() => hub.linkInstance("bad/branch", join(parent, "n2")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "invalid_instance_name";
  });
  assert.throws(() => hub.linkInstance("pats", join(parent, "n3"), { include: ["../escape"] }), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_view";
  });
  assert.throws(() => hub.linkInstance("bad", join(parent, "n4"), { branch: "no spaces" }), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "invalid_ref_name";
  });

  // Unlink removes the registration and leaves the directory exactly as it is.
  hub.unlinkInstance("alice");
  assert.throws(() => hub.unlinkInstance("alice"), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "unknown_instance";
  });
  assert.deepEqual(hub.listInstances(), []);
  assert.equal(existsSync(join(aliceRoot, CONTROL_DIRECTORY, "index")), true);
  // The registry on disk is valid JSON with the shape the reader expects.
  assert.deepEqual(JSON.parse(readFileSync(join(hubControl, INSTANCE_REGISTRY_FILE), "utf8")), { instances: [] });
});

test("an unborn hub refuses to link an instance that needs a new branch", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  assert.throws(() => hub.linkInstance("alice", join(parent, "alice")), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "unborn_head";
  });
  // But naming an existing branch is fine even before the first commit —
  // except no branch can exist yet either, so the same refusal applies.
  assert.throws(() => hub.linkInstance("alice", join(parent, "alice2"), { branch: "main" }), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "unborn_head";
  });
});

test("a listing reports a moved or broken instance instead of dropping it", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "readme.txt", "base\n", "base");
  const aliceRoot = join(parent, "movable");
  hub.linkInstance("alice", aliceRoot);
  rmSync(aliceRoot, { recursive: true, force: true });
  const listing = hub.listInstances();
  assert.equal(listing.length, 1);
  assert.equal(listing[0]?.name, "alice");
  assert.notEqual(listing[0]?.broken, undefined);
  assert.match(listing[0]?.broken ?? "", /does not hold a repository/);
});

test("view and hint files are validated, never degraded", () => {
  const control = join(freshDir(), CONTROL_DIRECTORY);
  mkdirSync(control, { recursive: true });
  assert.equal(readView(control), null);
  assert.deepEqual(readHints(control), []);
  assert.equal(viewIncludes({ include: [] }, "anything/at/all.txt"), true);
  assert.equal(viewIncludes({ include: ["src/**"] }, "src/a/b.txt"), true);
  assert.equal(viewIncludes({ include: ["src/**"] }, "doc/a.txt"), false);
  assert.equal(parseInstanceLink({ hub: "../hub" }), "../hub");

  writeFileSync(join(control, VIEW_FILE), "{ not json");
  assert.throws(() => readView(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_view" && /not valid JSON/.test(error.message);
  });
  writeFileSync(join(control, VIEW_FILE), JSON.stringify({ include: "src" }));
  assert.throws(() => readView(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_view" && /array/.test(error.message);
  });
  for (const pattern of ["", "/abs", "trailing/", "back\\slash", "nul\0", "a//b", ".", "..", "a/../b"]) {
    assert.throws(() => parseView({ include: [pattern] }), (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      return error.code === "bad_view";
    }, pattern);
  }
  assert.throws(() => parseView([]), (error: unknown) => error instanceof ObjectStoreError);
  assert.throws(() => parseInstanceLink({}), (error: unknown) => error instanceof ObjectStoreError);
  assert.throws(() => parseInstanceLink({ hub: 3 }), (error: unknown) => error instanceof ObjectStoreError);
  assert.throws(() => parseInstanceLink([]), (error: unknown) => error instanceof ObjectStoreError);

  writeFileSync(join(control, HINTS_FILE), "{ not json");
  assert.throws(() => readHints(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_hints";
  });
  writeFileSync(join(control, HINTS_FILE), JSON.stringify({ dirty: "a.txt" }));
  assert.throws(() => readHints(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_hints";
  });
  for (const name of ["", ".", "..", "a/b", "a\\b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b]"]) {
    assert.throws(() => assertInstanceName(name), (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      return error.code === "invalid_instance_name";
    }, name);
  }
});

test("an instance registry that exists but is broken fails loudly", () => {
  const control = join(freshDir(), CONTROL_DIRECTORY);
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, INSTANCE_REGISTRY_FILE), "{ not json");
  assert.throws(() => readInstances(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_instances";
  });
  writeFileSync(join(control, INSTANCE_REGISTRY_FILE), JSON.stringify({ nope: true }));
  assert.throws(() => readInstances(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_instances";
  });
  writeFileSync(join(control, INSTANCE_REGISTRY_FILE), JSON.stringify({ instances: [{ name: "x" }] }));
  assert.throws(() => readInstances(control), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "bad_instances" || error.code === "invalid_instance_name";
  });
  writeFileSync(join(control, INSTANCE_REGISTRY_FILE), JSON.stringify({ instances: [{ name: "x", path: "" }] }));
  assert.throws(() => readInstances(control), (error: unknown) => error instanceof ObjectStoreError);
});

test("an instance link pointing at a missing or malformed hub fails at open", () => {
  const root = freshDir();
  Repository.init(root);
  commitFile(Repository.open(root), "a.txt", "x\n", "base");
  const parent = root;

  const broken = join(parent, "broken-tree");
  mkdirSync(join(broken, CONTROL_DIRECTORY), { recursive: true });
  writeFileSync(join(broken, CONTROL_DIRECTORY, "link.json"), "{ not json");
  assert.throws(() => Repository.open(broken), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "broken_instance_link" && /not valid JSON/.test(error.message);
  });

  const orphan = join(parent, "orphan-tree");
  mkdirSync(join(orphan, CONTROL_DIRECTORY), { recursive: true });
  writeFileSync(join(orphan, CONTROL_DIRECTORY, "link.json"), JSON.stringify({ hub: "../not-a-repo" }));
  assert.throws(() => Repository.open(orphan), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "broken_instance_link" && /does not hold a pm-vcs repository/.test(error.message);
  });
});

test("a view change refuses to overwrite an untracked file and clears cleanly", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "a.txt", "a\n", "base a");
  commitFile(hub, "b.txt", "b\n", "base b");

  const narrow = hub.setView(["a.txt"]);
  assert.deepEqual(narrow, { widened: [], narrowed: ["b.txt"] });
  assert.equal(existsSync(join(root, "b.txt")), false);
  assert.equal(hub.readIndex().find((entry) => entry.path === "b.txt")?.sparse, true);
  assert.equal(hub.status().clean, true);

  // An untracked file at a widened path is protected.
  writeFileSync(join(root, "b.txt"), "precious untracked\n");
  assert.throws(() => hub.setView(["a.txt", "b.txt"]), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "view_would_overwrite_untracked";
  });
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "precious untracked\n");

  // Removing the file lets the widening materialize committed content, and
  // clearing the view returns the full tree with every file back on disk.
  rmSync(join(root, "b.txt"));
  const widened = hub.setView(["a.txt", "b.txt"]);
  assert.deepEqual(widened, { widened: ["b.txt"], narrowed: [] });
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
  assert.equal(hub.readIndex().find((entry) => entry.path === "b.txt")?.sparse, undefined);
  const cleared = hub.setView(null);
  assert.deepEqual(cleared, { widened: [], narrowed: [] });
  assert.equal(readView(join(root, CONTROL_DIRECTORY)), null);
  assert.deepEqual(readdirSync(root).filter((name) => name !== CONTROL_DIRECTORY).sort(), ["a.txt", "b.txt"]);
  assert.equal(hub.status().clean, true);
});

test("staging all never drops sparse entries and a sparse path is never a deletion", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "a.txt", "a\n", "base a");
  commitFile(hub, join("sub", "b.txt"), "b\n", "base b");
  hub.setView(["a.txt"]);
  const before = hub.readIndex().find((entry) => entry.path === "sub/b.txt");
  assert.ok(before?.sparse === true);

  const changed = hub.stage([]);
  assert.deepEqual(changed, []);
  const after = hub.readIndex().find((entry) => entry.path === "sub/b.txt");
  assert.equal(after?.id, before.id);
  assert.equal(after?.sparse, true);

  // An out-of-view path is also not a staged deletion when named explicitly.
  writeFileSync(join(root, "a.txt"), "a2\n");
  hub.stage(["a.txt", "sub/b.txt"]);
  const staged = new Map(hub.readIndex().map((entry) => [entry.path, entry]));
  assert.equal(staged.get("sub/b.txt")?.sparse, true);
  assert.notEqual(staged.get("a.txt")?.id, before.id);
});

test("a merge in progress keeps its conflicted paths inside the view", () => {
  const parent = freshDir();
  const root = join(parent, "hub");
  const hub = Repository.init(root);
  commitFile(hub, "a.txt", "base\n", "base");
  // Two branches that conflict at a.txt, merged in a working tree whose view
  // includes it: the merge must stop with visible state, not be refused.
  const aliceRoot = join(parent, "alice-tree");
  const fullerRoot = join(parent, "fuller-tree");
  hub.linkInstance("alice", aliceRoot, { include: ["a.txt"] });
  hub.linkInstance("fuller", fullerRoot);
  // Alice commits her own edit — in view — so merging fuller's divergent edit
  // is a genuine content conflict this working tree can see and must resolve.
  const alice = Repository.open(aliceRoot);
  commitFile(alice, "a.txt", "alice edit\n", "alice edit");
  commitFile(Repository.open(fullerRoot), "a.txt", "fuller edit\n", "fuller edit");

  const report = alice.merge("fuller", { message: "merge\n", author: later }, new Date());
  assert.equal(report.kind, "conflicted");
  assert.equal(existsSync(join(aliceRoot, CONTROL_DIRECTORY, "MERGE_STATE")), true);
  assert.match(readFileSync(join(aliceRoot, "a.txt"), "utf8"), /alice edit/);
  assert.match(readFileSync(join(aliceRoot, "a.txt"), "utf8"), /fuller edit/);
  assert.equal(alice.status().merge?.conflicts.includes("a.txt"), true);
  // A view change is refused while the conflict is unresolved.
  assert.throws(() => alice.setView([]), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    return error.code === "merge_in_progress";
  });
  alice.mergeAbort(new Date());
  assert.equal(alice.status().clean, true);
});
