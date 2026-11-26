# Fleet CI v2

PRs and manual dispatch run the quick tier. Required check names remain
`test (22)`, `test (26)`, `windows-acceptance-launcher (22)` and
`windows-acceptance-launcher (26)`. Linux checks use GitHub-hosted Ubuntu;
the Windows checks retain Windows because they verify native launcher, GC and
root-case contracts. Superseded PR runs cancel. Linux shard and release jobs time out at 22 minutes;
Windows jobs at 15 minutes. These are initial bounds pending PR measurements.

| Check or contract | PR Node 22 | PR Node 26 | Deep Node 22/26 × npm/Bun |
| --- | --- | --- | --- |
| npm ci, merge-driver preparation, pinned project extension | yes | yes | every job |
| Strict tracker health, required merge drivers | yes | yes | every job |
| Build and test compilation | yes | yes, in release gate | full release gate |
| Test suite, seeded properties, crash/recovery matrices, representative packed Node consumers | quick | quick, via coverage | full release gate |
| Typecheck, lint, duplication and docstring gates | — | yes | full release gate |
| Per-file coverage, unchanged 100% thresholds and source scope | — | quick | full |
| Native TOON installed CLI acceptance | — | yes | full release gate |
| Stat-cache installed CLI acceptance | — | yes | full release gate |
| Committed self-host bundle hash/import/source equality | — | yes | full release gate |
| Production dependency audit and Git identity audit | — | yes | full release gate |
| Pack dry-run and pack privacy check | — | yes | full release gate |
| Changelog consistency | — | yes | full release gate |
| Release changelog date and publish attestation | — | yes | full release gate |
| Bun graph installation and bunx ephemeral PM launcher | — | yes | graph install every job; bunx smoke in PR tier |
| Native Bun tracker-lenses and change-bundles tests | — | — | both Bun jobs |
| Windows installed PM launcher and native GC/root-case storage tests | separate Windows 22 job | separate Windows 26 job | retained in PR tier |
| Failure coverage artifact, seven-day retention | on failure | on failure | on failure, unique matrix names |
| CodeQL analysis | separate workflow for matching paths | separate workflow for matching paths | weekly scan also covers ignored paths |

Every changed path selects code CI, including README-only, docs-only and
tracker-only changes. `test/composition-consumer.test.ts` reads the shipped docs;
`test/packs.test.ts` benchmarks the real tracker, including its data files.
The self-host gate consumes every committed path except its explicit manifest
exclusions. There are therefore no inert data exclusions. Both Linux and Windows
detectors compare actual PR base/head endpoints with NUL-delimited paths and
rename folding disabled. Manual dispatch always selects code CI. Only an empty
PR diff retains the fallback dependency setup, health, changelog and Linux
source-input gates. The pinned pm-github install remains prerequisite setup for
strict health in a fresh checkout.

Node 26 runs all release-gate components in parallel at `PM_TEST_DEPTH=quick`: non-coverage commands and exactly merged coverage shards.
Node 22 runs build, test compilation and quick test shards, with no separate coverage, changelog or packing step. Some tests themselves pack consumers; those
assertions remain. Deep packed acceptance runs native Bun consumers but installs
archives using npm and the PM CLI; it does **not** prove Bun installer or bunx
installation paths. An explicit `bun install --no-save` and pinned bunx PM version
smoke cover those paths without another release gate.

The self-host gate stays in the PR release gate because it guards shipped VCS
object hashing, import and committed source equality. Depth does not weaken its
archive verification. After source, docs, tests and tracker changes are staged,
run `npm run self-host:write -- --staged`, stage `selfhost.bundle` and commit
it with those changes.
Verification never regenerates it.

