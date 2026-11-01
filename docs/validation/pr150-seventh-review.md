# PR 150 seventh-review repair

The seventh review of `6a0d4b5` accepted the whole-content equivalence repair and
cubic P1 regression, but reproduced two further gaps. The native-provenance
guarantee is unchanged: native derived copies are removed or an incomplete proof
refuses; user-authored alternate encodings and identifier-only audit facts are
outside that content-removal claim.

## Certified input is the input actually stored

The old descriptor preflight hashed from zero while fixed and CDC writers read
from the caller's cursor. Both writers now take one explicit `startOffset`
(default zero) and consume exactly `[startOffset, startOffset + totalLength)`.
Neither pass consumes the caller's descriptor cursor.

A second physical read can observe an in-place edit even when it uses the right
offset. Preflight therefore commits each 32 KiB block as well as the framed whole
identity. A private disposable file stores only the block checksums, not source
bytes. Publication copies a block into a private bounded buffer, verifies its
checksum, then supplies those same verified bytes to the fixed/CDC writer. A
changed block refuses with `source_changed` before any of its bytes are
published. Previously published matching blocks retain truthful provenance even
if a later block changes or the process crashes. The whole certificate still
precedes the first payload publication.

Checksum metadata is streamed to disk rather than accumulated in an input-sized
array. Descriptor input remains bounded in reachable memory; this is not a new
RSS or default-GC measurement. Buffer convenience methods take an owned snapshot
of already-resident input. Source commitment work checks the native lease and
primary provenance deadline throughout. EOF, zero/partial metadata writes and
cleanup errors have native fault regressions; cleanup never replaces a primary
failure. Ordinary completion removes the checksum directory. A process crash
can leave checksum facts but cannot leave source payload in that directory.

The advanced-descriptor regression covers fixed/CDC, loose/packed and default/
explicit offsets. A 16-history property varies the explicit source offset
independently of the caller cursor, interleaves GC/packing, then checks that no
indexed/native worktree descendant can reconstruct the erased content.

The fixed publisher now uses the commitment reader's complete-fill contract.
Its old second partial-read/EOF loop was unreachable: the only private reader
either fills the requested range or throws `short_read` in `sourceRange`. The
shared native EOF refusal remains tested for source and checksum reads.

## A complete accountability verdict is a fixed point

The old final catalogue check preceded the last file reopens and byte hashes.
Restoring an erased object or pack inside a reopen could escape that check.
The namespace barrier now follows every final reopen/rehash. Certification also
requires two consecutive complete passes with matching directory catalogues,
missing-root sets, file identities and byte hashes. A change discards the prior
pass; eight unsuccessful attempts refuse with typed `unverifiable` and
`bound: storage_attempts`. File/work/time bounds and descriptor cleanup remain
mandatory. If deletion has started, refusal leaves the denial pending.

Both native loose-object and pack restoration tests inject inside the final
receipt-phase reopen. Each must refuse and retain `pending: true`; neither can
publish an accountable completed receipt with the restored copy present.
A separate alternating-generation test proves bounded non-convergence. The
existing replacement-at-every-boundary matrix now covers 64 cells: two passes,
eight boundaries, loose/pack, and clean/foreign replacements. Its original
refusal and preservation assertions remain intact.

Obliteration holds the authoritative object-store lease through verification,
deletion and receipt publication. Every native object/pack writer takes that
lease, so a cooperating pm-vcs writer cannot invalidate an earlier check during
this interval. Direct filesystem writers that ignore the lease are not
serialized. The bounded scan rejects observed changes through its final
namespace barrier, including the reviewed reopen window; it does not promise
perpetual absence against an out-of-protocol writer acting after that barrier.
Standalone internal accountability callers must provide the same lease scope
when they require the native-writer guarantee.

## Input-certification class audit

