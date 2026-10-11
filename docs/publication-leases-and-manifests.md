# Publication leases and bounded fragment manifests

Publication through the filesystem and HTTP transports requires an explicit live
lease for every stable FileId in the updated tip, replaced tip, and newly
introduced parent history. A create followed by deletion before the tip still
publishes that historical identity. Renames retain their FileId and lease.
A batch validates all identities for all destination refs before moving any ref.
`--force` changes the ancestry policy, while lease ownership, scope and fencing
remain mandatory.

Acquire before publishing and renew while working:

```sh
pm vcs lease acquire <FileId> origin --refs refs/heads/main --ttl-ms 300000
pm vcs lease inspect <FileId> origin
pm vcs lease renew <FileId> origin --ttl-ms 300000
pm vcs push origin --branch main
pm vcs lease release <FileId> origin
```

Acquire each identity explicitly. Ref scopes are exact full ref names; comma
separated scopes support publication to multiple branches. Lifetimes are from
one millisecond to one day. Acquire refuses any live generation, including one
already held by the caller; renewal requires its current fence. Renewal and
release use the private saved proof unless `--fence` supplies one explicitly.
Expired generations cannot renew. Reacquisition creates a higher generation and
a fresh random fence; earlier fences cannot publish or release it. `break`
requires explicit receiver administrator authority and records a terminal event.
There is no automatic lease acquisition in push.

The public `FileTransport.lease`, `HttpTransport.lease`, and `changeRemoteLease`
APIs expose these same operations. `push` and `publish` accept explicit proof
lists; transport objects retain proofs obtained through their own explicit lease
calls. CLI workflows persist only proofs in private `lease-proofs.json`, keyed
by remote name with own-property lookup. Remote names such as `__proto__` remain
ordinary keys. Proofs and lease audits never enter bundles.

HTTP ownership comes from receiver token grants: an operator-supplied principal,
or a stable SHA-256 token identity. Break authority is a separate grant. Neither
request JSON nor operation-log timestamps choose the owner or expiry clock.
Filesystem access uses the current operating-system principal and grants local
administrative break authority. Direct access to repository control files is
trusted administrative access. Per-FileId JSONL audits are fsynced before success,
record actor, action, receiver time and complete generation state, and survive
process restart. Publication preflight and lease changes share the interprocess
object-store write lock. Preflight runs inside the ref transaction after ref
locks and CAS checks, using one receiver-clock sample before any ref write.

Refusals are `PublicationLeaseError` values: `lease_missing`, `lease_expired`,
`lease_wrong_principal`, and `lease_out_of_scope`, plus `lease_fenced` for a stale
generation. Each carries its named reason, FileId, holder and expiry. Missing
state has explicit null holder and expiry. HTTP preserves these fields.
Publication may receive immutable objects before refusal; all destination refs
remain unchanged.

## Fragment metadata contracts

The production disk and buffer fragment writers use a canonical hierarchy with
fanout 128. Leaves retain the v1 encoding. Interior v2 nodes authenticate each
child address, logical byte length, fragment count and height. All children
except the last fill their level's capacity. Safe integer byte addressing bounds
the hierarchy to eight levels, including leaves. Encoders and decoders reject
noncanonical bytes, unsafe totals, counts, heights and modes; traversal also
checks each selected child against its parent. Identical input and chunking
parameters produce the same address across disk, buffer and pure-ID workflows.
Existing v1 addresses and bytes are unchanged. Larger newly written files use
the v2 hierarchy and therefore have new root addresses.

`FragmentWriteResult.manifest` is the bounded root descriptor. For an interior
root, `fragments` is empty and `pages` names child nodes. `manifestFragments`
traverses logical entries lazily, with offsets, and seeks a range through
intersecting subtrees. `materializeManifest` explicitly requests the complete
logical entry array. `readManifest`, `encodeManifest`, `decodeManifest` and
`writeManifest` accept or return full buffers/descriptors as convenience APIs;
passing a large flat v1 descriptor to them explicitly opts into materialization.
They are not used by the streaming file or range reader to load legacy metadata.

`readFragmentedToFile` retains bounded metadata, one fragment payload and a
32 KiB output buffer. `readFragmentRange` retains bounded metadata and allocates
only its requested result buffer plus one fragment payload. `readFragmented`
allocates one full content buffer and copies fragments directly into it while
retaining bounded metadata. Fixed chunk size or
CDC's maximum chunk size bounds payload memory independently of file length.
Large v1 reads use `ObjectStore.readLines`: a bounded decompression worker and
one backpressured shared slot, canonical line decoding, frame-length checking
and full SHA-256 verification. A legacy range scans the entire flat metadata to
verify corruption even after the selected interval, with bounded memory but
linear scan time. Paged ranges visit only intersecting authenticated subtrees;
validation of the entire graph remains available through closure verification.
Small nodes use bounded compressed reads and bounded inflation.

Bundles and transport closure traverse pages, preserve child addresses and
validate parent/child metadata. Linked instances use these same readers and
preserve actionable missing-fragment errors. Lifecycle arrival checks reject
denied pages and fragments. Erasure includes every descendant manifest and blob,
refuses independently owned deduplicated content, and inspects lease audit files
for retained payload copies before issuing a physical erasure receipt.

The real-filesystem regressions include 32,769 one-byte disk fragments and
1,048,577 deduplicated logical entries in independent 48 MiB heap children for
both v1 and paged full reads and tail ranges. Correct-output materialization
reverts of each reader must exhaust that unchanged heap budget; reverting only
the disk writer must exceed the unchanged 128-entry physical node bound.
