# pm-vcs architecture

pm-vcs is a **version control system**. Not a porcelain over git, not a merge driver, not a
helper that shells out to `git merge-file` with better arguments. It has its own object
format, its own hashing, its own refs, its own index, its own diff, its own three-way merge,
its own operation log, and its own distribution format. Nothing in `engine/` executes git,
and nothing it writes is readable by git.

This document is the design of that system: what exists, why each decision was made, and what
is still ahead. It is deliberately explicit about status, because a design document that
describes intentions as if they were behaviour is worse than no document.

---

## 1. Why build one

Git is superb at what it was built for: versioning source files, where the meaningful unit of
change is a line of text.

Almost nothing an agent-run project actually cares about is a line of text. A tracker item is
a record — a status, a priority, a set of tags, an owner, an append-only history. Two agents
working one project on two branches routinely touch two *different fields* of one item. That
is not a conflict under any reasonable definition. Whether git can merge it, though, depends
on how many lines apart those fields happen to be serialized: an accident of file format, not
a property of the change.

The ecosystem's existing answer is to bolt merge drivers onto git so `.toon` items and
`.jsonl` history get field-aware handling. It works, pm-cli ships it, and it is the right
answer for repositories that must stay git repositories. But it is a patch over a mismatch.
The storage layer still thinks in lines; every tool downstream must be told not to; and the
guarantee only holds in a checkout where the drivers were installed — which a fresh clone is
not.

pm-vcs removes the mismatch instead. **A record is a first-class object kind alongside blobs,
trees and commits.** Merging two revisions of a record compares fields. Two agents editing two
different fields converge, always, because there is no line merge anywhere in the pipeline to
go wrong.

That is `project management = context management` pushed down into the storage layer. If
context is the thing worth preserving, the system that versions it should understand its
shape.

### What it learns from, and what it refuses to copy

| system | its best idea | what pm-vcs takes | what it rejects |
| --- | --- | --- | --- |
| **git** | content addressing; the commit DAG; the index as an explicit staging surface | all three | the line as the only merge unit; a plumbing surface an agent has to be trained on |
| **Jujutsu** | the operation log; `undo` as a verb; change ids stable across rewrite; automatic descendant rebase | all four | nothing significant — jj is the closest relative |
| **Subversion** | a single monotonic revision number is genuinely easy to talk about | nothing structural | central state; a working copy that cannot function offline |
| **Fossil / Forgejo** | project metadata belongs *inside* the repository, not in a service beside it | the conviction, and then further: metadata is a native object kind, not a table in an attached database | a bundled web application as the primary interface |
| **Epic Games Lore** | binary-first fragments, stable file identity, sparse instances and atomic remote publication | the general-file and scale invariants | its byte format and mandatory centralized authority |
| **kernel lore / git-send-email** | a change under review is transferable without a forge | the patch series as an object kind | email threading as the data model |

The honest summary of pm-vcs's position: **it is jujutsu's model, with records as a native
object kind, and with the forge's data folded into the repository rather than sitting beside
it.**

### What it is explicitly not

- **Not git-compatible.** Object ids are sha-256 over a different framing; there is no
  packfile format, no `.git` directory, no wire protocol in common. A pm-vcs repository cannot
  be pushed to a git remote and never will be. Compatibility would force the line-merge model
  back in through the object format, which is the entire thing being fixed.
- **Not a replacement for git in this repository.** pm-vcs's own source is versioned in git
  *and* in pm-vcs (§10). Git remains the transport to GitHub, where CI and review live.
- **Not a database.** It stores records because records are content. It does not index them,
  query them, or enforce a schema — `pm` does that, over the checkout.

---

## 2. Layers

