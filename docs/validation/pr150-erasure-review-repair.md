# PR 150 provenance repair

The orchestrator's third independent review of `ccc4942` reproduced five
failures. Its instruction replaces universal decoded-content claims with native
provenance. More speculative decoders cannot establish complete erasure. Earlier
codec validation in this document's history is not a certificate for this contract.

## Guarantee

Every pm-vcs-derived content representation of the selected object identities is
removed from owned native object storage, fragment compositions, registered local
exports and inventoried shared working copies. Native legacy operation summaries
are conservatively redacted. Identifier-only ancestry, indexes, refs, tombstones,
paths and journal facts remain; authoritative terminal denial changes their read
meaning to `obliterated`. They cannot reconstruct the erased content.

Independent user files, user-authored alternate encodings, names and metadata, caller-owned
buffers, external destinations and legacy unregistered exports are outside this
certificate, together with backups, snapshots, other clones and physical media.
A copied user filename is independent naming metadata, not evidence that its
bytes were derived from an object's content. The receipt explicitly lists these
exclusions. It never certifies universal absence of arbitrary encodings.

The secondary audit checks raw native payload/physical bytes and decoded native
JSON keys and string values, with a shared 16 MiB work budget and eight JSON
levels. It reports `suspected_residue`, `limited`, `scope` and `limits`. A false
residue flag proves no absence. Missing/exhausted diagnostics and encoding-shaped
benign data cannot refuse erasure or staging. Native ownership/corruption and
namespace failures remain hard refusals.

## Class audit

| Persisted location | Provenance rule and verdict |
| --- | --- |
| Loose objects, native write stages and every pack member | Exact object IDs and payload identities select every owned location. Native parsers, zlib framing, checksums, pack offsets/index and descriptor/namespace fences remain mandatory. Audit sees decoded native members; arbitrary blob content has no implied encoding. |
| Fragment manifests and pages | Ordered native edges, lengths, child types and page heights define composition. Streamed canonical whole-blob identity finds equivalent fragment layouts. All contributing fragments and reverse manifest/conflict wrappers join denial/deletion before mutation. Reads cannot reconstruct a denied root. |
| Future fixed/CDC fragment writes and arrivals | Whole-source content identity is checked before partial publication; composed incoming manifests use the same identity rule across held and carried objects. Exact IDs/digests and FileId/role checks remain. Arbitrary user encoding is not decoded or refused. |
| Native payload ownership | Zero-byte native records bind an object ID to each producing FileId before object publication. Exact names, kinds, empty bodies and directory/descriptor fences classify the namespace. Erasure includes unpublished writes and refuses shared ownership even without an index or commit edge. Interrupted intent publication contains only IDs, never source bytes. |
| Operation logs and receipts | Legacy summaries lack source IDs, so all prior summaries are conservatively replaced under the log lease. Atomic native publication removes old bytes; replay is idempotent. Every repository-owned append shares the store lease through its log lease, so a peer cannot append between redaction and erasure completion. Sequence/command/time and safe transitions remain; erased payload endpoints are nulled. Unknown log records refuse ownership. New erasure receipts contain identities and bounded audit facts. |
| Destruction journals, archives, owners, progress and stages | Exact names, kinds, schemas, inode bindings, progress checksums and namespace fences retain authority. Unknown bytes under destruction refuse before deletion. These records carry paths and object/file identity facts rather than payload bodies. Declared JSON strings participate in the nonblocking audit; arbitrary string encodings are not guessed. |
| Purge and fingerprint journals | Strict formats/checksums remain ownership gates. Digests and window signatures are one-way facts; absent diagnostic signatures only mark the audit limited. No payload body is written here. |
| Series, checkpoints, attestations and signatures | Series patches contain commit IDs, not patches with payload bodies. Checkpoint projections hash native record fields and store encoded tree/identity or digest facts; claims/signatures are verification evidence, not reversible selected content. User-authored descriptions/messages remain independent metadata. |
| Pack indexes, refs, HEAD and historical tree/index entries | Canonical structural IDs and lengths contain no reversible payload encoding. Historical FileId/root edges resolve through the terminal denial registry. A digest byte coincidence is not provenance. No promise to erase identifier-only ancestry or independent ref/path names is made. |
| Registered CLI bundle files, including signed change bundles | Native input inventory, canonical output blob ID, SHA-256 bytes and relative path are recorded before local publication. Affected artifacts use pinned worktree destruction; registry entries are removed. Changed bytes refuse and remain foreign. Native bundle parsing supplies ordinary archives; the signed exporter supplies its actual included-object inventory under the same source lease. Neither path guesses encodings. |
| Returned ordinary/signed bundle buffers and external/legacy exports | Returning/transferring bytes crosses the managed boundary. These copies are caller-owned; no local command can revoke them. Repository source `selfhost.bundle` is an independently versioned artifact, not an unregistered managed export owned by a target history. Its owner must regenerate it when source changes. |
| Private layer snapshots | Native canonical base64 is decoded by the layer reader. Resolved snapshots persist their native source IDs before materialization. The actual record renderer defines JSON and TOON output identities, including legacy snapshots. Selected sources, paths or produced content identities retain the layer ownership refusal. User-written independent layer names or alternate encodings remain outside provenance. |
| Config, remotes, credentials, authority, views and instance metadata | Native producers write identifiers, bindings, grants or user input, not reversible representations of object content. Existing JSON/kind and authorization checks remain. User-entered URLs and encoded strings are independent metadata, including double percent escapes and native URL normalization variants. |
| Lease audits and process markers | The same native audit decoder validates exact event/lease keys, FileId, generations and record types; descriptor/name fences reject replacement. Native PID and generation stages retain their grammar. Unknown fields/bytes refuse ownership. Resource/owner identities and process facts contain no object payload derivation; identifier coincidence does not deny benign writes. |
| Inventoried working files and linked instances | Removal follows selected FileId ownership and exact pinned preflight identities. Every native writer records source IDs, output identity and device/inode/birth identity in `outputs.json` before writing bytes. A final publication fact distinguishes complete content from interrupted output. Native copies remain attributable before index publication; unrelated replacements refuse. Retired outputs leave only identity facts. Unrelated user files, links and protected tools remain outside the certificate; shared native content owned by another FileId still refuses. |

