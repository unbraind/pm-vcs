# Repository composition and permanent payload erasure

Repository composition uses native pm-vcs objects through the engine API and pm
commands. Sparse linked instances share local storage independently of committed links.

## Committed links

A canonical, typed `link` object names an immutable repository identity, a pinned
commit object ID, and a source-to-destination path mapping. Its enclosing tree
commits the descriptor, never the linked repository's bytes. A clone reproduces
exactly that descriptor even when the linked repository is unavailable.

The operator's `vcs link --spec` file accepts ordinary JSON whitespace, including
pretty printing and a trailing newline. Its root must be an object; all fields
are validated and canonicalized by the existing `encodeLink` contract in
`stageLink` before object, descriptor or index publication. Unknown fields and
invalid roots, values or mappings refuse. Filesystem read errors retain their
native cause. Stored `link` bytes remain subject to strict `decodeLink` canonicality.

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
Erasure inspects leaf links as target text with no-follow identity checks, including
dangling and ignored owned links. An owned link is unlinked without reading or
deleting its target; unrelated user-authored links remain outside the provenance certificate. Ancestor links and protected control/runtime
paths remain forbidden. Ordinary restore, write and delete operations retain their
leaf-link refusal. The erasure removal must match the leaf identity inspected
before denial, as well as the captured ancestor identities.

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
manifest fragments, indexed pack members and owned temporary object copies.
Unsupported storage refuses before mutation. The guarantee covers native
provenance within owned application-visible repository storage, with a bounded
nonblocking residue audit; it excludes independent user encodings, external
backups, independently owned clones, filesystem snapshots and physical-media
forensic recovery.

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