```
                     pm CLI  (host: flags, output, extensions)
  ─────────────────────────────────────────────────────────────
   vcs-commands.ts     the command surface: one handler per verb
   index.ts            extension entry; registers commands + git interop
  ─────────────────────────────────────────────────────────────
   engine/repo.ts      the transaction boundary: refs + oplog + worktree
  ─────────────────────────────────────────────────────────────
   engine/worktree.ts  index, status, tree materialization
   engine/attribution.ts stable file identity and PM-linked change traces
   engine/rewrite.ts   change identities and history rewriting
   engine/merge.ts     merge bases, diff3 content merge
   engine/records.ts   per-field record merge
   engine/diff.ts      Myers diff, unified hunks
   engine/bundle.ts    offline history exchange
   engine/remotes.ts   named remotes and tracking-ref naming
   engine/transport.ts the remote boundary: advertise, fetch, push
   engine/sync.ts      fetch, push, clone over any transport
  ─────────────────────────────────────────────────────────────
   engine/model.ts     canonical encoders: tree, commit, record
   engine/refs.ts      refs, HEAD, compare-and-swap
   engine/oplog.ts     the operation log
   engine/objects.ts   content-addressed store
   engine/config.ts    record paths and field policy
   engine/ignore.ts    ignore rules
```

Each layer depends only downward. `engine/` never imports from the command layer, which is
what makes the engine usable as a library and testable without the host.

---

## 3. The object store

Four object kinds: `blob`, `tree`, `commit`, `record`.

An object's id is `sha-256` over `<<type>> <<byte-length>>\0<<payload>>`. The framing is
inside the hash on purpose: without it, a blob and a record holding identical bytes would
share an id, and a tree entry could resolve to the wrong kind.

**Storage** is one deflated file per object at `objects/<<first 2 hex>>/<<rest>>`. Writes go to
a uniquely suffixed temporary file in the destination directory, are `fsync`ed, and are then
`rename`d into place. Rename within a directory is atomic, so a reader sees either no object
or a complete one. A crash mid-write cannot leave truncated bytes under a valid id — which
would otherwise be indistinguishable from corruption forever afterwards. The temp name carries
the pid and random bytes so two processes writing *the same* object cannot collide on one temp
path.

**Reads re-hash.** `read` inflates, re-frames, and compares the hash to the id it was asked
for. The one failure a content-addressed store must never have is returning altered content
silently, so the check is not optional and not sampled.

**Absent is distinguished from unreadable.** Only `ENOENT` produces `object_not_found`; any
other errno is re-raised unchanged. Folding a permission denial into "no such object" would
tell an operator their history had lost content when the disk was merely unreadable, and those
two conditions call for opposite responses.

**Objects are never deleted.** Rewinding a ref makes a commit unreachable, not absent, which
is what makes `undo` always possible. Reclaiming space is Phase 6, and it will be constrained
by the operation log rather than by reachability alone.

### Canonical encoding

Every encoder is canonical: one logical value has exactly one byte representation. This is a
correctness requirement rather than tidiness, because the id *is* the hash of those bytes.

**Canonical does not mean normalised.** NFC and NFD forms of one logical name hash to two ids,
and that is deliberate ([`pm-vcs-ri7n`](.agents/pm/decisions/pm-vcs-ri7n.toon)). A tree entry
name is a filesystem name, and on Linux two files whose names differ only by normalisation form
can both exist in one directory — normalising would fold them into one entry and lose a file.
It would also stop the id being a function of the bytes on disk, so a tree could not be checked
out and re-staged to the same id. For record fields and values the argument is shorter: that is
user data, and a version control system which silently rewrites the data it was asked to
preserve has failed at its only job.

**Decoders enforce what the types claim.** Objects arrive from bundles, so a decoder is a trust
boundary rather than a convenience. `decodeTree` refuses a name that is not one usable path
segment, a duplicate name and a malformed id; `decodeCommit` refuses a repeated singleton
header, because a second one makes the commit's meaning depend on which occurrence a parser
keeps; `decodeRecord` recursively validates nested arrays and objects and refuses non-finite
numbers. Nested objects are necessary for native pm metadata, but casting past validation
would still let a tampered bundle fail later and without attribution during record merge.

