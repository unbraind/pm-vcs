# Indexed pack storage

A pack starts with the eight bytes `PMVCSP1\n`, followed by an unsigned
big-endian 32-bit JSON index length, then the index and concatenated zlib
frames. Each index tuple is `[objectId, bodyOffset, compressedLength, type]`.
Entries are sorted by address; ranges must cover the body exactly without gaps
or overlap. The pack filename is the SHA-256 of its complete physical bytes.
Object identities remain SHA-256 of `<type> <payloadLength>\0<payload>`.

Reads pin a descriptor, validate the bounded index against its filesystem
identity, read only the requested member range, inflate it within 16 MiB, then
verify its frame, kind and logical digest. GC, compaction and erasure additionally
verify the full pack checksum and every member before retiring any source.
Index memory is cached only while inode, size, mtime and ctime match. Packs are
bounded to 16 MiB of input plus index overhead; larger objects stay loose.

```ts
import { ObjectStore, PackRefusal, type PackReport } from "pm-vcs";

const objects = new ObjectStore(".pmvcs/objects");
try {
  const receipt: PackReport = objects.compact();
  console.log(receipt.objects, receipt.packs, receipt.packBytes);
} catch (error) {
  if (error instanceof PackRefusal) {
    console.error(error.code, error.remedy);
  } else {
    throw error;
  }
}
```

The SDK returns counts, bytes and at most 20 skip reasons rather than unbounded
object lists. `skippedCount` and `omittedSkipped` report exact totals.
`PackRefusalCode` is the typed integrity/lifecycle refusal union. It delegates tracker resolution and TOON/JSON rendering to the host CLI.
`InventoryEntry.packed` exposes the compressed byte offset and length in its
actual pack file; inventory rereads verify that exact member.
Object storage and representation changes use the package's existing
`ObjectStore.withWriteLock`; no tracker settings or item history are rewritten.
The host SDK has no binary object-pack or compressed-range-storage primitive.

Every mutation reads its inventory inside the lease and releases the lease last.
Maintenance rejects aliased object-directory roots before cleanup can touch data
protected by a different lease path. Common store refusals use `ObjectStoreError`,
also exported by the SDK.
Publication writes a unique staging directory and durable ownership marker,
fsyncs the payload, exclusively links the complete immutable pack, and fsyncs the
parent before removing any source. Retry verifies published packs, retires their
duplicate loose copies and retires only regular `payload` and `owner` leaves of staging jobs with
matching ownership markers. It removes the directory only when empty; foreign
children survive and receive skip reasons, including records arriving during
publication. Payload retirement precedes marker retirement, so interruption
cannot leave unmarked owned bytes. Unknown files, links and jobs are left alone
and reported as foreign. Empty interrupted directories have no payload and may
remain as reported foreign entries. No job is a retention root: all staged bytes
also exist in an authoritative loose object or published pack.

After process death, run `pm vcs recover-lock` and retry `pm vcs compact`.
Do not recover a live writer's lock. A peer that already published the exact
same pack counts as success; a conflicting destination refuses before source
retirement. A verified reader pins its opened representation or resolves again after concurrent
unpack and repack. Corruption raises `corrupt_pack` with a restore-and-retry remedy;
pending authorized erasure raises `pack_erasure_pending` with an obliterate remedy.

GC retains the same roots across both representations: refs, both operation-log
sides, staged and linked-instance data, merge state, upload pins and active
publication leases. A packed sweep materializes verified loose representations,
removes only unreachable addresses, and compacts survivors. A crash during this
sequence may temporarily leave loose storage; a subsequent compact restores
packed storage. Byte receipts distinguish candidate compressed bytes (with apportioned index
overhead) from net
physical bytes reclaimed after a rewrite.

Authorized erasure verifies and materializes all pack members under the same
lease before planning physical deletion. It then retires packs and owned staging
payloads, so the existing erasure inventory can prove that no recoverable packed
copy survives. Permanent denials continue to prevent reads and resurrection.
This deliberately trades erasure I/O for complete native-file accountability.
It does not promise secure overwriting of filesystem blocks or external backups.

To reproduce aggregate measurements on an approved public tracker copy:

