# Destructive operation receipts

Every engine namespace retirement uses three phases: validate the complete
request, persist an exact intent, then retire only its members and finalize its
receipt. Logical operations keep their existing domain authorization: erasure
credentials and FileId attribution, GC reachability and publication leases,
reference CAS, and captured working-tree identities. Invalid requests never
acquire deletion authority. In particular, an absent but well-formed FileId with
`--purge-unaccounted` returns `unknown_file` before purging unrelated storage.

Obliteration first performs complete read-only storage, historical ownership,
working-tree, layer, audit-format and flag validation. Unaccounted files are
inventoried without deleting them. The immutable tombstone records the selected
logical objects; separate frozen subplans record unaccounted files, working-tree
leaves, pack retirement and the resulting loose representations. New files
cannot join an interrupted plan. A new foreign copy makes verification refuse. A fresh explicit
`--purge-unaccounted` request may record another separately identified batch;
recovery never extends a prior batch. Purge receipts include bounded batch ids,
revision digests and pending counts, while legacy receipt entries remain audit
facts.

`--recover-lock` uses the same read-only request validator before retiring a dead
writer. An eight-attempt CAS includes authority/reachability metadata, every
object-store namespace stamp and the observed writer lock. A fully written,
flushed recovery guard is published exclusively, the revision is checked again,
and the normal leased operation repeats validation. A live or unknown guard is
preserved. A crash before publication can leave only an unpublished temporary.

```sh
pm vcs obliterate <file-id> --erase-token-file erase-token --reason incident --purge-unaccounted --recover-lock --json
pm vcs destructive-receipts --json
```

Retry the **original operation**, with its original identity and authorization,
to recover its immutable set. Receipt inspection is read-only and never grants
permission to delete a path. The CLI uses the host SDK's tracker resolution and
TOON/JSON renderers; both formats contain at most twenty receipt summaries and
twenty skip reasons, with exact pending/completed/omitted counts.

```ts
import { DestructionRefusal, inspectDestructions, ObjectStore } from "pm-vcs";

const objects = new ObjectStore(".pmvcs/objects");
try {
  const result = objects.compact();
  console.log(result.destruction.planned, result.destruction.deleted);
} catch (error) {
  if (!(error instanceof DestructionRefusal)) throw error;
  console.error(error.code, error.remedy, error.receipt?.id);
}
console.log(inspectDestructions(".pmvcs", 10));
```

Each private intent has a random operation id, store revision, root lifetime,
relative coordinates, parent lifetime, leaf identity including ctime, content
checksum, optional destination identity and exact outcomes. A fixed-size progress
bitmap binds each flushed acknowledgment to that immutable id and member count;
publication writes remain linear in the number of members. A completed checkpoint
retains the complete audit record. Public success/refusal receipts expose at most
twenty entries, with counts for owned deletions, moves, peer-observed absences,
skips and omissions. `DestructionRefusalCode` is an exhaustive SDK discriminator.

Each live handle fingerprints the immutable revision, root lifetime and ordered
member identities/destinations. Refresh refuses any authority change even when
the operation id is unchanged; only progress outcomes may advance.

Independent drainers serialize every journal read/modify/write under a fully
published per-intent process lease. They reread state while holding it, preserve
replaced sources/destinations, never extend an old set, and release ownership
last. A peer that already finished is reported with its original receipt id.
A missing source after an acknowledgment crash becomes an observed absence;
a rename is recovered only when the destination retains the recorded inode and
checksum. Recreated leaves are foreign. Root/parent retirement cancels pending
authority with a typed reason; terminal entries remain historical. Skipped entries cease to block recovery once
the peer leaves have disappeared; a clean store cannot remain stuck on an old
skip. Observing a new leaf under an already retired name refuses without
rewriting the original completed outcome. Foreign,
malformed or changing journal records are preserved and reported. Owned lease
cleanup keys include the captured owner stamp, so an unlink/acknowledgment crash
cannot transfer an old cleanup set to a new lock at the same pathname. Read-only
inspection reports absent or replaced member lifetimes as historical and never
uses those records to delete their successors. An owner release finishes truthfully
when a distinct peer acquires the lock name during receipt completion; reattaching
the original inode still refuses. Fresh empty requests never replay paths from
a completed nonempty set. Guarded worktree planning, retirement and receipt
failures preserve the public `worktree_path_changed` refusal and leave their
recorded sets available for recovery.
An interrupted owner-temporary retirement retries its recorded set and refreshes
the pinned owner stamp after removing its own hardlink; changed owner bytes remain
foreign and are preserved. Pending pruning resumes already-retired directories
without capturing later arrivals.