- **Trees** sort entries by name in UTF-8 byte order via `compareByteOrder`. Not `<` on
  strings (UTF-16 code unit order, which disagrees for anything above the BMP), and not
  `localeCompare` (locale-sensitive, so the same tree would hash differently under two `LANG`
  settings). Version 2 entries additionally carry stable file identity and optional copy
  provenance; the decoder retains the legacy tree format so identity migration never rewrites
  old history.
- **Commits** are headers then a blank line then the message: `tree`, `change` (Phase 2),
  `parent` (repeated, first-parent first), `author`, `committer`, then canonical repeated
  `item` associations. The timezone offset is stored beside the absolute timestamp rather
  than folded into it, so a commit renders in the zone it was made in without that zone ever
  affecting ordering or the id.
- **Records** are re-serialized with recursively sorted object keys and normalised scalars, so two agents whose
  editors disagree about key order or indentation produce **one** object id. A file whose
  formatting moved does not register as changed. This is not cosmetic: it is what keeps a
  reformat from presenting as a conflict. Native PM `.toon` documents are parsed and rendered
  through the public pm SDK, while configured JSON records retain their canonical JSON form.

---

## 4. Refs, and why every update is compare-and-swap

Refs are files under `refs/heads/` and `refs/tags/`; HEAD is either `ref: refs/heads/<<name>>`
or a raw object id when detached.

Every ref update takes an exclusive lock and is a **compare-and-swap**: the caller states the
value it believes the ref currently holds, and the write fails loudly if that is no longer
true.

This is the single most important concurrency decision in the system. Two agents that read the
same branch tip and both commit on top of it cannot both win. Under last-write-wins, the second
write silently discards the first agent's commit — no error, no report, and the work is only
missing. Under compare-and-swap the second write fails with "re-read and retry", which is a
recoverable condition an agent can act on.

Lock files and temp files are skipped when listing, so a concurrent writer never appears as a
phantom ref.

---

## 5. Index, working tree, status

The index is a versioned flat text file: a `pm-vcs-index 3` header followed by one canonical
JSON tuple per path with mode, object id, stable `FileId`, copy provenance and filesystem
identity. The stat cache records size,
mtime, ctime, device, inode and the time the observation was made. `status` and `add`
therefore `lstat` every indexed path but read and hash content only when that identity
changed. Legacy unversioned and version 2 indexes remain readable and are upgraded by the
next stage; an unknown future version is refused loudly.

Metadata is an optimisation, never an authority. An indexed observation must be at least
two seconds newer than the file metadata it verified, and the current observation must be
another two seconds newer than that cached observation, before a cache hit is possible.
Both comparisons use wall-clock nanoseconds so separate processes and hosts can read the
index, while the metadata-age condition covers common one- and two-second coarse ticks and catches a
same-size rewrite in the same tick even when its mtime is restored. After materialization,
an aged `status` read verifies the bytes and offers the resulting observation to the index.
That refresh compare-and-swaps the exact index snapshot under the shared index lock, so it
cannot overwrite a concurrent `add`; later status calls become metadata-only. Trusting size
and mtime alone here would turn a performance feature into silent content loss.

`status` reports the **three-way** difference — HEAD vs index (staged), index vs working tree
(unstaged), and paths in neither (untracked) — because collapsing those into one list is what
makes a partially staged file impossible to reason about.

Materializing a tree into the working tree is checked before it is performed: a `switch` that
would overwrite an uncommitted edit refuses **before writing anything**. A half-applied switch
leaves an agent holding a tree that matches no commit, with no way to describe what it has,
and no way to get back. Removal is restricted to paths owned by the current index. An
untracked path absent from the target remains untouched, while an untracked path the target
would overwrite is still refused before mutation.

Ignore rules are read on each use rather than cached, because `.pmvcsignore` is itself a
tracked file that a switch can change underneath the running command.

---