```sh
node --input-type=module -e 'import { benchmarkIndexedPacks } from "./scripts/pack-benchmark.ts"; console.log(JSON.stringify(benchmarkIndexedPacks(process.argv[1]), null, 2));' public-tracker-copy
```

The benchmark copies its input into a non-git scratch project, stages actual
tracker files, verifies every logical object before and after GC, and reports
compressed file bytes, filesystem allocation, file count and warm read median/p95.
The input tracker is read only. It does not report item content or local paths.

## Concurrent readers and platform durability

All logical object readers share `ObjectStore.resolveLocation`: presence and
kind probes, complete and bounded reads, typed reads, state inspection,
hydration, inventories and both chunk and line iterators. Pack backend readers
and the exported chunk decoder delegate to the same protocol. The test inventory
includes all 25 logical entry points, including shared-instance overrides. A generation
marker covers the loose set and pack catalog under the existing writer lease.
The resolver retries from the beginning when that generation changes, at most
`OBJECT_READ_RETRIES` (8) times. Only an unchanged idle generation proves
`object_not_found`; continued maintenance returns `object_store_changing` with
a retry remedy, including state inspection without falsely reporting corruption. Operational I/O failures remain visible.

Each successful resolution opens and retains one immutable descriptor and byte
range. The location also carries the indexed kind and 16 MiB decoded-frame bound;
full, bounded and streaming readers enforce both. Bounded reads additionally
enforce the caller's exact payload-byte limit, independent of framing overhead. A stream retains that handle until completion or consumer cancellation,
so unpacking and repacking cannot invalidate its input. Logical reads enforce
terminal denials before returning bytes and before each emitted chunk or line.
Only explicit internal erasure inspection can access denied physical bytes, and
it requires the owning writer lease. Recognized loose write temporaries are
skipped before decoding during compaction, including empty and truncated files.

`engine/durability.ts` owns every file flush and durable rename, link and removal. On POSIX it
flushes files before publication and synchronizes affected directories after
namespace changes. Node does not support directory fsync on Windows: that policy
keeps file fsync before atomic publication and uses acknowledgment of synchronous
rename/link/unlink operations for namespace changes. This avoids a portability
refusal after deletion; it does not claim POSIX directory-fsync power-loss
semantics on Windows. CI runs the shipped `pm vcs gc --apply --json` command on
Windows with Node 22 and 26 against a real non-git tracker, retaining live packed
data while collecting a loose candidate.

The reader regression enumerates the exported surface, runs every reader at
every compaction, unpack, repack and GC boundary on one non-git tracker, and
injects complete transitions between resolution stages. Separate crash tests
kill each maintenance step and prove that a rerun converges without changing
retained identities. Capability-forced durability tests exercise both policies
on a real filesystem.

### Descriptor ownership

Every explicit file open in object storage, pack storage and durability uses
`engine/object-files.ts`. The registered owner transfers with a resolved location
and closes synchronously in `finally`; closing twice cannot close a reused fd.
The synchronous streaming decoder uses pinned `pako@3.0.2` with 64-byte compressed
pushes and 16 KiB decoded slots. It holds bounded JS buffers and creates no worker,
file stream, or native decoder handle requiring an event-loop cleanup turn.
Zlib checksums, framing, content hashes, pack bounds and terminal denials remain
verified. `timeoutMs` bounds each synchronous input/decode step and excludes time
the consumer spends between yields.

Iterator `return()`, consumer exceptions and `for...of` break run the same close
path. When adapting an iterator with `Readable.from`, await its `close`/`finished`
settlement after `destroy()` or AbortController cancellation; that settlement
includes iterator cleanup. Synchronous scalar readers have no mid-operation
consumer-stop boundary and complete before returning.

`test/object-lifetime.test.ts` checks all 25 reader adapters in complete, early
stop, injected I/O error and abort modes for loose and packed representations
(200 cells). Linux compares the actual descriptor count immediately after every
operation; other platforms also enforce the ownership registry. Empty physical
inventories have no handle to fault, and eager/scalar early stops are completion.
Separate tests exercise native read/stat faults, explicit iterator return and
throw, async stream destroy and AbortController cancellation. Eight Linux child
processes with a 128-descriptor limit each perform 10,000 consecutive synchronous
stream operations without an event-loop turn (80,000 total), checking descriptor
and ownership baselines after every operation.

