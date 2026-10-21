# Find a regression with a linked PM test

Record the reproducer on an item, then give bisect a known-good ancestor and a
known-bad descendant:

```sh
pm test project-regression --add command="npm test"
pm vcs bisect start good-release main --item project-regression
pm vcs bisect run
pm vcs bisect status --json
pm vcs bisect reset
```

Or supply an explicit command, keeping the same item as the evidence destination:

```sh
pm vcs bisect start good-release main --item project-regression --command "npm test" --max-steps 8
pm vcs bisect run
pm vcs bisect run --max-steps 32
```

`run` executes the commands recorded on the item using the PM SDK's real
`pm test <item> --run` operation, including its trust, timeout and context rules.
`start --command` records that command as a linked test on the item and selects
only that exact command for the session, even when other tests are linked. The
command remains on the item after reset. Changing the predicate requires a new
session; if the selected test is removed, its probes become explicitly untestable.
The linked commands must be able to
run from a clean materialization of a candidate; install/build dependencies in
the recorded command when needed. Absolute paths in linked commands can still
refer to external resources, just as they can in `pm test`.

Each candidate runs in a disposable native repository under the private control
directory. The original HEAD, branch, index, tracked edits and untracked files
stay in place on success, test failure, SIGINT and process death. PM test context
sandboxes retain their normal semantics. PM milestones append to the current
authoritative tracker, including when that tracker is versioned in the source
repository. Those intentional history additions remain after the walk.

## Commands

| Command | Effect |
| --- | --- |
| `bisect start <good> <bad> --item <id> [--command <command>] [--max-steps <count>]` | Validate ancestry, predicate, clean tracked tree and absence of private layers; save boundaries, predicate, step limit and original checkout identity. |
| `bisect run [--max-steps <count>]` | Continue the session; an override becomes the saved limit for subsequent runs. |
| `bisect good [revision]` | Record a manual passing outcome; defaults to the walk's next candidate. |
| `bisect bad [revision]` | Record a manual failing outcome; defaults to the walk's next candidate. |
| `bisect skip [revision]` | Record a manual skip; defaults to the walk's next candidate. |
| `bisect status [--item <id>]` | Show the local session and latest milestones from all sessions in the shared tracker. |
| `bisect reset` | Remove local session state and interrupted candidate workspaces first; attempt an abandonment receipt and report a warning if it fails. |

Manual marks leave HEAD in place. With no revision, `good`, `bad` and `skip`
apply to `next` from `bisect status`; if no candidate remains they refuse with a
remedy to pass an explicit revision or inspect and reset the session. An explicit
revision can correct an earlier verdict, including the bad boundary. The good
boundary defines the excluded ancestry and only accepts `good`; marking it `bad`
or `skip` refuses with a remedy to reset and start with an earlier good revision.

All commands use the host's normal TOON output and accept its global `--json`
format. Reports include the session, boundaries, original checkout, ordered
candidate log, remaining work and next candidate. A conclusion includes the
stable change id, current commit, author, linked PM items and historical agent
harness/model when the change carries that provenance. Missing provenance stays
absent. Object ids use 12 characters by default; `--full` restores complete ids
in boundaries, steps, verdicts, original checkout and session listings. A boundary
prints `revision` only when it differs from its resolved commit. Boundary details
already represented in the report are omitted; durable observations remain full.
The package flag `--budget <tokens>` (default 1600, minimum 256) bounds the
candidate log using a conservative JSON character estimate. Verdict metadata is
always retained and can exceed that target. `stepsTaken` and `stepsOmitted` make
truncation explicit; durable state and PM history retain the complete log. The
pinned host does not accept universal read-output controls on this mixed mutation
command.

Each `run` attempts at most `maxSteps` candidates (default 128, a positive safe
integer). Skips, conflicts and untestable materializations count toward this
limit. If work remains, it saves `status: active` and `halted: step_limit`, records
a halt milestone on the item, and exits successfully with a resumable report.
Run again to continue; earlier verdicts are retained. Completing on the last
allowed step reports the conclusion immediately. This candidate count does not
replace the linked test's own timeout.

## Outcomes and assumptions

Bisect assumes a persistent regression: good descendants imply their ancestors
are good, and bad changes narrow the search to their ancestry. It selects a
candidate that splits the remaining ancestry as evenly as possible, including
merged branches. Each walk reads immutable commit metadata once while constructing
its range and caches candidate ancestry, stopping at good-boundary ancestors.
In shallow repositories, ancestry stops at the recorded shallow commits while
retaining those commits as possible boundaries or candidates. A shallow culprit
with omitted parents retains its explicit PM associations; `itemsBoundary: shallow`
reports that file-derived associations could not be established. File change
traces also omit deltas at these boundaries instead of inventing additions.
The 2,000-commit scaling regression counts 2,000 setup reads for 1,600 candidates
and zero further commit reads per decision step or final verdict. Candidate
materialization and linked-test execution are separate from these decision reads.
Multiple unrelated failures, flaky tests or a regression that
is later fixed violate this assumption; refine the linked test or boundaries.