## 6. Diff and merge

**Diff** is Myers, over lines for text and over entries for trees, rendered as unified hunks.

**Merge bases** are computed, not assumed. Two branches that have already merged each other
once have several minimal common ancestors; pm-vcs finds all of them and builds a virtual
base. Picking one arbitrarily is how a criss-cross merge silently reintroduces a change that
was already reverted — a failure mode that surfaces weeks later as a bug nobody can attribute.

**Content merge** is diff3 over the aligned regions. A region only one side touched takes that
side. A region both sides changed **identically** is *agreement*, not conflict: two agents
reaching the same conclusion independently is the most common way an automated merge wastes a
human's attention. Only genuine disagreement produces markers.

**Record merge** is per field, and this is the part that matters:

| strategy | rule |
| --- | --- |
| `scalar` (default) | One side changed it, that side wins. Both changed it differently, it conflicts — *alone*. |
| `set` | Both sides' members survive, duplicates collapse, order normalizes. |
| `sequence` | Append-only. Both sides' additions survive in deterministic order. |
| `timestamp` | Both sides must provide valid timestamps; the chronologically latest value wins, with UTF-8 byte order breaking equal-instant ties deterministically. |

A conflict is scoped to the thing that conflicted. A scalar disagreement on `status` conflicts
on `status`; `priority`, `tags` and `history` still merge. A document does not become
unreadable because one value disagreed, and no conflict markers are ever written into a
record — markers would make the record unparseable, which is how a line-merge model turns one
disagreement into a broken file.

---

### Stable file identity and PM attribution

Object identity answers “are these bytes identical?” A `FileId` answers “is this the same
logical file?” pm-vcs stores a cryptographically random 128-bit identity in tree entries.
Edits and unambiguous moves preserve it; copies mint a new identity and retain `copiedFrom`;
deletion keeps the identity discoverable in history. Merge refuses different identities at
one path and duplicate claims of one identity across paths **as resolvable identity conflicts**,
not process-aborting errors. Same-path additions choose the lower identity deterministically;
divergent renames retain both paths, deterministically fork one identity, and record the
original as copy provenance so the merged tree remains valid and auditable. Legacy migration derives identity
from the old path and object ID, so agents upgrading the same checkout independently converge;
filesystem identity preserves a move even when its bytes change before staging.

Commits may carry validated PM item IDs. `engine/attribution.ts` derives file traces from
immutable parent/tree deltas and joins them to the pm SDK's linked-file records. The join is
bidirectional: `vcs files` and `vcs changes` go from PM item to history; `vcs items` goes from
a native revision range back to explicit or file-linked PM work. The derived view is never an
authoritative side database and never mutates a PM item merely because content changed.

The complete Epic Lore research and the retain/adopt/adapt/reject map behind this model are in
[LORE.md](LORE.md).

---

## 7. The operation log

Every command that changes a ref appends one entry: what ran, when, and every ref transition
with its before and after value.

`undo` reverses an operation — refs and working tree together — and is itself an operation, so
it can be undone. This is jujutsu's best idea for agents specifically: "put it back" becomes
one verb instead of a reasoning problem about which object id used to be the tip, which an
agent gets wrong under exactly the conditions where it matters.

The log is append-only JSONL. A line that will not parse is skipped rather than fatal: a
truncated final line from a crash must not make the whole history of operations unreadable.

---

## 8. Distribution

**Today: bundles.** `export` writes selected refs and their history to a single file;
`import` verifies every object against its own id before admitting it. `--since` records
prerequisites, so a receiver lacking them fails loudly instead of importing a history with
holes.

**Shipped: remotes and a transport.** `engine/remotes.ts` stores named remotes in
`remotes.json`, deliberately *not* in `config.json`: config shapes what the history means and
must match in every clone, whereas the remote list is one clone's local knowledge and differs
between agents on the same project. `engine/transport.ts` defines the boundary — `advertise`,
`fetch`, `push` — and ships a filesystem implementation. `engine/sync.ts` holds the algorithms,
written against the interface and never against a path.