| Location | Result |
| --- | --- |
| `fragments.ts`: fixed and CDC descriptor writers | Explicit shared byte range; checksum-bound blocks verified before publication; changed bytes refuse. |
| `fragments.ts`: fixed and CDC buffer writers | Hash and fragment the same private snapshot; caller mutations cannot change certified bytes. |
| `objects.ts`: ordinary object writes | Snapshot before identity, denial and provenance checks; `writeRaw` hashes/encodes that owned payload. |
| `objects.ts`: arrivals, hydration and resumed uploads | Snapshot the complete arrival batch; recheck every declared ID against its actual snapshot before any payload storage. Imported unknown origins remain unknown. |
| `managed-exports.ts`: ordinary/signed local exports | Own the produced byte buffer before hashing/registration; publication uses the same snapshot. |
| `worktree-mutation.ts`: native materialization/rendering | Own content before native-output registration and filesystem publication. |
| `manifest-pages.ts` / `model.ts`: native manifests | Encode each metadata node once; the common writer snapshots its buffer. Whole-content identity reads verified native members under the lease. |
| `packs.ts`: compact, unpack, repack and GC survivor rewrites | Fully verified source objects are retained as private buffers; framing, compression and pack hashing consume those same buffers under the store lease. No unverified second source read supplies a previously certified ID. |
| `bundle.ts`: parse/import/unbundle | Parsing decodes and verifies carried payload identities; central arrival snapshots and ID rechecks protect publication, including mutation after earlier validation. Held duplicates are separately verified. |
| `change-bundles.ts`: signed envelopes | The archive is a newly serialized private buffer; manifest digest, signature and encoding consume it. The receiver decodes into owned archive bytes and ultimately uses the checked arrival path. |
| `object-stream.ts` / verified blob readers | These are read APIs, not separate streamed ingestion paths. Stored reader results go through the same snapshot/identity-checked writers. |
| `repo.ts`: staging comparison passes | A newly written manifest must equal the comparison ID before index publication, with a pinned working-file identity check. Retention reuses an existing immutable object rather than filing later-read bytes under an earlier hash. |
| Native JSON controls, refs, journals and receipts | Serialize metadata into owned strings/buffers once. Retained identifiers, paths and one-way hashes are audit facts rather than a new payload encoding. |
| Disposable source-checksum metadata | Fixed-width one-way block hashes only; no recoverable source payload. It grants no recovery/publication authority after process death. |

No ownership classifier, destruction refusal, physical-copy plan, denial guard
or prior equivalence evidence was removed. The complete sixth-review cubic
ledger and its 86 restored behavioral controls remain retained in
[pr150-cubic-triage.md](pr150-cubic-triage.md).

## Validation

The focused runs use isolated non-git fixtures and at most two test workers.
No threshold, ignore directive or ownership refusal changed.

| Gate | Passing evidence |
| --- | --- |
| Node 26 erasure storage, accountability, fragment and legacy repairs | 271/271; the later four final-reopen cells also pass in the 46-case set. |
| Node 26 fixed/CDC fragmentation, staging and review repairs | 187/187; unchanged bounded-memory assertion included. |
| Node 26 and Node 22 final regression selection | 46/46 on each runtime; includes accepted whole-content equivalence and cubic P1 controls. |
| Native Bun provenance | 75/75, including all nine descriptor offset/GC cases. |
| Native Bun reopen/convergence | 6/6. |
| Complete pack/GC and paged-manifest cases | 70/70 and 41/41 passed; the separate fragment-memory failure in that diagnostic cohort was corrected and rerun in the passing 187-case corpus. |
| Packed power loss and recovery | 3/3; 6,247 native boundaries, 538 distinct complete crash images, two convergent replays each. |
| Object/remote/instance/history compatibility | 94/94, plus 14/14 composition edges and 4/4 native publication/recovery races. |
| Final denial/deadline/owner-cleanup gaps | 6/6, also registered and executed through the PM test command. |
| Worktree races | Full run passed 257 unaffected cases; the 20 pruning cases pass after correcting the boundary-specific errno expectation. |
| Touched-module coverage | All five modules: 100% statements, branches, functions and lines; `c8 report --all --check-coverage --100 --per-file` passes. |
| Static and artifacts | Typecheck, lint, zero duplicates (95 sources / 30,221 lines), build and test build pass; docstrings cover 596 declarations; npm artifact privacy scans 340 files with zero findings. |

Full npm/Bun release matrices remain CI work under the seventh-review
instruction. The direct native Bun diagnostic using Node MockTracker faults is
excluded: Bun lacks the required `mock.method`/`mock.restoreAll` implementation.
Those fault tests run on Node 22 and 26; the native Bun counts above exercise the
supported non-mocked paths. No installer timeout was retried. Earlier failed
cohorts are diagnostic evidence, not additional passing-suite counts.

The race-fixture change preserves exact error assertions: between-step pruning
reaches the nonempty-directory refusal (`ENOTEMPTY`), whereas descriptor syscall
substitution reaches the earlier ancestor guard (`worktree_path_changed`). All
fault-injection, sentinel, mode, index and view preservation assertions remain.

