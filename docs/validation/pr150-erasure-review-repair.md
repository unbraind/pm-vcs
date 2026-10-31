# PR 150 erasure review repair

The latest repair closes the escaped-JSON retention finding from the re-review
of `6dfc776` and percent-escaped retention found in the native-URL audit. Its
representation-class audit and validation are below; the
earlier ownership and physical-copy repairs remain documented as baseline evidence.

The independent Codex review of `f4d4cf6` blocked on two reproducible erasure
defects. The main merge `d2c4768` and archive regeneration `f4d4cf6` are retained.

| Defect | General rule | Repair and regression |
| --- | --- | --- |
| Opaque `destruction/` contents survive a successful erasure. | A control-directory name cannot confer ownership on its contents. Classification must finish before payload deletion. | Reuse the complete intent decoder; validate current and archived records, progress framing and states, native staged artifacts, and inode-bound owner records. Reject unknown names, extra fields, wrong kinds and links with `unsupported_erasure_storage`. Pin each file and recheck the directory lifetime and complete namespace. Public-erasure tests cover foreign backups, malformed native-looking records, supported historical artifacts and namespace races. |
| One location per ObjectId loses owned copies after interrupted unpack. | Logical deduplication cannot discard physical deletion candidates. | Retain every `{ id, path }` in erasure preflight. Deduplicate only logical fingerprints; include every selected loose and pack location in the physical exclusion set. Unpack verifies an existing, intentionally denied loose copy through the existing writer-lease-scoped physical reader. Public reads still enforce permanent denial. Extend both existing lifecycle and power-loss matrices with pending packed erasure. |

## Engine audit

`assertSupportedControl` also admitted opaque refs and directories under native
metadata-file names. It now enforces the native file/directory kinds and descends
the reference tree, applying the existing ref-name and object-identity rules.
Only regular native ref temporaries get the reserved-lock-name exception.
Ref bytes are parsed and inspected on the same pinned descriptor, with file and
directory namespace checks. Verified literal identities use the existing literal
PID inspection policy: raw and canonical-base64 evidence still participates, but
an `80`-prefixed hexadecimal identity is not misclassified as a zlib stream. The
writer-produced `native ref literal 38` fixture reproduces that ambiguity; a
separate retained-copy fixture preserves the refusal for selected ref bytes.

Object directories already use complete native accountability. Lease directories
already enumerate regular audit entries and inspect their bytes. Destruction
metadata now participates in selected-byte inspection before deletion and before
certification, including supported records whose path fields retain selected
bytes. Fully verified binary progress frames receive raw fingerprint inspection;
their cryptographic checksums are not encoded documents. A deterministic native
writer fixture proves that incidental base64-shaped checksum bytes must remain
accepted, while selected bytes equal to that checksum still refuse before deletion.
The earlier broad rerun exposed this ambiguity (62/63); it is not counted as a
passing gate. No supported refusal or threshold is weakened.

Real SIGKILL probes also cover exclusive owner, intent and progress creation
before their first write. Those native operations can leave an exact regular
zero-byte `.tmp` stage. The classifier recognizes that empty creation state;
it neither grants checkpoint authority nor deletes the artifact. Empty canonical
records, unknown empty names, invalid owner PIDs and malformed stages containing
bytes still refuse. Removing this creation-state recognition makes the native
creation regression fail; restoring it passes all three crash cases.

GC retains physical inventory arrays; pack compaction keys candidates by physical
path. Other ObjectId-keyed maps cache logical graph metadata. Erasure's single-path
map was the deletion-preflight exception. Its later path-keyed inventory remains
appropriate after unpack retires the packs.

## Regression and revert evidence

All mutations run in disposable copies. Originals are restored in `finally`,
then the selected regression is rerun. No syntax/build failure counts as proof.