Four properties, each of them the reason the obvious implementation is wrong:

- **Fetch writes branches only under `refs/remotes/<<remote>>/`, and never a local branch.**
  A bundle names refs as the sender knows them, so importing one wholesale moves the receiver's
  `main` onto the sender's tip. Fetch therefore takes `importBundleObjects` — the object half of
  an import — and publishes the refs itself. Tags are the deliberate exception and keep their own
  names under `refs/tags`, because a tag identifies a point in history rather than one
  repository's opinion about a line of work. A tag the receiver already uses at another value is
  reported in `conflictingTags` and not moved: a tag names one immutable point, and re-pointing
  it changes what every existing reference to it resolves to.
- **Negotiation is filtered by the receiver, not trusted from the sender.** The fetching side
  offers its branches, tags and every remote's tracking refs as candidate `haves`. The serving
  side keeps only the ones it actually holds — a candidate it has never seen would otherwise be
  used as an exclusion boundary it cannot walk, failing the whole fetch with a missing-object
  error naming an object the caller does have.
- **The fast-forward refusal lives on the receiving side.** The repository being written to is
  the one with something to lose, and a check the sender performs is a check a sender can skip.
- **Compare-and-swap is what makes that check sound.** The refusal is computed against the tip
  the pusher observed; without the swap, a ref that moved in between would be overwritten by a
  verdict that no longer applies to it.

`clone` adopts the source's configuration before writing an object, because a clone that
started from the defaults would store records as blobs and merge them by line — two
repositories sharing commit ids while disagreeing about what those commits contain, each
internally consistent and therefore undetectable.

**Deferred to Phase 5.** A network transport. Committing to a wire format now would fix a
serialization before the forge has said what a served repository exposes, and the two would
have to agree retroactively. The interface is the commitment; the implementation follows it.

---

## 9. The forge, and the patch series

Phase 5, and the reason pm-vcs is scoped as a *system* rather than a tool.

Forgejo's insight is that issues, reviews and project state belong inside the project, not in a
service beside it that a clone cannot see. pm-vcs already stores records natively, so it does
not need an attached database to hold them — a review is a record, an issue is a record, and
both merge per field, which means two reviewers commenting concurrently converge instead of
conflicting.

Kernel lore and `git send-email` show that a change under review can be a first-class,
forge-independent artifact: a patch series exists,
can be transferred, re-derived, and applied, without a server mediating it. pm-vcs makes the
series an object kind rather than a text convention, so "the same series" is an identity
question with an answer instead of a diff comparison.

What that yields, concretely: an agent proposes a series, review state accumulates as records
in the repository, the series is applied, and every part of that exchange survives a clone —
with no forge account, no webhook, and no second source of truth.

---

## 10. pm-vcs versions its own source

Phase 4. The package tracks its own source code in pm-vcs, alongside git, and a CI gate proves
it.

The reason is not showmanship. A version control system whose own repository does not use it
has no evidence behind its claims, and every bug that only appears at real scale — a large
tree, a long history, a rename, a file that stops existing — stays undiscovered. Dogfooding is
the only test that exercises the system against the one workload nobody wrote a fixture for.

The mechanism: the self-hosted history ships as a tracked bundle. A gate imports it into a
scratch repository, re-verifies every object against its own id, and asserts the tip tree is
**byte-identical** to the git-tracked source. Source therefore cannot change without the
pm-vcs history following it, and the check cannot be satisfied by regenerating from a dirty
tree.

The concrete artefacts and their contract:

