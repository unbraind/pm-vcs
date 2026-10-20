# Change signatures and receiver trust

[pm-vcs-p7sign](../.agents/pm/features/pm-vcs-p7sign.toon) adds explicit
Ed25519 signing using only `node:crypto`. This is native pm-vcs history;
no Git signing format, executable or crypto dependency is involved.

`pm vcs sign [revision] --key <file>` signs an existing change and uses the
normal descendant replay, compare-and-swap and undo machinery. Explicit signing
keeps secret access out of ordinary commits, automated rewrites and publication.
It also lets each agent review precisely the version it is attesting. Revisions
unreachable from every branch, tag and HEAD are refused before writing objects.
The signed target keeps its committer; descendant replays record the caller as
committer, preserving each descendant's author, message and item links.

The signed bytes are the concatenation of UTF-8
`pm-vcs/change-signature`, NUL, `v1`, NUL, and `encodeRecord` canonical JSON
with exactly these fields:

- `changeId`: the effective stable change identity (including the legacy fallback).
- `tree`: the complete root tree content address, including conflict units and file identities.
- `author`: name, email, integer timestamp and timezone offset as stored.
- `message`: the exact string, including any trailing newline.
- `items`: distinct pm item IDs sorted in UTF-8 byte order.

JSON object keys sort in UTF-8 byte order recursively. Arrays retain order.
There is no trailing newline or Unicode normalization. Parents and committer
are deliberately excluded. This attests the change identity and snapshot, not
the ancestry, transport principal, freshness or approval of a branch update.
Signatures travel between clones of the same history; repository identity is
not part of this portable payload. Replaying onto a different change identity
or changing any signed field fails verification.

One `attestation` commit header carries base64 UTF-8 JSON with `version: 1`,
`publicKey` (canonical base64 Ed25519 SPKI DER) and `signature` (canonical
base64 64-byte signature). The header changes the commit address, never the
change identity. The signature does not recursively sign itself. Unrecognized
versions, extra envelope fields, invalid encodings, other algorithms and
truncated signatures are malformed. A structurally valid signature over other
bytes is tampered. Malformed evidence remains readable by object verification
so signature verification can report its specific failure.

All identity-preserving rewrite builders compare the signed bytes. An unchanged
payload retains its attestation through descendant replay, rebase or resolution
propagation. Changing the tree, message, author or item links removes it: the new
version is unsigned and must be explicitly signed. This applies to amend-like
`describe`, squash and split operations as well. A rebase onto additional content
changes the complete snapshot and therefore needs signing again. New changes
from cherry-pick or revert start unsigned. Undo restores the previous immutable
attested version; it cannot override current trust or revocation policy.

## Receiver policy

The shared control directory's `config.json` opts in with
`"trustedKeysFile": "trusted-keys.json"`. That file is receiver administration,
not a versioned working file or an incoming remote's authority. Its shape is:

```json
{
  "version": 1,
  "keys": [{ "identity": "agent-a@example.invalid", "publicKey": "<base64 SPKI DER>" }],
  "revocations": [{ "keyId": "<SHA-256 SPKI DER fingerprint>", "effectiveAt": 0 }]
}
```

Fingerprints are computed from actual key bytes, never mutable display names.
Each fingerprint has one author email binding; replacement is refused. Multiple
keys can be trusted for an identity during rotation. Revocations are append-only
through the administrative command, which rejects fingerprints absent from the
trusted key list before writing policy. The earliest effective time wins. Times are
nonnegative integer milliseconds since the Unix epoch, checked against the
receiver clock at publication, after expensive cryptographic verification and
again after FileId lease preflights.
Revocation applies to all signatures by that key, including historical ones;
there is no sender-controlled signing time or grandfathering.

Use `trust-key` and `revoke-key` on the receiver. They take the same store write
lease as publication, so an administrator's completed revocation precedes and
fences the next publication. A concurrent administrator waits for the active
writer (or receives the existing retryable store-lock refusal). A revocation
that commits after publication affects subsequent verification/publication.
Manual edits must be performed with writers stopped; arbitrary out-of-band
filesystem writers cannot participate in the store's concurrency guarantee.
Receiver administrators and their filesystem are trusted.

