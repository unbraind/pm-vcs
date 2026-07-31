# Changelog

## 2026.7.30 - 2026-07-31

### Added

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

### Fixed

- A VCS with no ignore mechanism can stage and then overwrite another VCS's control directory ([pm-vcs-aujy](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/issues/pm-vcs-aujy.toon))

### Other

- pm-vcs is not git-compatible, and that is the point ([pm-vcs-ljkx](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/decisions/pm-vcs-ljkx.toon))
- 100/100/100 coverage test suite for pm-vcs engine ([pm-vcs-m6ld](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/tasks/pm-vcs-m6ld.toon))
- pm-vcs: branch-aware merge safety for pm trackers ([pm-vcs-ghql](https://github.com/unbraind/pm-vcs/blob/main/.agents/pm/epics/pm-vcs-ghql.toon))
