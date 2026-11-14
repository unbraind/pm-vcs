# Pinned Daily Release rollout

This package delegates release execution to pm-ops v2026.11.14 at
`7687a35d7522482bd8361d60dbc2589e9afbc81c`. The package uses the matching
released pm-ops validator and explicitly permits empty changelog sections in
generation, checking and release notes. Dependabot covers the SHA through its
root github-actions ecosystem.

Package-owned inputs: `{"reconcile-only":"${{ (github.event_name == 'schedule' && github.event.schedule == '41 * * * *') || inputs.retire-unpublished == true }}","retire-unpublished":"${{ github.event_name == 'workflow_dispatch' && inputs.retire-unpublished == true }}","release-enabled":"${{ github.repository == 'unbraind/pm-vcs' && vars.PM_RELEASE_APPROVED == 'true' && github.ref == 'refs/heads/main' }}","changelog-script":"release:changelog","release-files":"selfhost.bundle"}`. Existing daily schedules
are retained, with canonical hourly reconciliation where scheduled releases exist.

Cross-repository npm OIDC was proven by the merged pm-jira pilot in
[run 43639146392](https://github.com/unbraind/pm-jira/actions/runs/43639146392),
as recorded on [pm-ops #272](https://github.com/unbraind/pm-ops/issues/272#issuecomment-6884325024).
The npm trusted publisher names this package repository and its own release.yml.
The first release run must still pass Verify npm will accept this workflow's OIDC identity.
Only the orchestrator merges, dispatches and verifies publication.

The caller contracts replace assertions about removed private release implementation.
Implementation behavior belongs to the pinned pm-ops release harness. Package-owned
approval, script and permission contracts remain checked locally.
