# PR 150 erasure review repair

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

## Focused validation

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
