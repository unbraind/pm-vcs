# Scale history and collection

`pm vcs gc` reports candidate content addresses and retained-object counts without
removing objects or hydrating promised payloads. `pm vcs gc --apply` replans under
the same interprocess object-store transaction used by push, staging, erasure,
lease changes and shared-instance writes, then removes only its unreachable
physical objects. It never trims refs or the operation log.

Reports also include `candidateBytes`, the compressed physical object bytes in
the plan, and `reclaimedBytes`, which is zero for a dry run and counts unlinked
bytes for a completed apply. Recognized temporary copies count separately even
when their addresses coincide. These are file lengths, rather than filesystem
allocation or a promise that snapshots and open descriptors released disk blocks.

## Ordinary large files

`pm vcs add` streams regular, non-record files at least 1 MiB into default CDC
manifests with a 64 KiB minimum, 1 MiB maximum and 18-bit Gear mask. These coarser
staging parameters reduce loose-object and fsync overhead; the existing fine-grained
CDC helper defaults stay unchanged. It first computes the uncompressed representation identity, then
publishes chunks under the existing store transaction. The descriptor-based
passes retain bounded buffers; a changed identity or filesystem observation
refuses index publication. Unreferenced chunks left by a refused add are GC
candidates. Files below the threshold and configured structured records keep
their existing blob and record semantics. Symlinks keep their target-text semantics.
Re-adding unchanged regular-file content preserves its recorded blob or manifest address,
including legacy large blobs and alternate fragment layouts. Comparisons stream
working bytes; changing storage defaults alone does not create a staged edit.

FileIds remain independent of content addresses. Rename plus edit on the same
filesystem retains identity; an unambiguous unchanged-content move can also be
recognized across filesystems. Copies get a new FileId and `copiedFrom` provenance.
An edited move across filesystems with no preserved identity remains ambiguous.
`pm vcs trace` reports the resulting FileId, stable ChangeId and PM item associations.

Status compares manifest-backed working files by streaming their bytes through
the exact recorded fragment boundaries, including fixed and historical layouts.
It never needs the complete file or stored blob payloads in memory. Range reads
use `readFragmentRange` and visit only overlapping manifest subtrees and blobs.
Chunk addresses hash uncompressed framed bytes, so changing the zlib level leaves
all identities unchanged. Native checkout and merge still have materializing paths;
streaming those paths and pack compaction are separate follow-up work.
Text merge interprets verified textual manifest payloads exactly like blobs: append-only
PM histories union both sides' appended events, and ordinary text uses diff3.
Blob/manifest transitions do not create semantic conflicts. These merges assemble
the logical payloads in memory and store their result as a blob, including real
diff3 markers when text conflicts. Incompatible record/link transitions retain
their existing explicit-conflict behavior.
Before materialization, bounded reads verify every fragment and classify UTF8
across fragment boundaries. Invalid or truncated UTF8 and NUL bytes retain a
complete-side binary conflict, without concatenating the manifest payloads.

Annotation reads verified logical text from blob and manifest storage, following
setters across storage transitions and renames. Fragmented PM histories retain
recorded agent provenance. Annotation assembles each selected text or history
payload in memory; it does not inherit the bounded-memory status contract.

Run `npm run benchmark:phase6` for the reproducible 200,000,000-byte
generated binary plus a copy of this package's real PM tracker. The benchmark
commits both, renames the binary and replaces 1% in its middle, verifies 21
4 KiB ranges against descriptor reads, and reports compressed store bytes,
chunk/byte reuse, timings and GC receipts. It retains both committed generations
and reclaims an explicitly unreferenced 1 MiB payload. All copied and generated
data stays in one temporary directory removed in `finally`. Release tests exercise
the same complete workflow on a small fixture; the full capacity run is explicit.

