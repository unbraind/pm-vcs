# PR 150 full-suite CI repair

The eighth independent review accepted the seventh-review fixes at merge head
`2a56576`, but its focused runs did not exercise the entire release corpus.
Full CI run `41332295415` failed nine tests on Node 22 and 26. Both complete job
logs and the Node 22 lcov artifact were read before changing production code.
The nine failures comprise five consumer children plus their parent, and three
other test cases. No coverage threshold or ownership refusal changes here.

## Diagnosis and repairs

| Failure | Classification and evidence | Repair |
| --- | --- | --- |
| All five built/npm/Node/native Bun/installed-CLI consumers | Obsolete expectation: eight user-authored base64 layers are outside the accepted native-provenance guarantee. The exact selected marker erases accountably in loose/packed storage both at the merge head and with all five seventh-round production modules reverted to `6a0d4b5`; the independent encoded blob remains and the receipt declares that exclusion. | Every consumer now tests that positive contract. Uncertified imported origins retain an explicit pre-deletion refusal on API, SDK command and installed text/JSON CLI surfaces. |
| Consumer program after its first failure was repaired | Coupled fixture: the publication tests intentionally retain foreign reference bytes and uncertified arrivals, then expected erasure in that same store to succeed. | Assert the compound store refuses and preserves its foreign reference. Use a separate fully known native history for successful erasure, clone, denial replay and legacy ref-conflict checks. |
| Denial no-op extension | Obsolete origin assumption: `cloneFrom` cannot invent clone-private source certificates. Erasing unrelated new content in that imported, unknown-origin store correctly refuses `uncatalogued_provenance`. | Keep the native producer as eraser and the clone as transfer receiver. Add a separate unknown-clone refusal test preserving durable denials, selected objects and worktree bytes. The original complete-closure-before-metadata-publication assertions remain. |
| Native writer PID facts | Obsolete refusal ordering: replacing a held native lease is detected by the earlier lease fence as `store_locked`, before control-directory classification. | Assert the exact earlier refusal, no denial and unchanged selected bytes. Retain the outer changed-owner refusal, foreign control-entry refusal and ordinary PID-coincidence success cases. |
| README-linked package docs | Packaging integration defect: README linked a validation report intentionally excluded from the package. | Link the existing explicitly shipped consumer contract and put the complete concurrency scope there. Keep validation evidence excluded; do not broaden the package allowlist. |
| Model coverage | Product scaling defect exposed by measurement: lcov records `BRDA:333,134,0,-1634889584` for the quadratic duplicate-name callback. This is executed work, not an unreachable branch. | Use one membership set in legacy, v2 and v3 tree decoding; preserve string equality, order, all schema checks and duplicate refusals. A 250-entry operation-count regression fails when the old function is restored, without relying on host timing. |
| Scanner coverage | One reachable optional-callback path and two genuinely dead branches. | Exercise a legal direct physical inspection without a budget callback, including retained-byte refusal. Remove only the dead branches proved below. |
| CLI address coverage | Bracketed IPv6 was exercised only in a child deliberately excluded from V8 instrumentation. | Exercise the real command in the measured process against occupied IPv4 and IPv6 sockets. Both must report address-in-use, proving normalization reached the actual bind. |

## Dead-branch proofs

`Matcher` is a module-private class. Its four construction sites (raw matching,
raw inspector, direct descriptor inspection and raw storage walking) each supply
only the pattern list. No template value or class constructor is exported or
passed to a callback. The unused optional template and its cloning branch have
no native caller and are removed.

In `scanErasureStorage`, the local hit state begins false. Its only writers are
the raw matcher and `RawInspector.feed`, both inside the byte loop immediately
followed by the retained-copy refusal. Any true value throws there.
`RawInspector.finish` only closes the inspector and cannot change the hit state.
No callback receives the state or inspector. Thus the later post-finish true
branch cannot be reached; the actual per-chunk refusal remains intact.

## Behavioral revert evidence

All controls run in disposable copies. Each produces an explicit assertion
failure with the behavior removed and passes after restoration (exit 1 / 0).
No syntax, import, setup or timeout failure counts.

| Control | Reverted behavior | Regression | Reverted / restored |
| --- | --- | --- | --- |
| R8-LinearTree | Restore old `decodeTree` | Legacy/v2/v3 decoding exceeds the linear predicate-work bound; stored order and duplicate errors remain checked. | 1 / 0 |
| R8-OptionalBudget | Invoke an omitted callback unconditionally | A valid direct physical inspection must succeed, while actual selected bytes must refuse. | 1 / 0 |
| R8-IPv6 | Keep brackets in the host supplied to bind | The real occupied IPv6 socket must produce address-in-use rather than a host-resolution failure. | 1 / 0 |
| R8-UnknownClone | Remove the unknown-origin fence | The imported clone must refuse before any denial, object or working-file change. | 1 / 0 |
| R8-ShippedDocs | Restore the README evidence link | The unchanged packaging test requires README-linked docs to be explicitly shipped. | 1 / 0 |

The consumer contract reproduction separately verifies both source epochs and
both physical storage modes. It establishes that permission for independent
user encodings was not introduced by byte-range, snapshot or two-pass changes.

## Complete-file inventory and runtimes

The preceding three repair rounds are the changes from `8ee69ad` through
`56b241a`: 24 complete test files. Including this round and the failed files
gives the 29-file matrix below. No name filter is used in these passing gates;
filters apply only to the disposable behavioral controls.

The Node gate uses CI's Node 22.23.4 and the unchanged `npm run coverage` command,
including every test file, all 95 production sources and per-file 100% limits.
The Bun-launched matrix uses Bun 1.3.14 to launch the same Node 26.13.0 test
runner used by CI's Bun package gate. It executes all 29 files completely.
The complete consumer file additionally executes the entire built and packed
consumer program in native Bun. This distinction is explicit: native Bun's
Node MockTracker methods are absent and `syncBuiltinESMExports` does not rebind
these filesystem imports, so a direct native fault-harness diagnostic is not a
passing gate. A separate native-harness port is not hidden behind skipped tests.

Each gate gets its own disposable home and scratch root. Only the pinned public
`pako@3.0.2` package is seeded into the otherwise empty npm cache to reproduce
CI's `npm ci` prerequisite for the consumer's intentional offline installation.
The cold-cache `ENOTCACHED` bootstrap and earlier failing diagnostic cohorts are
excluded from passing results. No installer timeout has been retried.

### Results

The repair round's local gates ran for four hours without a single failure, then stopped at the round's time limit before reporting final counts:
- the unfiltered Node 22 `npm run coverage` run had passed more than 845 reports and more than 750 of the 1,018 interrupted-unpack crash points;
- the 29-file Bun-launched matrix had passed more than 1,420 reports and finished the 512 generated lifecycle histories.

Complete before the stop:
- all five consumer scenarios and the packaging file, 12/12;
- the complete model and denial files, 25/25;
- all five behavioural controls above.

After the stop, the orchestrator reran the five files this round changes most directly, completely and unfiltered on Node 22.23.4: `test/model.test.ts`, `test/erasure-storage.test.ts`, `test/denial-noop-repair.test.ts`, `test/first-class-conflicts.test.ts` and `test/served-sync.test.ts`. They passed **191/191** in 2,556 s.

The complete matrix, with per-file 100% coverage on Node 22, Node 26 and Bun, is the CI run on the pushed head; the PR links it.