## Reviewer cases and regression evidence

`test/erasure-provenance.test.ts` drives real repository APIs for the five cases:
double-percent user data; whitespace/control-normalized backslash file URLs;
concatenated compressed streams in a native log summary; two split fragments
reconstructing a selected whole blob; and 1,024 repeated `3` bytes before erasure
and during later staging. Generated histories also combine loose/packed objects,
fragments, operation logs, registered bundle outputs, terminal historical reads,
fresh exports and idempotent cleanup. Ownership negatives preserve replaced
exports and unknown registry/destruction artifacts.

Control-stage classification shares the actual purge, denial, fingerprint and
export/output decoders. Complete valid stages and empty native bootstrap stages remain
accepted. Opaque bodies and unknown fields refuse before deletion. An operation-log
replacement stage contains only the redactor's fixed summaries or canonical erasure
audit summaries; legacy body-bearing summaries cannot masquerade as that stage.
Normal logs retain their original compatibility reader; strict erasure classification
never silently drops an unrecognized record.

| Finding / class regression | New outcome | Behavioral reversion | Restored result |
| --- | --- | --- | --- |
| Double-percent user data | Retained as independent data; receipt explicitly excludes user encodings. | Removing the receipt exclusion fails 1/1. | 1/1 |
| Concatenated compressed streams in native log summary | Summary removed by record provenance, without guessing its codec. | Removing native summary redaction fails 1/1. | 1/1 |
| Native-normalized whitespace/backslash file URL | Native parsing reproduction is asserted; user-authored address remains explicitly outside the certificate. | Removing the receipt exclusion fails 1/1. | 1/1 |
| Two split fragments reconstruct a selected whole | Native composition identity closes the manifest and fragments; read APIs and fresh compositions refuse. | Disabling native composition identity fails 1/1. | 1/1 |
| Benign 1,024 repeated digits | Erasure and later attributed staging succeed. | Restoring the `ccc4942` speculative arrival decoder fails 1/1. | 1/1 |
| Registered export/property history | Five generated loose/packed histories, including a shared-instance export, cannot retain a live native representation. | Removing export cleanup fails all five children and their parent. | 6/6 |
| Whole-content fragment publication | A denied source cannot leave newly published partial fragments. | Disabling whole-source preflight fails 1/1. | 1/1 |
| Unpublished native FileId writes | Native ownership persists before bytes, including objects with no index/tree edge. | Removing ownership publication fails 1/1. | 1/1 |
| Interrupted working outputs | Both complete and partial unindexed native copies are removed through durable source edges. | Removing only output publication fails both children and their parent. | 3/3 |
| Legacy record rendering | Native TOON aliases remain selected without any newer output registry. | Removing only the native TOON renderer identity fails 1/1. | 1/1 |
| Signed local archive | Actual native input inventory attributes the signed output to its source. | Removing only the exporter's source capture fails 1/1. | 1/1 |
| Native log producer race | Peer append after redaction cannot enter the erasure transaction. | Removing only the shared store lease fails 1/1. | 1/1 |
| Denied output FileId | A surviving source cannot create new working bytes assigned to a permanently denied FileId. | Removing only the producer FileId guard fails 1/1. | 1/1 |
| Indexed FileId edits | Current selected FileId authority continues to cover edits after native checkout. Output-only ownership retains its birth/content fence. | Applying the output-only fence to an already selected indexed path fails 1/1. | 1/1 |

Every mutation executes in an isolated source copy, restores every engine module
and reruns the same behavioral selection. Only failing mutants with passing restored
controls count as proof. Workspace production sources are never mutated by the harness.

