# Repository composition and permanent payload erasure

Repository composition uses native pm-vcs objects through the engine API and pm
commands. Sparse linked instances share local storage independently of committed links.

## Committed links

A canonical, typed `link` object names an immutable repository identity, a pinned
commit object ID, and a source-to-destination path mapping. Its enclosing tree
commits the descriptor, never the linked repository's bytes. A clone reproduces
exactly that descriptor even when the linked repository is unavailable.

Repository identity is stable across clones and independent of the configured
remote URL. An explicit resolution checks the contacted repository identity and
the exact commit ID before materializing the selected subset. Moving a branch
cannot silently move a pin. A path or URL is a local binding, never authority.
Credentials remain local and must be supplied for the linked repository itself;
the enclosing repository's authorization cannot grant access to the linked one.
Enclosing bundles never recursively traverse links or include linked credentials.
Resolution fails closed for a wrong repository, unavailable revision, unauthorized
source, unsafe path, or collisions with locally owned files. Linked content is
materialized as an instance-local layer through explicit resolution.

## Local layers

Layers hold overlay snapshots in the instance's private control directory. They
can cover tracked paths and add new paths; layer state and bytes never enter the
shared object store, index, committed tree, bundle, clone, or another instance.
The underlying index remains the committed/staged snapshot, so commit identity is
independent of an overlay. Bulk add skips layer-owned paths; explicit add refuses
them. Ordinary status excludes their changes and separately lists excluded layers
so local content is visible without masquerading as a repository modification.

Layer paths are canonical repository-relative paths. Ordinary project directories
named search, runtime, locks, transactions or checkpoints are supported. Actual SDK
tracker runtime fences apply beneath default tracker roots, configured record-path
tracker roots and the active SDK pm_root. These fences cannot be negated; canonical
path checks, every case spelling of .pmvcs and ALWAYS_IGNORED tool directories remain
protected. Context-free link encoding validates canonical and control paths; staging
and resolution also validate destinations and target sources with their root rules.
Control directories, tracker runtime state, symlink traversal, ambiguous overlapping ownership, dirty tracked paths,
and untracked collisions are refused before changing disk. Tree materialization
preserves overlays and the complete underlying index. Removing a layer restores
its underlying staged bytes or removes overlay-only paths. Layer edits cannot be
silently overwritten by a switch; they must be preserved or explicitly refused.
There is no promotion command. Explicit layer removal restores the underlying state;
new deliberate edits can then be staged. A normal add or commit never promotes a layer.

Working-tree descriptor writes, resolved layer materialization, layer restoration
and removal use `WorktreeMutation`, as do checkout, restore and sparse-view changes.
The same mutation boundary removes each instance's FileId-owned paths during
obliteration. Linux with usable procfs pins directory descriptors; other platforms
verify the captured directory identities around each step, retaining the documented
final check/use race of that portable backend. Every case spelling of `.pmvcs` is
protected at every depth, including the leaf. A refused erasure removal leaves its
durable denial pending and cannot publish a completed physical-erasure receipt.

## Typed obliteration

Obliteration is permanent payload erasure, separate from unreachable-object garbage
collection. It targets a stable FileId, with a path accepted only to resolve that
identity. Every historical payload of that identity is selected, including moves,
previous revisions, unreachable commits, indexes, manifests and their fragments.
History retains structural references and the terminal typed state; immutable
commit IDs are not rewritten into a misleading new ancestry.

Local erasure requires an explicitly configured authority and matching credential.
Authorization is checked inside the shared writer lease before any mutation,
including standalone erasure helpers. Version 2 local grants use scrypt
(N=16384, r=8, p=1), a random 16-byte repository salt and 32-byte verifiers.
Verifier encodings are validated before constant-time byte comparison. Legacy
unversioned SHA-256 grants cannot authorize link reads or erasure. Regenerate both
grants explicitly with `vcs authority --regenerate-legacy` only for the recognized
historical unversioned format. Unknown versions, JSON null, malformed grants, corrupt
JSON and unreadable files fail closed; they require trusted filesystem recovery.