Both direct filesystem push and HTTP whole/resumable publication reload policy
under the ref transaction locks. Every commit reachable from every requested
branch/tag target must be valid, including merge side histories and previously
held commits. Unrelated uploaded objects do not grant publication and do not
expand the requested signature-check scope. The served proposal/series catalog
uses the same rule so it cannot bypass enforcement. Invalid batches move no
refs and append no publication operation. Immutable uploaded objects and upload
receipts may remain for retry/collection under existing retention rules.

Publication retains process-local positive signature receipts for complete
ancestry, bounded to 16 receivers and 4,096 commit boundaries per receiver.
Insertion retains recent tips ahead of old ancestors, including for longer histories.
Subsequent signature walks stop at those boundaries, after independently
validating the requested object closure again. Uploaded or structurally valid
objects alone never establish signature trust. Receipts are discarded whenever
any policy content changes, the receiver clock moves before the receipt's
verification time, or the next scheduled revocation becomes effective.
The final publication preflight repeats ancestry verification if that deadline
passes during other checks, including when the requested tip was cached. This
preserves historical revocation without repeating old cryptographic checks on
every publication. Restarting the process or evicting receipts simply requires
full signature verification again; receipts never travel in bundles or metadata.

A `ChangeSignatureError` has code `change_signature_refused`, `changeId`,
`commitId` and `reason`: unsigned, untrusted, revoked, malformed or tampered.
These fields survive HTTP transport. Missing or malformed configured policy
fails closed. Unconfigured receivers retain legacy publication behavior.
Advertisements include only record paths and merge policy. Clone adoption and
HTTP advertisement parsing also discard receiver-only settings from older peers.
Fetching preserves the receiver's existing configuration and trust file. A clone
starts without enforcement until its own administrator enables it. Configuration
and trust files use atomic sibling-file replacement with file fsync and supported
directory fsync; readers observe complete previous or next snapshots.

`pm vcs verify --signatures` performs ordinary object verification and reports
each reachable commit's stable change ID and status. It returns a structured
`signatures` table when all are valid. Any invalid result throws a nonzero gate
error listing **every** row, including valid rows. The pm host cannot return a
structured report and a nonzero status together (the existing pm-cli #826 gap).
Ordinary `verify` retains its existing object-integrity contract.

## Threat model

| Threat | Defense | Limit |
| --- | --- | --- |
| Unknown agent or unsigned ancestor | Entire requested closure checked before any ref write | Enforcement must be enabled on the receiving repository |
| Replay onto another change | Stable change ID included in signed bytes | Identical signed versions can travel between clones |
| Content mutation under the same identity | Snapshot and attribution bound; rewrites invalidate changed payloads | Parents and committer are outside this attestation |
| Key replaced under the same agent name | SPKI fingerprint and author email binding | Administrator can deliberately grant a new key |
| Truncation, malformed evidence or other payload version | Strict envelope validation and Ed25519 verification fail closed | Object integrity alone is not signature trust |
| Revocation races with upload/push | Shared writer lease, policy reload and final receiver-time check | Completed earlier publications are not rolled back |
| Mixed valid/invalid multi-ref batch | Signature checks in transaction preflight | Failed uploads may leave unpublished immutable objects |
| Private key leakage | Explicit external key input, no key bytes persisted or echoed | Deliberately staging a secret through ordinary file commands remains the user's responsibility |
| Stolen trusted private key | Effective-time revocation and rotation | Crypto cannot distinguish its thief from its owner |

The adversarial tests use generated ephemeral keys and real stores, trackers,
transports and a separate revocation process. They inspect every written fixture
file except the explicitly supplied external private-key source, decompressed
object payloads, exported bundles and captured outputs for PEM/DER key material.
The 2,000-change benchmark prints count, valid count and measured wall time;
it is a measurement, not a platform-independent performance promise.