The redundant composition depth guard was removed with a structural proof:
`decodePagedManifest` permits heights 1 through 7, and `assertManifestChild`
requires every child height to be exactly its parent's height minus one. Legacy
nodes are leaves. Traversal cannot exceed seven page edges, so `depth > 8` was
unreachable for decoded native inputs. Kind, length and child-role refusals remain.

## Validation

All commands use isolated credentials-free child environments and owned scratch,
with at most two test workers. No installer was retried. The first native Bun attempt passed five behaviors but failed cleanup because Bun lacks the Node mocking API; portable cleanup now checks API availability, with Node mock restoration and every assertion retained. The corrected Bun run has zero cleanup errors. Superseded diagnostics,
expectation failures and deliberately stopped implementation matrices are not
passing evidence. Full npm/Bun release CI and independent review remain required;
local focused results are not a full release certificate.

Catalog scale is tracked separately in `pm-vcs-provenance-catalog-scale`. Identity-only
ownership edge files consume control-directory inodes, and native output publication
rewrites its current registry. The existing public pack benchmark measures the object
root; it does not establish total-clone metadata cost or checkout throughput. Any
catalog compaction must preserve source-before-bytes durability, strict classification,
legacy reads and every recovery guard.

| Focused gate | Result |
| --- | --- |
| Broad erasure, accountability, fragment-repair and provenance command | 228/228; zero failures, skips or cancellations |
| Packed power-loss matrix | 1/1; 6,007 native boundaries, 518 distinct complete crash images, two convergent replays each |
| Focused c8 cohort | 73/73; all five targeted modules reach 100% in each dimension |
| New provenance modules | `erasure-provenance.ts`, `managed-exports.ts`, `native-outputs.ts`, `oplog.ts` and `payload-owners.ts`: 100% statements, branches, functions and lines in the focused c8 cohort |
| Node 22 provenance runtime selection | 18/18, zero failures/skips/cancellations |
| Native Bun reviewer cases | 5/5; no cleanup errors after portable harness repair |
| Signed export / undo CLI | 2/2 |
| Packs | 38/38; includes real SIGKILL and competing-writer cases |
| Fragments | 56/56 |
| Lifecycle local selection | 43/43; 18/800 and 18/988 native interruption cuts, plus two process interleavings; full cuts and 512-seed model remain CI |
| Behavioral mutation groups | All fourteen mutants fail; every restored selection passes |

Exact commands and focused results are recorded on `pm-vcs-phase6packs`;
committed-head self-host evidence and CI run URLs accompany the pushed head. Native
ownership and primary verification limits, coverage thresholds and every default
CI matrix cut remain unchanged.


## Reproduce the focused checks

Use Node with at most two test workers and a fresh, credential-free child
configuration. The recorded commands use one worker:

```sh
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-skip-pattern=SIGKILL test/erasure-provenance.test.ts test/erasure-accountability.test.ts test/erasure-fragment-repairs.test.ts test/erasure-storage.test.ts
node_modules/.bin/c8 --include=engine/erasure-provenance.ts --include=engine/managed-exports.ts --include=engine/payload-owners.ts --include=engine/native-outputs.ts --include=engine/oplog.ts --100 --per-file --reports-dir=coverage/provenance-final2 --reporter=text --reporter=json node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 test/erasure-provenance.test.ts test/oplog.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-name-pattern="EVERY native obliterate-packed boundary" test/journal-durability.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 test/packs.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 test/fragments.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-skip-pattern="512 seeded|cut (?!(?:1|2|25|50|100|150|200|250|300|350|400|450|500|550|600|650|700|750):)" test/erasure-lifecycle.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-name-pattern="CLI handlers use explicit|undo fences HEAD" test/change-bundles.test.ts test/oplog.test.ts
bun test --parallel=1 --max-concurrency=1 --timeout=120000 --test-name-pattern="user-authored|native operation summaries|native split manifests|benign repeated digits" test/erasure-provenance.test.ts
npm run check
npm run build:test
npm run docstring
npm run pack:check
npm run changelog:check
```

The provenance runtime selection recorded on the pm item also runs on Node 22.
The local lifecycle command samples 18 cuts from each of its two interruption
matrices and omits the 512-seed model; CI retains the complete default matrices.
The complete npm/Bun release gate is CI evidence, not a local focused claim.
All pm writes precede `npm run changelog:full`, `npm run self-host:write`, the
commit, and `npm run accept:self-host` at HEAD. Archive verification never
regenerates its input.

## Fourth review: native derivation completeness

The accepted guarantee remains **native provenance erasure**. Every pm-vcs-derived
content representation of the selected object identities is removed from owned
objects and materializations. Identifier-only structural history and terminal
denials remain, with exact historical FileId roles for removed derived outputs.
User-authored alternate encodings remain outside this guarantee. Diagnostic
residue observations are bounded and never substitute for the primary proof.