Initial `setAuthority(principal, readCredential, eraseCredential)` remains supported
only when authority.json is genuinely absent. Replacing a valid v2 grant requires
the separate optional authorization `{ currentEraseCredential }`, which must match
the current erase verifier. The proposed new read or erase token grants no replacement
authority. CLI rotation supplies `--current-erase-token-file` separately from the
new `--read-token-file` and `--erase-token-file`. The typed alternative
`{ regenerateLegacy: true }` and CLI `--regenerate-legacy` apply only to recognized
historical grants; they never permit v2 overwrite. Both choices are mutually
exclusive. Classification, authorization and replacement hold the shared store lease
in Repository and lower-level configuration helpers. Linked instances rotate their
hub grant, so the change applies to all instances sharing it. Filesystem writers
that bypass this protocol already control the grant and stored payloads; these
checks protect supported command/API callers. Credentials and grants remain
clone-local and never enter bundles. A typed, canonical tombstone records
version, FileId, affected object IDs, principal, timestamp and reason, without
recording the erased bytes or credential. Its content-addressed identity and
persistent denial registry are the audit record; the operation log records the
command without making erasure reversible. Undo may restore a pointer but cannot
restore obliterated payloads.

Deduplicated content that belongs to another FileId must cause a scoped refusal,
not silently erase another file or leave the target recoverable. Inventory checks
cover the entire repository store, not merely current refs. Corrupt or incomplete
history prevents an unsafe partial plan. All instances sharing the store share the
denial state. Private overlays and working-tree copies owned by affected identities
must be scrubbed or cause refusal before reporting success.

Object publication and erasure serialize at the store boundary. The durable denial
record precedes deletion, so interruption cannot enable resurrection. Incomplete
erasure is a failed operation and must remain denied until cleanup completes.
Successful erasure removes selected loose objects, compressed representations,
manifest fragments and temporary object copies. This release refuses unsupported
pack/cache storage before mutation; it has no indexed pack backend. Unsupported
storage is never ignored in a successful receipt. The security guarantee
covers application-visible repository storage, not external backups, independently
owned clones, filesystem snapshots, or physical-media forensic recovery.

## Reads, verification and exchange

Payload state is a discriminated union: present, obliterated, missing, or corrupt.
Reading obliterated content raises a distinct typed error carrying its tombstone
identity. Checkout reports or represents that state explicitly and never writes
an empty file that could be mistaken for the original. Verify accepts intentional
obliteration as a reported terminal state, while missing and corrupt data remain
failures with their own discriminators.

Bundles carry typed denial metadata rather than erased payloads. A fresh clone can
reproduce intentional absence. Receiving a remote denial must not silently authorize
local deletion: erasure of locally held bytes needs local authority. Imports, fetch,
resumable uploads and publication preflight the denial registry before accepting
bytes. A stale peer cannot restore a denied object or introduce a new payload under
an obliterated FileId. Ref updates occur only after complete validation. Linking to
another repository cannot bypass its tombstones or collapse its authorization scope.

## Implementable format and security boundary

A link is a typed leaf object at a descriptor path, with exact file-to-file
mappings. It does not use a directory mode or recursively mount another tree.
Local bindings supply a repository object and its separate read credential.
Repository identity is a local durable opaque ID, reproduced by fresh bundles and
clones, rather than a remote URL or branch name. Legacy repositories acquire it
when explicitly requesting identity. Established identities cannot be replaced
by importing another archive, even into an empty repository. Fresh clones adopt
the source identity before their first explicit identity creation. Self-host archives without repository metadata
remain deterministic.

The supported erasure backend is the loose zlib store. Unknown storage entries,
pack/cache directories and unverifiable temporary copies refuse before mutation.
Recognized loose temporary objects participate in inventory and cleanup. Denial
is persisted and fsynced before removing bytes; interrupted cleanup blocks writes
until authorized retry succeeds. FileId provenance is mandatory for new local
payload writes once denial exists. Complete bundle imports preflight attribution;
resumable payload-only upload batches refuse after erasure because their protocol
has no trustworthy FileId envelope. This is an explicit fail-closed boundary.

Layer removal refuses edited overlays by default and requires explicit discard.
Checkout changes the underlying index while leaving overlay disk bytes untouched.
Erasure refuses affected private layers and ambiguous/unregistered copies rather
than claiming it deleted bytes whose ownership it cannot prove. Operators must
remove those layers/copies before retrying the authorized erasure.