The supported erasure backend accounts for complete loose zlib objects and indexed
packs. Every regular object-store file must parse completely; without explicit purge,
foreign, renamed, partial and old temporary files return `unverifiable`. Explicit `--purge-unaccounted`
authorizes identity-bound deletion with a receipt and complete re-verification;
see [accountability and purge](indexed-packs.md#physical-erasure-verification).
Denial
is persisted and fsynced before removing bytes; interrupted cleanup blocks writes
until authorized retry succeeds. FileId provenance is mandatory for new local
payload writes once denial exists. Complete bundle imports preflight attribution;
resumable payload-only upload batches refuse after erasure because their protocol
has no trustworthy FileId envelope. This is an explicit fail-closed boundary.

Layer removal refuses edited overlays by default and requires explicit discard.
Checkout changes the underlying index while leaving overlay disk bytes untouched.
Erasure refuses private layers at affected paths or holding selected native content
identities. Unregistered user copies remain outside the provenance certificate;
unknown object/control storage still refuses ownership classification.


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
Peers with object-fetch exchange metadata even when refs are unchanged. Empty clones preserve the
source identity and denial registry. Concurrent explicit identity requests serialize
creation under the store writer lease. Advertisement and archive export read
existing identity without mutation or a writer lease; legacy sources without an
identity remain unchanged. Identity adoption checks occupancy without inflating
objects. Validated denial records and address indexes are cached per store handle
against device, inode, nanosecond modification/change timestamps and size. Registry
replacement, in-place modification and pending/completed writes invalidate the
cache; returned records cannot mutate the cached authorization state.

## Physical inspection and durability bounds

Every surviving regular object-store file must parse completely as native loose
storage or an indexed pack, including checksums, ranges, framing and content
addresses. Unknown names, kinds, symlinks, incomplete representations and namespace
replacement refuse ownership. An explicit unaccounted-storage purge is separately
receipted and limited to its frozen authorized files. Every owned physical copy
participates, including loose/pack duplicates left by interruption. The bounded
raw/declared-JSON audit below is diagnostic and never replaces those checks.

`ObjectStore.walkInventory()` yields one frame- and hash-verified loose object or
recognized temporary copy at a time, using no-follow leaf opens and captured
root/directory/leaf identities. `inventory()` preserves its collecting API and
retains every payload for callers explicitly choosing that behavior.
`readInventoryObject(id, path)` re-reads only a canonical or recognized temporary
location for that address, including denied physical copies needed for pending
cleanup. These physical reads do not grant publication authority.

Erasure retains address/path/kind/digest metadata and decoded tree/manifest
structure during its first complete pass. After determining FileId closure and
refusing deduplication, it re-reads only selected payload locations. A second
complete verified pass inspects each surviving payload individually for retained
copies and verifies the physical path set before durable denial. Deletion uses
only those verified selected locations. Metadata, directory listings, decoded
structure and selected payload memory still scale with their respective scopes;
one decoded object's size and representation inspection also remain allocation
bounds. Whole-repository constant memory and production-scale readiness are not
established. The shared writer lease covers all passes and publication.

The application boundary includes supported loose storage, private control metadata,
current/retired registered working instances, and overlays. The active tracker
coordinate inside the caller's repository is rebased into each registered instance;
an external tracker retains its absolute boundary. Only the corresponding tracker
runtime paths are excluded, so same-named ordinary project directories remain
inspected. Tracker runtime fences cannot be erased through a forged owned
path. Ordinary project ignore rules cannot hide owned files from erasure. Unowned
standard tool artifacts, including nested tool-name files and leaf links, external
backups, independently owned clones,
filesystem snapshots, media recovery and novel custom encryption are outside it.
An owned protected tool path still refuses before denial publication.
Direct hostile filesystem mutation and writers bypassing the store lease are outside
the authorized application protocol. Operators must remove ambiguous retained copies
explicitly before retrying; the engine never silently deletes an unrelated FileId.

The denial-first ordering protects process interruption. Its power-loss guarantee
requires POSIX directory fsync; Windows retains the weaker namespace durability
limit below. Physical erasure uses the shared durability helper: files are fsynced before
publication and directories after namespace changes where supported. Windows uses
synchronous namespace acknowledgment after file fsync, with the documented weaker
power-loss guarantee; see [platform durability](indexed-packs.md#concurrent-readers-and-platform-durability).
A pending denial survives cleanup
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
Manifest conflicts validate every fragment's real frame, hash, blob kind and declared
length under the writer lease, one fragment at a time without assembling the file.
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

Link and manifest discovery advances in 64-byte compressed chunks until the frame
header is available; a DEFLATE dynamic header can require more than one chunk.
Each inflation attempt caps output at 4 KiB, backing off the input prefix when a
compressible payload reaches that limit. A valid frame header fits in 32 bytes
(kind, space, at most 16 decimal length digits and NUL). The compressed prefix
budget is 64 KiB. An ambiguous stream that exhausts it raises `object_prefix_limit`
instead of silently disappearing. This is an explicit discovery refusal bound,
not a guarantee that every possible legal zlib stream exposes its header within
that budget; deliberately padded streams can exceed it. Recognizable unrelated
kinds avoid full payload reads. The prefix is only a listing hint. A recognized
match still receives complete frame and hash validation, plus descriptor or
manifest validation by its caller. Missing or malformed unrelated content is
omitted; operational I/O errors remain visible. A damaged prefix may conceal
its kind, so listing is partial discovery rather than a repository verification
receipt. Resolution cannot use an omitted descriptor. Full verification and every
publication closure continue reading and hashing complete required payloads.
Scan and status each validate one private-layer metadata snapshot per operation.

Import checks all arrivals against combined local/received denials before any
publication; the same inputs under the same lease make another immediate local
preflight redundant. Locked `ObjectStore.accept` retains its own final preflight.
Import preflight validates each held object once within one closure walk, retaining
role and FileId checks for every reference. Carried bytes are independently hashed;
a held duplicate is also read and hashed before deduplication can substitute it
for the arrival. Ref import and fetch publication share the same store lease as
preflight. Series bases/patches and separately advertised fetch roots join that
preflight instead of repeating whole walks after publication. No cross-operation
payload trust cache is introduced.

Ordinary no-op fetch uses an implemented and advertised object-fetch endpoint to
exchange identity and denial metadata. Legacy fallback requests only advertised
branches/tags that map to local refs and are not conflicting tags. An empty
legacy fetch request means all refs; it is never used to mean metadata only.
When no refs are eligible and object-fetch is unsupported, transfer is skipped.
Such an old peer cannot exchange a new denial in that case; a peer supporting
object-fetch still exchanges metadata even for conflicting-only advertisements.

Every no-op path validates the receiver's held closure and local immutable audits,
including missing or corrupt payloads and pending denial, under the store lease.
A cold no-op costs one pass over those bytes. No-op fetch changes no refs, index
or operation log. `FetchReport.upToDate` is false when actual imported objects or
exchanged denial metadata change, even with no ref movements; unsupported peer
metadata is not evidence of its absence. Constant-byte cold no-op sync is not claimed.

Import preserves the durable denial registry and existing tombstone files when
received metadata adds no terminal identity, including stale peers omitting local
denials and peers repeating an already known record. Registry validation checks
canonical metadata; import separately reads and hash-verifies every local audit
object before publication. Missing or corrupt local audits refuse instead of
being silently reconstructed. A genuinely new received identity persists the
combined registry before object publication, after the complete arrival and
closure checks. Pending local cleanup and duplicate or conflicting FileIds still
refuse. Warm handles retain their registry cache across these unchanged imports;
this does not remove the cold closure hashing bound described above.

JSON-header regression fixtures assert native chmod-based EACCES only on POSIX
under a non-root process. Missing-file, directory, integrity and remaining
functional assertions run on every platform; root and Windows permission
enforcement is not established by those chmod fixtures.

Erasure certifies native provenance, not universal content inference. `guarantee.kind`
is `native-provenance`; `guarantee.objects` lists the selected content identities,
and `guarantee.excluded` identifies independent user encodings, names/metadata and
caller-owned or external copies. Every native content derivation within the owned
scope is removed or made a terminal, unreadable identity. Identifier-only tree,
index, reference, journal and receipt facts remain; immutable commit ancestry is
not rewritten. A retained identifier is not a retained payload representation.

Native FileId payload writes durably publish an identity-only ownership edge before
object bytes. This includes objects never published by an index or commit, and
shared unpublished ownership retains its refusal. The provenance namespace admits
only exact ID/FileId filenames containing empty regular files, with no symlinks.

Native manifests establish composition by their actual ordered fragment/page
edges and verified lengths. Their canonical whole-blob identity is computed with
a memoized composition proof, independent of the chosen chunk layout.
Each distinct object is decoded once per proof; repeated edges reuse cached bytes.
Logical content at 256 MiB, aggregate cache at 512 MiB, one million inspected
edges, the verification deadline or a changed store lease refuses before deletion.
Unknown legacy/imported payload provenance refuses with `uncatalogued_provenance`
and complete machine-readable object identities; reads and exports stay supported.
Native derivation certificates precede bytes and connect merge/replay, conflict
side/resolution, staged replacement/copy/rename, fragment rewrite and rendering
outputs transitively. Historical derived roots carry exact FileId roles, preserving
intentional absence without legitimizing independently shared ownership. Equivalent
compositions and their fragments, and reverse manifest/conflict wrappers, join
the deletion plan. Pending denial durably records this closure before deletion.
Future native compositions and whole-content fragment sources are checked against
terminal identities before publication. A different chunk layout cannot restore
an erased logical payload. Shared ownership still refuses rather than deleting
another FileId's content. Private layers at selected paths or holding the exact
selected native content identity must be removed explicitly first.

Repository-owned operation appends hold the store lease before the log lease,
so no peer can append between redaction and erasure completion. Standalone logs
retain their independent file lease.

Operation summaries created before complete source attribution existed are
conservatively redacted as a class, under the operation log's own lease. The
replacement is durable and recoverable, preserves sequence, command, timestamp
and safe transition facts, and removes selected payload endpoints. Unknown log
shapes refuse ownership rather than being silently discarded. The final erasure
operation records only bounded audit identities.

Native working-file writes persist source IDs, output identity and a filesystem
birth identity in `outputs.json` before the first content byte. Final publication
records completion; interrupted output remains attributable before its index
entry exists. Source closure removes these outputs through pinned destruction.
A different birth identity, or changed completed output, refuses and preserves
foreign bytes. Resolved private snapshots record their native source IDs; legacy
record snapshots are covered by the actual JSON/TOON renderer identities. User
copies or renames that cross the managed ownership boundary are independent
files and cannot be revoked by this certificate.

Repository-local ordinary and signed CLI bundle files have an `exports.json`
provenance registry:
canonical relative path, native input IDs, output blob identity and SHA-256 byte
fence. The signed native producer supplies its actual included-object inventory under
the same source lease. Registration precedes publication. Erasure retires affected registered
files through the existing pinned worktree destruction plans and removes their
registry entries. Replaced bytes refuse and remain untouched. Caller-returned
buffers, external destinations and legacy unregistered exports cross the managed
ownership boundary; they are independent copies requiring their owner's cleanup.
No erasure command can revoke bytes already handed to another owner.

The secondary audit checks raw native members and physical bytes and decoded
strings/keys in declared native JSON documents, bounded to 16 MiB of shared work
and eight JSON levels. Native readers already decode pack framing, zlib, manifest
pages and registered archive inventories for the primary identity proof. The
audit never guesses hex/base64/compression/URL transformations in arbitrary blobs
or JSON values. Its receipt contains `suspected_residue`, `limited`, `scope` and
`limits`. Missing or exhausted audit evidence cannot refuse benign erasure or
staging. A false residue flag is not proof of absence. Ownership, corruption,
namespace changes and unauthorized publication remain hard refusals.

The complete format/class audit and reviewer reproductions are recorded in
[the PR validation report](validation/pr150-erasure-review-repair.md).

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
Filesystem push validates every requested branch or tag name before importing
arrival bytes. Both push and uploaded-object publication validate the union of
requested commit roots under one synchronous writer lease, through the atomic
compare-and-swap ref transaction and operation receipt. Push includes requested
targets absent from the bundle advertisement in its import preflight; publication
uses one shared closure walk. Each distinct held object is read and hash-checked
once in that walk. Fast-forward policy can still read commit ancestry separately.
Invalid names precede bundle or closure errors; all closure errors precede
fast-forward policy and ref compare-and-swap. Stale push transactions retain
`ref_changed`; uploaded-object publication retains `publication_race`. A refused
publication clears its connection arrival receipt before retry.

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

## Private registry absence and native payload ownership

A missing `layers.json` means an empty registry. A present JSON `null`, non-array
root, malformed JSON or invalid layer entry raises `bad_layers` before bulk
staging can inspect or publish private overlay bytes. `readControlJson` accepts
an optional absence fallback, selected only by the original read's `ENOENT`;
`readLayers` supplies an empty array. Parsed values always undergo validation.
There is no additional existence probe. Other control readers keep their default
missing-file semantics, native I/O errors and symbolic-link refusals.

`writeManifest(store, manifest, fileId?)` and the fixed/CDC buffer, file and open
file-descriptor writers accept an optional final owning FileId. Every blob and
manifest write forwards that identity to `ObjectStore.write`. Before erasure,
existing calls without an identity remain supported. Once any denial exists,
local payload writers must supply their actual owning identity. A denied identity,
known denied object/content identities and native compositions still refuse
through the locked publication preflight. User-authored alternate encodings are
independent data; supplying ownership does not bypass native identity checks. Anonymous transport and legacy
unattributed arrivals retain their refusal.

Two-sided merges already pass their reconciled FileId to the payload writer.
Legacy trees without identities use the existing index-migration rule, now shared
in the model: SHA-256 over the legacy identity domain, repository-relative path
and original object address, truncated to 32 hex characters. A common base's
explicit identity takes precedence; otherwise its original address provides
migration provenance. With no common base, the actual pre-merge local entry
provides that provenance, matching staging. Explicit descendant identities remain
unchanged. Content conflicts retain their existing behavior, and stored input
bytes still undergo integrity and denial checks before synthesis.

Bounded real fixtures exercise private overlays, missing/empty/valid registries,
actual links and native filesystem errors, fixed/CDC buffer/file/descriptor writes,
standalone manifests, and legacy blob/record merges after unrelated authorized
erasure. Survivor manifests and fragments retain their hashes, reads and clone/
export behavior. The same package-owned scenarios run through built and npm-packed
Node, native Bun, and the pinned project-installed CLI consumer. Selected docstring
coverage remains a measured declaration subset (previous denominator 290), not
whole internal documentation coverage. The declared minimum SDK runtime and
independent true-global CLI proof remain historical and are not renewed here.


### Provenance across garbage collection

The clone-private `pm-vcs-derivation-3` certificate is self-contained: its sorted,
deduplicated `sources` contain every transitive native input identity, including
intermediate objects, manifest pages and fragments. `unknown` retains any ancestry
whose native origin could not be established. GC retains these metadata records
even when it collects their objects. Erasure never needs an intermediate payload
to follow a version-three certificate. `whole` records a manifest's reconstructed
whole-blob identity or the literal payload identity of a record, link or conflict, `members` retains its native composition dependencies, and a
virtual whole-blob certificate keeps the reverse representation links. Both sides
survive GC. Selected whole content therefore selects every equivalent container,
fragment/page set and native descendant, including registered worktree outputs.
`whole: false` is an incomplete primary proof and cannot certify erasure.

Before a sweep, GC upgrades version-one direct-parent and version-two records while their native
structures are still available. Erasure also upgrades them before granting any
deletion authority. A missing old object, an uncatalogued payload ancestor, or a
missing input certificate makes its derived objects unknown; erasure refuses with
`uncatalogued_provenance` naming the affected derived identities. Registered native
outputs establish their native blob kind without requiring a physical object-store
copy. Structural frames contain identity references and caller metadata rather
than derived payload snapshots; their certified origin facts are also retained.
Old objects still read and export. A conservative unknown flag is retained rather
than erased by an ordinary rewrite.

Certificate construction and upgrade deduplicate inputs, memoize each inspected
object and check the pinned lease and deadline throughout traversal. Primary
limits are one million objects/edges, 256 traversal levels for old direct-parent
graphs, and 300 seconds; reaching a limit grants no complete certificate. These
limits are separate from composition hashing and the diagnostic residue audit.
Only authorized erasure retires selected certificates, after recoverable bytes
and their output registrations have been removed. Normal GC never retires them.


Whole-content equivalence is recorded by the shared native object writer and all
fixed/CDC buffer and descriptor fragment producers. Fragment publication records
the source whole identity before recoverable fragment bytes; completed manifests
retain both that identity and every structural input. Direct native manifests
compute their reconstructed identity within the primary composition bounds.
Re-splitting content uses these same producers. Pack, repack and unpack retain
object IDs and their certificates. Bundle import, clone/fetch and hydration use
the common arrival path, which records native payload and manifest equivalence without
inventing clone-private origin certificates for imported payloads. An unknown
imported origin remains unknown and refuses erasure; equivalence alone grants
no deletion authority over independently owned data.

Equivalent content is not ownership authority. An independent FileId's fragment
or manifest representation retains its independent role and the existing
`erasure_dedup_conflict` refusal. Whole-content edges are recorded separately from
explicit native transformation inputs; they cannot silently relabel an
independently supplied file as a derived output.


Descriptor fragment ingestion takes an explicit start offset (default zero) and
preserves the caller cursor. Checksum-bound source blocks and private buffer
snapshots ensure the certified bytes are the published bytes. Accountability
requires two matching passes and a namespace check after final rehashes under
the native store lease. See the [seventh-review class audit and concurrency
scope](validation/pr150-seventh-review.md).
