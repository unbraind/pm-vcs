# Explain a native change through tracker lenses

`pm vcs explain [change]` compares an immutable native change (default `HEAD`)
against its **first parent**. Root changes compare against absence. This is a
snapshot delta, including for merges and rewrites; it is not a claim about the
original author of every inherited field. `origin` reuses native change
provenance, including recorded PM item and agent associations.

Opt in with `--lenses lifecycle,dependency,evidence,policy`. Without lenses,
records produce ordinary field provenance and blobs produce text provenance.
Both modes cite exact source objects and commits. Semantic labels replace the
ordinary field label on selected fields; they retain the same field and sources.
Use `pm vcs annotate <path> --at <change>` for per-line/field last setters and
conflict-side origins, `pm vcs verify --signatures` for trust checks, and
`pm vcs bisect` for linked-test execution. An evidence label reports recorded
metadata, not a successful test or an authentic signature.

| Lens | Recognized item fields |
| --- | --- |
| lifecycle | status, type, priority, assignee, closed_at, completed_at, close_reason, resolution |
| dependency | dependencies, parent, blocked_by, blocked_reason |
| evidence | files, docs, tests, test_runs, comments, notes, learnings |
| policy | acceptance_criteria, definition_of_ready, risk, confidence |

Policy means **declared item policy**, not enforcement. Settings, schemas,
history streams and arbitrary tracker objects remain opaque. Unknown item
fields retain ordinary field provenance. Custom schemas unsupported by the
pinned SDK conservatively remain opaque. Both present sides must be canonical
SDK-valid records, with strict built-in risk/dependency kinds, valid recorded
timestamps, required project/global link scopes, string body and item identity matching the tracker
filename. A malformed side makes the entire file delta opaque, so repairing an
item never invents historical lifecycle facts. Unconfigured item blobs are also
opaque. No view rewrites records or history. Unresolved fields keep ordinary
provenance; separate conflict rows cite the source commits and paths carrying conflict references.

`before` and `after` name `{commit, object, path}`. Missing sides mean absence;
`was: null` is a present null. `was`/`now` retain scalars up to 160 canonical UTF-8
bytes; larger values and collections become `{sha256, bytes}` of their canonical
record value. Dependency and evidence collections emit recorded entry additions
and removals with entryBefore/entryAfter indices and compact coordinate fields
(target id/kind, path, command or log timestamp/text). Matching retains exact
duplicate counts; order-only edits retain ordinary field provenance. Resolve the
cited object, field and entry index to inspect the original value.
File rows preserve mode/identity-only changes. Renames appear as path deletion
and addition; use trace/annotate for identity lineage.

Output defaults to 20 statements; `--limit` accepts 1..100. `total`, `omitted`
and `nextOffset` are always explicit. Continue with the **same immutable change**
and lenses plus `--offset <nextOffset>`; offset counts statements, not bytes.
An offset beyond the end returns an empty page. The query reads changed payloads
and both tree metadata snapshots to count all statements, but never unrelated
payloads or other refs. Output size is bounded by page size and scalar summaries;
source path/field names are preserved exactly.

Expected refusals carry stable codes and remedies: `invalid_lens` lists valid
names, `invalid_lens_page` describes page bounds, and `lens_shallow_boundary`
requires fetching omitted parent ancestry. Native revision and object failures
retain existing pm-vcs refusal codes. An opaque row is a successful observation,
not a refusal and not permission to repair content.

## Example

In an initialized native tracker, snapshot a change normally:

```sh
pm vcs add .agents/pm/tasks/example.toon
pm vcs commit --message 'Record work in progress'
pm vcs explain HEAD --lenses lifecycle,dependency,evidence,policy --limit 10 --json
pm vcs explain HEAD --lenses lifecycle --limit 1
pm vcs explain HEAD --lenses lifecycle --limit 1 --offset 1
```

For a valid item's status change, a statement has `lens: lifecycle`,
`field: status`, `was: open`, `now: in_progress`, the item ID, and both exact
object/commit citations. A linked test list produces an `evidence` statement
whose entry digest and path/command coordinates cite the recorded list; it does not run the test.
Default output is compact TOON; the host's `--json` emits the same typed object.

The published SDK exposes the same query and types:

```ts
import { explainChange, TRACKER_LENSES } from 'pm-vcs';
import { Repository } from 'pm-vcs/dist/engine/repo.js';

const repository = Repository.open(process.cwd());
const report = explainChange(repository.objects, repository.resolve('HEAD'), {
  lenses: TRACKER_LENSES,
  limit: 10,
});
console.log(report.statements, report.nextOffset);
```

The SDK reads the supplied object store only. It neither opens today's tracker
nor changes its policy, tests, claims, refs, index or working content. Git is not
required by either surface.

## Public tracker acceptance receipt

The manual helper accepts extracted **public** snapshots, initializes a real SDK
tracker in a fresh plain directory, records both as native snapshots, then makes
the copied tracker read only before querying. It checks exact tracker hashes
before and after and verifies every cited object exists. The original checkout
is only read for archive export. It does not query hosted or private data.

```sh
scratch=$(mktemp -d)
mkdir "$scratch/base" "$scratch/tip"
git archive ab9e92eb49110fd3cdfaf6e458a56e2fdfe1f1c9 .agents/pm | tar -x -C "$scratch/base"
git archive 27e1d84671fa8c139f7dd00b9e41a7b407319ec7 .agents/pm | tar -x -C "$scratch/tip"
GIT_CEILING_DIRECTORIES="$(dirname "$scratch")" node test/helpers/validate-tracker-lenses.ts "$scratch/base" "$scratch/tip"
```

Measured on this 20-change public pm-vcs window: **147 items, 2,175 history
events, 300 files, 4,381,779 bytes**. The query returned **799 statements in 40
pages** at limit 20: 71 lifecycle, 17 dependency, 496 evidence, 16 policy, 173
ordinary field and 26 opaque rows. Largest JSON page: **14,000 bytes**. Total
query time across all pages: **3,932.03 ms** on the CPU-saturated validation host;
this is an observation, not a performance guarantee. Tracker hashes remained
exact; the target had no Git repository. The aggregate tracker digest was
`9a6b751ed89486b87b7849fcebd688fbbb27d4544d8fc379c9a964caf5170fa7`.
The 26 opaque rows include tracker history/configuration payloads; opacity does
not mean those source files are corrupt. Separate installed-CLI regressions run
with an empty PATH and verify native content/control hashes after both formats.