## Shipped API and transport behavior

`Repository.identity`, `setAuthority`, `stageLink`, `links` and `resolveLink` implement
composition. `layers`, `addLayer` and `removeLayer` manage private snapshots;
`readFileState`, `obliteratedPaths`, `verify` and `obliterate` expose typed lifecycle
states. CLI commands are `vcs authority`, `vcs link`, `vcs link resolve`, `vcs layer`
and `vcs obliterate`, plus standalone `vcs recover-lock`; `vcs status`, `vcs add` and `vcs verify` include these semantics.
Resolution binds a local target repository explicitly. Remote link bindings and
promotion are outside this release; ordinary repository bundle/fetch transports
carry the committed descriptors and typed absence metadata.

Closure validation requires real, correctly typed commits, parents and trees.
A denial can exempt only an attributed payload leaf whose FileId and root match
its canonical tombstone. A structural reference or another FileId's leaf cannot
use a denial to hide missing data. Imports validate advertised, series and every carried commit/tree closure
before object storage or ref publication. Standalone object fetch carries denial
metadata; a structural object imports only with its closure already held or carried. Fresh import reconstructs the canonical
typed audit object even when no tree names it, and verification checks that audit.
Fetch exchanges metadata even when refs are unchanged. Empty clones preserve the
source identity and denial registry. Concurrent explicit identity requests serialize
creation under the store writer lease. Advertisement and archive export read
existing identity without mutation or a writer lease; legacy sources without an
identity remain unchanged. Identity adoption checks occupancy without inflating
objects. Validated denial records and address indexes are cached per store handle
against device, inode, nanosecond modification/change timestamps and size. Registry
replacement, in-place modification and pending/completed writes invalidate the
cache; returned records cannot mutate the cached authorization state.

## Physical inspection and durability bounds

Every surviving loose-object payload participates in pre-mutation copy inspection,
including unattributed or unreachable objects and recognized temporary copies.
Raw loose frames, zlib-compressed frames and canonical base64 tokens are inspected
recursively, including combinations of those representations. Retained ambiguous
copies cause `erasure_retained_copy`; they are preserved and no denial is published.
Arrival denial compares type-independent payload digests and full-frame object IDs,
so changing an outer blob's identity cannot admit a known recoverable representation.

Supported representation inspection allows six nested decodes and a cumulative
decoded-byte budget of the greater of 16 MiB or six times the raw input length.
Raw input length and the number of base64-shaped words do not consume that budget.
Decodes are visited individually without building a queue for the entire document.
Exact frame and nonempty raw-payload denial matches are checked before decoding.
Recognizable framing
or zlib that is malformed, or a supported encoding exceeding a bound, causes
`uninspectable_payload`. These are refusal bounds, never an assertion that the
uninspected content is clean. Small fragments shared incidentally with metadata
also cause conservative refusal. Unsupported pack/cache artefacts are refused by
physical inventory; this release does not implement a pack backend.

The application boundary includes supported loose storage, private control metadata,
current/retired registered working instances, and overlays. The active tracker
coordinate inside the caller's repository is rebased into each registered instance;
an external tracker retains its absolute boundary. Only the corresponding tracker
runtime paths are excluded, so same-named ordinary project directories remain
inspected. Tracker runtime fences cannot be erased through a forged owned
path. Ordinary project ignore rules cannot hide owned files from erasure. Standard tool directories
excluded from repository tracking, external backups, independently owned clones,
filesystem snapshots, media recovery and novel custom encryption are outside it.
Direct hostile filesystem mutation and writers bypassing the store lease are outside
the authorized application protocol. Operators must remove ambiguous retained copies
explicitly before retrying; the engine never silently deletes an unrelated FileId.

