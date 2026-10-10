/** Shared between-step race scenarios plus Linux descriptor-pinned syscall-boundary protection. */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { parseIgnore } from "../engine/ignore.ts";
import { writeCommit, type Signature } from "../engine/model.ts";
import { ObjectStoreError, type ObjectStore } from "../engine/objects.ts";
import { Repository } from "../engine/repo.ts";
import { buildTree, materializeTree } from "../engine/worktree.ts";
import { WorktreeMutation, worktreeMutationCapabilities } from "../engine/worktree-mutation.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let betweenSteps = false;
let fixture: ReturnType<typeof makeTempDir> | undefined;
const author: Signature = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  fixture?.cleanup();
  fixture = undefined;
});

/** Set up ordinary tracked bytes and independent outside/control sentinels in one disposable fixture. */
function setup(control: boolean = false): { repo: Repository; destination: string; tree: string; tip: string } {
  fixture = makeTempDir();
  const repo = Repository.init(join(fixture.root, "worktree"));
  const destination = control ? join(repo.root, "nested/.pmvcs") : join(fixture.root, "outside");
  for (const path of [join(repo.root, "branch/new"), join(destination, "new"), join(destination, "droppable")]) {
    mkdirSync(path, { recursive: true });
  }
  for (const path of [join(repo.root, "branch/leaf.txt"), join(destination, "leaf.txt"), join(destination, "new/leaf.txt"), join(destination, "droppable/sentinel")]) {
    writeFileSync(path, "sentinel\n", { mode: 0o600 });
  }
  const id = repo.objects.write("blob", Buffer.from("replacement\n"));
  const tree = buildTree(repo.objects, new Map([["branch/leaf.txt", { id, mode: "100755" }]]));
  const tip = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "fixture\n" });
  repo.refs.compareAndSwap("refs/heads/main", null, tip);
  repo.writeIndex([{ path: "branch/leaf.txt", id, mode: "100755" }]);
  return { repo, destination, tree, tip };
}

/** Hook both descriptor-safe syscalls and their old pathname equivalents for behavioral revert proofs. */
function intercept(operation: "open" | "mkdir" | "unlink" | "rmdir", leaf: string, swap: () => void, erasure = false): () => boolean {
  let swapped = false;
  const trigger = (path: unknown): void => {
    if (!swapped && typeof path === "string" && path.endsWith(`/${leaf}`)) {
      swapped = true;
      swap();
    }
  };
  if (betweenSteps) {
    const lstat = fs.lstatSync;
    let observations = 0;
    let pruning = false;
    if (operation === "rmdir") {
      const readdir = fs.readdirSync;
      mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
        const entries = readdir(...args);
        if (entries.length === 0 && args[1] === undefined) pruning = true;
        return entries;
      });
    }
    mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]).endsWith(`/${leaf}`)) {
        observations += 1;
        // Unlink's second observation (first with a retained erasure identity), open's post-unlink absence observation,
        // mkdir's first missing-child observation, or rmdir's repeated child check.
        const boundary = operation === "unlink" ? (erasure ? 1 : 2) : operation === "open" ? 3 : 1;
        if (operation === "rmdir" ? pruning : observations === boundary) trigger(args[0]);
      }
      return lstat(...args);
    });
    return () => swapped;
  }
  if (operation === "open") {
    const open = fs.openSync;
    mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[1] === "number" && (args[1] & fs.constants.O_CREAT) !== 0) trigger(args[0]);
      return open(...args);
    });
    const write = fs.writeFileSync;
    mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => { trigger(args[0]); return write(...args); });
  } else if (operation === "mkdir") {
    const mkdir = fs.mkdirSync;
    mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => { trigger(args[0]); return mkdir(...args); });
  } else {
    const remove = operation === "unlink" ? fs.unlinkSync : fs.rmdirSync;
    mock.method(fs, operation === "unlink" ? "unlinkSync" : "rmdirSync", (...args: Parameters<typeof fs.unlinkSync>) => {
      trigger(args[0]);
      return remove(...args);
    });
    const rm = fs.rmSync;
    mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => { trigger(args[0]); return rm(...args); });
  }
  syncBuiltinESMExports();
  return () => swapped;
}

