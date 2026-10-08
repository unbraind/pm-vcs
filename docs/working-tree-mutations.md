# Working-tree mutation protection

`WorktreeMutation` is shared by tree materialization, file restore and empty-directory
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
and higher-level callers retain their existing ref/rollback semantics.

## Validation boundary

The shared deterministic race suite exercises materialize, restore and prune against
both strategies, including ancestor and leaf swaps into outside or nested control state,
ordinary inode replacement, missing/type-changing directories and hardlink isolation.
It also runs with portable `O_NOFOLLOW` disabled to exercise the Windows flag boundary.
Linux additionally retains the original swaps inside the final syscall boundary, where
descriptor pinning protects the destination. These final-gap tests are not claimed as
portable protection. Capability simulation on Linux does not establish native macOS or
Windows execution; Windows launcher CI alone does not establish engine coverage.

The behavioral revert proof disables only the portable ancestor/leaf identity checks,
leaving descriptor pinning, exclusive creation and non-recursive deletion intact. The
unchanged portable race cases must fail, while the restored suite and Linux scenarios
pass. Release checks retain the all-source coverage denominator and four 100% thresholds.

Revert receipt for this change: temporarily insert `if (!this.pinned) return;` at the
start of `verify` and `verifyLeaf`, leaving the tests unchanged, and run:

```sh
node --test --test-name-pattern='^portable' test/worktree-races.test.ts
node --test --test-name-pattern='pinned: syscall' test/worktree-races.test.ts
```

The first command exits 1 with 50 passing and 20 failing cases; the second exits 0 with
35 passing cases. Both have zero skips. Restoring the source byte-for-byte and running
`node --test test/worktree-races.test.ts` passes the entire matrix. No revert is retained
in the implementation. The final matrix contains 35 scenarios in each of four runs
(pinned between steps, pinned syscall boundary, portable, portable without `O_NOFOLLOW`)
and four capability/selection cases.
