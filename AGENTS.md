# AGENTS.md

The self-host audit verifies the committed archive against committed source,
independently hashing and importing all carried objects. It never regenerates
an archive during verification. Package manifests are excluded explicitly by
`self-host.json` so dependency-only bumps do not need archive updates.

Workflow action revision changes are allowed only when both archived and current
lines use full 40-hex commit SHAs and version comments under an explicitly trusted
owner. The action path and every other workflow byte must remain identical.
Commands, permissions, action replacements, file additions/removals, file modes,
malformed pins and ordinary source changes still require regenerating and
committing `selfhost.bundle`.

Stage tracker, documentation, test and source changes, then run
`npm run self-host:write -- --staged`. Stage the bundle, commit it with those
changes and verify the resulting tip with `npm run accept:self-host`. Dependabot owns dependency refreshes;
fix recurring CI coupling in the package rather than editing individual bot PRs.