A passing execution is `good`; a normal assertion failure is `bad`. Exit 125 is
`skip`; a refused, empty, timed-out or otherwise unrunnable execution is
`untestable`. Shell exits 126/127 are untestable. A candidate whose payloads
cannot be checked out records `untestable` with the object-store
error code and is not retried automatically. Unexpected checkout errors and
runner exceptions preserve the pending candidate for a retry. A candidate carrying unresolved
conflict units is `conflicted` and never executes the linked tests. Any
interrupted linked test takes precedence over other outcomes and halts the walk.
Interrupted observations are logged and retried on resume.

A precise result is `first_bad`. If skipped, conflicted or untestable candidates
could contain the regression, the result is `ambiguous`, with the earliest
known-bad change and the unresolved observations. It never labels those
observations good. A manual correction that eliminates all known bad observations
can produce `no_bad_change`.
If every interior candidate skips, the result is `ambiguous`, naming the declared
bad boundary and every unresolved candidate rather than claiming a first bad change.

Verdicts are keyed by stable change identity. Rebase/amend/describe can rewrite
commit ids without rerunning judged changes; current ancestry is used when
applying those verdicts. Named boundaries follow updated refs; hash boundaries
remain pinned. Reusing a verdict assumes the stable change retains the same test
behavior. Start a new session if the test contract or change behavior changes.

## Interruptions and agents

Session state is atomically replaced in `BISECT_STATE` before execution and after
each result. A pending candidate left by process death is explicitly logged and
retried. Run `bisect run` again to resume. A per-worktree process lease refuses
concurrent mutation; a separate SDK-worker receipt refuses run/reset while an
orphaned candidate test is still executing. Retry after that worker finishes.
Every candidate has a unique private directory. A proven dead owner is recovered
automatically. Unknown owners refuse with an inspection remedy. `status` remains readable during a run.

Use separate linked instances for agents running concurrently. Each has private
session state and candidate workspaces; immutable source objects and the PM
tracker can be shared. Start, step, halt, conclusion and reset milestones append
to PM history on the linked item. `status` lists both sessions without replacing
either agent's private state. PM ownership policy still applies to item writes.
SIGKILL cannot run cleanup: its private candidate directory is removed on the
next run or reset, while the original checkout remains available throughout.

## Without git

All bisect operations use pm-vcs's own object store, refs and change graph. They
work in a plain directory with a PM tracker and no git executable on `PATH`.
The predicate itself must also be runnable there: a command that explicitly
requires git still needs its own prerequisite. Candidate execution and milestone
recording do not require a git repository.

The pinned PM SDK normally probes a Git branch for linked-test trust. Bisect
supplies that SDK input only inside its worker: hosted source refs take priority,
existing Git HEAD metadata is read directly when available, and plain projects
use `pm-vcs:<native-repository-identity>`. No Git executable is invoked. The
SDK worker rejects optional Git process requests before process creation, including
the SDK's sandbox-initialization probes, allowing its normal no-git fallback. The
predicate keeps its original hosted-ref environment, including absent or empty
values and explicit linked-test environment directives. Foreign source-ref tests
still require normal PM trust acknowledgement; this does not enable untrusted
execution.

## Public-data demonstration

`test/bisect-demo.ts` imports 34 committed public `pm-csv` tracker snapshots into
a scratch native repository and records the source revision alongside each one.
It deliberately introduces a persistent failing flag at snapshot 18, records
`node probe.mjs` on a real PM item, and invokes the installed CLI. The demonstrated
range spans public commits `53807ddccac4d5190deebdb52661ec398a44d0ed` through
`417072bd7c402f5f8d3387beb37b33d8c887ab6b`. Four linked-test executions identified
snapshot 18 (`fad7e30c040dff33f789bd6c5176882b27825427`) and verified the original
checkout remained at the bad tip. The captured default TOON report decreased from
2,834 to 1,516 bytes (1,318 bytes saved, 46.5%) with compact ids and redundant
boundary text removed. The regression flag is synthetic; the tracker
snapshots are actual public history. See the [captured TOON report](bisect-demo.txt).

To reproduce with a local copy of the public source repository:

```sh
node test/bisect-demo.ts <public-source-checkout> <report-output-file>
```
