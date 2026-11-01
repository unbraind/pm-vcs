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
