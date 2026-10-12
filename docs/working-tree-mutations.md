# Working-tree mutation protection

`WorktreeMutation` is shared by tree materialization, file restore, sparse-view widening
and narrowing, private layers, repository links, physical erasure and empty-directory
pruning. Before mutation it records the device/inode identities of the root and every
ordinary directory in the initial worktree topology, excluding control and always-pruned
subtrees. New directories are recorded immediately after exclusive creation. Existing
symlinks are never captured as directories. An identity mismatch, disappearance or type
replacement raises the typed `worktree_path_changed` refusal.

## Strategy selection

On Linux, when procfs exists and the root descriptor path resolves to the captured
root inode, directory descriptors remain open throughout the mutation. Children are
addressed through `/proc/self/fd/<fd>`, retaining the original directory even if its
pathname is replaced after the last check. This preserves descriptor-pinned protection
against redirection through swapped ancestor pathnames. It does not prevent an actor
from directly moving an already opened inode elsewhere, just as `openat` would not.

On macOS, Windows and Linux without usable procfs, directory operations use ordinary
paths. No directory descriptors are required. The injectable
`worktreeMutationCapabilities.descriptorPaths` probe permits this strategy to be tested
on Linux; a missing, restricted or identity-mismatched procfs backend also selects it.

## Portable fallback

Every captured ancestor, starting with the worktree root, is rechecked with `lstat`
immediately before and after each `mkdir`, file `open`, descriptor write, descriptor
chmod, `unlink` and `rmdir`. Directory identity checks reject symlinks as well as ordinary
directory replacements. Existing leaves are verified again before unlink and their
absence is checked afterward. Removed directories must also remain absent afterward.

Files are replaced by unlinking the old leaf and exclusively creating a new inode with
`O_CREAT | O_EXCL | O_NOFOLLOW` where `O_NOFOLLOW` is supported. On Windows that flag is
unavailable: a no-follow `lstat` checks that the leaf is absent immediately before open,
and `fstat` of the new descriptor must match a non-symlink `lstat` of the leaf immediately
afterward. The same leaf identity checks bracket write and chmod on every platform.
Content and mode changes use the file descriptor, so replacing the leaf cannot redirect
them to a symlink target. Replacing a hardlink also creates a new inode instead of
changing its outside alias. Deletions use only non-recursive `unlink` and `rmdir`.

The portable checks narrow but cannot fully close the race between the final verification
and a pathname syscall: Node has no `openat` API. An ancestor swapped in this interval
can redirect a mkdir, open, unlink or rmdir before the next verification detects it.
The fallback therefore detects observable replacements between steps and refuses, but
does not provide the Linux descriptor-pinned guarantee against syscall-boundary swaps.
It is not an atomic transaction or a filesystem sandbox. A refusal may leave partially
changed files; materialize and restore do not publish their replacement index on refusal,
and higher-level callers retain their existing ref/rollback semantics. Sparse-view changes
finish file mutations and pruning before recording the replacement view and sparse index,
so a mutation refusal, including pruning, retains the previous view and index.

## Validation boundary

The shared deterministic race suite exercises materialize, restore, prune and sparse-view
widening and narrowing against both strategies, including ancestor and leaf swaps into
outside or nested control state, ordinary inode replacement, missing/type-changing
directories and hardlink isolation.
It also runs with portable `O_NOFOLLOW` disabled to exercise the Windows flag boundary.
Linux additionally retains the original swaps inside the final syscall boundary, where
descriptor pinning protects the destination. These final-gap tests are not claimed as
portable protection. Capability simulation on Linux does not establish native macOS or
Windows execution; Windows launcher CI alone does not establish engine coverage.

The behavioral revert proof disables only the portable ancestor/leaf identity checks,
leaving descriptor pinning, exclusive creation and non-recursive deletion intact. The
unchanged portable race cases must fail, while the restored suite and Linux scenarios
pass. Release checks retain the all-source coverage denominator and four 100% thresholds.

Historical PR 96 revert receipt: temporarily insert `if (!this.pinned) return;` at the
start of `verify` and `verifyLeaf`, leaving the tests unchanged, and run:

```sh
node --test --test-name-pattern='^portable' test/worktree-races.test.ts
node --test --test-name-pattern='pinned: syscall' test/worktree-races.test.ts
```

At that revision the first command exited 1 with 50 passing and 20 failing cases; the
second exited 0 with 35 passing cases, both with zero skips. These counts describe the
historical matrix, not later additions. No revert is retained in the implementation.
The current matrix passes 266 tests: 65 scenarios in each of four runs
(pinned between steps, pinned syscall boundary, portable, portable without `O_NOFOLLOW`)
and six capability/selection and lock-cleanup cases.

Revert receipt for the sparse-view coverage: restore only the path-based apply loop of
`Repository.setView` — `rmSync`, recursive `mkdirSync`, `writeFileSync` and `chmodSync`
with pathname pruning — leaving the tests unchanged, and run:

```sh
node --test --test-name-pattern=setView test/worktree-races.test.ts
```

The command exits 1 with 0 passing and 40 failing cases: the path-based widening
succeeds through the swapped ancestor and overwrites the outside or control sentinel,
while the path-based narrowing deletes it. Restoring the boundary-routed `setView`
passes all 40 cases across the same four runs, each refusal leaving the recorded view
and index untouched. Reverting only the pruning-before-publication change to `setView`
also makes this command fail: 24 pass and 16 fail because widening and narrowing
pruning refusals have already recorded the replacement view and sparse index.
