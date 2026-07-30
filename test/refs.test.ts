import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ObjectStoreError } from "../engine/objects.ts";
import {
  BRANCH_PREFIX,
  TAG_PREFIX,
  type RefEntry,
  RefStore,
  assertRefName,
} from "../engine/refs.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a ref store backed by a fresh directory.
 *
 * @returns The store and its root.
 */
function freshRefs(): { refs: RefStore; root: string } {
  dir = makeTempDir();
  const root = join(dir.root, ".pmvcs");
  return { refs: new RefStore(root), root };
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const id = "abcdef0123456789".repeat(4);
const otherId = "fedcba9876543210".repeat(4);

test("assertRefName rejects every documented class of bad name", () => {
  const bad = (name: string): void => {
    assert.throws(
      () => assertRefName(name),
      (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_ref_name",
      `expected ${JSON.stringify(name)} to be rejected`,
    );
  };
  // Empty.
  bad("");
  // Leading or trailing slash.
  bad("/refs/heads/x");
  bad("refs/heads/x/");
  // Backslash is a path separator on some platforms.
  bad("refs\\heads");
  // Whitespace, control characters and the reserved punctuation set.
  bad("refs heads");
  bad("refs\theads");
  bad("refs\u0000heads");
  bad("ref~s");
  bad("ref^s");
  bad("ref:s");
  bad("ref?s");
  bad("ref*s");
  bad("ref[s");
  bad("ref]s");
  // Empty path segment from doubled slashes.
  bad("refs//heads");
  // Relative path segments would let a ref escape its directory.
  bad("refs/./heads");
  bad("refs/../heads");
  // A segment ending in .lock collides with the lock file suffix.
  bad("refs/heads/x.lock");
});

test("assertRefName accepts a normal hierarchical name", () => {
  // A reasonable branch name does not throw.
  assertRefName("refs/heads/feature/x-1");
});

test("compareAndSwap creates, updates and deletes a ref", () => {
  const { refs } = freshRefs();
  const name = `${BRANCH_PREFIX}main`;

  // Create: expected null, next is an id.
  refs.compareAndSwap(name, null, id);
  assert.equal(refs.read(name), id);

  // Update: expected the previous id.
  refs.compareAndSwap(name, id, otherId);
  assert.equal(refs.read(name), otherId);

  // Delete: expected the current id, next null.
  refs.compareAndSwap(name, otherId, null);
  assert.equal(refs.read(name), null);
});

test("compareAndSwap refuses a stale expected value and leaves the ref untouched", () => {
  const { refs } = freshRefs();
  const name = `${BRANCH_PREFIX}main`;
  refs.compareAndSwap(name, null, id);

  // Another agent has moved the ref on; a stale expectation must fail rather than
  // silently clobber the newer value.
  assert.throws(
    () => refs.compareAndSwap(name, "0".repeat(64), otherId),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "ref_changed",
  );
  // The ref is unchanged: the failed update wrote nothing.
  assert.equal(refs.read(name), id);
});

test("read refuses a corrupted ref value", () => {
  const { refs, root } = freshRefs();
  const name = `${BRANCH_PREFIX}bad`;
  refs.compareAndSwap(name, null, id);
  // Corrupt the stored value to something that is not an object id.
  writeFileSync(join(root, ...name.split("/")), "not-an-id\n");

  assert.throws(
    () => refs.read(name),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_ref",
  );
});

test("list walks a prefix, excludes locks and temp files, and sorts by name", () => {
  const { refs, root } = freshRefs();
  refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, id);
  refs.compareAndSwap(`${BRANCH_PREFIX}feature/a`, null, otherId);
  refs.compareAndSwap(`${TAG_PREFIX}v1`, null, id);

  const branches = refs.list(BRANCH_PREFIX);
  assert.deepEqual(
    branches.map((entry: RefEntry) => entry.name),
    [`${BRANCH_PREFIX}feature/a`, `${BRANCH_PREFIX}main`],
  );

  // A stray .lock or .tmp file under the ref tree must not appear in the list,
  // nor trip it up.
  mkdirSync(join(root, ...BRANCH_PREFIX.split("/")), { recursive: true });
  writeFileSync(join(root, ...BRANCH_PREFIX.split("/"), "stray.lock"), `${id}\n`);
  writeFileSync(join(root, ...BRANCH_PREFIX.split("/"), "stray.tmp"), `${id}\n`);
  const again = refs.list(BRANCH_PREFIX);
  assert.ok(!again.some((entry: RefEntry) => entry.name.endsWith(".lock") || entry.name.endsWith(".tmp")));
});

test("readHead handles an unborn branch, a live branch and a detached head", () => {
  const { refs } = freshRefs();
  // An unborn branch: HEAD names a ref that does not exist yet.
  refs.setHeadToRef(`${BRANCH_PREFIX}main`);
  const unborn = refs.readHead();
  assert.equal(unborn.kind, "branch");
  assert.equal(unborn.target, null);

  // A live branch.
  refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, id);
  assert.equal(refs.readHead().target, id);
  assert.equal(refs.resolveHead(), id);

  // A detached HEAD points directly at a commit.
  refs.setHeadDetached(otherId);
  const detached = refs.readHead();
  assert.equal(detached.kind, "detached");
  assert.equal(detached.target, otherId);
});

test("readHead rejects a missing HEAD and a corrupt one", () => {
  const { refs } = freshRefs();
  // No HEAD at all: the directory is not an initialised repository.
  assert.throws(
    () => refs.readHead(),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_head",
  );

  // A HEAD holding something that is neither a symbolic ref nor an id.
  mkdirSync(join(dir!.root, ".pmvcs"), { recursive: true });
  writeFileSync(join(dir!.root, ".pmvcs", "HEAD"), "garbage\n");
  assert.throws(
    () => refs.readHead(),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "corrupt_head",
  );
});

test("setHeadDetached refuses a malformed id", () => {
  const { refs } = freshRefs();
  assert.throws(
    () => refs.setHeadDetached("not-an-id"),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "invalid_object_id",
  );
});

test("list skips a subdirectory it cannot read", () => {
  const { refs, root } = freshRefs();
  refs.compareAndSwap(`${BRANCH_PREFIX}main`, null, id);
  // A subdirectory under the ref tree that cannot be read is skipped rather than
  // aborting the whole listing.
  const unreadable = join(root, ...BRANCH_PREFIX.split("/"), "unreadable");
  mkdirSync(unreadable, { recursive: true });
  writeFileSync(join(unreadable, "inner"), `${id}\n`);
  chmodSync(unreadable, 0o000);
  try {
    const branches = refs.list(BRANCH_PREFIX);
    // The readable ref still appears; the unreadable subtree contributes nothing.
    assert.deepEqual(branches.map((entry: RefEntry) => entry.name), [`${BRANCH_PREFIX}main`]);
  } finally {
    chmodSync(unreadable, 0o755);
  }
});

test("compareAndSwap reports a held lock", () => {
  const { refs, root } = freshRefs();
  const name = `${BRANCH_PREFIX}main`;
  const lockPath = join(root, ...name.split("/")) + ".lock";
  mkdirSync(join(root, ...name.split("/")).replace(/\/[^/]+$/, ""), { recursive: true });
  // Hold the lock by creating the .lock file first.
  writeFileSync(lockPath, "held");
  assert.throws(
    () => refs.compareAndSwap(name, null, id),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "ref_locked",
  );
});