Deep runs on main pushes, daily at 02:53 UTC and manual dispatch. Release cron
remains 03:23 UTC; weekly CodeQL remains Monday 06:17 UTC. Distinct checks are
`deep (22, npm)`, `deep (22, bun)`, `deep (26, npm)` and `deep (26, bun)`.
Every gate has its own job and scratch namespace, with the original 20 GiB
preflight, byte/inode reporting and owned-directory cleanup. One gate per job
removes the sequential npm/Bun accumulation implicated in [#154](https://github.com/unbraind/pm-vcs/issues/154);
this is a structural fix, not a measurement proving every storage failure gone.

Deep uses `PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`, a 120-minute job timeout,
and cancellation per ref. It queues on `[self-hosted, pm-local]` unless the
controller sets `PM_LOCAL_DEEP=off`, which selects GitHub-hosted Ubuntu. No
repository variables are changed by this rollout. Setup Node restores npm's
GitHub cache only on hosted runners; local runners retain their persistent npm
cache. Setup Bun runs only on hosted runners; local images supply Bun on PATH,
and every deep job logs `bun --version`.

Unset depth means full. Quick uses the deterministic prefix of each large
seeded corpus: one tenth rounded up, at least 25 and capped by the original
count (500 → 50, lifecycle 512 → 25, 128/200 → 25). Seeds and per-case assertions stay
identical. Lifecycle batch size stays 16 with a partial final batch. Large-history checks use 200 commits in quick and the original 2,000 in full,
retaining exact one-read, no-unrelated-read, logarithmic-decision and signature
verification assertions. Memory-limit fixtures retain their original sizes in both tiers. Crash matrices
still enumerate and compare the complete native trace in both tiers; quick
executes the first 25 generated cut ordinals (or every cut when there are fewer
than 25), while deep and unset depth recover every original cut. Crash traces
are a separate corpus from seeded properties: a ten-percent cut prefix still
ran 79–82 cuts in the measured native lifecycle cases and exceeded a ten-minute
focused local budget. The fixed quick prefix preserves the 25-case floor. Completion counts
and timing averages use only the selected cuts. No coverage threshold or source exclusion changes.
The launcher and child environment allowlist propagate both depth and time scale.
Crash subprocess safety budgets scale for slow hardware; finite property corpora
use operation counts instead of an elapsed-time timeout. The 512 TiB refusal
regression asserts exactly one root-object read rather than a one-second deadline.

[#151](https://github.com/unbraind/pm-vcs/issues/151) describes annotation cleanup
hitting ENOTEMPTY on PM lock directories. Main already uses managed fixtures:
owned child close and queued tasks settle before retrying recursive removal
(`maxRetries: 8`); persistent failures remain visible. This rollout verifies that
existing fix and does not claim a new reproduction or change its semantics.

## Evidence and rollout limits

The owner measured 1,163 runner-minutes in one day, median successful PR wall
206 minutes (maximum 358), against fleet usage of 39,929 runner-minutes and about
28 minutes of queueing. The previous PR gate ran four full release checks.
Main [run 43609609072](https://github.com/unbraind/pm-vcs/actions/runs/43609609072)
spent 176m30s on Node 22 and 93m03s on Node 26, each executing npm and Bun gates.
Its slowest measured test was the 512-seed lifecycle model (835 seconds), followed
by large history and exhaustive crash-cut tests. These are historical full-tier
measurements, not controlled quick/full comparisons.

Local validation is limited to typecheck, lint, touched tests and bounded checks.
A full local run is deliberately excluded: the owner reports a previous six-hour
timeout. Quick coverage is deferred to PR CI if the unchanged exhaustive matrices
make a twenty-minute local budget implausible. Record exact commands, measured
quick results, PR job wall times (created → completed, including queueing) and
remaining gaps in Task `pm-vcs-ci-disk-reserve` and the PR. Full-depth certification
belongs to ci-deep after merge; its runtime and the initial quick timeout bounds
remain to be measured. Release workflows, pm-github workflows, verifier scripts,
branch protection and repository variables are outside this change.


## Documentation and tracker gate inputs

Docs/tracker PRs run the complete quick tier, including changelog checking,
release changelog date verification, identity auditing, self-host acceptance and
packed-file privacy.
Self-host acceptance builds first and compares the committed bundle against the
committed tree; verification never rewrites the bundle. A stale README or tracker
snapshot therefore fails before merge.

Gate-script audit: `self-host.ts` includes every tracked path except the three
explicit `self-host.json` exclusions, including documentation and tracker data.
`verify-release-changelog-date.ts` invokes the generator on `.agents/pm`.
`verify-pack-privacy.ts` scans the real shipped README, changelog, architecture,
lore and selected docs. `audit-git-identities.ts` reads the tracked public address
allowlist and all physical Git object identities, so documentation commits retain that gate.
The existing unconditional tracker health check and cheap changelog check remain.

Other release gates were inspected: typecheck/build, lint, duplication and
docstrings target TypeScript/configuration; coverage runs the declared source
and fixture suites; native TOON/stat-cache acceptance uses synthetic projects;
production audit reads dependencies; publish-attestation verification reads
package/workflow shell inputs. The composition consumer tests read current
shipped documentation, and the pack benchmark reads the package tracker; both
belong to the quick suite. Pack dry-run adds no documentation validation beyond
the real archive already inspected by pack checking.

## Review round E

Both assigned checks hit the 30-minute job timeout. The Node 26 log measures 474 and 504 seconds for two benchmark tests: each redundantly runs both in-process and CLI benchmarks, resulting in four full executions. Retain one direct benchmark and one real CLI invocation from a checkout containing spaces. Keep every source and coverage threshold intact. Targeted benchmark and fixture validation records are linked from the package tracker.

The initial cheap tier excluded tracker record formats. Round AT removes those
exclusions because the pack benchmark reads the actual tracker.
`test/ci-routing.test.ts` executes both detectors with documentation, tracker data
and executable paths. Product deadlines, full-depth cases and coverage thresholds are unchanged.

Round F: every new test entrypoint imports session isolation first and child
launches use explicit fixture environments. Executable tracker files retain
PR-time CodeQL analysis. Node 22 now uses the same complete batched suite as
coverage: ordinary files overlap on at most four workers, while the three
core-owning matrices stay serial. No file is removed from either tier.

Run 43771863859 failed its ordinary batch on the routing isolation audit, so
the old runner never reached erasure-storage, erasure-crash-matrix or
exact-gates. Their omitted executions explain the broad coverage shortfalls.
The runner now completes both batches and preserves a nonzero result. The
complete benchmark runs the real CLI with runner-owned instrumentation, covering
the real entry guard. The separate spaced-checkout fixture stays unchanged.

## Quick-fit finite matrices

Explicit finite budgets use `testDepth(full, quick)`; seeded corpora keep their
25-case minimum. `testKinds` selects the first ordinal of every observed named
boundary in quick and returns every original ordinal in full.

| Contract | Quick | Deep / unset |
| --- | --- | --- |
| Reader resolution interruptions | 26 schedules (25 diagonal plus an explicit inventory injection): every reader, all 4 transitions and all 7 resolution boundaries, with live/erased checks | all 700 reader/transition/boundary schedules |
| Pinned-reader external retirement | every reader and loose/packed representation; first occurrence of each native I/O boundary kind | every observed ordinal |
| Absolute and relative SIGKILL pack/unpack/GC sweeps | first occurrence of every named boundary for each operation, preserving relative-root recovery and replay assertions | every native ordinal |
| Pending-root publication model | 1 deterministic seed × (`ref` in all 4 ref namespaces + 5 other root formats) × loose/packed = 18 stores; all 4 namespaces asserted | 8 seeds, 144 stores |
| Lifecycle accountability model | first 25 seeds, all crash kinds and instance/payload pairs asserted | all 512 seeds |
| Composition packed consumer | Node project-installed CLI path (also executes SDK composition and denied merges); prerequisite refusals retained | all 5 built/packed Node/Bun/project-CLI paths |
| Packed conflict resolution | one real-host case for each of the 10 kinds `testKinds` selects (field: boolean, empty, null, number, raw, whitespace; text: empty, json-string, raw, whitespace); direct SDK tests retain all 11 opaque value cases | all 11 packed real-host values |
| Packed move-source and snapshot-release consumers | Node SDK entrypoint with all 7 source and all 3 ownership kinds | Node/Bun × SDK/JSON/TOON × every scenario |
| Complete CDC benchmark | one instrumented real CLI execution | same plus separate checkout-with-spaces invocation |

No source scope, coverage percentage, job timeout or product deadline changes.
The separate benchmark boundary fixtures remain in both depths. Deep retains
all deferred runtime, packaging and real-host combinations.

## Round G file shards and coverage union

Required `test (22)` and `test (26)` checks are always-run aggregates. The former
requires every Node 22 quick shard; the latter requires the parallel non-coverage
release gates and the coverage merge, which depends on every Node 26 shard.
Failures, cancellations and skipped prerequisites fail the code aggregate.
Docs/tracker changes select the same quick shards and release gates as other
source changes because their contents are test inputs.

There are **8 shards per Node line**, reducing a code CI run from 35 to 23 jobs.
Both matrices call the same deterministic file allocator in
`test/helpers/ci-shards.ts`. It discovers every `test/*.test.ts` at runtime,
then assigns the largest measured files to the least-loaded shard. Timing
entries affect placement only: new files receive a 60-second estimate and still
run, while removed files are never selected. No test file is omitted. The
22-minute hard cap stays unchanged; the projection target is at most 12 minutes,
including a conservative two-minute setup reserve.

Sizing uses complete [run 43808985868](https://github.com/unbraind/pm-vcs/actions/runs/43808985868)
at `c342e00`. Coverage collection took 4,145 seconds across the 14 shards;
Node 22 tests took 3,457 seconds. `test/ci-shard-times.json` records seconds per
file, taking the larger Node 22/26 cost. The weights also retain the slower
observed costs from the first eight-shard run described below. Costs sum top-level test durations only
(no nested-subtest double counting), with each matrix's remaining collection
and process-startup time spread across its 148 files. This gives a conservative
initial 4,278.148-second combined inventory. After the measured outlier and
conflict-suite split below, the inventory is 4,650.216 seconds across 149 files.
Seven perfectly balanced shards already project to 784.317 seconds with setup,
exceeding 720. Eight largest-first shards project to at most 701.639 seconds
(11.69 minutes). Six or fewer cannot fit
either, so eight is the smallest projected fit under this reserve.

Plain sorted round-robin assignment at eight is imbalanced. The shared measured
allocator avoids that clustering. The first eight-shard run showed a slower
Node 22 conflict suite; its 35 unchanged cases are now registered through shared
fixtures by two entrypoints: 28 core cases and 7 real CLI/transfer consumers.
Their observed case totals are 222.742 and 176.107 seconds. No case, seed or
assertion was removed. The largest remaining file is about 260 seconds, below
the per-shard collection budget. Workflow tests
prove complete, unique discovery, consistent matrix/merge counts, deterministic
assignment and the eight-shard upper budget. The seven-shard lower bound is
historical sizing evidence only: a speed-up must not fail the contract. Eight
shards were selected from the observed inventory and setup reserve above; the
live test constrains only the maximum eight-shard projection. These are projections; queueing,
WAN setup variance and future file growth require new hosted measurements.
The Windows acceptance launcher jobs are unchanged.

Each coverage artifact contains repository-relative per-file line, branch and
function hits plus original V8 offset ranges. Merge uses the same runtime merger
as the original gate, before calculating percentages. Merging percentages or
line-only branch keys is invalid: dynamically emitted branch ranges may differ
between shards. A real two-file fixture covers a branch and a function exclusively
in each shard and compares the merged totals and hits with an unsharded run.
Missing or duplicate shards and differing Node majors fail closed. Minor and
patch differences within the same major are accepted. Thresholds, source scope,
`npm run coverage`, `npm run release:check` and ci-deep stay unchanged.

The VCS merge invokes c8 report with the original scope, `--all --100 --per-file`,
so every source file and all four original dimensions remain mandatory.

The non-coverage job runs every other original release command, plus the existing
Bun/bunx smoke. Setup, download/merge and required aggregates have their own
bounded jobs. Actual hosted wall times and merged coverage belong in the tracker
and PR body; a projection is not a completed timing or coverage certificate.

The earlier partial-log fourteen-shard estimate is superseded by the complete
run and eight-shard sizing above. The baseline used 147 runner-minutes and 13.6
minutes wall time, but failed merged branch coverage (99.54% in `engine/refs.ts`).
The single uncovered branch was line 299, `if (failure !== undefined) throw failure`:
all fourteen per-shard reports record zero hits at that location. This is a test
gap, not a union-key defect. A focused c8 experiment combining the original raw
refs ranges with the new test reaches 100% in all four dimensions for refs; the
throw-failure location records one hit. That experiment mixes the hosted
26.13.1 collection with a local 26.13.0 witness and is diagnostic evidence only;
full-suite, matching-runtime certification still belongs to the new hosted run. The existing cleanup-failure test throws during
validation, before a completed transaction can report a release failure. A new
depth-independent deterministic test completes two ref updates, injects failures
only when their leases release, and asserts that the first error propagates,
both refs are published, every lock is removed and every descriptor closes.
Thresholds and merger identities stay unchanged.

Direct shard commands publish the package's `node_modules/.bin` through
`GITHUB_PATH` after installation, preserving the npm script environment.
PM CLI integration tests must run rather than skip because `pm` is unavailable.
The workflow contract checks this setup in both shard matrices.

## Eight-shard measured correction

[Run 43813269377](https://github.com/unbraind/pm-vcs/actions/runs/43813269377),
code head `5660350ce41c1ecaed123c39c73b468f89d278cf`, passed all 23 jobs and
the full merged 100/100/100/100 gate across 102 measured files. It used 140.35
summed execution runner-minutes; run creation to final job completion was
979 seconds (16m19s). Quick shard 4 spent 560 seconds queued. Quick shard 8
executed for 925 seconds, missing the sizing target despite passing.

That completed log measures 398.849 seconds in the conflict suite, compared
with its old 132.605-second estimate, plus higher signature/reader costs.
The core/consumer split and refreshed conservative costs above correct this
observed imbalance. The first run certifies coverage and the test inventory;
it does not certify the revised placement or prove every shard meets twelve
minutes. Fresh hosted timings are recorded in the tracker and PR body.