| Isolated behavioral reversion | Failing behavior | Restored result |
| --- | --- | --- |
| Disable destruction-artifact classification. | The public control-refusal corpus reports a missing expected exception for the selected foreign backup. | 1/1 passes. |
| Collapse preflight locations back to the last path per ObjectId. | The existing packed transaction recovery matrix refuses with `erasure_retained_copy`. | 1/1 passes. |
| Restore the ordinary reader for an existing loose unpack copy. | The same recovery matrix refuses with `object_obliterated`. | 1/1 passes. |
| Reject every zero-length stage as an invalid record. | The real creation-stage SIGKILL corpus refuses with `unsupported_erasure_storage`. | 1/1 passes, covering three native creation boundaries. |
| Decode a verified literal ref as arbitrary compressed data. | A real native `80`-prefixed object identity refuses with `unsupported_erasure_storage`. | 1/1 passes; selected bytes in ref metadata still refuse. |
| Treat a verified progress bitmap as an encoded document. | A native checksum produces `unsupported_erasure_storage` on a clean erasure. | 1/1 passes; raw selected checksum bytes still refuse. |

The control corpus includes native writer-produced checkpoints, archived records,
progress bitmaps, staged records and owner markers. Sparse control layouts and
native reference temporaries remain accepted. Malformed fields, retained payload
bytes, changed descriptors, vanished records, replaced directories and links
refuse while leaving the asset, readable payload and denial state unchanged.

The lifecycle fixture uses a real SIGKILL after the last `unpacked` member. A
selected object then has one loose representation and entries in two independently
produced native packs. Both original packs remain, and the erasure is pending.
Every native lifecycle-journal cut is registered as a named subtest; CI runs all
cuts by default. Local focused runs select named cuts with the standard Node test
filter. Recovery checks physical absence, accountable storage, a retained peer,
the same idempotent tombstone and one operation-log receipt.

The power-loss matrix adds `obliterate-packed` to its existing sequence domain.
It restores every distinct crash image, retries twice, checks pending-receipt
completion and verifies selected physical copies are absent. The existing
acknowledged-transaction matrix also interrupts exactly at `unpacked`.

Exact commands, counts and revert outcomes are recorded on `pm-vcs-phase6packs`.
The full release matrix is left to CI under the updated orchestrator instruction.

## Earlier CI repair retained

The original 17-record mapping remains in `pr150-ci-repair.md`. The completed
diagnostic npm run on `1c36eaf` reported 2,304 passes, one failure and zero skips or
cancellations. All four originally failing source files reached 100% in all
coverage dimensions. Its sole failure was the fragmented-read counter reporting
164,327 bytes against the unchanged 131,072-byte bound. The retained synchronous
backing-store-sweep calibration passed on Node 22 and Node 26, including its
whole-file-allocation negative control. That diagnostic run is not a passing
release gate.

## Focused validation for 6dfc776

All focused commands use an isolated child environment and owned scratch, with
one test worker per command and at most two active test workers.

- The linked Node 26 c8 control selection passes 9/9 after the bitmap repair;
  the new destruction validator, reference walker and literal inspection helpers
  have no uncovered branch records in that focused report. File-wide and
  repository-wide coverage are separate release gates.
- Node 22 controls plus acknowledged packed recovery pass 10/10 after the bitmap
  repair. The reported annotation, fixture-lifetime and scratch cases pass 5/5.
- The final-source PM-linked lifecycle matrix passes 42/42 locally: 35 selected native cuts
  (17/722 retired-instance and 18/934 interrupted-unpack), two matrix parents and
  five ordinary cases. CI retains every native cut by default. The larger
  interrupted-unpack fixture has a bounded 120-second setup/child deadline;
  expected SIGKILL and all recovery assertions remain mandatory.
- Packed power-loss recovery passes 1/1 across 5,546 native boundaries and 474
  distinct complete crash images, each replayed twice. The subsequent bitmap
  format refinement is covered by the deterministic control and acknowledged
  recovery tests above.
- The complete pack file passes 38/38 on the final source, including all 90
  relative-root SIGKILL cuts with two successful replays each.
- Typecheck, build, test compilation, lint, zero duplication, docstrings (91 files,
  570 declarations) and real package privacy inspection pass.