Physical erasure requires file and directory fsync. On Windows, Node cannot provide
the required directory-flush guarantee, so erasure raises `unsupported_durability`
before persisting denial or deleting bytes. Ordinary private metadata uses fsynced
files and atomic replacement, plus directory fsync on supported systems; Windows
metadata has the stated directory-durability limit. A pending denial survives cleanup
failure and refuses reads/publication until explicit authorized recovery. A crashed
writer lease can be recovered with `vcs recover-lock`, without erasure credentials
or payload deletion. New leases publish fsynced PID metadata with an atomic hard
link, so a crash cannot publish an empty owner. Empty legacy locks require a
one-minute grace period; live or unknown owners refuse. Recovery never clears
a pending denial: completing interrupted erasure still requires erase authority.
Operators must coordinate explicit recovery, excluding concurrent recovery commands.
Temporary owner files contain only PID metadata, remain subject to retained-copy
inspection, and cannot introduce payload bytes through the supported writer protocol.


## Application transactions and merge resolution

Scope discovery, inventory, durable denial and deletion share one synchronous store
lease. Shared-instance linking holds that lease from initial validation through
registration and materialization; registration precedes the first payload copy so
an interrupted link remains in the known cleanup scope. Unlink retains the worktree
location for future cleanup. Distinct native store handles at the same resolved root
share in-process reentrancy, while independent processes contend on the exclusive
filesystem lock. Restore, sparse-view writes, merge markers, checkout and native
materialization/replay helpers retain the lease across reads and resulting writes.
Callbacks must be synchronous; asynchronous work cannot outlive a lease.

Native tree merges reconcile FileId provenance before synthesizing blobs, records
or append-only histories. Subsequent merge and replay operations can therefore
continue on unrelated content after erasure without reopening a terminal identity.
Restore preserves both FileId and copy provenance.

Link descriptors merge atomically. An agreed descriptor or one-sided change stays
a typed link. Incompatible two-sided descriptor changes, including link/plain-file
changes, raise `link_merge_conflict` before commit/ref/index/layer publication.
Resolution requires explicitly staging and committing an agreed descriptor on the
current branch, then retrying the merge; the engine does not select a pin through
text merge or create a misleading clean commit. Existing resolved private bytes
remain unchanged until explicitly removing or resolving their layer.

Incoming principal, reason, FileId,
repository identity and pinned revision fields must be strings; JSON coercion cannot
manufacture valid typed metadata. An erased empty blob
remains denied by its exact typed address and FileId, while zero-byte structural
objects remain healthy and writable.


Proposed audit bytes are also part of physical-erasure preflight: the complete
canonical tombstone loose frame, pending and completed denial JSON, and planned
operation receipt must be free of selected payloads in supported representations
before the first audit-object or denial write. Conflicting bounded metadata raises
`erasure_audit_conflict` with old bytes and denial state unchanged; authorization
can retry with nonconflicting metadata. This checks every generated audit field,
including principal, timestamp, addresses, reason and receipt text. The exact assigned
operation receipt is validated again under its publication lock. Short payloads
that coincide with required metadata may require conservative refusal.

Hub and linked-instance verification both classify `object_not_found` and
`missing_fragment` as missing. Actual damaged bytes remain corrupt, and validated
FileId-attributed terminal payloads remain explicitly obliterated.

## Mutation and publication contracts

Private-layer parent and descendant collisions are checked before switch, hard
reset, undo or rewrite changes refs, HEAD or the operation log. Undo validates
its planned post-undo HEAD, including a restored branch that the same operation
moves. Checkout retains the same check for direct materialization. Manifest or
mixed record/blob changes return a per-path content conflict and preserve our
complete typed object; manifest metadata is never text-merged into a blob.
Agreed and one-sided changes keep the existing tree-merge behavior.

When a competing payload merge encounters an intentionally obliterated address,
it returns a per-path content conflict and retains our complete entry, including
mode, FileId and copy provenance. Every surviving input still undergoes frame,
kind and hash verification under the shared store lease; missing or corrupt
objects refuse. Surviving link descriptors retain explicit pin reconciliation.
An obliterated entry on our side remains absent during marker inspection and
materialization, and merging never changes the denial registry. A terminal
FileId cannot receive replacement bytes through ordinary staging. Reusing its
path for an unrelated identity requires explicitly removing the old entry from
the index before staging the new file; this does not reopen the erased identity.