Coverage profiles are filtered to current source boundaries. Fragment profiles
come only from the final bounded-buffer source epoch, avoiding same-length
constant changes in earlier diagnostic runs. Every touched module is included
explicitly; the repository-wide CI coverage inventory is unchanged.

Commands use the existing release scripts (`npm run check`, `npm run build`,
`npm run build:test`, `npm run docstring`, `npm run pack:check`) and serial Node
`--test --test-concurrency=1` invocations. Native Bun uses
`bun test --max-concurrency=1 --timeout=600000 test/derivation-provenance.test.ts`
and the final-reopen/convergence selection in `test/erasure-accountability.test.ts`.
The PM item retains the exact 46-case and six-case regression commands.

## Behavioral revert controls

Each row ran in a disposable copy. The indicated behavior was removed, the
named regression failed behaviorally (exit 1), then the fixed source was
restored and the same regression passed (exit 0). Syntax, imports, setup and
timeouts do not count. The partial-checksum-write control produces the native
`short_read` refusal instead of the required successful round trip; the other
27 controls fail an explicit assertion. The 86 sixth-review controls are
retained separately and are not claimed as rerun here.

| Control | Regression selection | Test file | Reverted / restored |
| --- | --- | --- | --- |

| R7-FD | `advanced descriptor / descriptor provenance property` | `test/derivation-provenance.test.ts` | 1 / 0 |
| R7-Reopen | `final reopen.*matching pass 1` | `test/erasure-accountability.test.ts` | 1 / 0 |
| R7-FixedPoint | `two agreeing complete / namespace that never repeats` | `test/erasure-accountability.test.ts` | 1 / 0 |
| R7-PostRehash | `final reopen.*matching pass 2` | `test/erasure-accountability.test.ts` | 1 / 0 |
| R7-BlockCheck | `verified .*source blocks` | `test/review-repair.test.ts` | 1 / 0 |
| R7-BufferSnapshot | `native (fixed / cdc) publication snapshots` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ObjectSnapshot | `native write publication snapshots` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ArrivalSnapshot | `native arrival publication snapshots` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ArrivalIdentity | `arrival publication rejects` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ExportSnapshot | `native export publication snapshots` | `test/review-repair.test.ts` | 1 / 0 |
| R7-WorktreeSnapshot | `native worktree publication snapshots` | `test/review-repair.test.ts` | 1 / 0 |
| R7-OffsetBounds | `invalid explicit source offset` | `test/review-repair.test.ts` | 1 / 0 |
| R7-EOF | `source commitment lifecycle.*proof-short` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ProofPartial | `source commitment lifecycle.*partial-write` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ProofZero | `source commitment lifecycle.*zero-write` | `test/review-repair.test.ts` | 1 / 0 |
| R7-CloseFailure | `source commitment lifecycle.*close-error` | `test/review-repair.test.ts` | 1 / 0 |
| R7-ClosePrimary | `source commitment lifecycle.*source-plus-close` | `test/review-repair.test.ts` | 1 / 0 |
| R7-CleanupFailure | `source commitment lifecycle.*cleanup-error` | `test/review-repair.test.ts` | 1 / 0 |
| R7-CleanupPrimary | `source commitment lifecycle.*(source-plus-cleanup / close-plus-cleanup)` | `test/review-repair.test.ts` | 1 / 0 |
| R7-Deadline | `descriptor commitment work observes` | `test/review-repair.test.ts` | 1 / 0 |
| R7-Lease | `descriptor commitment stops reading` | `test/review-repair.test.ts` | 1 / 0 |
| R7-PureCDCEOF | `streamed CDC identification refuses` | `test/review-repair.test.ts` | 1 / 0 |
| R7-Memory | `writing a file larger than any single buffer` | `test/fragments.test.ts` | 1 / 0 |
| R7-WholeDenied | `completed erasure rejects recertifying` | `test/review-repair.test.ts` | 1 / 0 |
| R7-StoreDeadline | `live store owner outlasting` | `test/review-repair.test.ts` | 1 / 0 |
| R7-RetiredSize | `failed store publication preserves an owner whose size` | `test/review-repair.test.ts` | 1 / 0 |
| R7-RetiredMtime | `failed store publication preserves an owner whose mtime` | `test/review-repair.test.ts` | 1 / 0 |
| R7-RetiredCtime | `failed store publication preserves an owner whose unchanged` | `test/review-repair.test.ts` | 1 / 0 |

All PM writes finish before `changelog:full`, `changelog:check`, staging,
`self-host:write` and the code/tracker/archive commit. The committed HEAD then
runs `accept:self-host`; later tracker changes require a new archive.