- **`selfhost.bundle`** is the tracked text bundle, produced by the engine's own `exportBundle`.
  It advertises one ref, `refs/heads/self-host`, whose tip commits the source snapshot. The
  trees inside it use the legacy (FileId-free) encoding, which drops FileId metadata from the
  hash — names, modes and directory structure still contribute, so a tree id is a function of
  the *shape and content* of the source rather than of content alone. Dropping FileId is what
  makes it reproducible: two runs over identical source produce identical tree ids.

  The *bundle file* is not a pure function of the source, though, and it is worth being precise
  about that: it accumulates one commit per regeneration, and each commit carries the `HEAD` sha
  in its message. Identical source with a different history therefore yields a different bundle.
  The gate does not compare bundle bytes — it compares the tip **tree** id, which is the part
  that is determined by the source.
- **`self-host.json`** is the gate's data file. It records the bundle path, names the ref, and
  holds the **exclusion set**: the *tracked* paths deliberately kept out of the history. The
  exclusion set is data, not scattered literals — the only entry is the bundle file itself,
  which cannot contain itself, and that entry is **required**, because omitting it makes every
  regeneration fold the previous bundle into its own source tree.

  The bundle path here is **recorded, not obeyed**: it is checked against a constant in
  `scripts/self-host.ts` and rejected if it disagrees. This file ships with the source, so a
  pull request can set any value in it; letting that value choose a write target made `--write`
  a write primitive aimable at `README.md` or `.git/hooks/pre-commit`. Git-ignored paths (`dist/`, `coverage/`, `node_modules/`) never appear in
  `git ls-files` and need no entry. A tracked path in neither the bundle nor the exclusion set
  fails the gate closed.
- **`npm run self-host:write`** regenerates the bundle. It snapshots the current source, appends
  one commit when the tree changed and leaves the history untouched when it has not, and writes
  the file. It is the **only** path that writes the bundle.
- **`npm run accept:self-host`** is the gate, and it **never writes**. It reads the **committed**
  bundle and the **committed** source both straight out of `HEAD` — the bundle through
  `git cat-file`, the source through a detached `git worktree` — so a dirty working tree cannot
  affect the verdict and regenerating the bundle without committing it changes nothing. The
  configuration and the tracked-path list are read from that extracted worktree too, not from the
  checkout: an uncommitted edit to `self-host.json` could otherwise exclude a committed path, and
  a staged add or delete could move `git ls-files` without moving the extracted tree. `git` is the
  only external binary involved; an earlier `git archive | tar` pipe was removed because nothing
  on Windows exercised it while the gate sits inside `release:check` and `prepublishOnly`.

  It enumerates the source with `git ls-files -z` (NUL-delimited, because a newline is legal in a
  path), drops the exclusion set, rebuilds the source tree through the engine's `buildTree`, and
  imports the bundle through `importBundleObjects` — **into an object store of its own**. That
  isolation is the self-containment proof: sharing a store with the source side would let a
  bundle missing an object borrow the bytes from the source and still resolve. The full ancestry
  is walked from the tip, so a missing ancestor commit is a hard read failure rather than an
  unnoticed truncation, and blob presence is asserted explicitly, because flattening a tree reads
  the tree objects and never the content behind them.

  Finally it asserts the bundle's tip tree id equals the source tree id. Because canonical trees
  hash every name, mode and blob id beneath them, that hash equality is the byte-exactness proof:
  it covers content and mode together, with no line-ending normalisation anywhere in the path.

Git remains the transport to GitHub. The claim is not that pm-vcs replaces git here; it is
that pm-vcs correctly versions a real, active codebase — and that the repository can prove it
on every commit.

---

## 11. Status

