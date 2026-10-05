import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Repository } from "../engine/repo.ts";
import {
  DEFAULT_REPOSITORY_DISCOVERY_LIMITS,
  isServableRepositoryDirectory,
  ServedRepositoryDirectories,
} from "../engine/served-repositories.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const fixtures: ReturnType<typeof makeTempDir>[] = [];

/** Creates a disposable served root. */
function root(): string {
  const fixture = makeTempDir();
  fixtures.push(fixture);
  return fixture.root;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

test("catalogue values come from discovery and hostile names are only exact keys", () => {
  const directory = root();
  Repository.init(directory);
  const nested = Repository.init(join(directory, "tenant", "repo"));
  Repository.init(join(directory, ".hidden"));
  Repository.init(join(directory, "%2e%2e"));
  const directories = new ServedRepositoryDirectories(directory);
  assert.equal(directories.lookup(""), directory);
  assert.equal(directories.lookup("tenant/repo"), nested.root);
  for (const name of ["..", "../repo", "%2e%2e", "%2e%2e%2f", "/tenant/repo", directory,
    "tenant\\repo", "tenant/repo\0", "tenant//repo", "tenant/repo/", ".hidden", "constructor", "__proto__"]) {
    assert.equal(directories.lookup(name), undefined, JSON.stringify(name));
  }
});

test("catalogue refreshes on a miss at most once per interval and replaces stale entries", () => {
  const directory = root();
  let now = 0;
  const directories = new ServedRepositoryDirectories(directory, DEFAULT_REPOSITORY_DISCOVERY_LIMITS, () => now);
  const late = Repository.init(join(directory, "late"));
  assert.equal(directories.lookup("late"), undefined);
  now = 1_000;
  assert.equal(directories.lookup("late"), late.root);
  rmSync(late.root, { recursive: true });
  const another = Repository.init(join(directory, "another"));
  assert.equal(directories.lookup("unknown"), undefined);
  assert.equal(directories.lookup("another"), undefined);
  assert.equal(directories.lookup("late"), late.root);
  now = 2_000;
  assert.equal(directories.lookup("another"), another.root);
  assert.equal(directories.lookup("late"), undefined);
  rmSync(directory, { recursive: true });
  now = 3_000;
  assert.equal(directories.lookup("unknown"), undefined);
  assert.equal(directories.lookup("another"), undefined);
});

test("discovery bounds directory entries and depth instead of following request names", () => {
  const directory = root();
  const repository = Repository.init(join(directory, "tenant", "repo"));
  const limits = { ...DEFAULT_REPOSITORY_DISCOVERY_LIMITS, maxEntries: 1 };
  assert.equal(new ServedRepositoryDirectories(directory, limits).lookup("tenant/repo"), undefined);
  assert.equal(new ServedRepositoryDirectories(directory, { ...limits, maxEntries: 100, maxDepth: 1 }).lookup("tenant/repo"), undefined);
  assert.equal(new ServedRepositoryDirectories(directory, { ...limits, maxEntries: 100, maxDepth: 2 }).lookup("tenant/repo"), repository.root);
  for (const value of [0, -1, 1.5, Infinity]) {
    assert.throws(() => new ServedRepositoryDirectories(directory, { ...limits, maxEntries: value }), { code: "bad_limits" });
  }
});

test("enumeration rejects outside, inside and dangling filesystem aliases", () => {
  const directory = root();
  const outside = Repository.init(root());
  const owned = Repository.init(join(directory, "owned"));
  symlinkSync(outside.root, join(directory, "escape"), "junction");
  symlinkSync(owned.root, join(directory, "alias"), "junction");
  symlinkSync(join(directory, "missing"), join(directory, "dangling"), "junction");
  writeFileSync(join(directory, "file"), "ordinary file");
  const directories = new ServedRepositoryDirectories(directory);
  for (const name of ["escape", "alias", "dangling", "file"]) assert.equal(directories.lookup(name), undefined);
  assert.equal(directories.lookup("owned"), owned.root);
  assert.equal(isServableRepositoryDirectory(join(directory, "escape")), false);
});

test("control directories, linked instances and aliased metadata remain unservable", () => {
  const directory = root();
  writeFileSync(join(directory, ".pmvcs"), "not a directory");
  assert.equal(isServableRepositoryDirectory(directory), false);
  rmSync(join(directory, ".pmvcs"));
  const outside = Repository.init(root());
  symlinkSync(outside.controlDirectory, join(directory, ".pmvcs"), "junction");
  assert.equal(isServableRepositoryDirectory(directory), false);
  rmSync(join(directory, ".pmvcs"));
  const owned = Repository.init(directory);
  writeFileSync(join(owned.controlDirectory, "link.json"), "{}");
  assert.equal(isServableRepositoryDirectory(directory), false);
  rmSync(join(owned.controlDirectory, "link.json"));
  rmSync(join(owned.controlDirectory, "HEAD"));
  symlinkSync(join(outside.controlDirectory, "HEAD"), join(owned.controlDirectory, "HEAD"));
  assert.equal(isServableRepositoryDirectory(directory), false);
  rmSync(join(owned.controlDirectory, "HEAD"));
  assert.equal(isServableRepositoryDirectory(directory), false);
  mkdirSync(join(directory, "ordinary"));
  assert.equal(isServableRepositoryDirectory(join(directory, "ordinary")), false);
});
