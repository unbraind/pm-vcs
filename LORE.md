# Epic Games Lore research

This document records what pm-vcs learns from **Epic Games' Lore VCS**. It refers to
[EpicGames/lore](https://github.com/EpicGames/lore), not
[lore.kernel.org](https://lore.kernel.org/), the Linux community's email archive. The two
systems solve different problems and are deliberately kept separate here.

Research date: 2026-08-01. Lore was pre-1.0 (`v0.8.6`), so this is an architecture input,
not a compatibility promise.

## Primary sources

- [Repository and implementation](https://github.com/EpicGames/lore)
- [System design](https://epicgames.github.io/lore/explanation/system-design/)
- [CLI reference](https://epicgames.github.io/lore/reference/lore-cli-commands/)
- [CLI configuration](https://epicgames.github.io/lore/reference/lore-cli-config/)
- [Quickstart](https://epicgames.github.io/lore/tutorials/quickstart/)
- [Glossary](https://epicgames.github.io/lore/glossary/)
- [Roadmap](https://epicgames.github.io/lore/roadmap/)
- [FastCDC decision](https://epicgames.github.io/lore/developing/decisions/00001-fast-cdc/)
- [Mutable branch-state decision](https://epicgames.github.io/lore/developing/decisions/00002-branch-tracking-in-mutable-store/)
- [View-independent merge decision](https://epicgames.github.io/lore/developing/decisions/00018-view-independent-merges-and-subtree-grafting/)

## What Lore is

Lore is a general, binary-first VCS designed for very large repositories and game-production
assets. Its public architecture separates two systems behind one API:

1. A storage system holds immutable, content-addressed fragments plus a small mutable
   key-value namespace. It does not understand files, revisions or branches.
2. A version-control system builds files, Merkle trees, revisions, staging, branches,
   working-copy instances, merges and synchronization from those primitives.

The API is the product boundary; CLI and server processes are consumers. This is the same
boundary pm-vcs requires: storage and repository operations must be usable directly from
TypeScript, while the pm extension remains a thin command adapter.

## Storage and scale

Lore addresses immutable fragments by BLAKE3. Mutable repository and branch lookups live
outside that immutable store and advance separately. Fixed-size tree nodes and node blocks
support structural sharing and targeted traversal rather than requiring a complete tree to
be decoded for every operation.

File payloads are opaque bytes. Text behavior is layered above storage, not embedded into its
identity model. Lore uses content-defined fragmentation, with FastCDC selected to preserve
deduplication when bytes are inserted near the start of a large file, and compression is a
storage concern rather than part of the uncompressed content identity. This enables resumable
transfer, range reads and reuse of fragments across revisions.

pm-vcs already stores arbitrary bytes and keeps text diff/merge above its object store. Its
current loose-object design still stores one whole file as one blob. It therefore retains the
binary-first boundary and defers these scale additions until they are benchmarked in
TypeScript:

- streaming object reads and writes;
- content-defined and fixed-size fragment strategies;
- fragment-list objects carrying byte offsets;
- compression metadata independent of logical identity;
- range reads and resumable fragment transfer; and
- binary viewers and merge adapters above storage.

Copying Lore's byte format or constants is explicitly rejected. pm-vcs has its own versioned,
canonical format and SHA-256 object identities.

## Revisions, branches and identity

Lore revisions reference Merkle-tree state and parent revisions. Branch identity is an opaque,
stable identifier separate from a mutable display name. Mutable branch state is stored outside
the immutable revision graph and publication advances it atomically.

Lore also carries stable context beside file content. A path answers where content is in one
revision; a file identity answers which logical file it is across revisions. That distinction
is essential for renames, copies, locking and lifecycle deletion.

pm-vcs adopts that invariant with a native 128-bit `FileId` in versioned tree entries:

- a new file receives a cryptographically random identity;
- an unambiguous move preserves identity;
- a copy receives a new identity and records `copiedFrom` provenance;
- content edits and mode changes preserve identity;
- deletion leaves the historical identity traceable; and
- merge rejects both different identities at one path and one identity claimed by two paths.

Legacy trees remain readable. Identity is added when a legacy file is staged, so migration is
incremental and does not rewrite old history. That migration identity is derived from the
legacy path and object ID, ensuring two agents independently migrating the same file converge;
new files still receive random identities. Filesystem identity also preserves `FileId` when a
rename and content edit happen before the same stage operation.

## Working-copy instances and sparse views

Lore instances materialize views of a repository. View rules govern inbound materialization;
ignore rules govern outbound staging. Immutable content can be cached and shared while each
instance keeps independent branch, staging and dirty state. Missing data can be fetched lazily.

pm-vcs should adopt sparse instances only after remote object reads and fragmented storage
exist. A view may change what is materialized, never the committed root-tree identity. Merge
must operate on full trees even when the instance sees a subset, and conflicts outside the
view must remain visible. Shared immutable stores must not imply shared HEAD, index, view,
dirty state or operation log.

## Remotes and concurrency

Lore uses an authoritative remote for canonical branch pointers, authorization and durability,
while ordinary editing remains local. Publication uploads immutable content first and advances
the mutable branch pointer last. Interrupted uploads can resume; unattached uploaded fragments
are harmless; a raced pointer update refuses.

pm-vcs adapts this to per-remote authority rather than one mandatory central server:

1. negotiate missing reachable objects or fragments;
2. transfer them independently and resumably;
3. verify hashes and closure at the receiver;
4. compare-and-swap the remote ref as the single publication point; and
5. leave local history unchanged when publication loses a race.

Bundles remain the offline and air-gapped transport. Peer-to-peer-only operation is rejected
as a restriction, not as a capability.

## Multi-user serving, locks and isolation

Lore partitions storage authorization. Physical deduplication must not mean that knowing an
object hash grants another tenant's data, or that existence and timing become cross-tenant
oracles. The future pm-vcs service must carry an authorized repository partition through every
read, write, copy, list and ref operation.

Files that cannot merge need remote-enforced leases. A local lock cannot stop another machine
from publishing. pm-vcs locks must key on `FileId`, survive rename, and record owner, branch
scope, expiry, renewal, break authority and an append-only audit trail. Enforcement belongs at
the atomic publication boundary.

## Links, layers and lifecycle deletion

Lore distinguishes committed links from local layers. A link pins content from another
repository and travels with history. A layer overlays content for one instance without
changing the committed revision. pm-vcs will adapt both rather than reproduce Git submodules:
committed links pin immutable repository/revision identities and preserve authorization;
local layers never affect commit IDs and remain visibly outside status unless promoted.

Lore also distinguishes deliberately obliterated payloads from missing or corrupt data.
pm-vcs currently never deletes objects. Garbage collection of unreachable data and mandatory
erasure of reachable history are separate designs. Obliteration requires typed absence,
authorization, audit, deduplication isolation and explicit checkout/verify behavior.

## PM-linked file attribution

The pm CLI already records file links on project items. pm-vcs now resolves those links through
its own immutable history, without Git:

```text
PM item id -> linked repository path -> FileId -> file deltas -> ChangeIds -> revisions
```

Commits may also carry canonical, deduplicated PM item IDs explicitly. The derived attribution
is not a second source of truth and does not mutate an item when a file changes.

| command | question answered |
| --- | --- |
| `pm vcs commit --item <id[,id...]>` | Which PM work was this revision intentionally implementing? |
| `pm vcs trace <path-or-file-id>` | How did this logical file move, copy, change or disappear? |
| `pm vcs files <item-id>` | Which stable files and changes belong to this item's file links? |
| `pm vcs changes <item-id>` | Which stable ChangeIds are explicit or derived for this item? |
| `pm vcs items [from..to]` | Which items are explicit or linked to files changed by this range? |

The first implementation derives answers from canonical trees, commits and current PM links.
Historical link-at-event-time indexing, at-scale persistent indexes, fragments, views, locks,
served remotes and obliteration remain separately tracked work rather than inflated claims.

## Capability decisions

| capability | decision in pm-vcs |
| --- | --- |
| arbitrary byte files | retain; shipped |
| structured record objects and field merge | retain as a differentiator; shipped |
| immutable content plus compare-and-swap pointers | retain; shipped locally |
| stable file identity | adopt; shipped |
| stable branch identity separate from name | adopt before served remotes |
| FastCDC and fragment storage | adopt the invariant after TypeScript benchmarks |
| sparse views and lazy fetch | adopt after remotes and fragments |
| authoritative server | adapt to authority per remote |
| resumable publication | adopt |
| tenant partitions | adopt for hosted service security |
| remote-enforced file leases | adopt using `FileId` |
| committed links and local layers | adapt |
| typed obliteration | adopt separately from garbage collection |
| Lore object or wire compatibility | reject |
| mandatory centralized operation | reject |
| pm-vcs change IDs and operation log | retain as differentiators |