for (const strategy of ["pinned", "portable", "portable-no-follow"] as const) {
  for (const boundary of strategy === "pinned" ? ["between steps", "syscall"] : ["between steps"]) {
    describe(`${strategy}: ${boundary}`, () => {
      beforeEach(() => {
        betweenSteps = boundary === "between steps";
        mock.method(worktreeMutationCapabilities, "descriptorPaths", () => strategy === "pinned");
        if (strategy === "portable-no-follow") mock.method(worktreeMutationCapabilities, "noFollow", () => 0);
      });

      for (const control of [false, true]) {
        for (const action of ["materialize", "restore"] as const) {
          for (const operation of ["open", "mkdir", "unlink"] as const) {
            test(`${action} refuses ancestor replacement at ${operation} into ${control ? "control state" : "outside"}`, () => {
              const { repo, destination, tree, tip } = setup(control);
              const path = operation === "mkdir" ? "branch/new/leaf.txt" : "branch/leaf.txt";
              if (operation === "mkdir") fs.rmdirSync(join(repo.root, "branch/new"));
              const source = operation === "unlink" ? buildTree(repo.objects, new Map())
                : operation === "mkdir" ? buildTree(repo.objects, new Map([[path, { id: repo.objects.write("blob", Buffer.from("replacement\n")), mode: "100755" }]])) : tree;
              const revision = source === tree ? tip : writeCommit(repo.objects, { tree: source, parents: [], author, committer: author, message: "source\n" });
              const index = repo.readIndex();
              const swapped = intercept(operation, operation === "mkdir" ? "new" : "leaf.txt", () => {
                renameSync(join(repo.root, "branch"), join(repo.root, "parked"));
                symlinkSync(destination, join(repo.root, "branch"), "dir");
              });
              let failure: unknown;
              try {
                if (action === "restore") repo.restore([path], revision);
                else materializeTree(repo.objects, repo.root, source, ".pmvcs", parseIgnore(""), undefined, new Set([path]));
              } catch (error) { failure = error; }
              assert.equal(swapped(), true, "the selected mutation boundary was exercised");
              for (const sentinel of ["leaf.txt", "new/leaf.txt", "droppable/sentinel"]) {
                assert.equal(readFileSync(join(destination, sentinel), "utf8"), "sentinel\n");
                assert.equal(statSync(join(destination, sentinel)).mode & 0o777, 0o600);
              }
              assert.ok(failure instanceof ObjectStoreError);
              assert.equal(failure.code, "worktree_path_changed");
              assert.deepEqual(repo.readIndex(), index, "refusal does not publish a partial index");
            });
          }
        }
      }

      for (const control of [false, true]) {
        for (const action of ["layer-add", "layer-restore", "layer-delete", "link", "obliterate"] as const) {
          const operations = action === "obliterate" || action === "layer-delete" ? ["unlink"] as const
            : action === "layer-restore" ? ["open", "unlink"] as const : ["open", "mkdir", "unlink"] as const;
          for (const operation of operations) {
            test(`${action} refuses ancestor replacement at ${operation} into ${control ? "control state" : "outside"}`, () => {
              const { repo, destination, tip } = setup(control);
              repo.restore(["branch/leaf.txt"], tip);
              const path = operation === "mkdir" ? "branch/new/leaf.txt" : "branch/leaf.txt";
              if (operation === "mkdir") fs.rmdirSync(join(repo.root, "branch/new"));
              if (action === "layer-delete") {
                const empty = buildTree(repo.objects, new Map());
                repo.materialize(empty);
                repo.commit({ message: "empty underlying tree", author }, new Date(1000));
              }
              if (action === "layer-restore" || action === "layer-delete") {
                repo.addLayer("fixture", new Map([[path, { content: Buffer.from("private replacement\n"), executable: false }]]));
              }
              if (action === "obliterate") {
                repo.setAuthority("fixture", "read-fixture", "erase-fixture");
                writeFileSync(join(repo.root, path), "unique payload selected for permanent physical erasure\n");
                repo.stage([path]);
                repo.commit({ message: "selected identity", author }, new Date(1000));
              }
              const replaceAncestor = (): void => {
                renameSync(join(repo.root, "branch"), join(repo.root, "parked"));
                symlinkSync(destination, join(repo.root, "branch"), "dir");
              };
              let swapped: (() => boolean) | undefined;
              if (action === "obliterate") {
                // Guarded preflight reads also observe this leaf. Arm the
                // removal race after the original durable denial write.
                const record = repo.objects.recordDenials;
                mock.method(repo.objects, "recordDenials", (...args: Parameters<ObjectStore["recordDenials"]>) => {
                  record.apply(repo.objects, args);
                  swapped = intercept(operation, "leaf.txt", replaceAncestor, true);
                });
              } else swapped = intercept(operation, operation === "mkdir" ? "new" : "leaf.txt", replaceAncestor);
              assert.throws(() => {
                if (action === "layer-add") repo.addLayer("fixture", new Map([[path, { content: Buffer.from("private replacement\n"), executable: true }]]));
                else if (action === "layer-restore" || action === "layer-delete") repo.removeLayer("fixture");
                else if (action === "link") repo.stageLink(path, { version: 1, repository: repo.identity(), revision: tip,
                  mappings: [{ source: "source.txt", destination: "vendor/file.txt" }] });
                else repo.obliterate(path, "erase-fixture", "incident", new Date(2000));
              }, { code: "worktree_path_changed" });
              assert.equal(swapped?.(), true, "the selected mutation boundary was exercised");
              for (const sentinel of ["leaf.txt", "new/leaf.txt", "droppable/sentinel"]) {
                assert.equal(readFileSync(join(destination, sentinel), "utf8"), "sentinel\n");
                assert.equal(statSync(join(destination, sentinel)).mode & 0o777, 0o600);
              }
              if (action === "obliterate") assert.equal(repo.objects.denials()[0]!.pending, true, "a failed removal cannot report completed erasure");
            });
          }
        }
      }

      test("materialize refuses ancestor replacement at pruning without recursively deleting control content", () => {
        const { repo, destination } = setup(true);
        mkdirSync(join(repo.root, "branch/droppable"));
        const swapped = intercept("rmdir", "droppable", () => {
          renameSync(join(repo.root, "branch"), join(repo.root, "parked"));
          symlinkSync(destination, join(repo.root, "branch"), "dir");
        });
        assert.throws(() => repo.materialize(null), { code: "worktree_path_changed" });
        assert.equal(swapped(), true);
        assert.equal(readFileSync(join(destination, "droppable/sentinel"), "utf8"), "sentinel\n");
      });

      test("materialize rejects an ordinary ancestor inode replacement before writing", () => {
        const { repo, tree } = setup();
        assert.throws(() => materializeTree(repo.objects, repo.root, tree, ".pmvcs", parseIgnore(""), (_path, object) => {
          renameSync(join(repo.root, "branch"), join(repo.root, "parked"));
          mkdirSync(join(repo.root, "branch"));
          return object.payload;
        }), { code: "worktree_path_changed" });
        assert.equal(existsSync(join(repo.root, "branch/leaf.txt")), false);
        assert.equal(readFileSync(join(repo.root, "parked/leaf.txt"), "utf8"), "sentinel\n");
      });

      test("restore refuses root replacement after the exclusive file open", () => {
        const { repo, destination, tip } = setup();
        const swapped = intercept("open", "leaf.txt", () => {
          renameSync(repo.root, join(fixture!.root, "parked-root"));
          symlinkSync(destination, repo.root, "dir");
        });
        assert.throws(() => repo.restore(["branch/leaf.txt"], tip), { code: "worktree_path_changed" });
        assert.equal(swapped(), true);
        assert.equal(existsSync(join(destination, "branch")), false);
        assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
      });

      test("exclusive creation refuses a leaf symlink installed after unlink", () => {
        const { repo, destination, tip } = setup();
        intercept("open", "leaf.txt", () => symlinkSync(join(destination, "leaf.txt"), join(repo.root, "branch/leaf.txt")));
        assert.throws(() => repo.restore(["branch/leaf.txt"], tip), { code: "worktree_path_changed" });
        assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
      });

      test("replacing a hardlink writes and chmods a new inode without changing its outside alias", () => {
        const { repo, destination, tip } = setup();
        fs.unlinkSync(join(repo.root, "branch/leaf.txt"));
        fs.linkSync(join(destination, "leaf.txt"), join(repo.root, "branch/leaf.txt"));
        repo.restore(["branch/leaf.txt"], tip);
        assert.equal(readFileSync(join(repo.root, "branch/leaf.txt"), "utf8"), "replacement\n");
        assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
        assert.equal(statSync(join(destination, "leaf.txt")).mode & 0o777, 0o600);
      });


      for (const replacement of ["missing", "file", "symlink", "directory"] as const) {
        test(`directory capture refuses ${replacement} substitution and closes already opened descriptors`, () => {
          const { repo, destination } = setup();
          let swapped = false;
          const opened = new Set<number>();
          const open = fs.openSync;
          const close = fs.closeSync;
          const lstat = fs.lstatSync;
          let observations = 0;
          const swap = (): void => {
            swapped = true;
            renameSync(join(repo.root, "branch"), join(repo.root, "parked"));
            if (replacement === "file") writeFileSync(join(repo.root, "branch"), "file\n");
            if (replacement === "symlink") symlinkSync(destination, join(repo.root, "branch"));
            if (replacement === "directory") mkdirSync(join(repo.root, "branch"));
          };
          mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
            if (!swapped && String(args[0]).endsWith("/branch")) {
              observations += 1;
              if (replacement === "missing" || replacement === "file" || (strategy !== "pinned" && observations === 2)) swap();
            }
            return lstat(...args);
          });
          mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
            if (!swapped && String(args[0]).endsWith("/branch")) swap();
            const fd = open(...args);
            opened.add(fd);
            return fd;
          });
          mock.method(fs, "closeSync", (fd: number) => { opened.delete(fd); close(fd); });
          assert.throws(() => new WorktreeMutation(repo.root, ".pmvcs"), { code: "worktree_path_changed" });
          assert.equal(swapped, true);
          assert.equal(opened.size, 0);
        });
      }

      test("a new ancestor installed after the snapshot is refused, while absent removals are harmless", () => {
        const { repo, destination } = setup();
        const mutation = new WorktreeMutation(repo.root, ".pmvcs");
        try {
          mutation.remove("missing/deep/file");
          symlinkSync(destination, join(repo.root, "missing"));
          assert.throws(() => mutation.write("missing/leaf.txt", Buffer.from("bad"), 0o644), { code: "worktree_path_changed" });
        } finally { mutation.close(); }
        assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
      });

      test("exclusive mkdir refuses a directory created by a concurrent writer", () => {
        const { repo } = setup();
        const mutation = new WorktreeMutation(repo.root, ".pmvcs");
        const mkdir = fs.mkdirSync;
        mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
          mkdir(...args);
          writeFileSync(join(String(args[0]), "sentinel"), "concurrent\n");
          return mkdir(...args);
        });
        try {
          assert.throws(() => mutation.write("concurrent/file", Buffer.from("bad"), 0o644), { code: "worktree_path_changed" });
        } finally { mutation.close(); }
        assert.equal(readFileSync(join(repo.root, "concurrent/sentinel"), "utf8"), "concurrent\n");
      });

      test("unlink refuses a concurrent leaf directory without deleting it recursively", () => {
        const { repo } = setup();
        const mutation = new WorktreeMutation(repo.root, ".pmvcs");
        const unlink = fs.unlinkSync;
        mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
          unlink(path);
          mkdirSync(path);
          writeFileSync(join(String(path), "sentinel"), "concurrent\n");
          return unlink(path);
        });
        try {
          assert.throws(() => mutation.remove("branch/leaf.txt"), { code: "worktree_path_changed" });
        } finally { mutation.close(); }
        assert.equal(readFileSync(join(repo.root, "branch/leaf.txt/sentinel"), "utf8"), "concurrent\n");
      });

      for (const boundary of ["fstat", "chmod"] as const) {
        test(`a leaf replaced at ${boundary} cannot redirect descriptor write or chmod`, () => {
          const { repo, destination, tip } = setup();
          let swapped = false;
          const swap = (): void => {
            swapped = true;
            renameSync(join(repo.root, "branch/leaf.txt"), join(repo.root, "branch/parked-leaf"));
            if (boundary === "chmod") symlinkSync(join(destination, "leaf.txt"), join(repo.root, "branch/leaf.txt"));
          };
          if (boundary === "fstat") {
            const fstat = fs.fstatSync;
            mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
              const stat = fstat(...args);
              if (!swapped && stat.isFile()) swap();
              return stat;
            });
          } else {
            const chmod = fs.fchmodSync;
            mock.method(fs, "fchmodSync", (...args: Parameters<typeof fs.fchmodSync>) => { swap(); return chmod(...args); });
          }
          assert.throws(() => repo.restore(["branch/leaf.txt"], tip), { code: "worktree_path_changed" });
          assert.equal(swapped, true);
          assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
          assert.equal(statSync(join(destination, "leaf.txt")).mode & 0o777, 0o600);
        });
      }

      for (const operation of ["writeFileSync", "fchmodSync"] as const) {
        for (const replacement of ["ancestor", "leaf"] as const) {
          test(`${operation} refuses a ${replacement} symlink swap and preserves its outside target`, () => {
            const { repo, destination, tip } = setup();
            const original = fs[operation];
            let swapped = false;
            mock.method(fs, operation, (...args: Parameters<typeof original>) => {
              if (typeof args[0] === "number" && !swapped) {
                swapped = true;
                const path = replacement === "ancestor" ? join(repo.root, "branch") : join(repo.root, "branch/leaf.txt");
                renameSync(path, `${path}-parked`);
                symlinkSync(replacement === "ancestor" ? destination : join(destination, "leaf.txt"), path);
              }
              return Reflect.apply(original, fs, args);
            });
            assert.throws(() => repo.restore(["branch/leaf.txt"], tip), { code: "worktree_path_changed" });
            assert.equal(swapped, true);
            assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
            assert.equal(statSync(join(destination, "leaf.txt")).mode & 0o777, 0o600);
    });
  }
}

