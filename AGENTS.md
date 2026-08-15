# AGENTS.md

## Why dependency bots cannot update this package alone

The `release:check` gate includes `accept:self-host`, which reads the committed `selfhost.bundle` and the committed source out of `HEAD` and rejects any byte difference. Only `npm run self-host:write` regenerates the bundle, and a dependency bot cannot run that step. So when Dependabot edits `package.json` and `package-lock.json`, the bundle stops matching the source and the gate fails on every PR — including security patches. A dependency bump must always be accompanied by `npm run self-host:write` and the regenerated `selfhost.bundle` committed in the same commit as the lockfile change. The `dependency-refresh.yml` workflow automates this so a scheduled job, not a bot, produces mergeable refresh PRs.