### Physical erasure verification

Success requires an **accountable store**, rather than a negative search for an
encoding. Every regular file below the active object root and dormant object roots
of registered instances participates, including every pack, loose, temporary and
foreign subdirectory, regardless of name or extension. Missing roots are checked
again before completion. Each file must be either a canonical loose pathname
containing one complete zlib frame with matching logical SHA-256, kind and length,
or a canonical pack pathname whose complete physical SHA-256, index coverage,
member bounds and every logical member verify. Trailing bytes, incomplete streams,
renamed or copied packs, foreign files and old write temporaries are unaccounted.
No object-store temporary is live at the completion barrier. Empty directories
contain no bytes and may remain. Links and special files refuse verification.

Every accounted object is checked against permanent denial addresses and nonempty,
type-independent payload SHA-256 digests. Empty payloads retain their typed address;
unrelated empty structural objects remain valid. Denial and native accountability
are required even if no byte diagnostic matches. Unknown files without the selected
payload still make the store `unverifiable`; compressed variants and truncations
cannot bypass this rule. The refusal names only a safe file class and a remedy.

Default obliteration preserves unaccounted files and refuses. An operator with
current erase authority can explicitly authorize their deletion:

```sh
pm vcs obliterate <file-id> --erase-token-file erase-token --reason incident --purge-unaccounted --json
```

```ts
const receipt = repository.obliterate(fileId, eraseCredential, "incident", new Date(), {
  purgeUnaccounted: true,
});
console.log(receipt.storage.accountable, receipt.purge.deleted, receipt.purge.omitted);
```

The typed SDK exports `ErasureOptions`, `ErasureAccountabilityReport`,
`ErasurePurgeEntry` and `ErasurePurgeReceipt`. The existing writer lease covers the
entire operation and releases last. Before unlinking an unaccounted file, a durable
private `erasure-purge.json` plan records its relative pathname, class, physical
SHA-256, byte count and device/inode/size/mtime identity. Audit arguments are
validated before purge. The engine rechecks that exact identity immediately before
unlinking; a repaired native peer is preserved. A retry without the flag can finish
only its exact previously authorized plan. Foreign or invalid purge metadata
refuses without granting deletion. Normal object deletion still follows FileId
attribution and refuses another owner's shared payload.

Purge receipts distinguish confirmed deletion, observed absence after interruption,
and peer replacement. They contain exact counts and confirmed deleted bytes, at
most 20 entries and an omitted count; they never include content. More than 20 files
can be purged. The full journal remains private. A fresh verification follows any
purge or receipt transition before completion is published. A crash can leave a
pending denial or an incomplete purge plan; authorized rerun converges without
repeating the completed operation receipt.

Terminal purge entries (`deleted`, `absent`, `replaced`) are immutable historical
audit facts. They never require their original instance, root or pack to remain
in the current scope, and reading them performs no lookup of the old pathname.
Pending entries bind both the selected file identity/hash and the exact root's
device, inode and birth time. Removing, pruning or recreating that root cancels
pending authority with `root_retired`, `root_missing` or `root_replaced`; receipts
report an exact `cancelled` count and preserve the reason. A replacement root
cannot inherit deletion authority, even through a retained hard-linked file.
Legacy unbound pending plans become `cancelled` with `legacy_authorization`;
remaining unaccounted files need a fresh explicit purge authorization. Completed
legacy records remain valid history. Cancellation is durable under the owning
lease and resumes safely after interruption.

Accountability catalogues are operation-local snapshots, rebuilt on every
verification. Erasure progress and fingerprint journals use logical object IDs
and payload digests rather than requiring old physical locations to exist.
Registered or retired instance cleanup scope still requires an explicit prune
when its binding disappears; that administrative boundary is independent of
historical purge receipts. Once the current scope is accountable and payload-free,
a vanished historical reference cannot permanently block another obliteration.