A native payload certificate is durably published before its first object bytes.
It records source identities and distinguishes independently supplied FileId roles
from native derived roles. Reverse edges are indexed once; a queue visits each
identity once. Native manifest/conflict edges, rendered records and managed outputs
join the same closure. Current indexes and birth-fenced output records select
worktree materializations of derived identities as well as the original FileId.
Independently shared payload ownership still refuses.

Uncatalogued legacy payloads are **unknown**, including unreachable objects and
ordinary imported archives that do not carry the clone-private catalog. Erasure
refuses with `uncatalogued_provenance`, the complete machine-readable `objects`
list, and a bounded diagnostic naming the first twenty identities, before any
payload deletion or denial publication. Read, evaluation, export and identity-
preserving storage maintenance remain supported. Rewriting an existing address
cannot manufacture an origin certificate for it. No content scan upgrades unknown
provenance to unrelated data.

Composition traversal memoizes each native object and inspects each ordered edge
once. Repeated edges reuse a cached result. Primary proof budgets refuse before
deletion: a logical composition must be below 256 MiB, aggregate distinct-node
cache below 512 MiB, and edge work below one million. Each node, edge and 64 KiB
hashing slice checks the deadline and the caller's pinned publication or
recovery-validation lease. These are primary proof limits, separate from the
nonblocking residue audit. The eight-object 512 TiB fixture refuses after reading
only its root. Oversized/over-budget composition grants no erasure certificate.

| Derivation site in `engine/` | Native provenance / preservation | Regression coverage |
| --- | --- | --- |
| `rewrite.ts:mergePath` record merge, text merge, append-only PM log union | Input identities are scoped through every output and side envelope | Different-FileId merge; record/text/history producer cases |
| `rewrite.ts` replay used by rebase, cherry-pick, revert, squash and virtual merge bases | All paths reuse the certified common producer; unchanged identities are reused | Common producer cases plus existing replay and first-class conflict suites |
| `conflicts.ts:fieldSide`, text side slices and competing resolutions | Field/hunk envelopes carry native inputs; conflict objects also record alternatives | Record/text producer cases; resolution/range remapping; competing-resolution regression |
| `conflicts.ts:carryConflicts` / `resolvePayload` | Shifted descriptors carry old unit and old/new projection; resolved payload carries projection and selected units | Resolution and shifted text conflict regression |
| `repo.ts:stage` / `stageContent` | Prior identity follows replacement, rename/copy and CDC writes; complete birth/content-matching native outputs retain their real producer inputs | Replacement, rename, copy refusal, chunk rewrite, staged bundle/rendering/large-output, partial/replaced-output cases |
| `repo.ts:stageLink` | A descriptor pin replacement carries its previous native identity | Link derivation regression |
| `fragments.ts`, `manifest-pages.ts`, `model.ts:writeManifest` | Scoped native inputs reach each chunk; manifests record ordered native children | Generated derivation history; existing split-manifest/read and fragment suites |
| `native-outputs.ts`, `worktree.ts`, `worktree-mutation.ts`, repository materializers | Source records precede bytes; derived paths require current birth/content evidence, independently owned projections remain intact | Different-FileId removal and pending/completed retry; generated history; edited/unregistered leaves; existing interrupted outputs |
| `forge.ts:writeReview` | Review updates carry previous review/outcome records; initial caller fields and identifier-only series references are origins | Review-update provenance regression and existing served-forge suite |
| `objects.ts:write` | Shared certificate barrier; monotonic source/role union; legacy identities cannot be relabelled | Generated history, legacy same-address rewrite, classification/refusal corpus |
| `objects.ts:writeRaw`, `packs.ts`, `bundle.ts`, `sync.ts`, `transport.ts`, `bisect.ts` | Identity-preserving physical copies and imports never invent provenance; existing local certificates remain authoritative; unknown imported/legacy objects refuse erasure | Packed recovery matrix, legacy compatibility, existing pack/import tests |
| `managed-exports.ts`, `bundle.ts`, `change-bundles.ts` | Registered output inventories and hashes cover actual carried object identities, including signed archives | Existing generated bundle and signed export properties |
| `oplog.ts`, receipts, destruction journals | Summaries are conservatively redacted; retained identifiers/fingerprints are one-way audit facts | Existing operation-summary, destruction classification and accountability regressions |
| `model.ts` tree/commit/series, refs, index, partial state, metadata | Structural identity references remain valid typed intentional absences; arbitrary caller metadata is not inferred content derivation | Derived historical-root role checks; verification/export after erasure; existing refusal corpus |

The prior three-issue fixes, merge-from-main resolutions and uncovered-branch
proofs remain recorded in `pr150-ci-repair.md` and the earlier sections above.
This round changes neither coverage thresholds nor ownership/storage guards.


### Fourth-review revert controls

All mutations ran in disposable source copies, with isolated runtime state. The
production copy was unchanged. Each mutant fails the named behavioral selection;
the restored implementation passes it. The table accounts for **21 mutation
groups, 27 failing mutant cases and 27 restored passes**.

