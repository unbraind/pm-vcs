# Scheduled GitHub issue sync diagnosis, 2026-11-16

[Failed workflow run](https://github.com/unbraind/pm-vcs/actions/runs/43827565812).

Observed failure:

```text
pm github gate: import plan is not idempotent — 1 duplicate provenance tag(s) in the existing corpus, 0 new entr(y/ies) without a provenance tag, 1 conflicting target(s).
```

Main still called pm-github 2026.11.4. Reuse [PR #208](https://github.com/unbraind/pm-vcs/pull/208), which already pins sync and closeout to 2026.11.15. This continuation retains those commits and records the additional failure diagnosis. No second pin PR is needed.

The shared #150 reference belongs to pm-vcs-phase6packs (pack storage) and pm-vcs-crash-matrix-ci (crash-matrix runtime). They track distinct work. The pack item also references #154 and #158; those references caused the old conflicting target. Version 2026.11.15 separates reference tags from explicit import ownership, so each issue receives its own unambiguous target. Both items and their histories are preserved; neither is closed.

## Import gate evidence

11 planned, 0 skipped, 0 matched by provenance, 0 adopted, 11 new. The command exited 0 after a transient GitHub HTTP 502 retry.

For non-blocked importers the read-only command is:

```sh
pm github import unbraind/pm-vcs --state all --atomic --gate --dry-run --with-comments --json
```

Command output (exit 0):

```text
pm github gate: plan verified — 11 planned, 0 skipped, 0 matched by provenance, 0 adopted, 11 new.
[dry-run] Atomic plan would import 11, update 0, skip 0. Adopt 0.
```

A passing plan proves completeness and identity planning, not successful writes or a new scheduled CI run. Shared reference tags remain references; new mirror items in a plan are not applied by this investigation.

## Validation

Typecheck and lint pass. The pinned tracker validation returns `ok: true` with existing advisories. The seeded tracker validation and gated import preview also pass through `pm test --run --progress`. Package quick tests are still running at the initial draft; no full passing package suite is claimed. Remaining results are recorded in the linked sync repair item. CI is not dispatched manually, and no successful scheduled rerun is claimed.
