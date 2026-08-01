# pm-vcs

**A version control system written from scratch, in TypeScript, on the pm SDK — for projects
whose most important content is structured, not textual.**

Not a git wrapper. Not a helper around `git merge`. pm-vcs has its own content-addressed
object store, its own refs, its own index, its own diff, its own three-way merge, its own
operation log and its own distribution format. No code path in the engine shells out to `git`,
and nothing it writes is git-compatible.

The scope is the whole system — the storage and history model of git, the rewriting and
operation-log model of jujutsu, and the conviction Fossil, Forgejo and lore share that a
project's own metadata and its changes under review belong *inside* the repository rather than
in a service beside it. All of it written from scratch on the pm SDK, around one primitive git
does not have: **the record**.

**[ARCHITECTURE.md](ARCHITECTURE.md) is the design document** — every decision, why it was
made, and an honest per-capability statement of what is shipped and what is still ahead. Read
it before the command table if you want to know what this actually is.

```bash
npm install --save-dev pm-vcs     # or: bun add -d pm-vcs
pm install pm-vcs
pm vcs init
```

---

## Why write another version control system

Git is superb at what it was built for. It was built for source files, and its merge is a
merge of *lines*.

Almost everything a team's context actually lives in is not lines. A tracker item is a
record: a status, a priority, a set of tags, an assignee, an append-only history. Two agents
working the same project on two branches routinely touch two *different fields* of one item.
That is not a conflict in any meaningful sense — but whether git can merge it depends on how
many lines apart the fields happen to be serialized, which is an accident of the file format
rather than a property of the change.

The ecosystem's existing answer is to bolt merge drivers onto git so that `.toon` items and
`.jsonl` history get field-aware handling. That works, and pm-cli ships it. But it is a patch
over a mismatch: the storage layer still thinks in lines, and every tool downstream has to be
told not to.

**pm-vcs removes the mismatch instead of patching it.** A record is a first-class object kind
alongside blobs, trees and commits. Merging two revisions of a record compares fields, not
lines. Two agents editing two different fields converge, always, with no line-merge hazard
anywhere in the pipeline — because there is no line merge in the pipeline.

This is the philosophy the rest of the ecosystem is built on —
**project management = context management** — pushed down into the storage layer. If context
is the thing worth preserving, the system that versions it should understand its shape.

### Where it sits among the systems it learns from

| | versions | merge unit | pm-vcs takes |
| --- | --- | --- | --- |
| **git** | file trees | lines | content addressing, the commit DAG, the object model |
| **Subversion** | file trees | lines | nothing structural; a cautionary tale about central state |
| **Jujutsu** | file trees | lines | the operation log, and `undo` as a first-class verb |
| **Fossil / Forgejo** | files + project metadata | lines / a database | the conviction that project metadata belongs *inside* the VCS |
| **pm-vcs** | file trees **and records** | **fields**, then lines | — |

Jujutsu's operation log is the best idea in modern version control for agents: every command
is recorded, so "put it back" is one verb rather than a reasoning problem about which id was
the old tip. pm-vcs has it. Fossil is right that issues and project state belong in the
repository rather than beside it — pm-vcs goes further and makes them a native object kind
rather than a table in an attached database.

---

## Designed for many agents on one project

Every decision below exists because the expected user is several autonomous agents working
concurrently, not one person at a keyboard.

**Ref updates are compare-and-swap under an exclusive lock.** Two agents that read the same
branch tip and both commit on top of it cannot both win. The second write fails, loudly, and
says to re-read and retry. A last-write-wins ref update is precisely how one agent's commit
disappears with nothing anywhere reporting it.

**Identical concurrent edits are agreement, not conflict.** Two agents reaching the same
conclusion independently is the most common way an automated merge wastes attention. pm-vcs
merges it cleanly.

**A conflict is scoped to the thing that conflicted.** A genuine scalar disagreement on one
field conflicts *on that field*, and every other field of that record still merges. A
document does not become unreadable because one value disagreed.

**Merge bases are computed, not assumed.** Two branches that have already merged each other
once have several minimal common ancestors. pm-vcs finds all of them and builds a virtual
base. Picking one arbitrarily is how a criss-cross merge silently reintroduces a change that
was already reverted.

**Nothing is destroyed before it is known to succeed.** A switch that would overwrite an
uncommitted edit refuses *before writing anything*. A half-applied switch leaves an agent
with a tree matching no commit and no way to describe what it has.

**Objects are never removed**, so `undo` is always possible. Rewinding a ref makes a commit
unreachable, not absent.

---

## Commands

### The repository

```console
$ pm vcs init --record-path '.agents/pm/**/*.toon' --set-field 'tags:set,history:sequence'
$ pm vcs add
$ pm vcs commit --message "Close the deployment item"
$ pm vcs log --limit 10
$ pm vcs diff main feature
```