| Removed behavior | Regression selection in `derivation-provenance.test.ts` | Mutant failures / restored passes |
| --- | --- | --- |
| Replace the common merge input scope with a plain writer lease | `merge of different FileIds` | 1 / 1 |
| Treat an erased conflict alternative as authority over its independent projection | `erasing a native conflict alternative` | 1 / 1 |
| Remove catalog source edges from erasure selection | `merge of different FileIds` | 1 / 1 |
| Remove the uncatalogued-object refusal | `ccc4942-era` | 1 / 1 |
| Expand a previously visited composition again | `memoized composition` | 1 / 1 |
| Remove the composition deadline barrier | `memoized composition` | 1 / 1 |
| Remove the composition lease fence | `memoized composition` | 1 / 1 |
| Remove the primary logical-byte bound | `eight native objects|composition faults` | 2 / 2 |
| Remove exact historical roles for derived absences | `merge of different FileIds` | 1 / 1 |
| Remove the staging input scope | `staging records replacement|staging records rename|staging records fragment-rewrite` | 3 / 3 |
| Drop native inputs from conflict field envelopes | `competing field resolutions` | 1 / 1 |
| Drop scoped inputs from streaming payload publication | `generated native derivation history` | 1 / 1 |
| Drop the previous descriptor from pin replacements | `link pin replacements` | 1 / 1 |
| Drop previous review/outcome inputs from review updates | `native review updates` | 1 / 1 |
| Remove the complete derivation namespace fence | `derivation classification` | 1 / 1 |
| Remove the pinned catalog-directory retirement authority | `catalog retirement` | 1 / 1 |
| Grant a selected derived index ID deletion authority without current output evidence | `derived worktree ownership` | 2 / 2 |
| Lose producer inputs when staging a registered native output | `staging a native` | 3 / 3 |
| Ignore durable derived roles during cleanup retry | `merge of different FileIds` | 1 / 1 |
| Treat an erased historical projection as an input to fresh independent staging | `merge of different FileIds` | 1 / 1 |
| Remove the read-only recovery parent/lease fence | `recovery validation fences` | 1 / 1 |

The legacy fixture writes the exact `ccc4942` field-side record frame, compressed
with the prior writer's level, without a later catalog. Reading and exporting it
still work. A same-address rewrite cannot turn its unknown past into a certified
origin. Erasure refuses with the named identity before denial or payload deletion.

Native fixture calibrations preserve the tested behavior without weakening
production guards. The unpack interruption fixture first originates the retained
member in its destination, then adds the independently produced second pack; its
loose-plus-two-pack selected copies still traverse every sampled crash cut. The
remote-authority fixture explicitly checks unknown-provenance refusal in the
ordinary clone, then imports the known-origin source's erasure receipt into the
still-held clone and retains the remote-deletion-authority refusal. Two older
encoding assertions now distinguish independently authored containers from exact
raw/native-frame identities: the latter remain denied, including when reoffered
through batch arrival; arbitrary compressed/base64 containers remain readable and
attributed writes remain allowed under the already accepted guarantee.

Queue uniqueness is structural: initialization uses a Set, and the only enqueue
function inserts into that same Set before enqueueing. An already processed queue
entry is unreachable; its redundant branch was removed. Lease-checker presence
inside an active synchronous action is also structural: writer/recovery scopes
register it before invoking callers and retire it without an intervening callback.
Outside an active scope still refuses, as do changed leases and parent lifetimes.

### Fourth-review local validation

All runtime commands use one test worker and isolated HOME/scratch state. Node 26
is 26.13.0, Node 22 is 22.23.1, and Bun is 1.3.14. The full npm/Bun release matrix
remains CI evidence, rather than a claim about these local focused selections.

| Selection | Result |
| --- | --- |
| `derivation-provenance.test.ts` plus `erasure-provenance.test.ts`, linked test 74 | 97/97; both `engine/derivations.ts` and `engine/erasure-provenance.ts` at 100% statements, branches, functions and lines |
| New provenance/ownership corpus under Bun | 31/31 |
| Node 22 merge, legacy, memoization, budget, staged-output and recovery selection | 10/10 |
| `packs.test.ts`, linked test 60 | 38/38 |
| Selected composition and first-class conflict replay/import cases | 32/32 |
| Publication-validation suite | 8/8 |
| Packed power-loss matrix, linked test 61 | 6,225 native boundaries, 538 distinct full crash images, two convergent replays each; retained object and foreign tripwire preserved |
| `erasure-lifecycle.test.ts`, linked test 59 | 43/43; 18 cuts in each interruption scenario |
| Accountability, fragment repair, storage and fragment suites, linked test 76 | 218/218 |
| Static checks and package privacy | Typecheck, source/test builds, lint and zero duplicates pass; 95 files / 585 declarations documented; 340 packaged files / zero privacy findings |

