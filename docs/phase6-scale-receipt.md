# Phase 6 native scale receipt

Measured 2026-10-21 on a shared Linux runner with Node 24.19.0. This is one
capacity measurement under concurrent host load, not a production throughput or
cold-cache latency guarantee. Reproduce with `npm run benchmark:phase6`.

The benchmark copied the package's real public PM tracker, stored its TOON items
as structured records, and generated a deterministic 200,000,000-byte binary in
bounded blocks. Native PM-VCS commits recorded the baseline and a rename with a
2,000,000-byte middle replacement (1%). The FileId stayed unchanged, the two
ChangeIds differed, and both trace entries retained the epic association.
No generated binary, copied tracker or native object database is carried in Git.

| Measurement | Result |
| --- | ---: |
| Binary bytes | 200,000,000 |
| Real tracker files committed | 306 |
| Baseline compressed object file bytes | 201,271,356 |
| Object file bytes after the 1% edit | 203,550,572 |
| Additional object bytes | 2,279,216 |
| Original unique binary chunks | 609 |
| Edited binary chunks | 611 |
| Reused edited chunks | 604 (98.8543%) |
| Reused binary bytes | 98.8683% |
| Baseline stage plus commit | 273,094.25 ms |
| Edited stage plus commit | 80,738.10 ms |
| Verified 4 KiB range samples | 21 |
| Warm-cache range median | 13.6759 ms |
| Warm-cache range p95 | 52.9613 ms |
| GC dry-run candidate bytes | 1,048,920 |
| GC applied reclaimed bytes | 1,048,920 |
| Committed generations retained | 2 |

Object bytes sum compressed file lengths, including framing and manifest
overhead; they exclude refs/index/control metadata and filesystem allocation.
Chunk reuse counts occurrences in the edited binary whose addresses occur in
the baseline; byte reuse weights those occurrences by their lengths. Range
timings include manifest traversal and verified decompression, immediately after
writes and inventory reads warmed the filesystem cache. Every range was compared
with an independent file-descriptor read.

GC deliberately reclaimed an unreferenced 1 MiB generated payload. Neither old
committed content nor oplog-reachable history was treated as garbage. The dry-run
and apply byte receipts agreed, and reachable objects verified after collection.
All generated data lived in one owned temporary directory and was removed.

Native staging uses 64 KiB minimum / 1 MiB maximum CDC chunks with an 18-bit Gear
mask. An initial capacity attempt using the existing fine-grained helper defaults
was stopped after exposing excessive loose-object/fsync overhead; its partial
data was removed. Those helper defaults remain compatible and unchanged. Packs,
streaming native checkout/merge, explicit intent for ambiguous edited moves,
abandoned upload expiry and retirement of forge/oplog roots remain separate
tracked work.

Regression evidence includes bounded-reader refusals, same-inode rename plus
edit, copy provenance, unchanged compression identities, single-overlap range
reads, physical temporary-copy accounting, source drift and a packed CLI consumer
with only Node on PATH and Git discovery fenced at the fixture parent. Restoring
only `stageLocked`, `computeStatus` or `collectGarbage` to the baseline makes its
corresponding regression fail.