test("pruning refuses content added after the empty-directory observation", () => {
  const { repo } = setup();
  mkdirSync(join(repo.root, "branch/droppable"));
  const rmdir = fs.rmdirSync;
  mock.method(fs, "rmdirSync", (...args: Parameters<typeof fs.rmdirSync>) => {
    writeFileSync(join(String(args[0]), "sentinel"), "concurrent\n");
    return rmdir(...args);
  });
  assert.throws(() => repo.materialize(null), { code: "worktree_path_changed" });
  assert.equal(readFileSync(join(repo.root, "branch/droppable/sentinel"), "utf8"), "concurrent\n");
});

test("a leaf installed after unlink verification refuses before file open", () => {
  const { repo, destination } = setup();
  const mutation = new WorktreeMutation(repo.root, ".pmvcs");
  const lstat = fs.lstatSync;
  let observations = 0;
  mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]).endsWith("/leaf.txt") && ++observations === 4) {
      symlinkSync(join(destination, "leaf.txt"), args[0]);
    }
    return lstat(...args);
  });
  try {
    assert.throws(() => mutation.write("branch/leaf.txt", Buffer.from("bad"), 0o644), { code: "worktree_path_changed" });
  } finally { mutation.close(); }
  assert.equal(readFileSync(join(destination, "leaf.txt"), "utf8"), "sentinel\n");
});

