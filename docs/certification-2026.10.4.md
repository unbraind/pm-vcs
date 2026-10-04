# PM CLI/SDK 2026.10.4 certification

Tracker: [pm-vcs-bcgs](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/chores/pm-vcs-bcgs.toon).

Exact development pins: CLI/SDK, pm-ops and pm-changelog 2026.10.4;
Babel core/parser 8.0.6; TypeScript syntax plugin 8.0.3; @types/node 26.6.4;
c8 12.0.0; ESLint 10.12.0; jiti 2.7.0; jscpd 5.4.0; TypeScript 7.0.2;
the compatibility compiler alias remains exactly TypeScript 5.9.3. The runtime
host floor stays 2026.8.1. Owner publishing gates remain unchanged.

Dependabot #86's exact CodeQL init/analyze pin is
`2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` (`# v4`). The pm-ops update in
#83 is superseded by 2026.10.4. The merge-driver launcher is byte-identical to
the installed pm-ops template. Eight launcher tests pass, including a malformed
lookup-path regression preserving the original resolution error.

The dependency-refresh workflow now dispatches `ci.yml` on the exact branch
after creating its PR with GITHUB_TOKEN, with `actions: write` permission.
Three workflow tests execute the actual shell block with disposable command
doubles: collision-safe branch dispatch, failed PR creation preventing dispatch,
and the existing manual trigger preserving all four required names:
`test (22)`, `test (26)`, `windows-acceptance-launcher (22)` and
`windows-acceptance-launcher (26)`. The missing dispatch/permission failed before
the fix and all three tests passed afterwards.

Both `npm audit --omit=dev` and `npm audit` report zero vulnerabilities.
No open Dependabot security alerts were present. Managed pm-github 2026.10.4 is
restored explicitly in Linux CI before strict health. `npx pm health
--strict-exit --require-merge-drivers` passed. `npx pm github import
unbraind/pm-vcs --state all --atomic --dry-run` proposed 1 import / 0 updates /
0 skips; no GitHub or tracker sync writes occurred.

Real-data dogfood copied the repository's `.agents/pm` into disposable
`pm-vcs-dogfood/.agents/pm`, packed with `npm pack --pack-destination
<scratch>/pack`, installed with `npm install --ignore-scripts
@unbrained/pm-cli@2026.10.4 <tarball>` and `npx -y @unbrained/pm-cli@2026.10.4
package install <tarball> --project`. Both `npx -y
@unbrained/pm-cli@2026.10.4` and `bunx --bun @unbrained/pm-cli@2026.10.4` ran:

```sh
--version
--json vcs init --record-path '.agents/pm/**/*.toon' --set-field tags:set,notes:sequence,updated_at:timestamp
--json vcs add .agents/pm/chores/pm-vcs-bcgs.toon .agents/pm/history/pm-vcs-bcgs.jsonl
--author 'SteveBot <1153461+unbraind@users.noreply.github.com>' --json vcs commit --message 'Real tracker initial snapshot' --item pm-vcs-bcgs
comment pm-vcs-bcgs '<disposable launcher marker>'
--json vcs add .agents/pm/chores/pm-vcs-bcgs.toon .agents/pm/history/pm-vcs-bcgs.jsonl
--author 'SteveBot <1153461+unbraind@users.noreply.github.com>' --json vcs commit --message '<disposable launcher marker>' --item pm-vcs-bcgs
--json vcs status
--json vcs log --limit 2
--json vcs diff <first-commit> <second-commit>
--json vcs export <scratch>/real-<launcher>.bundle
```

Each host reported 2026.10.4, staged only the real Chore/history pair, created
two commits attributed to that item, returned clean status and two history
entries, and showed the scratch marker in the diff. npm exported 159754 bytes;
native Bun exported 163426 bytes. All commands exited 0. Scratch was deleted.

The self-host bundle is regenerated from staged working-tree paths and committed
with the dependency lockfile, as required by AGENTS.md. The full PM-linked release gate passed 797/797 tests, zero skips, and 100%
statements/branches/functions/lines across the unchanged c8 inventory. It also
passed native TOON, stat-cache, committed self-host, production audit, identity,
pack, changelog/date and publish-attestation gates. Exact runner: `npx pm test
pm-vcs-bcgs --run --only-index 4 --progress --pm-context tracker
--override-linked-pm-context`, executing `flock
/tmp/claude-1000/heavy-gate.lock npm run release:check`. CI's locked
`bun install --no-save` also passed. Final PM evidence is bundled again before
the final committed self-host verification. Existing
coverage excludes the benchmark script; that separate source-inventory boundary
remains tracked by pm-vcs-tj07.

Initial exact-head PR CI passed Node 22/26, both Windows launcher checks and
CodeQL at c88f1cf. Reused acceptance criteria now name all three 2026.10.4 pins;
the linked release gate creates the parent of the mandatory shared lock before
acquisition. Sourcery weekly and Cubic monthly quota notices are missing
substantive review evidence; Gemini/Copilot have not replied. These tracker
corrections preserve all runtime behavior, thresholds and publishing gates.

**NOT READY: automated required PR checks remain unresolved.** The requested
GITHUB_TOKEN dispatch executes CI on the exact branch and preserves all four
job names, but [GitHub Docs](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
exclude workflow_dispatch job checks from required PR status-check evaluation.
CodeRabbit correctly identified this boundary. Removing the explicitly requested
dispatch or introducing an owner credential was refused in this certification
scope; the finding stays unresolved.
[pm-vcs-dispatch104](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-dispatch104.toon)
tracks the owner's eligible-event decision. Green normal pull_request CI on this
certification PR does not prove the automatic refresh path clears branch rules.