| capability | comparable to | state |
| --- | --- | --- |
| content-addressed store, four object kinds | git objects | **shipped** |
| canonical tree/commit/record encoding | git objects | **shipped** |
| refs, HEAD, compare-and-swap updates | git refs + `--force-with-lease`, always on | **shipped** |
| index, three-way status, safe checkout | git index / `switch` | **shipped** |
| Myers diff, unified hunks | `git diff` | **shipped** |
| all minimal merge bases, virtual base | `git merge-base --all` | **shipped** |
| diff3 content merge, identical-edit agreement | `git merge-file` | **shipped** |
| **per-field record merge** | nothing in git | **shipped** |
| operation log, `undo` | `jj op log` / `jj undo` | **shipped** |
| bundles with prerequisites | `git bundle` | **shipped** |
| integrity verification | `git fsck` | **shipped** |
| ignore rules | `.gitignore` | **shipped** |
| change ids stable across rewrite | `jj` change ids | **shipped** |
| describe / rebase / squash / split | `jj` / `git rebase -i` | **shipped** |
| cherry-pick / revert / reset / restore | git equivalents | **shipped** |
| automatic descendant rebase | `jj` | **shipped** |
| stable file IDs across edit/move/copy/delete | Epic Games Lore | **shipped** |
| PM item ↔ native file/change attribution | pm SDK | **shipped** |
| remotes, clone, fetch, push | git transport | **shipped** |
| self-hosted source, CI-gated | — | **shipped** |
| patch series as an object | kernel lore / `git format-patch` | **Phase 5** |
| review + issues as native records | Forgejo, but in-repository | **Phase 5** |
| served repository | Forgejo / `git daemon` | **Phase 5** |
| packed storage, reachability index | git packfiles | **Phase 6** |
| shallow / partial history | git `--depth` / partial clone | **Phase 6** |
| garbage collection bounded by the oplog | `git gc`, but oplog-aware | **Phase 6** |
| fragmented large files, sparse/lazy instances | Epic Games Lore | **Phase 6** |
| conflicts stored in commits | `jj` conflict objects | **considered, not scheduled** |
| signed commits | git signing | **considered, not scheduled** |
| submodules / large-file offloading | git submodules / LFS | **rejected for now** |

Each phase is tracked as an epic in this repository's own tracker, under
[`pm-vcs-tr2a`](.agents/pm/epics/pm-vcs-tr2a.toon):

| phase | epic |
| --- | --- |
| 2 — change identities and history rewriting | [`pm-vcs-ijj7`](.agents/pm/epics/pm-vcs-ijj7.toon) |
| 3 — distribution over a real transport | [`pm-vcs-wm40`](.agents/pm/epics/pm-vcs-wm40.toon) |
| 4 — pm-vcs versions its own source | [`pm-vcs-390t`](.agents/pm/epics/pm-vcs-390t.toon) |
| 5 — the forge and the patch series | [`pm-vcs-5h6j`](.agents/pm/epics/pm-vcs-5h6j.toon) |
| 6 — scale | [`pm-vcs-b7cb`](.agents/pm/epics/pm-vcs-b7cb.toon) |

---

## 12. Git interoperability, and why it is quarantined

Three commands — `vcs git preflight`, `vcs git preview`, `vcs git items` — reason about a git
checkout: whether its merge drivers are installed, what merging a ref would do to tracker data
per item and per field, and which pm items a commit range touched. They exist because pm items
today mostly live in git repositories, and refusing to help there would be dogma.

They live in `git.ts`, `preflight.ts`, `preview.ts` and `ledger.ts` — **never in `engine/`**.
The engine has no git dependency and must keep none, so that the boundary stays a fact about
the code rather than an intention in a document.

---

## 13. Testing

The c8 gate instruments all production TypeScript with `--all` and requires 100% statements,
branches, functions, and lines. A source file that no test loads is therefore measured at zero
instead of disappearing from the report. ESLint separately rejects unsafe and non-erasable
TypeScript syntax, the docstring gate requires production declarations to explain their public
contract, and jscpd fails on any duplicated production block.

Tests build real repositories in temporary directories through the real engine and drive
commands through the host's real extension loader (`createExtensionTestHarness`). There are no
api doubles: asserting against a double of the host asserts against this package's assumptions
about the host rather than against the host.

An unreachable branch is not suppressed. It is either made reachable — which is how the
`ObjectStore.read` errno defect in §3 was found — or deleted along with a written-down
invariant explaining why it cannot happen.