test("pruning refuses a directory recreated immediately after rmdir", () => {
  const { repo } = setup();
  const rmdir = fs.rmdirSync;
  let recreated = false;
  mock.method(fs, "rmdirSync", (...args: Parameters<typeof fs.rmdirSync>) => {
    rmdir(...args);
    mkdirSync(args[0]);
    recreated = true;
  });
  assert.throws(() => repo.materialize(null), { code: "worktree_path_changed" });
  assert.equal(recreated, true);
});

test("materialize and restore create, replace, remove and prune ordinary nested files", () => {
  const { repo } = setup();
  const id = repo.objects.write("blob", Buffer.from("ordinary\n"));
  const path = "fresh/deep/ordinary.txt";
  const tree = buildTree(repo.objects, new Map([[path, { id, mode: "100644" }]]));
  const tip = writeCommit(repo.objects, { tree, parents: [], author, committer: author, message: "ordinary\n" });
  const entries = materializeTree(repo.objects, repo.root, tree, ".pmvcs", parseIgnore(""));
  assert.deepEqual(entries.map((entry) => entry.path), [path]);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "ordinary\n");
  writeFileSync(join(repo.root, path), "edited\n");
  repo.restore([path], tip);
  assert.equal(readFileSync(join(repo.root, path), "utf8"), "ordinary\n");
  const empty = buildTree(repo.objects, new Map());
  const emptyTip = writeCommit(repo.objects, { tree: empty, parents: [], author, committer: author, message: "empty\n" });
  repo.restore([path], emptyTip);
  repo.materialize(null);
  assert.equal(existsSync(join(repo.root, "fresh")), false);
});