The lifecycle selection samples 18 cuts from each interruption scenario; CI retains
the complete matrices and the 512-seed model. No installer timeout was retried.
All tracker writes precede changelog regeneration, archive generation, commit and
committed-HEAD self-host acceptance. Unknown legacy/imported provenance is an
intentional pre-deletion refusal; catalog portability/scale remains separate work
tracked by `pm-vcs-provenance-catalog-scale`.

## Fifth review: provenance survives garbage collection

The fifth-review instruction for `8ee69ad` retains the accepted native-provenance
guarantee: normal GC must never turn unknown ancestry into a successful erasure.
The repair changes the certificate, rather than retaining intermediate payloads.

`pm-vcs-derivation-2` records the sorted, deduplicated complete native input set in
`sources`, including intermediate identities and every manifest page/fragment.
The writer unions each parent's complete inputs before publishing bytes. Explicit
`unknown` identities survive propagation and ordinary rewrites. All certificate
metadata survives GC, including records whose payloads have been collected.
Erasure uses that retained metadata and checks both present payloads and registered
native output identities; no physical intermediate is required for version two.
A missing certificate or unknown input makes the derived identity unknown and
produces `uncatalogued_provenance` before payload deletion or denial publication.

Version-one direct-parent records are upgraded from native structures while the
inputs remain available. GC preview and apply call the same upgrader; preview
leaves persisted bytes unchanged, while apply flushes upgrades before its sweep.
First erasure also upgrades before its pending boundary. Missing old physical
ancestors remain unknown. Registered native outputs establish their actual blob
kind without requiring a separate object-store copy. Ordinary legacy reads and
exports stay supported; rewriting an address cannot certify its unknown past.

| Location / class | Result |
| --- | --- |
| `objects.ts:write`, `derivations.ts:recordDerivation` | Complete monotonic input sets precede bytes; inherited unknowns remain explicit |
| Manifest/page/fragment and conflict producers | Native member references are recorded at publication, even when containers later disappear |
| `native-outputs.ts` | Registered renderings retain transitive input evidence before recoverable bytes |
| `gc.ts:collectGarbage` | Preview shares the proof; apply upgrades before retirement; certificates are never collection candidates |
| `erasure.ts` | Unknown ancestry refuses for physical and virtual outputs; catalog edges survive absent intermediate objects |
| Pack/unpack and imports | Identity-preserving storage does not weaken certificates or invent payload origins |
| Certificate migration/retirement | Classified directory lifetime stays pinned; output registrations retire before selected certificates |

Certificate traversal memoizes inspected identities and bounds object/edge work
at one million, old direct-parent depth at 256 and time at 300 seconds. Every
node, copied input and unknown input checks the deadline and pinned lease. Primary
proof bounds remain separate from the nonblocking diagnostic audit. No threshold,
ownership refusal, destruction classification or physical-copy plan was weakened.
Two redundant `parent.unknown` fallbacks were removed: the resolver returns only
validated version-two records, constructed upgrades or version-two cycle markers;
each always defines the array. This proof is also recorded on the PM item.

The GC-anywhere property exercises eight deterministic histories, four derivations
each, with blobs, fragments, packed storage, native outputs, registered bundles,
operation summaries and GC between derivations. Six known histories erase every
owned derived output and deny reconstruction; two legacy-unknown histories refuse
without deleting payloads or publishing denial. The manifest regression includes
native pages and fragments, then collects both containers before erasure. The
legacy merge regressions collect the uncatalogued envelope before erasure, with
both new and upgraded direct-parent evidence. Additional cases cover missing
certificates, first-erasure upgrade/retry, read-only migration and replaced catalog
parents. The old unchanged-large-blob assertion now checks complete ancestry
before GC, then preserves the native identity through unchanged staging.

### Fifth-review revert controls

All mutations ran in disposable source copies; the package sources were unchanged
by the controls. Each mutant fails and each restored selection passes. The stricter
catalog-presence-only mutation reinstates the old decision while retaining the
existing physical-ownership refusals.

| Reverted behavior | Behavioral selection | Mutant failures / restored passes |
| --- | --- | --- |
| Restore the old direct-parent writer alone | Large native output certificate before GC | 1 / 1 |
| Remove unknown-ancestry refusal | Both collected legacy merges and GC-anywhere property | 3 / 3 |
| Omit implicit manifest member inputs | Collected native manifest output | 1 / 1 |
| Omit transitive input flattening | Large native output certificate | 1 / 1 |
| Remove upgrade before GC | Known old direct-parent roots and collected old manifest output | 2 / 2 |
| Treat an absent old object as known | Missing old ancestor | 1 / 1 |
| Ignore a missing input certificate | Lost certificate after GC | 1 / 1 |
| Restore catalog-presence-only checking | Both collected legacy merge cases | 2 / 2 |

Total: **8 mutation groups, 12 expected failures, 12 restored passes**. No timeout
or import failure is counted as a behavioral proof.

### Fifth-review gates

