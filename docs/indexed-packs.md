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
This deliberately trades erasure I/O for the existing complete deletion proof.
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

Obliteration independently scans **every regular file** below the object-storage
root, including pack, loose, temporary and arbitrary foreign subdirectories.
Dormant object directories in registered instances are included too.
Names, extensions, pack magic and recognized inventory entries do not define the
proof boundary. It detects raw payloads, typed frames, canonical payload base64
(as written by bundles), and embedded zlib streams at any byte offset, including
pack members and recoverable data with a truncated or invalid checksum. Native compressed-member bodies stripped of their zlib headers/checksums are
fingerprinted too, for every supported frame kind: changing the kind does not
reopen the payload. All
compression levels written by loose storage, unpacking and packs are covered.
The same streaming inspector composes embedded zlib and base64 decoding: bundle
encodings of complete packs or stripped compressed members remain detectable.
Four base64 alignments handle alphabetic prefixes and partial final words.

Before deletion, the engine records only lengths, rolling signatures and SHA-256
hashes in a versioned, checksummed private `erasure-verification.json` journal.
Unknown formats and checksum damage refuse certification before lookup. No selected content is
persisted there. These signatures let a retry verify raw copies at arbitrary
offsets after canonical objects have already disappeared. SHA-256 confirms every
rolling-hash candidate. The same writer lease covers reading/updating this proof,
publication of pending denial, deletion, final scan and completion. Interrupted
atomic proof/denial temporaries remain preserved and inspected during retry.

The preflight scan excludes only selected, verified files scheduled for deletion.
The final scan excludes nothing. A hit throws typed `ErasureStorageRefusal` with
`erasure_retained_copy`, a safe `fileClass` and a remedy. Foreign files are never
deleted by the scanner. Harmless foreign files remain and are counted in the
receipt's `storage.files`, `storage.foreign` and bounded `storage.classes` map.
Unreadable, changing, aliased or excessive-decode storage refuses completion.
Post-deletion failures leave denial pending; retries use the durable signatures
and do not duplicate the completed operation receipt.

Scanning keeps source/decoded slots bounded (64 KiB / 16 KiB) and rolling windows
bounded by the largest selected representation. Decode work is limited to the
larger of 16 MiB and six maximum-ratio DEFLATE passes over a file. Inspection
is bounded to six nested codec layers, 32 active zlib streams per layer, 512
live inspectors and 16 MiB base64 words. Exhaustion refuses a proof with
`uninspectable_payload` (or the decode-budget refusal), rather than silently
accepting an uninspected encoding. As before, complete recognized historical structure is required
for attribution. This verifies the owned filesystem namespace under its writer
lease, not secure sector wiping or copies outside that namespace.

Once an object descriptor is pinned, subsequent inventory validation uses only
`fstat` and reads on that descriptor. Root, parent and leaf names are validated
before pinning. Namespace retirement does not invalidate verified immutable
bytes; in-place size/mtime changes still refuse. Link count and ctime are not
content identities because unlinking changes them.

Regression evidence: 168 seeded stores across fourteen encodings and six locations,
72 nested codec cases across nine forms, four alignments and two offsets, 27
frame-kind/compression-level combinations with stripped wrappers, and
406 actual pinned/native I/O boundary injections across all 25 reader APIs, nine
logical SIGKILL cuts, 66 native proof/denial publication cuts, and a competing
process at every logical erasure boundary on one non-git tracker.

Older or imported denials can lack the byte-window evidence needed for a new
physical certificate after source bytes are gone. This refuses with
`incomplete_erasure_inventory` until verified source evidence is restored; it
never treats a policy-only denial as a byte-deletion proof. Automatic transport
of this additional evidence is tracked separately. Existing logical denials
continue to block reads and arrivals.