test("the mutation boundary rejects hostile paths and pre-existing non-file leaves", () => {
  const { repo, destination } = setup();
  const mutation = new WorktreeMutation(repo.root, ".pmvcs");
  try {
    for (const path of [".pmvcs/secret", "nested/.PMVCS/secret", "", "a//b", "./file", "../file", "a/\0b"]) {
      assert.throws(() => mutation.write(path, Buffer.from("bad"), 0o644), { code: "path_ignored" });
    }
    assert.throws(() => mutation.write("branch/new", Buffer.from("bad"), 0o644), { code: "worktree_path_changed" });
    assert.throws(() => mutation.remove("branch/new"), { code: "restore_directory_unsupported" });
    mutation.remove("branch/absent");
    assert.equal(mutation.prune("branch/new"), true);
    symlinkSync(join(destination, "leaf.txt"), join(repo.root, "leaf-link"));
    assert.throws(() => mutation.remove("leaf-link"), { code: "worktree_path_changed" });
    assert.throws(() => mutation.prune("missing"), { code: "worktree_path_changed" });
  } finally { mutation.close(); }
});

    });
  }
}

for (const backend of ["missing", "wrong inode"] as const) {
  test(`unavailable descriptor backend (${backend}) selects portable mutation`, () => {
    const { repo, destination } = setup();
    mock.method(worktreeMutationCapabilities, "descriptorPaths", () => true);
    const stat = fs.statSync;
    mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
      if (String(args[0]).startsWith("/proc/self/fd/")) {
        if (backend === "missing") throw new Error("unavailable");
        return stat(destination, args[1]);
      }
      return stat(...args);
    });
    const mutation = new WorktreeMutation(repo.root, ".pmvcs");
    try {
      mutation.write("fresh/deep/leaf.txt", Buffer.from("portable\n"), 0o644);
      mutation.remove("branch/leaf.txt");
      mutation.prune();
    } finally { mutation.close(); }
    assert.equal(readFileSync(join(repo.root, "fresh/deep/leaf.txt"), "utf8"), "portable\n");
    assert.equal(existsSync(join(repo.root, "branch")), false);
  });
}

