# PR 150 sixth review and cubic triage

All 59 unresolved threads were fetched with every comment and complete `reviewThreads(first:100)` / comment pagination. This is the orchestrator response ledger; no thread was replied to or resolved.

| Thread id | Priority | Classification | Change or reason | Regression / revert evidence |
|---|---|---|---|---|
| `PRRT_kwDOToJT7M6yWzbE` | P1 | fixed | Bind native files to bounded SHA-256 before parsing, before acceptance/purge, and at the final catalogue barrier; ctime is only a fast metadata fence. | erasure-accountability: loose/packed same-tick rewrites after parsing and at the final barrier; R01 |
| `PRRT_kwDOToJT7M6yWzbH` | P2 | fixed | Measured inventory is now 95 production sources; update the inventory assertion. | raw-coverage inventory assertion; R02 |
| `PRRT_kwDOToJT7M6yWzbJ` | P2 | fixed | Run session isolation before child-process imports. | test-environment first-statement audit; R03 |
| `PRRT_kwDOToJT7M6yWzbK` | P2 | fixed | Preserve intent/plan refusal types in plan, prune and unlink; filesystem identity failures retain worktree_path_changed. | review-repair: working-tree plan/prune/remove; R04 |
| `PRRT_kwDOToJT7M6yWzbL` | P2 | follow-up | pm-vcs-provenance-catalog-scale: batch under a publication lease; publishing only after bytes would lose crash provenance. | Scale work is outside this repair; pre-byte ownership remains required. |
| `PRRT_kwDOToJT7M6yWzbM` | P2 | fixed docs | Document pako runtime dependency in README and PR description. | Requirements matches package.json; documentation change. |
| `PRRT_kwDOToJT7M6yWzbN` | P2 | fixed docs | State Windows namespace-flush limitation beside denial-first interruption guarantee. | docs/links-layers-obliteration.md; documentation change. |
| `PRRT_kwDOToJT7M6yWzbP` | P2 | fixed | Resolve prepared publications against the private instance and shared writer control directories as appropriate. | review-repair: linked instance prepared publication; R08 |
| `PRRT_kwDOToJT7M6yWzbQ` | P2 | refuted | Semantic inventory may skip malformed temporaries; full physical planErasureStorage and accountErasureStorage classify every file before denial/deletion and completion. | engine/erasure.ts:229,484 and engine/erasure-accountability.ts:251,254; truncated-prefix/foreign-file refusal and purge corpus prevent corrupt bytes from certifying success. |
| `PRRT_kwDOToJT7M6yWzbR` | P2 | fixed | Retry only a matching incomplete output with exact path/id/birth; preserve foreign replacements. | review-repair: interrupted managed archive; R10 |
| `PRRT_kwDOToJT7M6yWzbS` | P2 | fixed | Flush the existing empty owner edge and directory before publishing dependent payload. | review-repair: EEXIST owner-edge fsync; R11 |
| `PRRT_kwDOToJT7M6yWzbT` | P2 | fixed | Enqueue every native tree/commit/conflict/manifest/series edge without argument spreading. | review-repair: 150000-entry native tree; R12 |
| `PRRT_kwDOToJT7M6yWzbW` | P2 | fixed | Use caller-owned disposable cleanup for benchmark scratch, without namespace receipts. | review-repair: disposable cleanup has no ledger; benchmark fixture; R13 |
| `PRRT_kwDOToJT7M6yWzbX` | P2 | fixed test | Snapshot durable state immediately before and after anonymous fragment refusal. | layer-null-write-attribution-repair refusal-state corpus; R14 |
| `PRRT_kwDOToJT7M6yWzbY` | P2 | fixed test | Pin exact expected refusal per invalid selector/credential/reason/options cell. | destructive-plans invalid-input property; R15 |
| `PRRT_kwDOToJT7M6yWzba` | P2 | obsolete | Current test/composition.test.ts test at partial native owner-write case contains actual RLIMIT subprocess and durable-state assertions. | Existing nonempty partial-owner-write regression; no empty passing body. |
| `PRRT_kwDOToJT7M6yWzbd` | P2 | fixed | Only ESRCH permits recovery; EPERM remains a typed locked refusal. | review-repair: permission-denied PID liveness; R17 |
| `PRRT_kwDOToJT7M6yWzbh` | P2 | fixed | Observational receipt computes absence without writing the purge journal. | review-repair: read-only purge receipt; R18 |
| `PRRT_kwDOToJT7M6yWzbj` | P2 | fixed | Validate composition path before provenance/output writes. | review-repair: invalid native output path preserves metadata; R19 |
| `PRRT_kwDOToJT7M6yWzbk` | P2 | fixed test | Require the named injected crash and assert the boundary actually fired. | destructive-plans valid-input property; R20 |
| `PRRT_kwDOToJT7M6yWzbm` | P2 | fixed test | Assert acquired-handle fault injection in every error/abort soak operation. | object-lifetime low-FD soak; R21 |
| `PRRT_kwDOToJT7M6yWzbn` | P2 | follow-up | pm-vcs-disposable-cleanup-contracts: installer temporary cleanup and primary-error preservation. | General installer lifecycle, outside pack/erasure/provenance repair. |
| `PRRT_kwDOToJT7M6yWzbq` | P2 | fixed | Translate only exclusive-exists/path-owned errors; preserve corrupt metadata and store refusals. | change-bundles: CLI corrupt export registry; R23 |
| `PRRT_kwDOToJT7M6yWzbs` | P2 | follow-up | pm-vcs-disposable-cleanup-contracts: privacy-tool disposable cleanup and receipt retention. | General validation-tool lifecycle; gate-owned outer roots already bound this run. |
| `PRRT_kwDOToJT7M6yWzbu` | P2 | fixed | Stop live children with bounded TERM/KILL escalation and await close. | fixture-lifetime: actively stops a registered live child; R25 |
| `PRRT_kwDOToJT7M6yWzbx` | P2 | fixed test | Assert durable state remains unchanged after standalone manifest attribution refusal. | layer-null-write-attribution-repair refusal-state corpus; R26 |
| `PRRT_kwDOToJT7M6yWzb3` | P2 | fixed test | Require a nonempty bitmap and retain its exact bytes after erasure. | erasure-storage: native destruction checkpoints/progress; R27 |
| `PRRT_kwDOToJT7M6yWzb6` | P2 | fixed test | Match obliterate explicitly; unknown worker actions fail before mutation. | review-repair: pack helper typo preserves asset/denials; R28 |
| `PRRT_kwDOToJT7M6yWzb7` | P2 | fixed test | Measure completed reads; unexpected EMFILE fails child execution instead of printing a constant. | object-lifetime low-FD soak measured receipt; R29 |
| `PRRT_kwDOToJT7M6yWzb_` | P2 | fixed | Reject symlink/non-directory, wrong-owner and group/world-writable namespace ledgers. | review-repair: shared-writable external ledger preserves victim; R30 |
| `PRRT_kwDOToJT7M6yWzcC` | P2 | fixed | Closed owner fd getter refuses; preserve it through loose and packed location wrappers. | review-repair: raw/loose/packed stale handle and live replacement; R31 |
| `PRRT_kwDOToJT7M6yWzcF` | P2 | follow-up | pm-vcs-disposable-cleanup-contracts: preserve original fetch error when staging cleanup fails. | General transport cleanup lifecycle outside this repair. |
| `PRRT_kwDOToJT7M6yWzcI` | P2 | fixed | Dispose failed fragment output without a new retirement ledger or masking the primary error. | review-repair: fragment length mismatch plus cleanup EACCES; R33 |
| `PRRT_kwDOToJT7M6yWzcJ` | P2 | fixed test | Always remove the fixture in finally after handle assertions. | path-identity teardown safety; R34 |
| `PRRT_kwDOToJT7M6yWzcL` | P2 | obsolete | 8ee69ad replaced the former eight-node claim with memoized composition and explicit 256MiB logical/512MiB cache bounds. | engine/erasure-provenance.ts and validation repair documentation; current comment matches bounds. |
| `PRRT_kwDOToJT7M6yWzcO` | P2 | fixed test | Use the 1-based post-unlink crash count. | journal-durability: interrupted ref retirement; R36 |
| `PRRT_kwDOToJT7M6yWzcQ` | P2 | fixed test | Treat default open mode as read-only; require writable mode on every file fsync and at least one. | durability: Windows writable metadata flushes; R37 |
| `PRRT_kwDOToJT7M6yWzcR` | P2 | fixed test | Audit actual fs imports, namespace/default receivers and named aliases, including async methods. | durability policy AST negative corpus with allowed backend wrapper; R38 |
| `PRRT_kwDOToJT7M6yWzcT` | P2 | fixed test | Require VerificationRefusal for exhausted primary receipt budgets. | process-marker-accounting orphan cleanup budget; R39 |
| `PRRT_kwDOToJT7M6yWzcU` | P2 | fixed | Whole identity hashing is mandatory; buffer raw denial digests are conditional on denials, while descriptor inputs share one identity/denial prepass. | fixed/CDC buffer and file corpus plus equivalence-through-GC; R40 |
| `PRRT_kwDOToJT7M6yWzcW` | P2 | follow-up | pm-vcs-disposable-cleanup-contracts: bisect scratch cleanup cost and lifecycle. | General bisect scratch API outside pack/erasure/provenance repair. |
| `PRRT_kwDOToJT7M6yWzcX` | P2 | follow-up | pm-vcs-verification-contracts: checkpoint-specific refusal/remedy compatibility. | General checkpoint SDK contract; current verifier still fails closed. |
| `PRRT_kwDOToJT7M6yWzcZ` | P2 | fixed test | Default global/system git configuration isolation; preserve explicit fixture overrides. | test-environment allowlist must-allow/must-refuse corpus; R43 |
| `PRRT_kwDOToJT7M6yWzca` | P2 | fixed docs | Qualify measured memory bound by V8 flag and measured category; no default-runtime/RSS claim. | docs/validation/pr150-ci-repair.md; documentation change. |
| `PRRT_kwDOToJT7M6yWzcc` | P2 | fixed test | Resolve lexical option/env bindings, including uninitialized shadows and two-argument options; audit both core import spellings. | test-environment AST negative and positive corpus; R45 |
| `PRRT_kwDOToJT7M6yWzcd` | P2 | clarified contract | Supplied internal locations remain caller-owned until first next; public store iterators acquire lazily. Callers must close an unstarted supplied location. | engine/object-stream.ts documented ownership; review-repair unopened public iterator has no fd. |
| `PRRT_kwDOToJT7M6yWzce` | P2 | follow-up | pm-vcs-disposable-cleanup-contracts: self-host temporary cleanup and external ledger lifetime. | General self-host tooling lifecycle; gate-owned outer roots bound validation artifacts. |
| `PRRT_kwDOToJT7M6yWzcf` | P2 | fixed test | Pin EACCES/foreign_destructive_intent/destructive_operation_pending per fault and exact receipt size. | destruction: native deletion/progress storage fault matrix; R48 |
| `PRRT_kwDOToJT7M6yWzcg` | P2 | fixed test | Pin source/destination lifetime and foreign archive refusal codes. | destruction: journal publication ownership matrix; R49 |
| `PRRT_kwDOToJT7M6yWzch` | P2 | fixed | Recognize absolute and cross-drive external export projections. | review-repair: cross-drive and absolute projections write external bytes; R50 |
| `PRRT_kwDOToJT7M6yWzci` | P3 | follow-up | pm-vcs-disposable-cleanup-contracts: separate remove(force) API contract from persistent retirement. | General durability API compatibility outside this repair; ownership guards stay unchanged. |
| `PRRT_kwDOToJT7M6yWzcj` | P3 | fixed docs | Qualify unverifiable as the default, before explicitly authorized purge. | docs/links-layers-obliteration.md; documentation change. |
| `PRRT_kwDOToJT7M6yWzck` | P3 | follow-up | pm-vcs-verification-contracts: distinguish attempted checks from successful verifications. | General verify-result accounting outside this repair. |
| `PRRT_kwDOToJT7M6yWzcl` | P3 | fixed test title | Describe injected ENOTEMPTY accurately. | fixture-lifetime synthetic native-fault regression unchanged. |
| `PRRT_kwDOToJT7M6yWzcm` | P3 | fixed test | Use high PRNG bits for choices, shuffle, instance and injected payload. | 512-seed independent lifecycle model; generator diversity assertion; R55 |
| `PRRT_kwDOToJT7M6yWzcn` | P3 | follow-up | pm-vcs-provenance-catalog-scale: cache denials only under proven generation/lease fences. | Removing refresh unconditionally can hide a newly published denial; optimize with ownership proof. |
| `PRRT_kwDOToJT7M6yWzcp` | P3 | fixed test | Discard duplicate worker coverage explicitly. | test-environment child-env audit and serve-worker corpus; R57 |
| `PRRT_kwDOToJT7M6yWzcr` | P3 | fixed test | Map literal next=null to actual null for deletion CAS. | review-repair: real ref helper deletion; R58 |
| `PRRT_kwDOToJT7M6yWzct` | P3 | fixed test | Discard duplicate served-sync worker coverage explicitly. | test-environment child-env audit and served-sync corpus; R59 |