| command | what it does |
| --- | --- |
| `pm vcs init` | Create a repository. `--record-path` declares which paths hold structured records; `--set-field` declares how their fields merge. |
| `pm vcs status` | The three-way difference between HEAD, the index and the working tree. Stable indexed paths are checked from stat metadata without re-reading content; racy timestamp-window entries are always hashed. |
| `pm vcs add [paths…]` | Stage paths, or everything. A path that no longer exists stages as a deletion. |
| `pm vcs commit --message` | Record the index. Refuses an empty commit unless `--allow-empty`. |
| `pm vcs log [rev]` | First-parent history, newest first. |
| `pm vcs diff [from] [to]` | Unified diff between two revisions' trees. |
| `pm vcs branch [name]` | List, create (`--at`) or delete (`--delete`) branches. |
| `pm vcs switch <rev>` | Move HEAD and update the working tree. Refuses rather than overwrite uncommitted work. |
| `pm vcs merge <rev>` | Three-way merge. `--fail-on-conflict` to gate CI. |
| `pm vcs tag [name]` | List or create tags. |
| `pm vcs undo` | Reverse a recorded operation, refs and working tree together. |
| `pm vcs oplog` | Every operation, with the refs it moved and where from. |
| `pm vcs export <file>` | Write refs and their history to a bundle. |
| `pm vcs import <file>` | Import a bundle, verifying every object against its own id. |
| `pm vcs verify` | Re-read every reachable object and check it against its id. |

### Git interoperability

pm items today mostly live in git repositories, and pm-vcs can reason about that without
being git. These three are the only commands that touch git:

| command | what it does |
| --- | --- |
| `pm vcs git preflight` | Can *this* git checkout merge tracker data field-aware? |
| `pm vcs git preview <ref>` | What would merging `<ref>` do to tracker data, per item and per field? |
| `pm vcs git items <range>` | Which pm items did this commit range create, modify and close? |

---

## The part that matters: per-field merge

Declare which paths hold records and how their fields reconcile:

```console
$ pm vcs init --record-path 'items/*.json' --set-field 'tags:set,history:sequence'
```

Two agents, on two branches, edit the same item:

```jsonc
// base
{ "id": "pm-1", "title": "Ship the thing", "status": "open",
  "priority": 3, "tags": ["area:vcs"], "history": ["created"] }

// agent A closes it
{ …, "status": "closed", "history": ["created", "closed by A"] }

// agent B retitles and reprioritises it
{ …, "title": "Ship the thing (revised)", "priority": 1,
      "tags": ["area:vcs", "urgent"], "history": ["created", "retitled by B"] }
```

```console
$ pm vcs merge agent-b
merge:
  kind: "merged"
  clean: true
  conflicts: []
```

```jsonc
{ "history": ["created", "closed by A", "retitled by B"],
  "id": "pm-1", "priority": 1, "status": "closed",
  "tags": ["area:vcs", "urgent"], "title": "Ship the thing (revised)" }
```

Every change survived. No conflict markers exist anywhere, because no line merge ran.

### Field strategies

| strategy | rule |
| --- | --- |
| `scalar` (default) | One side changed it, that side wins. Both changed it differently, it conflicts — alone. |
| `set` | Both sides' members survive, duplicates collapse, order normalised. |
| `sequence` | Append-only. Both sides' additions survive in deterministic order. |

A genuine disagreement still conflicts, and says exactly what disagreed:

```console
$ pm vcs merge y --fail-on-conflict
Error: Merging y left 1 conflict(s): items/pm-1.json (status)
```

`priority`, `tags` and `history` merged. Only `status` is unresolved.

### Records are canonicalised on the way in

A configured record path is parsed and re-encoded canonically when staged, so two agents
whose editors disagree about key order or indentation produce **one object id**. A file whose
formatting moved does not register as changed. This is not cosmetic: it is what keeps a
reformat from presenting as a conflict.

---

## How it is built

```
engine/objects.ts    SHA-256 content addressing over `<type> <byteLength>\0<payload>`.
                     zlib loose objects, temp-file-and-rename writes. Reads re-hash rather
                     than trusting the filename, so silent corruption is detectable.
engine/model.ts      Canonical encodings for trees, commits and records. Trees sort by byte
                     order, never locale collation — a tree must not hash two ways under two
                     LANG settings.
engine/refs.ts       Branches, tags, HEAD (symbolic or detached), compare-and-swap updates.
engine/diff.ts       Myers O(ND) line diff, hunk grouping, unified rendering.
engine/merge.ts      Commit-DAG reachability, minimal merge bases, diff3 content merge.
engine/records.ts    Per-field record merge; append-only log union.
engine/worktree.ts   Versioned index with racy-clean-safe stat caching, working-tree scan,
                     tree materialization, and three-way status.
engine/ignore.ts     An always-ignored set plus `.pmvcsignore`.
engine/config.ts     Which paths hold records and how their fields merge — per repository,
                     so two agents cannot disagree about it.
engine/oplog.ts      Append-only operation log; `undo`.
engine/bundle.ts     Export and import, verifying every object against its own id.
engine/repo.ts       The porcelain.
```

### Repository layout

```
.pmvcs/
  format          repository format version
  HEAD            "ref: refs/heads/main", or a raw object id when detached
  config.json     record paths and field strategies
  index           the staging area
  refs/heads/*    branch tips
  refs/tags/*
  objects/ab/cd…  zlib-deflated, content-addressed by SHA-256
  oplog.jsonl     append-only operation log
```