The broad three-file focused rerun passes 103/103, with zero failures, skips or
cancellations, including all 168 randomized foreign-store cases. Final pack and
lifecycle rerun counts, committed self-host proof and pushed-head CI receipts
are recorded on the feature item and PR. The earlier
failed broad run and cancelled diagnostic probes are excluded from passing counts.
No installer was retried. Full npm/Bun release acceptance remains for CI under
the updated orchestrator instruction.

The broad focused command is:

```sh
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-skip-pattern=SIGKILL test/erasure-accountability.test.ts test/erasure-fragment-repairs.test.ts test/erasure-storage.test.ts
```

The locally selected lifecycle command leaves all default matrix cuts in source:

```sh
node --expose-gc --no-concurrent-array-buffer-sweeping --test --test-concurrency=1 --test-skip-pattern="512 seeded|cut (?!(?:1|2|25|50|100|150|200|250|300|350|400|450|500|550|600|650|700|750):)" test/erasure-lifecycle.test.ts
```

An expanded local lifecycle command accidentally included the separate 512-seed
model in a 900-second orchestration bound. It timed out after all 35 selected
native cuts passed, with no assertion failure reported; it is not a passing gate.
That model took 1,499,756 ms in the earlier full diagnostic run. The intended
focused command above excludes it locally, while CI retains it unchanged.
The original branch-coverage fault file also passes 15/15 on the final source.

## Decoded-state re-review of 6dfc776

The reviewer reproduced a completed receipt while the escaped destruction path
retained `selected secret "quoted bytes" 937184`. Raw JSON text is not its string
value. Every declared encoding must be decoded before comparing selected bytes.

`JsonStrings` now shares one bounded UTF-8/UTF-16 JSON string decoder between
materialized and streaming inspection. It visits keys as well as values, handles
all JSON escapes and surrogate pairs across input slots, and never joins adjacent
strings. Existing strict destruction-record parsing and classification still run
before semantic inspection. Hex words receive both byte alignments; decoded JSON,
hex, base64, loose frames and zlib compose under the existing depth, work, context
and time bounds. Raw inspection remains mandatory. New speculative codec guesses
inside literal strings or decoded hex do not classify random native identifiers
as compressed documents. Every recoverable output byte participates even if a
new literal/hex codec guess later fails; incomplete declared raw/base64 streams
retain their existing refusals. Decode-budget exhaustion always refuses. Existing raw/base64 codec refusals remain strict.

