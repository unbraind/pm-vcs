# Quick-fit measurements: pm-vcs

Code head: `4464c113add64c3aa48e4724dd5d72759d46bf2e`. [CI run 43794135980](https://github.com/unbraind/pm-vcs/actions/runs/43794135980).
Jobs API snapshot: 2026-11-16T03:06:25+00:00. All local timing commands use `PM_TEST_DEPTH=quick`; unset/full depth is not run locally.

| Job | Result at snapshot | Created to completion | Queue | Started to completion |
| --- | --- | --- | --- | --- |
| test (26) | in_progress | unfinished | 1s | >= 1219s running |
| test (22) | in_progress | unfinished | 1s | >= 1219s running |
| windows-acceptance-launcher (22) | success | 76s | 1s | 75s |
| windows-acceptance-launcher (26) | success | 98s | 2s | 96s |

Step times are completed wall times from `started_at` to `completed_at`; running values are lower bounds, not completed durations.

| Step | test (26) | test (22) | windows-acceptance-launcher (22) | windows-acceptance-launcher (26) |
| --- | --- | --- | --- | --- |
| Set up job | 3s success | 1s success | 1s success | 1s success |
| Checkout | 17s success | 14s success | 19s success | 21s success |
| Detect code changes | 0s success | 0s success | 0s success | 0s success |
| Setup Node.js | 4s success | 1s success | 7s success | 12s success |
| Setup Bun | 0s success | 1s success | — | — |
| Install dependencies | 4s success | 4s success | 16s success | 14s success |
| Install project pm-github extension | 0s success | 1s success | 2s success | 6s success |
| Verify tracked pm project health | 1s success | 1s success | 2s success | 2s success |
| Check documentation and tracker changes | skipped | skipped | skipped | skipped |
| Engines floor build and quick tests | skipped | >= 1195s running | — | — |
| Quick npm release gate | >= 1189s running | pending | — | — |
| Keep the coverage report when the gate fails | pending | pending | — | — |
| Bun and bunx install smoke | pending | pending | — | — |
| Post Setup Bun | pending | pending | — | — |
| Post Setup Node.js | pending | pending | 1s success | 1s success |
| Post Checkout | pending | pending | 2s success | 2s success |
| Verify the installed PM CLI launcher | — | — | 2s success | 1s success |
| Build Windows storage acceptance | — | — | 1s success | 1s success |
| Verify Windows GC apply on a non-git tracker | — | — | 20s success | 34s success |
| Complete job | — | — | 0s success | 0s success |

## Local focused evidence

The prior quick fixtures were frozen before editing, including their old depth helper. Baseline and revised processes overlapped on a heavily loaded shared host. These are uncontrolled relative measurements; they do not prove a hosted runtime target. A failed watchdog is not a passing baseline. Parent and nested rows may overlap and must not be added.

| Test | Prior quick seconds / result | Revised quick seconds / result |
| --- | --- | --- |
| 512 seeded lifecycle sequences always match an independent accountability model and converge when clean | 982.711 pass | 632.793 pass |
| CLI values, unfiltered unit selection and structural recording refusal have explicit outcomes | 51.271 pass | 107.332 pass |
| EVERY pinned reader boundary tolerates an external retirement with unchanged generation and lock | not measured / not reached / deep-only | 444.993 pass |
| EVERY reader retains relative-construction identity at EVERY maintenance boundary after cwd changes | not measured / not reached / deep-only | 61.630 pass |
| EVERY reader retries from the top or pins its opened handle when each storage transition interrupts resolution | not measured / not reached / deep-only | 113.600 pass |
| EVERY reader x EVERY compact/unpack/repack/GC boundary retains live bytes and never resurrects an erased object | 15.848 pass | 45.869 pass |
| FileId obliteration removes conflict units and all alternatives and prevents their resurrection | 27.312 pass | 53.374 pass |
| SIGKILL at every compact step converges without loss, duplicates or changed live reads | not measured / not reached / deep-only | 48.203 pass |
| a competing process at both retirement boundaries is excluded until the owning erasure releases last | 41.905 pass | 44.475 pass |
| a competing process cannot transition the same tracker at ANY compact boundary; peer reruns report success | not measured / not reached / deep-only | 39.093 pass |
| a pending file cannot transfer deletion authority to a replacement root even when its inode is retained | 10.563 pass | 5.462 pass |
| a pinned packed member refuses truncation without returning neighboring or unverified bytes | not measured / not reached / deep-only | 6.719 pass |
| a retained object retries a retired pack catalog after concurrent GC repacks its survivors | not measured / not reached / deep-only | 10.306 pass |
| benchmark empty stores, directory noise and invocation identity are measured | 4.824 pass | 6.606 pass |
| built and npm-packed SDK10 Node/native Bun consumers and project-installed CLI execute composition and denied merges | 1875.103 pass | 758.688 pass |
| bundle arrivals cannot attach novel field or text conflict roots to an erased FileId | 59.921 pass | 133.373 pass |
| bundle, push/fetch, shallow partial history and GC retain conflicted changes | 82.253 pass | 106.344 pass |
| conflict schemas, tree/index versions and absence envelopes fail closed on malformed inputs | 4.379 pass | 10.304 pass |
| field objects preserve all alternatives, nonoverlapping edits and unresolved metadata across stage and sparse checkout | 74.968 pass | 84.022 pass |
| generation metadata refuses corruption and retries inconsistent snapshots and failed opens without masking stable I/O errors | not measured / not reached / deep-only | 14.492 pass |
| hunk objects store no markers, retain independent work, shift ranges and resolve all hunks | 44.098 pass | 62.421 pass |
| inventory retries catalog errors after transitions and deduplicates a retired physical fallback | not measured / not reached / deep-only | 11.248 pass |
| legacy fail-on-conflict remains isolated and conflicting mode flags refuse before mutation | 26.621 pass | 53.073 pass |
| ordinary text edits preserve adjacent insertions and replacement ranges when a later agent resolves | not measured / not reached / deep-only | 88.853 pass |
| packed CLI resolves literal empty strings, spaces and EOF newlines through the real host | not measured / not reached / deep-only | 401.994 pass |
| packed npm and Bun SDK/CLI JSON/TOON consumers require eligible move sources | 332.659 failure/watchdog | 137.713 pass |
| packed npm and Bun SDK/CLI JSON/TOON consumers require positive snapshot release | 332.624 failure/watchdog | 59.624 pass |
| pending authority is cancelled for retired, missing or replaced roots without following their pathnames | 10.603 pass | 8.935 pass |
| pinned inventory rejects in-place same-size mutation and a directory substituted before pinning | not measured / not reached / deep-only | 4.546 pass |
| pinned inventory survives external unpack with identical generation and writer lock | not measured / not reached / deep-only | 5.964 pass |
| random corpus reads, stable addresses and fragment ranges agree before and after compaction and GC | not measured / not reached / deep-only | 34.245 pass |
| reader surface enumeration classifies every exported operation and prevents omission of a new reader | 0.498 pass | 2.147 pass |
| real PM worktrees: two PM_AUTHOR identities keep working, a third resolves exactly one status unit | 89.673 pass | 123.051 pass |
| recognized loose temporary streams enforce the store's permanent denial before decoding | not measured / not reached / deep-only | 5.524 pass |
| resolution rejects absent selections, dirty state, out-of-view paths and incompatible units | 19.941 pass | 43.752 pass |
| resolve command preserves raw empty and whitespace values before optional JSON decoding | 86.464 pass | 188.186 pass |
| retry exhaustion is typed after exactly eight generations; stable absence is the only not-found result | not measured / not reached / deep-only | 10.863 pass |
| review: a purged dormant instance can be unlinked, removed and pruned before another obliteration | 27.164 pass | 28.152 pass |
| root-bound journals retain strict validation and do not read historical paths or authorize outside roots | 11.008 pass | 8.066 pass |
| streams retain an opened representation across repack and stop between buffered lines after terminal denial | not measured / not reached / deep-only | 11.946 pass |
| the benchmark test runs from a checkout path containing spaces | 600.297 failure/watchdog | not measured / not reached / deep-only |
| the complete benchmark CLI measures real CDC and fixed-size stores | 600.734 failure/watchdog | 600.543 failure/watchdog |
| verify rejects missing sides, corrupt conflict schemas, digest corruption and wrong side kinds | 29.128 pass | 53.625 pass |

Both repositories pass `npm run typecheck`, `npm run build:test`, `npm run lint`, strict workflow YAML parsing and `PM_TEST_DEPTH=quick node --test test/depth.test.ts` (4 tests each). The helper command also passes through `pm test --run --only-last --progress`. Coverage percentages, source scope, product deadlines and CI job ceilings are unchanged. No full-depth certification is claimed.

The actual-injection reader regression passes 1/1 in 149.401s: `PM_TEST_DEPTH=quick node --test --test-name-pattern="retries from the top" test/object-read-protocol.test.ts`. The two extra packed consumers pass 2/2 in 202.366s: `PM_TEST_DEPTH=quick node --test --test-reporter=spec --test-concurrency=1 test/sparse-move-consumer.test.ts test/snapshot-durability-consumer.test.ts`. Entrypoint/worker isolation passes 1/1 in 36.648s; allowlist instrumentation passes 2/2.

The unchanged complete benchmark hit the local 600s harness watchdog. Its retry command is `PM_TEST_DEPTH=quick PM_TEST_TIME_SCALE=3 node --test --test-name-pattern="complete benchmark CLI" test/cdc-benchmark.test.ts`, executed through the PM runner. This scales only the existing harness watchdog; no product contract or job timeout changes. The broad touched-file run has that known local failure and is not claimed passing.

Prior hosted quick bottlenecks: reader resolution 499.434s; composition consumers 247.867s; packed raw-value CLI 238.848s; two benchmarks 209.268s and 190.316s; pending roots 167.850s; lifecycle 147.483s; pinned-reader retirement 123.430s; relative GC crash sweep 118.278s. Next unchanged candidates include generated merge histories (102.111s), seeded root spellings (70.303s), large-history metadata (68.900s), large logical-byte descriptors (68.322s), JSON header repair (58.555s) and other packed conflict-format consumers (57.205s on Node 22). Exact final-run ranking requires completed job logs.

Remaining helper-level lifecycle, fixture and journal power-loss matrices still select 25-cut prefixes in test/helpers/crash-matrix.ts, test/helpers/fixture-crash-matrix.ts and test/helpers/journal-sequences.ts. Converting those to audited named-kind representatives remains follow-up work on the existing CI item; this iteration does not claim every exhaustive family has been retuned.

The scale-3 benchmark retry **passes 1/1 in 1335.744s wall** through the PM runner; the initial unscaled timeout remains recorded above.

The regenerated committed self-host bundle independently verifies against committed source.

Exact revised touched-file command:

```sh
PM_TEST_DEPTH=quick node --test --test-reporter=spec --test-concurrency=2 test/depth.test.ts test/object-read-protocol.test.ts test/cdc-benchmark.test.ts test/composition-consumer.test.ts test/first-class-conflicts.test.ts test/ref-publication-recovery.test.ts test/packs.test.ts test/erasure-lifecycle.test.ts
```

The complete unselected combinations remain in ci-deep. The 15-minute target and unchanged coverage gates require completed hosted quick checks; unfinished or cancelled checks are missing evidence.

The local broad revised command was stopped at the bounded cutoff: 48 passed, one benchmark watchdog failure, and three cancelled files; it is not a passing suite. The reader-resolution matrix passes in 113.600s in that run (the separate 149.401s probe also passed); pinned-reader external retirement passes in 444.993s. The one packed raw-value CLI path passes in 401.994s. Absolute/relative pack sweeps and pending-root model completion remain unverified locally.