### The four object kinds

| kind | holds |
| --- | --- |
| `blob` | raw bytes |
| `tree` | sorted `(mode, name, id)` entries |
| `commit` | a tree, zero or more parents, author, committer, message |
| `record` | **a structured document as canonically ordered fields** |

`record` is the one git does not have, and the reason this system exists.

---

## Safety

pm-vcs is usually initialised *inside* an existing checkout, so it treats the working tree as
something it shares rather than owns.

`.git`, `.hg`, `.svn`, `.bzr`, `_darcs`, `CVS` and `node_modules` are **always** ignored and
**cannot be re-included** — not by `.pmvcsignore`, and not by a commit whose tree names a path
inside them. Materialization filters the target tree, so history recorded before the rules
existed still cannot write over another tool's state. This is pinned by a test that builds a
deliberately hostile commit naming `.git/HEAD` and asserts it materializes to nothing.

`.pmvcsignore` adds project patterns with gitignore-like semantics: `#` comments, a trailing
slash for a directory, a pattern without `/` matching by basename at any depth, and `!` to
re-include. Staging an ignored path *by name* is refused rather than skipped — staging
nothing while reporting success is how a commit ends up missing a file.

---

## Distribution

There is no network protocol *yet* — remotes, `clone`, `fetch` and `push` are Phase 3. Until
then a bundle is one text file, which is a transport every agent already has:

```console
$ pm vcs export /tmp/work.bundle --ref refs/heads/feature
$ pm vcs import /tmp/work.bundle          # in another repository
```

Import reproduces **identical commit ids**, verifies every object against its own hash before
storing it, and fails whole — naming the missing ids — when a bundle depends on history the
receiver does not have. A file that can be copied, attached or piped is the transport an
agent already has, and it works the same between two directories on one host, between a job
and its runner, and across a review.

---

## Roadmap

Everything below is tracked as an epic in this repository's own tracker, under
[`pm-vcs-tr2a`](.agents/pm/epics/pm-vcs-tr2a.toon). The per-capability status table lives in
[ARCHITECTURE.md §11](ARCHITECTURE.md#11-status).

| phase | what it adds | epic |
| --- | --- | --- |
| **2** | Change identities that survive rewriting, plus `describe`, `rebase`, `squash`, `split`, `cherry-pick`, `revert`, `reset`, `restore`, and automatic descendant rebase | [`pm-vcs-ijj7`](.agents/pm/epics/pm-vcs-ijj7.toon) |
| **3** | Named remotes, remote-tracking refs, and `clone`/`fetch`/`push` over a transport with reachability-based negotiation | [`pm-vcs-wm40`](.agents/pm/epics/pm-vcs-wm40.toon) |
| **4** | pm-vcs versioning its own source, with a CI gate proving the tracked history matches the source tree byte for byte | [`pm-vcs-390t`](.agents/pm/epics/pm-vcs-390t.toon) |
| **5** | The forge: a patch series as an object kind, review state as records, and a served repository | [`pm-vcs-5h6j`](.agents/pm/epics/pm-vcs-5h6j.toon) |
| **6** | Scale: packed storage, a reachability index, shallow and partial history, and garbage collection bounded by the operation log | [`pm-vcs-b7cb`](.agents/pm/epics/pm-vcs-b7cb.toon) |

---

## Requirements

- Node.js ≥ 22.18 (`engines`), tested on 22 and 26
- `@unbrained/pm-cli` ≥ 2026.7.29 (peer dependency)
- Works under `npm`/`npx` and `bun`/`bunx`
- No runtime dependencies beyond the Node standard library

## Development

```bash
npm ci
npm run check        # typecheck
npm run coverage     # the suite behind a 100/100/100 gate
npm run release:check
```

The coverage gate walks the source tree and fails when a file is **absent** from the report,
not only when it is under threshold. Node omits never-loaded files entirely, so an untested
module would otherwise pass a 100% threshold by not being measured.

Tests run against real repositories and real filesystems. There are no mocks and no
hand-built `api` doubles: this is filesystem and merge code, and a fake of either would only
assert against the suite's own assumptions.

## Known upstream issues this package works around

- [unbraind/pm-cli#825](https://github.com/unbraind/pm-cli/issues/825) — `FlagDefinition`'s
  index signature defeats excess-property checking, so a misnamed flag field type-checks and
  then aborts activation, dropping every later sibling command. Flags here use `long` /
  `value_name` / `value_type`.
- [unbraind/pm-cli#826](https://github.com/unbraind/pm-cli/issues/826) — an extension command
  cannot both return a structured report and exit non-zero, and a thrown handler error's
  remediation is replaced by a generic line. Gate commands therefore throw, with the
  remediation folded into the message.
- [unbraind/pm-cli#832](https://github.com/unbraind/pm-cli/issues/832) — pm-cli bundles a
  private `pm-vcs` exemplar that claims the `vcs` alias and registers `vcs log` / `vcs merge`,
  with no way for a package author to detect the collision. Enabling both in one workspace is
  not supported.

## License

MIT