| Persisted location | Native interpretation and audit verdict |
| --- | --- |
| Destruction current records, archives, owners and nonempty stages | Shared native decoder validates complete JSON schemas, names, kinds and identities. The representation scanner additionally visits every decoded JSON key/value, including escaped paths. Unknown storage still refuses before deletion. |
| Destruction progress | Fixed binary magic, intent ID, entry count, SHA-256 binding and outcome bytes are verified. It contains no arbitrary string fields. Raw bytes are checked; the textual ID is also covered by its mandatory linked JSON intent. The existing checksum must-allow and raw-retention must-refuse cases remain. |
| Purge receipts and fingerprint journal | Existing schema/checksum parsers retain authority. Shared JSON/hex/base64 inspection now covers decoded file/root fields, keys, digests and proposed audit bytes before mutation. |
| Operation log and lease audits | JSONL records participate in the same semantic string scan. Sequence/command/summary/ref fields and audit keys cannot hide selected bytes behind JSON escapes. |
| Index, config, HEAD, identity, authority, remotes, instance/link/view/dirty metadata and native control stages | Index JSON tuples, ordinary JSON records and native text retain their existing readers. All regular control bytes participate in materialized semantic inspection; verified PIDs retain their literal policy. Control-first inspection preserves the existing typed ref refusal. |
| Native remote URL fields and URL-bearing retained payloads | `transport.ts` and `objects.ts` use `fileURLToPath`; `http-transport.ts` uses native URL parsing; `credentials.ts` decodes URL userinfo. Both scanners inspect percent bytes, canonical addresses and native filesystem paths. The same native parser handles slash/dot normalization. Complete locators at native payload and decoded-string boundaries receive the same projection in streaming inspection; a locator exceeding the 64 KiB normalization window refuses before deletion. Raw inspection remains mandatory. |
| Private layers | Content was already base64-decoded and inspected. The audit found path/name/key metadata omitted with the `layers.json` exception; the full layer document now participates after existing content/ownership checks, preserving `erasure_layer_conflict`. |
| Refs and native ref temporaries | Existing names, ObjectId values, pinned descriptors and namespace fences remain. Raw and canonical base64 bytes are checked; binary identity bytes decoded from canonical hex are now checked too. |
| Loose and packed object identities | Every retained inventory ID is checked as literal and decoded hexadecimal bytes before deletion, and again in final descriptor-scoped accountability. A selected payload equal to a peer's binary identity refuses. |
| Pack index and length-prefixed members | `PackStorage.index` validates exact four-field tuples: ordered IDs, contiguous offsets, positive lengths and fixed types; there are no arbitrary user-string fields. IDs receive the check above. Native range/framing/zlib decoding supplies every member to the streaming semantic scanner. Final physical raw inspection and checksum/identity barriers remain. |
| Native payloads: tree, record, commit, manifest, conflict, tombstone and blobs | Every retained canonical frame is inspected after native decompression, both in preflight and final accounting. JSON-backed names/keys/values now decode before comparison; legacy raw names and messages retain raw inspection. Hex/base64/compressed composites also participate. |
| Worktree files, link text and private bundle files | Existing content inspection now decodes JSON and hex too. Unowned filenames additionally participate, since a retained path can itself reveal the payload. Existing `erasure_worktree_conflict` is preserved. Protected tool artifacts retain their explicit scope boundary. |
| Bundle header/body and admission | Native bundle parsing validates framing, object hashes and base64 members. A retained bundle is inspected as worktree content, including JSON header keys and recursively decoded body objects. Existing arrival digest/closure/attribution checks use the same expanded materialized decoder; their authority rules are unchanged. |

Regression corpora cover the exact reviewer case, backslashes, `\u0001` and
`\u0007`, literal and escaped non-ASCII text, surrogate pairs, and a containing
path. They also cover native journal history, metadata keys, operation logs,
lease audits, layer paths/content, filenames, loose/packed JSON and composite
copies, binary IDs and native bundle headers/body. Each refuses while preserving
the selected asset and leaving denial unpublished. Must-allow cases retain native
ref literals, progress checksums, ordinary decoded values and every existing
classification guard. Incremental cases exercise every input split and bounded
4096-byte output slots against native JSON parsing.

The final native-decoder search also found percent-escaped URLs. A disposable
public-erasure probe against `5019dad` completed with selected bytes retained in
the decoded path of a file remote. `UrlBytes` now shares bounded output slots with
the JSON decoder. Supported schemes and percent
triplets survive arbitrary input splits. Literal ASCII tab/newline characters
removed by native URL parsing are removed in this interpretation; encoded control
bytes remain present. Literal controls are removed before triplet recognition,
including controls inside a triplet. Native `URL` and `fileURLToPath` projections
also cover address/path normalization, using the same parser as transport.
Streaming projection captures at most 64 KiB for a complete locator beginning
at a native member or decoded-string boundary. Larger locators give the typed
`uninspectable_payload` refusal before deletion; truncated projection cannot
certify erasure. An unrelated 32 KiB locator and a 70 KiB JSON document with a
short URL remain accepted. Ordinary binary slots retain only the bounded scheme
suffix. Malformed and interrupted escapes retain their literal
bytes while every complete percent byte is inspected. The unchanged raw scan
still covers literal percent text. URL-derived inspection does not recursively
reinterpret its unchanged scheme; actual JSON/base64/hex/compression transforms
continue to compose under the original bounds. Native remote-writer regressions
cover quotes, controls and non-ASCII text, with loose/packed and composite copies
and an ordinary-URL must-allow case. No new native codec family was found beyond
JSON, canonical base64, hexadecimal identities, native framing, zlib and URLs.

