# Changelog

## 2026.7.30 - 2026-07-31

### Added

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

- Phase 2: change identities and history rewriting ([pm-vcs-ijj7](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/epics/pm-vcs-ijj7.toon))

### Fixed

- Initialize pm-vcs at the source workspace outside Git ([pm-vcs-c590](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-c590.toon))
- A VCS with no ignore mechanism can stage and then overwrite another VCS's control directory ([pm-vcs-aujy](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-aujy.toon))

### Other

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