| Gate | Result |
| --- | --- |
| Final-source provenance corpus | 45/45; both proof modules at 100% statements, branches, functions and lines |
| Combined provenance/erasure corpus | 108/108; later integration selection 5/5; these overlapping cohorts are not summed |
| Accountability, storage, GC, packs, fixed/CDC fragments and legacy fetch repair | 341/341 |
| Lifecycle | 43/43, sampling 18/818 and 18/1006 actual native cuts |
| Packed power-loss matrix | 1/1, 6,225 boundaries / 538 distinct crash images / two convergent replays each |
| Bun provenance corpus | 45/45 |
| Node 22 focused selection | 12/12 |
| Static/privacy | Typecheck, source/test builds, lint, zero duplicates, 95 files / 590 documented declarations, 340 packaged files / zero findings |

Every intended test command caps workers at one. An unfiltered PM execution was
stopped after it began historical linked commands; none of those interrupted
results is counted. Subsequent PM runs select one linked index and use the
isolated child environment and shared-host-safe defaults. PM reports execution
results but its existing `tracking_disabled` policy prevents storing run receipts;
sanitized evidence remains in PM comments and this document.

No installer timeout was retried. Full npm/Bun release gates, complete lifecycle
cuts and the 512-seed model remain CI work. Tracker writes finish before changelog
and archive generation; committed-HEAD self-host acceptance verifies without
regeneration. The prior merge/archive commits remain ancestors, main is included,
and tracker history extends main byte for byte. Catalog portability and retained
metadata scale remain on `pm-vcs-provenance-catalog-scale`.


## Sixth review: durable whole-content equivalence

The former certificate retained container and fragment ancestry but omitted the
whole-blob identity reconstructed by a manifest. After GC removed the container,
a derived record could be unrelated to the selected whole blob in the retained
graph. Version-three certificates retain the whole identity and native members,
with a reverse member set on a virtual whole-blob certificate. The erasure queue
follows both retained members and transitive sources. Metadata is retained by GC;
unknown imported or old ancestry still refuses before any deletion.

| Equivalent representation producer | Durable route and verdict |
| --- | --- |
| Canonical record, link or conflict payload equal to a blob | The shared native representation classifier records `hashObject("blob", payload)` before publication; retained whole/member edges survive collection of the typed input. Structural frames remain identifier-only metadata. |
| Direct native manifest or page | `ObjectStore.write` -> `representation` -> `nativeRepresentation`; reconstructed whole identity and members precede native payload publication. |
| Fixed and CDC buffer fragmentation | `bufferContent` -> `withWholeContent`; identify once, record root before fragment bytes, finish with `recordWholeContent`. Raw denial digest is conditional. |
| Fixed and CDC descriptor/file fragmentation | `descriptorContent` shares the source identity pass; file wrappers receive that identity rather than hashing again. Fragment sources and final manifest record it. |
| Fragment re-split | Same fixed/CDC producers; alternate boundaries retain the same whole identity. |
| Pack member, repack and unpack | Existing object IDs are unchanged; packing does not drop derivation metadata or invent a separate logical content identity. |
| Bundle/unbundle and filesystem or HTTP clone/fetch | `importBundleObjects` -> `ObjectStore.accept`; native manifest equivalence is recorded from arrived native frames. Uncatalogued imported origins remain unknown. |
| Promisor hydration and resume upload | Shared `ObjectStore.accept` path; equal native content has the same ID. It cannot acquire a false independent origin. |
| Old certificates and absent ancestors | Upgrade reconstructs while native inputs exist; missing proof remains unknown. GC cannot convert unknown into completed erasure. |

Regressions cover the exact loose and packed collected-manifest reproduction,
four generated fixed/CDC/descriptor/re-split histories with GC and registered
outputs, and bundle import with retained equivalence but unknown origin. Existing
GC-anywhere, merge, legacy and bounded traversal cases remain in the corpus.
Cubic's complete 59-thread response ledger is in
[pr150-cubic-triage.md](pr150-cubic-triage.md) and on `pm-vcs-phase6packs`.

The P1 physical-accountability repair binds each native file to a bounded
SHA-256 before parsing and rechecks the held descriptor before acceptance or
purge and again at the final catalogue barrier. Size, mtime and ctime alone do
not prove content stability: a same-tick rewrite can preserve them. Four native
regressions freeze the ctime observation while rewriting equal-sized loose and
packed bytes and restoring mtime, both after parsing and at the final barrier.
Every case refuses; removing the byte fences falsely certifies all four. Purge
journals still accept older four-component identities for reading; those older
pending stamps cannot authorize a newly observed deletion lifetime.


The final class audit also covers literal native payload equivalence: records,
links and conflicts that carry the same payload as a whole blob retain that
blob identity before publication. Six regressions collect the typed input and
then erase its whole blob in loose and packed storage; every indexed descendant
and registered worktree output is removed. Disabling only this classifier makes
all six fail, and restoration passes all six. This is structural native identity,
not speculative decoding of independently authored content.

