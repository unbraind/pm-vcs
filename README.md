# pm-vcs

Branch-aware merge safety for [pm-cli](https://github.com/unbraind/pm-cli) trackers.

pm-cli already ships the *mechanism* that lets many agents work one project on many branches
and merge without losing item data: `pm merge install` writes git merge drivers,
`pm merge driver` performs field-aware merges of item documents and append-only history, and
`pm merge reconcile` / `pm merge report` account for history afterwards.

**pm-vcs covers what happens before you merge, and what git's history has to say about your
items.** It does not reimplement the merge drivers — it calls them.

```bash
npm install --save-dev pm-vcs     # or: bun add -d pm-vcs
pm install pm-vcs
```

## Commands

### `pm vcs preflight`

One call, one verdict: can *this* checkout merge tracker data field-aware?

```console
$ pm vcs preflight
ok: true
preflight:
  checks:
    - name: "merge_fence_committed"
      status: "pass"
      detail: "The committed .gitattributes carries the pm merge fence."
    - name: "merge_drivers_configured"
      status: "pass"
    - name: "merge_fence_coverage"
      status: "pass"
    - name: "merge_driver_runs"
      status: "pass"
      detail: "The configured merge driver executed successfully against a synthetic three-way input."
    - name: "tracker_worktree_clean"
      status: "pass"
```

Run it as the first thing you do in a new checkout. It exits non-zero when a check fails, and
every failure names a remediation.

**Why it matters.** `.gitattributes` is committed and travels with the repository, but it is
inert on its own: the `merge.pm-*.driver` definitions live in **git config**. Without them git
silently falls back to its default line-based merge on `.toon` items and history JSONL — you
get a line-merged or conflicted item file and nothing anywhere says the field-aware driver
never ran.

Which checkouts actually have that hole is worth stating precisely, because the intuitive
answer is wrong:

| Checkout | Drivers present? | Why |
| --- | --- | --- |
| `git clone` | **No** | clone copies the committed fence but not git config — so every collaborator's clone and every CI checkout starts unprotected |
| `git worktree add` | **Yes** | a linked worktree shares the repository's config file, so the main clone's drivers already apply |

Both halves are pinned by tests, against real clones and real worktrees.

`merge_driver_runs` goes further than checking that config exists: it **executes** the
configured driver against a synthetic three-way input in a temporary directory. A driver
command pointing into `node_modules` resolves in the clone it was installed from and fails in
a checkout that never ran `npm install` — and it fails *during* a merge, once your working
tree has already been rewritten.

`merge_drivers_configured` grades a *missing* driver as a failure and a *drifted* driver
command as a warning. Drift is the normal state for a repository that installed its drivers
from a local devDependency; the driver still runs, so failing on it would keep preflight
permanently red in exactly the repositories that took the more portable route.

### `pm vcs preview <ref>`

What would merging `<ref>` into HEAD do to your tracker data — per artifact, per field,
**without touching the working tree**?

```console
$ pm vcs preview agent-b
preview:
  entries:
    - path: ".agents/pm/history/sbx-o6a5.jsonl"
      artifact: "history"
      resolution: "union"
      stream_strategy: "union_reanchor"
      entries_total: 7
    - path: ".agents/pm/tasks/sbx-o6a5.toon"
      artifact: "item"
      resolution: "conflict"
      conflict_fields: ["priority"]
      union_fields: ["notes"]
  totals: { clean: 0, union: 1, conflict: 1, delete_modify: 0, unprotected: 0 }
```

Read that as: *both agents appended notes and they will union losslessly; both changed
`priority` and someone has to decide.*

| Resolution | Meaning |
| --- | --- |
| `clean` | identical, or only one side changed — nothing to decide |
| `union` | append-only streams and commutative collections that merge losslessly |
| `conflict` | both sides changed the same scalar; the driver resolves toward `ours` and reports it |
| `delete_modify` | one side deleted the artifact, the other changed it — git settles this at the tree level and never runs a driver |
| `unprotected` | a tracker artifact no pm merge driver covers in this clone: a silent line-merge waiting to happen |

**Why you can trust it.** The preview reads the three blobs straight out of git
(`merge-base`, `HEAD`, `<ref>`) and hands them to `mergeItemDocuments`,
`mergeHistoryStreams`, `mergeRelationshipEventStreams` and `mergeJsonDocuments` — the exact
functions `pm merge driver` runs, from `@unbrained/pm-cli/sdk/merge`. Both the preview and the
real merge reduce to the same call on the same inputs, so the prediction cannot drift from the
outcome: a rule change in the CLI changes both at once. Which driver applies to a path comes
from `git check-attr`, so `.gitattributes` matching is git's answer, not a second
implementation of it.

The test suite proves the claim rather than asserting it: it diverges one item on two real
branches, records the prediction, performs the real `git merge`, and checks that git conflicts
on exactly the predicted path, that `ours` won the predicted scalar, and that both agents'
notes survived.

Use `--fail-on` to turn it into a CI gate:

```bash
pm vcs preview origin/main --fail-on conflict      # unresolvable field collisions and delete/modify
pm vcs preview origin/main --fail-on unprotected   # also fail on artifacts no driver covers
```

Without `--fail-on` it is a report and always exits 0.

### `pm vcs items <range>`

Which pm items did this commit range create, modify or delete?

```console
$ pm vcs items main..HEAD
items:
  items:
    - id: "sbx-k2p9"
      kind: "created"
      path: ".agents/pm/features/sbx-k2p9.toon"
      commits:
        - short: "a1b2c3d"
          author: "agent-a"
          date: "2026-07-30T09:14:02Z"
          subject: "Add the export pipeline"
  totals: { created: 1, modified: 0, deleted: 0 }
```

Directly consumable by a PR description or release notes. Only item *documents* are counted,
never their history streams — a stream always changes alongside its document, so counting both
would double every entry.

## Design constraints

- **No state of its own.** Every answer is derived from git and the tracker, so pm-vcs can
  never itself become a merge conflict.
- **Read-only.** No command writes to the working tree or the index. `preflight` writes only
  into a temporary directory it creates and removes, to execute the driver probe.
- **Compose, never duplicate.** Merge outcomes come from the shipped merge primitives;
  attribute matching comes from `git check-attr`; driver and fence audits come from
  `auditMergeDriverConfiguration` and `auditMergeAttributeFence`.
- **No shell.** Git is invoked with an argument array and no shell, so a branch or path
  containing a space, quote or `$` cannot change the command that runs.

## Requirements

- Node.js >= 22.18.0 (`engines`), tested on 22 and 26
- `@unbrained/pm-cli` >= 2026.7.29 (peer dependency)
- Works under `npm`/`npx` and `bun`/`bunx`

## Development

```bash
npm ci
npm run check        # typecheck
npm run coverage     # test suite behind the 100/100/100 coverage gate
npm run release:check
```

Tests run against real git repositories holding real pm trackers, created by the real `pm`
binary. There are no mocks and no hand-built `api` doubles: the package's whole claim is that
it predicts what git and the shipped drivers do, and a fake of either would only assert
against the suite's own assumptions.

## Known upstream issues this package works around

- [unbraind/pm-cli#825](https://github.com/unbraind/pm-cli/issues/825) — `FlagDefinition`'s
  index signature defeats excess-property checking, so a misnamed flag field type-checks and
  then aborts activation. Flags here use `long` / `value_name` / `value_type`.
- [unbraind/pm-cli#826](https://github.com/unbraind/pm-cli/issues/826) — an extension command
  cannot both return a structured report and exit non-zero, and a thrown handler error's
  remediation is replaced by a generic line. Gate commands therefore throw, with the
  remediation folded into the message.

## License

MIT