Before erasure opens another inventoried worktree, its link must resolve to this
hub's physical shared control directory. Matching clone identity alone cannot
establish that binding. Missing or reused locations refuse instead of being
silently skipped. `vcs instance prune-retired <stored-relative-path>
--erase-token-file <file> --reason <code>` explicitly relinquishes only a missing
or unbound retired path. It requires erasure authority, refuses a still-bound
instance and records principal, reason and scope reduction in the local operation
log before changing inventory. It deletes no working bytes. The audit records
that future erasure receipts no longer claim cleanup at that location; independent
clones and externally moved copies remain outside those receipts. Undo does not
restore relinquished cleanup scope. Active entries must first be explicitly unlinked.

The writer lease waits against an elapsed five-second deadline, with sleeps
bounded by the remaining time. A live owner is never recovered or displaced.
Contention reports retry guidance and reserves recovery for interrupted writers.

Link listing uses at most 64 compressed prefix bytes per unrelated index object.
The prefix is only a listing hint. A recognized link still receives complete
frame, hash and descriptor validation. Missing or unrecognizable unrelated content
is omitted; operational I/O errors remain visible. A damaged prefix may conceal
its kind, so listing is partial discovery rather than a repository verification
receipt. Resolution cannot use an omitted descriptor. Full verification and every
publication closure continue reading and hashing complete required payloads.
Scan and status each validate one private-layer metadata snapshot per operation.

Import preflight validates each held object once within one closure walk, retaining
role and FileId checks for every reference. Carried bytes are independently hashed;
a held duplicate is also read and hashed before deduplication can substitute it
for the arrival. Ref import and fetch publication share the same store lease as
preflight. Series bases/patches and separately advertised fetch roots join that
preflight instead of repeating whole walks after publication. No cross-operation
payload trust cache is introduced.

Ordinary no-op fetch uses the existing object endpoint to exchange identity and
denial metadata. It still validates the receiver's held closure, including missing
or corrupt payloads; a cold no-op costs one pass over those bytes. Legacy transports
without that endpoint or its advertised capability retain their full-bundle
fallback. Constant-byte cold no-op sync is not claimed.

Recognizable base64-derived zlib candidates retain strict malformed-data and
output-budget refusal. An encoded denied payload can exceed the inspection budget
while remaining recoverable with a larger budget. Suppressing that refusal would
admit uninspected content. Ordinary binary data that resembles a malformed encoded
candidate can also receive a conservative refusal; availability is bounded by
supported representation inspection.

## Recovery, export and closure memory


The erasure command's `--recover-lock` flag validates the erase credential before
changing the writer lock, including when invoked from a shared instance. A wrong
credential leaves a real dead owner's lock and selected bytes untouched. The
standalone `vcs recover-lock` command still recovers ordinary dead writers without
erase authority; recovery alone never completes pending erasure.

Export uses bounded manifest discovery for file leaves. Serialization still reads
and hashes every exported object completely. Missing leaves/manifests, damaged hashes
and malformed matching manifests refuse export. Prefix hints never substitute
for serialization integrity.

Closure deduplication retains verified kinds for blobs, records and validated
links, plus decoded commits, trees and manifest fragments. Every reference still
checks its role and FileId/root denial attribution. Leaf payload bytes do not
survive in the closure map. Link validation happens before retaining its kind;
hash-valid malformed links and manifests still produce corruption. Held copies
are read and hashed within the same publication lease, including duplicates of
valid incoming objects; presence alone grants no trust.
Physical/structural failures are also retained for this walk, so a hash-valid
malformed link or manifest shared by two owners is read once and refuses both.
A context-dependent role mismatch leaves the successful kind available for
another reference; denial checks always precede reuse of cached results.

Closure metadata scales with graph size. One large inflated object and complete
carried bundle payloads still require memory. Bounded closure retention does not
establish multi-gigabyte operational readiness or full privacy and scale assurance.

Resumable uploads hash every claimed ID in the entire batch before denial decoding
or storage mutation. Denial preflight and writes then share one writer lease.
Malformed tree/manifest bytes under valid claimed addresses return documented
`corrupt_object`, including with existing or corrupt denial metadata, and a later
bad object cannot leave earlier valid objects stored. Valid hashes continue
through the unchanged denial and provenance rules.
