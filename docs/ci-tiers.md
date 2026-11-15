# Fleet CI v2

PRs and manual dispatch run the quick tier. Required check names remain
`test (22)`, `test (26)`, `windows-acceptance-launcher (22)` and
`windows-acceptance-launcher (26)`. Linux checks use GitHub-hosted Ubuntu;
the Windows checks retain Windows because they verify native launcher, GC and
root-case contracts. Superseded PR runs cancel. Linux jobs time out at 30 minutes;
Windows jobs at 15 minutes. These are initial bounds pending PR measurements.

| Check or contract | Code PR Node 22 | Code PR Node 26 | Docs/tracker-only PR | Deep Node 22/26 × npm/Bun |
| --- | --- | --- | --- | --- |
| npm ci, merge-driver preparation, pinned project extension | yes | yes | all four required jobs | every job |
| Strict tracker health, required merge drivers | yes | yes | all four required jobs | every job |
| Build and test compilation | yes | yes, in release gate | — | full release gate |
| Test suite, seeded properties, crash/recovery matrices, packed Node/Bun consumers | quick | quick, via coverage | — | full release gate |
| Typecheck, lint, duplication and docstring gates | — | yes | — | full release gate |
| Per-file coverage, unchanged 100% thresholds and source scope | — | quick | — | full |
| Native TOON installed CLI acceptance | — | yes | — | full release gate |
| Stat-cache installed CLI acceptance | — | yes | — | full release gate |
| Committed self-host bundle hash/import/source equality | — | yes | — | full release gate |
| Production dependency audit and Git identity audit | — | yes | — | full release gate |
| Pack dry-run and pack privacy check | — | yes | — | full release gate |
| Changelog consistency | — | yes | all four required jobs | full release gate |
| Release changelog date and publish attestation | — | yes | — | full release gate |
| Bun graph installation and bunx ephemeral PM launcher | — | yes | — | graph install every job; bunx smoke in PR tier |
| Native Bun tracker-lenses and change-bundles tests | — | — | — | both Bun jobs |
| Windows installed PM launcher and native GC/root-case storage tests | separate Windows 22 job | separate Windows 26 job | cheap gates in both Windows jobs | retained in PR tier |
| Failure coverage artifact, seven-day retention | on failure | on failure | — | on failure, unique matrix names |
| CodeQL analysis | separate workflow for matching paths | separate workflow for matching paths | path-filtered | weekly scan also covers ignored paths |

The cheap path runs dependency setup, strict health and changelog consistency.
The existing pinned pm-github extension install is prerequisite setup for strict
health in a fresh checkout. Detection compares actual PR base/head endpoints with
NUL-delimited paths and rename folding disabled. Tracker data, Markdown, docs and
LICENSE are cheap; executable JS/TS tracker files select code CI. Manual dispatch
always selects code CI. `selfhost.bundle` is a code path: documentation changes
that also regenerate the archive receive the code checks.

Only Node 26 runs `npm run release:check` in PR CI, with `PM_TEST_DEPTH=quick`.
Node 22 runs `npm test` (build, test compilation and tests), with no separate
coverage, changelog or packing step. Some tests themselves pack consumers; those
assertions remain. Packed acceptance runs native Bun consumers but installs
archives using npm and the PM CLI; it does **not** prove Bun installer or bunx
installation paths. An explicit `bun install --no-save` and pinned bunx PM version
smoke cover those paths without another release gate.

The self-host gate stays in the PR release gate because it guards shipped VCS
object hashing, import and committed source equality. Depth does not weaken its
archive verification. After source, docs, tests and tracker changes are staged,
run `npm run self-host:write` and commit `selfhost.bundle` with those changes.
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
count (500 → 50, 512 → 52, 128/200 → 25). Seeds and per-case assertions stay
identical. Lifecycle batch size stays 16 with a partial final batch. Full-depth
large-history, memory-limit and exhaustive crash-cut contracts retain their
original sizes in both tiers. No coverage threshold or source exclusion changes.
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