Certification opens one registered descriptor at a time, parses from that fd,
then compares `fstat(fd)` with `lstat(path)` using device, inode, size and mtime.
A renamed, replaced or resized file restarts inspection. A final catalogue barrier
checks every directory and pathname again, across all roots together. Each file
and the complete scope have eight attempts; continued mutation returns
`unverifiable`. Source reads and decoded slots are bounded to 64 KiB and 16 KiB.
This pathname check belongs to certification: ordinary pinned object readers keep
using their descriptor when compaction retires its pathname, as described above.

Native accountability is required and byte/fingerprint inspection supplies an additional
conservative check of supported representations. Neither check substitutes for an
incomplete other check. The private checksummed journal stores only lengths and
digests. A positive hit refuses cleanup. Missing or corrupt evidence, a decode
error, or reaching a depth, stream, context, byte or time bound returns typed
`unverified` with the exact bound; it never returns `accountable: true`.
Every surviving native member is inspected separately, including members sharing
a pack with the selected object. Final native parsing feeds the representation
inspector from bounded slots while holding the same file descriptor used by raw
inspection and the final pathname identity barrier. Directory catalogues are
checked together before certification. A late copy therefore cannot fall between
separate native and byte-proof snapshots. Preflight purge exclusions expire;
anything recreated at a retired pathname is a current file and is inspected again. Complete canonical native framing alone cannot
certify a blob that conceals selected bytes under additional encodings.
Base64 quartets stream through a bounded buffer so large supported words do not
require a buffer proportional to their length. Optional evidence transport is
tracked separately; restore the original inspection journal before requesting a
new physical certificate after a transfer that omitted it.

Integrity reports separate `checked` objects from the overall `verification`
result; `verified` is zero when the proof is incomplete. Reachability exhaustion
refuses GC before a deletion plan is published. Receipt inspection reports
`verification.status: unverified` when a work bound or recognized-record decode
fails, even beyond the rendered page. Core assurance history that reaches the
SDK's 1000-verdict query cap is incomplete evidence and cannot attach a checkpoint.
JSON and TOON carry the same negative verdict and named bound. Output pagination
never limits which records contribute to the overall verdict.


Regression evidence includes 160 seeded store states across ten native/foreign/
copied/renamed/truncated/overwritten forms, 190 exhaustive truncation/overwrite
cases with an independent native decoder, and 32 replacement cells across every
verification boundary for loose and packed files. Native purge publication,
directory barriers and unlinking have 96 real SIGKILL cuts. A competing process
runs at every accountability/purge boundary on one non-git tracker. Earlier reader
retirement and resource-lifetime regressions remain part of the release gate.

Root-lifecycle regression evidence adds seeds 1..512 over 32 isolated native hub
copies in a real non-git SDK project: 6,144 operations, 2,048 independent model
verdicts and 768 injected crashes across eight publication boundaries. Operations
cover add, unlink/remove, prune, same-name recreation, foreign arrivals, explicit
purge and obliteration; every sequence ends with a successful clean-store retry.
There are also 44 actual native lifecycle-journal SIGKILL cuts and a competing
process at both lifecycle-publication boundaries on one non-git tracker.

This certificate covers the inspected filesystem namespace under the native writer
lease. It does not promise secure sector wiping, external backup removal, or
protection against mutation after the final barrier by an actor bypassing that
lease. Windows uses the documented namespace acknowledgment policy above.

Pack rewrite, GC, purge and owned lease cleanup share the [three-phase destructive
operation protocol](destructive-operations.md). Complete source validation precedes
staging recovery or duplicate retirement. `PackReport.destruction` records the
exact frozen source set; interrupted recovery preserves newly arrived files.

Storage handles resolve relative filesystem roots when they are constructed.
For example, `new ObjectStore(".pmvcs/objects")` keeps addressing that store after
a later `process.chdir()`. Inventories return absolute physical locations;
lease keys, pack caches and recorded deletion sets use the same captured
namespace. Relative inventory hints and exclusions resolve when their API is
called, including before a lazy iterator is consumed. Returned deletion plans
retain their captured source, destination and descriptor aliases throughout
recovery. Later namespace changes on a caller request refuse before deletion;
equivalent relative spellings compare through the same captured base. Use a
new handle to select a different storage root.