All ten earlier decoded-state reversion groups were repeated after adding URL
inspection. Eight URL groups were then repeated on the final implementation.
Each mutation runs in a disposable copy, restores the original in `finally`,
reruns the selection and removes the copy.

| Final URL behavioral mutation | Mutant result | Restored selection |
| --- | --- | --- |
| Remove materialized URL inspection | 8/18 fail: native remote fields and a metadata key escape the pre-deletion guard. | 18/18 |
| Remove streamed URL inspection | 11/18 fail: retained loose, packed and composite URL bodies escape the guard. | 18/18 |
| Stop percent-byte decoding | 4/18 fail: encoded HTTP paths and embedded retained data escape inspection. | 18/18 |
| Drop the carried scheme suffix on non-URL slots | The real streaming split-input regression fails at a scheme crossing the input boundary. | 1/1 |
| Remove control filtering before triplet recognition | 2/18 fail: an embedded URI with a control inside a triplet receives untruthful completion. | 18/18 |
| Remove materialized native URL projection | 3/18 fail: normalized file/HTTP addresses retain selected bytes. | 18/18 |
| Remove streamed native URL projection | 4/18 fail: normalized loose/packed/HTTP bodies retain selected bytes. | 18/18 |
| Remove the normalization-window refusal | The oversized-locator public-erasure regression unexpectedly completes using a truncated projection. | 1/1 |

Together with the ten semantic-repair groups, these are eighteen behavioral
mutation groups. The binary-slot optimization skips byte-by-byte scheme probing
when a slot contains no colon and retains only the six-byte recognition suffix.
The every-split corpus exercises both sides of that path. It adds no ownership,
classification or refusal exception.

The decoded-state round has nine additional isolated behavioral reversion groups:

| Reversion | Observed regression | Restored selection |
| --- | --- | --- |
| Remove materialized JSON string inspection | The reviewer's quoted-name case unexpectedly completes. | 1/1 |
| Remove streaming JSON decoding | Retained JSON values/keys and composites escape native-object inspection. | 13/13 |
| Remove streaming hex decoding | Hex and hex/compression copies escape native-object inspection. | 13/13 |
| Remove full layer-document inspection | A selected value remains recoverable from a layer path. | 11/11 |
| Remove retained filename inspection | A selected value remains in an unowned filename. | 11/11 |
| Remove literal hex identity inspection | Native loose/pack/ref identities retain the selected binary bytes. | 4/4 |
| Remove preflight identity inspection | Final verification refuses only after deleting the asset. | 4/4 |
| Remove final descriptor identity inspection | A late native identity gets a completed receipt. | 1/1 |
| Discard output when a newly decoded codec guess errors | Truncated hex/zlib metadata retains the recoverable selected prefix. | 11/11 |

All failures are behavioral, not syntax or compilation failures. Each original
is restored in `finally` before its passing selection and disposable-copy removal.
The broader first diagnostic was 135/136 with one changed-refusal-priority failure;
that priority is repaired. An earlier packed diagnostic refused at a journal guard
for one crash image. A targeted current-source replay passes 25 nearby images;
only the subsequent complete final-source matrix can count as a passing gate.

Compatibility diagnostics found two additional ordering/interpretation details.
New codec guesses derived from a decoded JSON/hex value must retain that origin
through descendants: an incidental nested base64/zlib prefix in a native nonce
is not a declared compressed document. Every recoverable prefix still participates
and every original raw/base64 refusal stays strict. A native writer forced to
produce nonce `654a7a2f000000000000000000000000` proves this must-allow case;
reverting origin propagation fails, restoring it passes 1/1. This is the tenth
isolated reversion group in the decoded-state round.