test("platform capability probes select paths without directory descriptors or no-follow flags", () => {
  const { repo } = setup();
  assert.equal(worktreeMutationCapabilities.descriptorPaths("win32"), false);
  assert.equal(worktreeMutationCapabilities.descriptorPaths("darwin"), false);
  mock.method(fs, "existsSync", () => false);
  assert.equal(worktreeMutationCapabilities.descriptorPaths("linux"), false);
  assert.equal(worktreeMutationCapabilities.noFollow({}), 0);
  const open = fs.openSync;
  let directoryOpens = 0;
  mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[1] === "number" && (args[1] & fs.constants.O_CREAT) === 0) {
      directoryOpens += 1;
      throw new Error("directory descriptors unavailable");
    }
    return open(...args);
  });
  const mutation = new WorktreeMutation(repo.root, ".pmvcs");
  try {
    mutation.write("fresh/ordinary.txt", Buffer.from("portable\n"), 0o644);
    mutation.remove("branch/leaf.txt");
    mutation.prune();
  } finally { mutation.close(); }
  assert.equal(directoryOpens, 0);
  assert.equal(readFileSync(join(repo.root, "fresh/ordinary.txt"), "utf8"), "portable\n");
});

test("falling back from procfs cannot adopt a concurrently replaced root inode", () => {
  const { repo } = setup();
  mock.method(worktreeMutationCapabilities, "descriptorPaths", () => true);
  const stat = fs.statSync;
  mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    if (String(args[0]).startsWith("/proc/self/fd/")) {
      renameSync(repo.root, join(fixture!.root, "parked-root"));
      mkdirSync(repo.root);
      throw new Error("unavailable");
    }
    return stat(...args);
  });
  assert.throws(() => new WorktreeMutation(repo.root, ".pmvcs"), { code: "worktree_path_changed" });
  assert.equal(readFileSync(join(fixture!.root, "parked-root/branch/leaf.txt"), "utf8"), "sentinel\n");
});


test("store lock cleanup preserves a foreign lock after a successful callback", () => {
  const { repo } = setup();
  const path = join(repo.controlDirectory, "objects.lock");
  assert.throws(() => repo.objects.withWriteLock(/** A replacement lock is never owned by this transaction. */ () => {
    fs.unlinkSync(path);
    writeFileSync(path, "foreign owner");
  }), { code: "worktree_path_changed" });
  assert.equal(readFileSync(path, "utf8"), "foreign owner");
});

test("store lock cleanup preserves a foreign lock and the original root-mutation refusal", () => {
  const { repo, destination, tip } = setup();
  mkdirSync(join(destination, ".pmvcs"));
  writeFileSync(join(destination, ".pmvcs/objects.lock"), "foreign owner");
  betweenSteps = false;
  intercept("open", "leaf.txt", () => {
    renameSync(repo.root, join(fixture!.root, "parked-root"));
    symlinkSync(destination, repo.root, "dir");
  });
  assert.throws(() => repo.restore(["branch/leaf.txt"], tip), { code: "worktree_path_changed" });
  assert.equal(readFileSync(join(destination, ".pmvcs/objects.lock"), "utf8"), "foreign owner");
});