Classification totals: **45 fixed (including documentation and test corrections), 10 follow-up, 2 obsolete, 1 refuted, 1 clarified contract**. The 10 follow-up threads are grouped in `pm-vcs-disposable-cleanup-contracts`, `pm-vcs-verification-contracts` and the existing `pm-vcs-provenance-catalog-scale`. All items remain open for orchestrator verification.


## Behavioral revert controls for this round

Each control ran in a disposable package copy. Only the named changed behavior
was removed; its selected behavioral test failed, then passed after restoration.
A timeout, compiler/import failure or setup failure is not a valid control.
R12 is the native argument-stack failure from the restored spread operation; all
other groups assert an observable output, refusal, state, lifetime or fault.
The table records independent mutation groups, not a sum of overlapping tests.

The exact selection command is `node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-name-pattern="<selection>" <file>`.

| Control | Behavioral selection | File | Mutant / restored exit |
| --- | --- | --- | --- |
| R01 | `in-place rewrite` | `test/erasure-accountability.test.ts` | 1 / 0 |
| EQ-loose-packed | `whole-content equivalence survives` | `test/derivation-provenance.test.ts` | 1 / 0 |
| R04 | `working-tree .* preserves typed` | `test/review-repair.test.ts` | 1 / 0 |
| R08 | `prepared publications in linked` | `test/review-repair.test.ts` | 1 / 0 |
| R10 | `managed archive retries` | `test/review-repair.test.ts` | 1 / 0 |
| R11 | `existing empty payload-owner` | `test/review-repair.test.ts` | 1 / 0 |
| R17 | `permission-denied PID` | `test/review-repair.test.ts` | 1 / 0 |
| R18 | `observational purge receipts` | `test/review-repair.test.ts` | 1 / 0 |
| R19 | `native output paths are validated` | `test/review-repair.test.ts` | 1 / 0 |
| R23 | `CLI handlers use explicit` | `test/change-bundles.test.ts` | 1 / 0 |
| R25 | `actively stops a registered live child` | `test/fixture-lifetime.test.ts` | 1 / 0 |
| R28 | `pack helper rejects unknown` | `test/review-repair.test.ts` | 1 / 0 |
| R30 | `shared-writable external` | `test/review-repair.test.ts` | 1 / 0 |
| R31 | `closed raw, loose and packed` | `test/review-repair.test.ts` | 1 / 0 |
| R33 | `disposable cleanup leaves` | `test/review-repair.test.ts` | 1 / 0 |
| R43 | `child allowlist drops` | `test/test-environment.test.ts` | 1 / 0 |
| R50 | `cross-drive and absolute` | `test/review-repair.test.ts` | 1 / 0 |
| R58 | `pack helper rejects unknown` | `test/review-repair.test.ts` | 1 / 0 |
| EQ-GC | `equivalence-through-GC` | `test/derivation-provenance.test.ts` | 1 / 0 |
| R02 | `production coverage contains` | `test/raw-coverage.test.ts` | 1 / 0 |
| R03 | `all test entrypoints` | `test/test-environment.test.ts` | 1 / 0 |
| R13 | `benchmark scratch cleanup` | `test/review-repair.test.ts` | 1 / 0 |
| R14 | `post-erasure fixed-buffer` | `test/layer-null-write-attribution-repair.test.ts` | 1 / 0 |
| R15 | `all invalid selector credential` | `test/destructive-plans.test.ts` | 1 / 0 |
| R20 | `valid identities across every` | `test/destructive-plans.test.ts` | 1 / 0 |
| R36 | `interrupted ref retirement resolves` | `test/journal-durability.test.ts` | 1 / 0 |
| R37 | `metadata durability opens writable` | `test/durability.test.ts` | 1 / 0 |
| R38 | `all production fsync` | `test/durability.test.ts` | 1 / 0 |
| R39 | `orphan process-stage cleanup preserves` | `test/process-marker-accounting.test.ts` | 1 / 0 |
| R40 | `native buffer fragments hash whole identity` | `test/review-repair.test.ts` | 1 / 0 |
| R45 | `all test entrypoints` | `test/test-environment.test.ts` | 1 / 0 |
| R48 | `native deletion and progress-storage` | `test/destruction.test.ts` | 1 / 0 |
| R49 | `journal publication verifies both` | `test/destruction.test.ts` | 1 / 0 |
| R57 | `all test entrypoints` | `test/test-environment.test.ts` | 1 / 0 |
| R59 | `all test entrypoints` | `test/test-environment.test.ts` | 1 / 0 |
| R34 | `path-identity fixture cleanup` | `test/fixture-lifetime.test.ts` | 1 / 0 |
| R55 | `lifecycle generator explores every` | `test/erasure-lifecycle.test.ts` | 1 / 0 |
| R26 | `standalone manifest refuses denied` | `test/layer-null-write-attribution-repair.test.ts` | 1 / 0 |
| R27 | `erasure retains native destruction checkpoints` | `test/erasure-storage.test.ts` | 1 / 0 |
| R21 | `10,000 sequential reads` | `test/object-lifetime.test.ts` | 1 / 0 |
| R29 | `10,000 sequential reads` | `test/object-lifetime.test.ts` | 1 / 0 |
| R12 | `valid wide tree` | `test/review-repair.test.ts` | 1 / 0 |
| EQ-late | `whole blob created after GC` | `test/derivation-provenance.test.ts` | 1 / 0 |
| OWN-equivalence | `independent whole-equivalent` | `test/derivation-provenance.test.ts` | 1 / 0 |
| R45-scope | `all test entrypoints` | `test/test-environment.test.ts` | 1 / 0 |
| R45-bare | `all test entrypoints` | `test/test-environment.test.ts` | 1 / 0 |
| CG01 | `invalid direct payload` | `test/review-repair.test.ts` | 1 / 0 |
| CG02 | `pending erasure refuses both` | `test/review-repair.test.ts` | 1 / 0 |
| CG03 | `fragment restore writes every` | `test/review-repair.test.ts` | 1 / 0 |
| CG04 | `nested whole-content producers` | `test/review-repair.test.ts` | 1 / 0 |
| CG05 | `erasure native control classifiers` | `test/review-repair.test.ts` | 1 / 0 |
| CG06 | `erasure native control classifiers` | `test/review-repair.test.ts` | 1 / 0 |
| CG07 | `erasure native control classifiers` | `test/review-repair.test.ts` | 1 / 0 |
| CG08 | `erasure lease audit classification` | `test/review-repair.test.ts` | 1 / 0 |
| CG09 | `erasure lease audit classification` | `test/review-repair.test.ts` | 1 / 0 |
| CG10 | `erasure audit reports bounded raw` | `test/review-repair.test.ts` | 1 / 0 |
| CG11 | `erasure audit reports bounded raw` | `test/review-repair.test.ts` | 1 / 0 |
| CG12 | `erasure raw diagnostic I/O` | `test/review-repair.test.ts` | 1 / 0 |
| CG13 | `legacy managed export ownership` | `test/review-repair.test.ts` | 1 / 0 |
| CG14 | `native destruction classification` | `test/review-repair.test.ts` | 1 / 0 |
| CG15 | `native retirement hashes` | `test/review-repair.test.ts` | 1 / 0 |
| CG16 | `exclusive native publication refuses` | `test/review-repair.test.ts` | 1 / 0 |
| CG17 | `native process leases bound` | `test/review-repair.test.ts` | 1 / 0 |
| CG18 | `native process lease bootstrap` | `test/review-repair.test.ts` | 1 / 0 |
| CG19 | `native process leases recover` | `test/review-repair.test.ts` | 1 / 0 |
| CG20 | `native dead-owner retirement propagates` | `test/review-repair.test.ts` | 1 / 0 |
| CG21 | `opaque imported manifest` | `test/review-repair.test.ts` | 1 / 0 |
| CG22 | `bounded reads reject a compressed` | `test/review-repair.test.ts` | 1 / 0 |
| CG23 | `semantic compaction inventory retains` | `test/review-repair.test.ts` | 1 / 0 |
| CG24 | `namespace recovery refuses a non-publication` | `test/destruction.test.ts` | 1 / 0 |
| CG25 | `namespace recovery fences` | `test/destruction.test.ts` | 1 / 0 |
| CG26 | `namespace publication refuses its fresh` | `test/destruction.test.ts` | 1 / 0 |
| CG27 | `namespace publication refuses its completed` | `test/destruction.test.ts` | 1 / 0 |
| CG28 | `namespace publication refuses its recovering` | `test/destruction.test.ts` | 1 / 0 |
| CG29 | `namespace root inspection honors` | `test/destruction.test.ts` | 1 / 0 |
| CG30 | `empty-directory recovery preserves completed` | `test/destruction.test.ts` | 1 / 0 |
| CG31 | `native process lock control` | `test/review-repair.test.ts` | 1 / 0 |
| CG32 | `erasure refuses a lease directory` | `test/review-repair.test.ts` | 1 / 0 |
| CG33 | `native operation-log stages` | `test/review-repair.test.ts` | 1 / 0 |
| CG34 | `legacy managed export ownership` | `test/review-repair.test.ts` | 1 / 0 |
| CG35 | `purge candidates are current` | `test/erasure-accountability.test.ts` | 1 / 0 |
| CG36 | `root withdrawn during purge publication` | `test/erasure-accountability.test.ts` | 1 / 0 |
| CG37 | `legacy whole-content producers` | `test/derivation-provenance.test.ts` | 1 / 0 |
| CG38 | `legacy whole-content producers` | `test/derivation-provenance.test.ts` | 1 / 0 |
| EQ-typed | `typed whole-payload equivalence` | `test/derivation-provenance.test.ts` | 1 / 0 |
| CG39 | `unrecognized empty lease` | `test/review-repair.test.ts` | 1 / 0 |