The new logical identity check runs after the original post-scan control guard,
so a directory replacement at a scan boundary keeps the established
`unsupported_erasure_storage` refusal. Control checks and native ref priority
remain intact. The corrected compatibility selection passes 14/14, including the
protected tool boundary, ref literals/refusals, ID checks and journal races.
The 142/144 diagnostic before these corrections is not a passing gate. One
pre-correction power rerun was cancelled; its partial progress is not certification.

## Decoded-state validation at `5019dad`

| Gate on the corrected implementation | Result |
| --- | --- |
| PM-linked erasure/accountability/fragment-repair focus | 146/146, zero failures, skips or cancellations |
| PM-linked JSON/codec and composition compatibility c8 cohort | 57/57; `json-strings.ts` and `representations.ts` each 100% statements, branches, functions and lines |
| Complete packed power-loss matrix | 1/1; 5,546 native boundaries, 474 distinct complete crash images, two successful replays each |
| PM-linked lifecycle focus | 42/42; 17/722 retired-instance and 18/934 interrupted-unpack native cuts |
| Node 22 decoded-state and bounded streaming selection | 46/46; 32 MiB corpus retained 1,075,345 bytes and made two observed reads under unchanged bounds |
| Complete fragment suite | 56/56, including retained whole-file-allocation and backing-store calibration assertions |
| Ten isolated behavioral reversion groups | Every mutant fails; every restored selection passes |
| Static/build/test compilation/docstrings | Passed; 92 production files, 574 documented declarations, zero duplicated lines |
| Actual package privacy inspection | 328 files scanned, zero findings |

Each test command uses one worker; at most two test workers run concurrently.
The exact linked commands and outcomes are retained on `pm-vcs-phase6packs`.
Every default lifecycle cut and the separate 512-seed model remain enabled in CI;
local selection does not certify the complete lifecycle domain. Full npm/Bun release
acceptance and fresh independent Codex review remain pending on the pushed head.
No installer was retried. Tracker writes finish before changelog/archive generation;
committed self-host verification and pushed-head CI receipts are reported on the PR.

## Final URL-class validation

All counts below use the final production implementation. No installer was retried.

| Gate | Result |
| --- | --- |
| Erasure/accountability/fragment-repair cohort | 166/166, zero failures, skips or cancellations |
| Decoder/composition c8 cohort | 77/77; `json-strings.ts`, `url-bytes.ts` and `representations.ts` each 100% statements, branches, functions and lines |
| Node 22 decoder and bounded streaming cohort | 66/66; 32 MiB corpus retains 1,075,345 bytes and makes two observed reads under unchanged bounds |
| Complete packed power-loss matrix | 1/1; 5,546 native boundaries, 474 distinct complete crash images, two convergent replays each |
| Lifecycle focus | 42/42; 17/722 retired-instance and 18/934 interrupted-unpack native cuts |
| Complete pack suite | 38/38; 13 compact, 32 unpack and 45 GC native SIGKILL cuts, two successful replays each |
| Complete fragment suite | 56/56 |
| Behavioral reversion groups | All eighteen mutants fail behaviorally; all restored selections pass |
| Static, production/test compilation and docstrings | Passed; 93 production files, 582 documented declarations and zero duplicated lines |
| Actual package privacy inspection | 332 files, zero findings |

The combined pack/fragment attempt expired at its mistaken 900-second harness
budget without an assertion failure. The final standalone pack run uses the
pre-existing 3,600-second linked-command budget, and fragments run separately.
The redundant combined link is removed through the CLI; diagnostic history is
retained. Earlier deliberately stopped implementation runs and the initial
120-second broad runner timeout do not count as passing gates. None of these
changes modifies a production, memory, coverage or CI threshold.

The exact commands and results are linked on `pm-vcs-phase6packs`. At most two
workers run concurrently, with one test worker per command. Full npm/Bun release
acceptance and fresh independent review remain CI/orchestrator work on the pushed
head. Every default lifecycle cut and the 512-seed model remain enabled there.
All tracker writes finish before changelog/archive generation; the committed
archive is then verified at HEAD without regeneration during that verification.
