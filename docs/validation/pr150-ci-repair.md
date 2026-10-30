# PR 150 CI repair

The source-head report for `dee3155` in CI run `40949021532` identified the
following uncovered branch records. Thresholds remain 100% per file across all
four dimensions. Every case below uses real native storage outside Git. Faults
are restricted to an explicitly owned source, destination, descriptor or receipt.

| Original source line | Behavior and regression in `test/publication-faults.test.ts` |
| --- | --- |
| `engine/destruction.ts:482` | Cancellation refuses both a replaced and a vanished destination; the original source and peer value remain intact. |
| `engine/destruction.ts:543` | A missing fresh source cannot adopt a receipt for another source or another destination. |
| `engine/destruction.ts:575` (two records) | Recovery propagates native I/O errors, other typed refusals, pending target changes and receipt-checkpoint interruption. |
| `engine/destruction.ts:597` | Cancelled-publication cleanup preserves native and typed failures, including interruption after retirement, and converges on retry. |
| `engine/destruction.ts:637` | Recovery with no ledger preserves an ordinary file without creating authority. |
| `engine/destruction.ts:658` | Intent-reading I/O failure propagates; inventory cannot claim a complete root set. |
| `engine/destruction.ts:666` | Progress-reading I/O failure propagates independently of intent reading. |
| `engine/destruction.ts:668` | An absent prepared source contributes no pending root and leaves the current ref unchanged. |
| `engine/publication.ts:47` | Ordinary destinations do not open a missing source as native root metadata. |
| `engine/refs.ts:244` (two records) | Malformed HEAD predicates and duplicate literal HEAD destinations refuse before recovery or mutation. |
| `engine/refs.ts:279` | An absent predecessor or a recovered peer value cannot satisfy a fresh HEAD CAS. |
| `engine/refs.ts:329` | Permissive enumeration skips an unreadable leaf and retains readable peers; strict enumeration refuses the incomplete read. |
| `engine/repo.ts:646` | Index-owner inspection errors propagate and release the original lock; a status-cache recovery that observes a newer index returns without overwriting it. |

Two nullable fallbacks have no reachable behavior:

- In HEAD recovery, reaching the second comparison means the first normalized
  predecessor equals `head.expected`, which is always a string. A nullish
  predecessor cannot satisfy that comparison. Normalize the predecessor once
  and reuse it, removing the second, unreachable nullish alternative.
- A detached `HeadState` always has a complete target. Every `advanceHead` caller
  derives its expected value from an existing target: commit's parent, merge's
  current tip, resolve's current target, replay's checked target, or reset's
  current target. The null case belongs to an unborn symbolic branch, which
  returns through the branch arm. Remove only the detached null-to-undefined
  fallback.

V8 also reported the closing whitespace of the index catch as an uncovered
branch: that catch either returned false or threw, so it could never fall
through. Let only the changed-index case finish the catch and return false after
`finally`. Success still returns true, native errors still throw, and cleanup
still precedes every result. The two index regressions exercise both outcomes.

## Previously implemented issue fixes retained

- **158:** `6b6c002` recognizes only schema- and identity-verified native process
  markers during erasure; drains abandoned process staging under its owner
  lease; deduplicates the erasure operation while holding the log lease; and
  recovers original staging-directory retirement receipts. Unknown and replaced
  entries still refuse. The power-loss fixture separately preserves logical
  mtime across namespace-only alias changes: restoration's private byte copy
  must not invent a content write. Regressions include real SIGKILL at the
  stage/owner/log boundaries, original-directory cleanup, acknowledged packed
  recovery and the complete lifecycle/power-loss matrices.
- **151:** `aee95e4` settles explicitly owned tasks, child close and watcher close
  before asynchronous, bounded native removal. Annotation uses foreground SDK
  refresh, avoiding detached fixture work. Transient ENOTEMPTY and permanent
  failures remain distinct and tested; this is lifecycle coordination with
  bounded removal, not an assertion retry.
- **154:** `b412ea5` gives npm and Bun separate owned scratch roots and removes
  exactly that root on success or failure. Native namespace audit receipts live
  outside each repository and previously accumulated between gates. `a06d928`
  adds byte/inode and owned-root/coverage measurements. Executable workflow
  tests preserve unrelated runner and outside sentinels and retain the original
  exit status, including when diagnostics fail. The historical runner log does
  not establish whether bytes or inodes were exhausted; that attribution remains
  separate from the independently proven scratch-lifetime defect.

Behavioral mutations run only in disposable source copies. Each original is
restored in `finally`, then its regression is rerun. The pm feature item records
individual commands, failing mutations and restored passes. The release gate
runs the complete existing matrices with one test worker, sequentially through
npm and Bun, using isolated Git identity and separate scratch roots.

## Isolated revert results

All twenty mutations fail with exit 1; each restored regression passes with
exit 0 and exactly one executed test. The first fifteen cover the fault/edge
cases above (HEAD validation has independent malformed and duplicate reverts).
The remaining five recheck native erasure ownership, restored logical mtime,
transient ENOTEMPTY handling, resource settlement and gate scratch ownership.
Failures include the expected native/typed exception as well as assertion
failures; no syntax/build failure is counted as a revert proof. Exact commands
and per-mutation outcomes are recorded on `pm-vcs-phase6packs`.