CI gives each full release gate an owned scratch root and removes that root after
all gate commands exit. Disposable fixture receipts stay inside that root, so the
npm and Bun suites do not accumulate each other's audit files. Production receipt
retention is unchanged.

The namespace audit covers these paths:

| Engine paths | Validation and intent |
| --- | --- |
| `erasure.ts`, `erasure-accountability.ts` | Complete FileId/credential/ownership/control/worktree preflight; frozen purge, logical object and physical retirement sets. |
| `gc.ts` | Validate all roots and reachability under the writer lease before frozen candidate retirement; unpack and survivor compaction have separate recorded sets. |
| `packs.ts` | Validate every published and loose source before duplicate removal or staging recovery; immutable loose-source and pack-retirement sets. Owned staging leaves and empty directories use the same namespace helper. |
| `worktree-mutation.ts` | Capture the whole erasure/pruning set and parent descriptors before retirement; descriptor-relative mutation preserves topology fences. |
| `refs.ts` | Validate every ref/CAS and preflight callback under all ref locks before a frozen ref-retirement batch. |
| `objects.ts`, `bisect.ts`, `instances.ts`, `oplog.ts`, `repo.ts` | Verify dead or descriptor-owned lease identities before cleanup; preserve new owners. Bisect reset freezes state/workspace deletion together. |
| `credentials.ts`, `composition.ts`, `fragments.ts`, `sync.ts`, remaining `repo.ts` publication/rollback paths | Atomic rename or captured recursive cleanup through `durability`, including owned temporaries, merge/index state, failed clones/instances, and layer views. |

`durability.ts` is the only production module allowed to call native rename,
unlink, rmdir or fsync. Its namespace adapters always invoke the intent protocol.
The finite bootstrap consists only of atomic journal publication, single-byte
progress acknowledgment and exclusive descriptor-owned unpublished process-owner
or journal-mutex cleanup; these use
that same platform-aware helper and cannot recursively create deletion intents.
Bootstrap temporaries cannot authorize payload deletion. POSIX flushes directory
entries; Windows flushes files and acknowledges synchronous namespace operations.

The pinned PM SDK provides asynchronous `commitWorkspaceTransaction` and
item/workspace locks, but no synchronous descriptor-bound binary-store deletion
transaction or compressed-range pack primitive. The engine preserves its
synchronous public storage API and native writer lease; PM lookup, history,
settings, item transactions and rendering continue through the existing SDK.
Domain deletion receipts live with the store. Ordinary atomic publication and
lease-cleanup intents use a private namespace ledger keyed by the owning root;
they do not alter logical control snapshots or tracker metadata. Copied ledgers
remain foreign to a different root. Private receipt/checkpoint auxiliaries are
retained for audit; this command does
not erase receipt history.

Tests use real non-git SDK trackers, independent tree hashes and a tripwire,
seeded valid/invalid request sets, actual SIGKILL at owner/intent/progress/receipt
boundaries, competing native drainers, foreign records, replaced parents and
leaves, and injected I/O failures. A static AST audit rejects direct namespace
or durability calls outside the one helper.

A caller that has revalidated every current precondition may supersede an obsolete
pending plan. GC uses `reachability_changed`; compaction, unpacking, erasure,
worktree pruning, ref retirement and bisect reset use `eligibility_changed`.
The old exact set is durably marked `superseded` and remaining authority is
cancelled with `preconditions_changed` before its receipt is archived or a fresh
revision-bound set is published. A crash at either publication boundary resumes
this handoff. An obsolete handle cannot delete through the replacement plan.
Owned lease and temporary cleanup keeps its original identity authority and
cannot opt into this domain revalidation. Extra arrivals alone never expand a
pending set. A new ref protecting an interrupted GC candidate therefore preserves
that object while the freshly validated collectible set can still be retired.

Working-tree erasure keeps its original inode authority across recovery. A peer
replacement remains foreign on every retry, including after a terminal refusal;
a FileId or reused pathname alone cannot authorize adopting it into a new set.
Remove or resolve that foreign leaf explicitly before retrying. Validated GC
reachability changes can supersede a plan without granting authority over a
working-tree replacement.