Two removed fallback alternatives are provably unreachable. A previous record
returned by `certificateResolver` is version three with an array of `members`:
new records supply it, classification validates it, and every legacy upgrade or
cycle result constructs it. Thus `previous.members ?? []` had a dead fallback;
the actual membership merge remains. All five calls of the private
`assertSupportedControl` pass their real deadline/lease callback, so its no-op
parameter default was unused. The callback is now required, and every existing
control refusal and observation remains. Reachable branches instead have native
fault/refusal regressions, including empty foreign lease-audit names.

The exact original manifest reproduction, equivalence-through-GC property and
late whole-blob arrival each fail under a behavioral revert. Ownership controls
also fail if implicit whole-content association is incorrectly treated as an
explicit native derivation. Legacy producer callbacks have separate failing
reverts. The complete 86-group selector ledger is in
[pr150-cubic-triage.md](pr150-cubic-triage.md), with mutant exit 1 and restored exit
0 for every group. The P1 four-case same-tick regression is part of that ledger.


## Sixth-review final local validation

These cohorts overlap and are not summed. Every command uses at most one worker;
no more than two test workers run concurrently. Production hashes remain unchanged
from the final coverage/static checks.

| Focused gate | Result |
| --- | --- |
| Node 26 erasure/provenance/plans/accountability/lifecycle/review | 239/239 |
| Node 26 storage/fragment/legacy repair | 154/154 |
| Node 26 provenance before the four extra typed cells | 62/62 |
| Composition and authorization integration | 22/22 |
| Complete pack and GC suites | 70/70 |
| Fixed/CDC fragments and paged manifests | 97/97 |
| Packed power loss plus recovery regressions | 3/3 |
| Node 22 final compatibility selection | 15/15 |
| Bun final provenance corpus | 66/66 |
| PM-linked equivalence / typed equivalence / P1 / fixture commands | 3/3, 6/6, 4/4, 5/5 (overlapping selections) |
| Current touched-module coverage | 17 modules; 100% statements, branches, functions and lines; c8 --all --100 --per-file passes |


The packed matrix covers **6,247 native boundaries and 538 distinct full crash
images**, with two convergent engine replays per image. Native held data and the
foreign sentinel are preserved. The complete pack suite also covers real SIGKILL,
competing processes and relative-root/cwd changes through compact, unpack and GC.
The 62-case Node provenance run preceded four added link/conflict cells; all six
typed cells subsequently pass through the PM runner and on Node 22, and the full
66-case final file passes under Bun.

Earlier unchanged-path evidence also includes 235/235 reader/lifetime checks,
6,750 reader/writer cells and 406 pinned boundaries; the 512-seed lifecycle model
passes 2/2 selections covering 6,144 operations, 2,038 verified verdicts, 759
interrupted runs and 461 legitimate pending-link refusals. These figures describe
that measured corpus, not exhaustive arbitrary histories.

Static validation passes typecheck, source/test compilation, lint and the zero
clone-pair gate (95 sources / 30,175 lines). Docstrings cover 95 files and 595
declarations; package privacy scans 340 files with zero findings. The final
changelog and committed-HEAD self-host commands follow the required tracker-first
sequence. Full npm/Bun release matrices and fresh independent review remain CI /
orchestrator work. No installer timeout was retried. An initial direct Bun run
used its default five-second test limit and failed; it is excluded. Rerunning
with `--timeout=600000` passed all 66 cases.

Commands for the final isolated cohorts (credential-free scratch HOME/TMPDIR and
Git configuration were supplied by the gate harness):

```sh
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-skip-pattern="SIGKILL|EVERY native|512 seeded lifecycle|valid wide tree" test/erasure-provenance.test.ts test/derivation-provenance.test.ts test/destructive-plans.test.ts test/erasure-accountability.test.ts test/erasure-lifecycle.test.ts test/review-repair.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-skip-pattern="SIGKILL|one tracker serializes|streaming erasure does not retain" test/erasure-storage.test.ts test/erasure-fragment-repairs.test.ts test/stream-erasure-legacy-fetch-repair.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 test/packs.test.ts test/gc.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 test/fragments.test.ts test/cdc-fragments.test.ts test/manifest-pages.test.ts
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-name-pattern="EVERY native obliterate-packed|interrupted ref retirement resolves|acknowledged packed transactions" test/journal-durability.test.ts
bun test --max-concurrency=1 --timeout=600000 test/derivation-provenance.test.ts
node --expose-gc --test --test-concurrency=1 --test-name-pattern="in-place rewrite|whole-content equivalence survives|typed whole-payload equivalence|legacy whole-content producers|unrecognized empty lease" test/erasure-accountability.test.ts test/derivation-provenance.test.ts test/review-repair.test.ts
npm run check
npm run build:test
npm run docstring
npm run pack:check
```

The last Node selection uses Node 22; other Node cohorts use Node 26. Coverage
includes exactly the seventeen changed production modules, using current-source
V8 profiles and excluding stale source epochs. No configuration threshold or
ignore directive changed. The full 95-module release coverage matrix remains CI.