Roots include every ref namespace, detached HEAD, both endpoints of every oplog
transition, every current and retired shared instance's complete sparse index,
pending merge parents/bases, review series, terminal erasure audits and durable
upload receipts. Trees traverse all entries; manifests traverse pages and blobs.
Legal `.tmp` ref names and directory components remain roots and appear in ref
listings. Atomic ref writes use exclusive randomized names in the reserved
`.lock` namespace, preventing collisions with legitimate refs. Legacy `.tmp`
files containing addresses are retained conservatively; malformed `.tmp` refs
refuse collection before deletion rather than being silently omitted.
Ref refusals report logical repository paths such as `.pmvcs/refs/heads/main`,
without exposing the absolute store location. Old `<ref>.<pid>.tmp` crash leftovers
cannot be distinguished from legal refs by their names; explicit inspection and
migration remain tracked in `pm-vcs-legacyreftmp`.
An active receiver FileId lease conservatively retains the entire store because
unpublished arrivals need not yet have a tree attributing their FileId. Released
or expired leases stop that additional retention. Corrupt metadata, unavailable
instances, corrupt objects and interrupted erasure refuse collection before the
first deletion. Unknown physical storage layouts also refuse. Collection also
fails closed when a root path is a broken symbolic link, or when the hub's
instance registry is missing rather than merely empty: both read as an absent
root set otherwise, and an absent root set is how staged history gets deleted.
Repositories initialized by this build always carry the registry.

An upload records durable pins before accepting immutable objects. An interrupted
or disconnected upload can therefore resume after collection. Applied GC retires
pins only once a fresh graph walk proves durable ownership. Abandoned uploads
remain retained; expiring those receipts is a separate lifecycle policy. GC killed
during deletion leaves only an incomplete sweep of unreachable objects. Recover
the dead writer lock with `pm vcs recover-lock`, then rerun GC: no saved deletion
plan is replayed, so new refs and leases are always considered. GC never authorizes
obliteration, and its report does not claim physical erasure of retained history.

## Bounded transfer

```console
pm vcs clone source destination --depth 2
pm vcs clone source destination --filter blob:none
pm vcs fetch origin --depth 8
pm vcs fetch origin
```

Depth counts generations from each advertised tip, with the shortest distance
through merge parents. Commit IDs, trees, parent links and FileIds remain unchanged.
Clone-local `partial.json` records exactly the commits whose parents were omitted;
log and ancestry stop at those explicit boundaries. A fetch that leaves nothing
omitted removes `partial.json` entirely, returning the repository to complete-history
mode so later unchanged fetches again negotiate from local tips instead of
retransferring the full bundle. A filtered export from a repository that is itself
a filtered clone passes its own promises on rather than fetching from its promisor
mid-export, and a promisor that names a linked instance serves demand reads from
the hub's shared store. Fetching greater depth also
works when the remote tip has not moved. An ordinary fetch restores complete
advertised history. Operation-log history keeps its older boundaries until their
parents have actually arrived. GC also retains physically present ancestors behind
a still-recorded shallow boundary, including arrivals from an interrupted fetch.

`blob:none` carries commits, trees, records, links and every manifest page; only
blob payloads become promises. Checkout retrieves the current files. Historical
reads fetch only requested missing blobs, and fragment range reads retrieve only
the overlapping fragments. The cache verifies kind and SHA-256 before publication,
obeys terminal erasure denials, and shares the same writer transaction. Corrupt
held data is never replaced silently. Unpromised missing objects remain errors.
Promises store a remote name; authentication remains in the existing remote
credential store. Filesystem and HTTP transports advertise `partial-history`;
a peer lacking it refuses bounded requests before publication.

Partial archives require opt-in fetch. Ordinary bundle imports and receiver push
validation still require complete history. A shallow clone can push to a receiver
holding its omitted ancestors; fetch complete history before pushing to an empty
receiver. Synchronous historical HTTP reads use an isolated bounded client process.
Use a separately running HTTP server when using the synchronous repository API.
