# Changelog

## Unreleased

### Added

- Add scripts/self-host.ts to coverageGate.sources and bring it to 100/100/100 ([pm-vcs-4t67](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-4t67.toon))
- Clone builds a working tree from a remote and inherits its record configuration ([pm-vcs-jj9r](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-jj9r.toon))
- Push refuses a non-fast-forward and lands every ref under compare-and-swap ([pm-vcs-64x4](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-64x4.toon))
- Fetch with object negotiation computed from reachability ([pm-vcs-hi5k](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-hi5k.toon))
- Named remotes and remote-tracking refs ([pm-vcs-h8x2](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-h8x2.toon))
- Give arbitrary files stable identities and native PM-linked change attribution ([pm-vcs-ag8y](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-ag8y.toon))
- Stat cache skips stable paths and hashes metadata changes or racy timestamps ([pm-vcs-47zn](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-47zn.toon))
- Change identities and history rewriting ([pm-vcs-bddk](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-bddk.toon))
- Bundle export and import so two repositories exchange history ([pm-vcs-o5e3](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-o5e3.toon))
- Operation log and undo ([pm-vcs-48sr](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-48sr.toon))
- Working tree, index and status ([pm-vcs-lofj](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-lofj.toon))
- Per-field record merge so structured data never line-merges ([pm-vcs-48q3](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-48q3.toon))
- Merge base over the commit DAG and three-way content merge ([pm-vcs-zrxk](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-zrxk.toon))
- Myers diff and unified hunks over lines and trees ([pm-vcs-g7sy](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-g7sy.toon))
- Refs, HEAD and compare-and-swap branch updates ([pm-vcs-00nv](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-00nv.toon))
- Content-addressed object store: blobs, trees, commits and records ([pm-vcs-9c77](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-9c77.toon))
- pm vcs items: map a commit range onto the pm items it touched ([pm-vcs-jeun](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-jeun.toon))
- pm vcs preview: predict a merge's per-field resolution before running it ([pm-vcs-7nbo](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-7nbo.toon))
- pm vcs preflight: turn silent merge-driver absence into a loud, remediable failure ([pm-vcs-pty0](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/features/pm-vcs-pty0.toon))

### Changed

- Regenerate selfhost.bundle for the updated source ([pm-vcs-3nxa](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-3nxa.toon))
- Phase 2: change identities and history rewriting ([pm-vcs-ijj7](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/epics/pm-vcs-ijj7.toon))

### Fixed

- Fix NODE_V8_COVERAGE lcov corruption in test helpers ([pm-vcs-lapg](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-lapg.toon))
- The 100 percent branch gate rested on an incidental execution, so an unrelated change failed CI on Node 26 only ([pm-vcs-8e8k](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-8e8k.toon))
- A fetched branch can be neither named nor listed, so the push refusal's own remediation cannot be followed ([pm-vcs-dh19](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-dh19.toon))
- Make the release gate deterministic: a clock-dependent changelog date and a branch V8 reported inconsistently ([pm-vcs-ehvf](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-ehvf.toon))
- Harden the distribution surface against the review findings: one base for clone, atomic remotes, and a bounded push namespace ([pm-vcs-6220](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-6220.toon))
- Switch removes untracked paths absent from the target tree ([pm-vcs-c5pg](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-c5pg.toon))
- Refresh verified stat cache after materialization without trusting concurrent bytes ([pm-vcs-v4z8](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-v4z8.toon))
- Documented TOON record paths fail staging because the record codec accepts JSON only ([pm-vcs-l8jv](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-l8jv.toon))
- Close PR 3 transactional rewrite data-integrity findings ([pm-vcs-ntht](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-ntht.toon))
- A mode-only change produces an empty diff, so an executable bit can move invisibly ([pm-vcs-pxgl](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-pxgl.toon))
- Initialize pm-vcs at the source workspace outside Git ([pm-vcs-c590](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-c590.toon))
- A VCS with no ignore mechanism can stage and then overwrite another VCS's control directory ([pm-vcs-aujy](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-aujy.toon))

### Other

- Port the parser-backed docstring gate into pm-vcs ([pm-vcs-yaks](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/chores/pm-vcs-yaks.toon))
- Cover the Git identity release audit in the exact source gate ([pm-vcs-ol9m](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-ol9m.toon))
- Upgrade upload-artifact to v7 without breaking the self-host gate ([pm-vcs-qzy7](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/chores/pm-vcs-qzy7.toon))
- Gate CI on strict tracked pm project health ([pm-vcs-kwlz](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/chores/pm-vcs-kwlz.toon))
- Phase 4: pm-vcs versions its own source ([pm-vcs-390t](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/epics/pm-vcs-390t.toon))
- Address the PR \#10 bot review: fixture-only main, shared git runner, no external chmod ([pm-vcs-stp3](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-stp3.toon))
- Self-host tests + CI + changelog wiring ([pm-vcs-hbmy](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-hbmy.toon))
- Self-host exclusion-set config + committed bundle ([pm-vcs-f0yw](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-f0yw.toon))
- Self-host write/regenerate script ([pm-vcs-sd7h](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-sd7h.toon))
- Self-host verify-only gate script ([pm-vcs-r7h2](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-r7h2.toon))
- Phase 3: distribution over a real transport ([pm-vcs-wm40](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/epics/pm-vcs-wm40.toon))
- The transport is an interface with a filesystem implementation, not a network protocol yet ([pm-vcs-6qva](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/decisions/pm-vcs-6qva.toon))
- Research Epic Lore and map its general-VCS design into pm-vcs ([pm-vcs-rmqh](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-rmqh.toon))
- Implement show operation ([pm-vcs-z400](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-z400.toon))
- Implement restore operation ([pm-vcs-zdrk](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-zdrk.toon))
- Implement reset operation ([pm-vcs-lccx](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-lccx.toon))
- Implement revert operation ([pm-vcs-64sz](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-64sz.toon))
- Implement cherry-pick operation ([pm-vcs-4jwm](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-4jwm.toon))
- Implement split operation ([pm-vcs-8zdp](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-8zdp.toon))
- Implement squash operation ([pm-vcs-2fo2](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-2fo2.toon))
- Implement rebase operation ([pm-vcs-167g](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-167g.toon))
- Implement describe operation ([pm-vcs-eqo5](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-eqo5.toon))
- Adopt current pm SDK and release-tooling dependencies in Phase 2 ([pm-vcs-zj42](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/chores/pm-vcs-zj42.toon))
- Close the last five branch arms in the history-rewriting slab ([pm-vcs-63kd](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-63kd.toon))
- Retain explicit topological ordering for rewrite ranges ([pm-vcs-6ihf](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/decisions/pm-vcs-6ihf.toon))
- Rename the git interoperability commands under a pm vcs git prefix ([pm-vcs-nzw9](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-nzw9.toon))
- Canonical encoders do not normalise Unicode ([pm-vcs-ri7n](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/decisions/pm-vcs-ri7n.toon))
- pm-vcs is not git-compatible, and that is the point ([pm-vcs-ljkx](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/decisions/pm-vcs-ljkx.toon))
- 100/100/100 coverage test suite for pm-vcs engine ([pm-vcs-m6ld](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-m6ld.toon))
- pm-vcs: branch-aware merge safety for pm trackers ([pm-vcs-ghql](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/epics/pm-vcs-ghql.toon))
