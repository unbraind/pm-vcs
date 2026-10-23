# Capability-limited change bundles

Use `vcs bundle` to exchange selected **native histories** between ordinary
directories. Git is unnecessary. The sender explicitly selects immutable tips,
destination branch names and exact authorized paths. All selected ancestors and
their complete trees must fit that scope. This preserves commit and stable change
identities. Selecting a path from a mixed-scope commit refuses; create a separate
native history with that authorized content before exporting.

The receiver supplies its own scope, trusted keys and expected destination values.
The sender's signed scope limits that authority further. Neither embedded keys nor
sender-selected branch names grant receiver permission. Import admits objects and
publishes only the named branches; it does not check out files, execute commands,
replay tracker mutations, change HEAD, adopt clone identity, or import erasure
authority. Local signature and semantic checkpoint publication policies still
apply. Admitted objects may remain when a local checkpoint publication rule refuses
the ref update, just as with ordinary native transport. A capability limits this
operation; it cannot restrict subsequent actions by the receiving repository owner.

## Example

First create a native commit containing only authorized files, for example the
tracked `review.toon` file. Obtain its exact commit id from `pm vcs log --json`.
Create an Ed25519 private key outside the working directory. Use the SPKI DER public
key encoded as canonical base64 for receiver trust, as with native change signing.
Keep private keys and local authorization files out of version control.

Sender `request.json` (replace the example digest with the actual native tip):

```json
{
  "scope": { "paths": ["review.toon"], "refs": ["refs/heads/review"] },
  "tips": { "refs/heads/review": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "signer": "reviewer@example.invalid"
}
```

```sh
pm vcs bundle export selected.bundle --input request.json --key-file ../signing.pem --json
```

Independently prepare receiver `authority.json`, replacing `PUBLIC_KEY_BASE64` with
the sender's verified public key. Existing native trusted-key policies use this
same `trust` shape. The receiver may authorize a broader set of paths and branches;
the signed manifest still limits the imported set.

```json
{
  "scope": { "paths": ["review.toon"], "refs": ["refs/heads/review"] },
  "trust": {
    "version": 1,
    "keys": [{ "identity": "reviewer@example.invalid", "publicKey": "PUBLIC_KEY_BASE64" }],
    "revocations": []
  }
}
```

Receiver `expected.json` requires a new branch:

```json
{ "refs/heads/review": null }
```

```sh
pm vcs bundle inspect selected.bundle --authorization authority.json
pm vcs bundle import selected.bundle --authorization authority.json --expected expected.json --json
```

For an existing branch, replace `null` with its independently read current native
commit id. Tip and expected-value maps must match the declared scope ref by ref;
commas are literal characters in a ref name, never branch-set separators.
Every imported branch needs exactly one expected value. A mismatch
refuses before importing objects. Import deliberately leaves the native index and
working files alone; inspect or check out the admitted history separately.

The default TOON and `--json` receipts contain only a manifest digest and counts:
`objects`, `excluded`, `changes`, `refs`, `unknownOmissions`, `scopeComplete` and
`complete`. No object contents, inventory arrays, credentials or tracker bodies
are expanded into agent output. Export reports the written byte count. The full
inventory remains in the signed file. Output files are created exclusively with
private permissions and an existing output file is never overwritten.

## SDK

The package entry point exports `exportChangeBundle`, `inspectChangeBundle`,
`importChangeBundle`, both policy parsers and their typed contracts:

```ts
const bytes = exportChangeBundle(sender.objects, tips, scope, signer, privateKey);
const report = inspectChangeBundle(receiver.objects, bytes, authorization);
const imported = importChangeBundle(receiver, bytes, authorization, expected);
```

Scopes contain sorted, unique exact relative paths (1..1000) and full branch names
(1..100). Tags, globs, traversal, implicit dependency expansion and unsupported
fields refuse. Arrays use native UTF-8 byte ordering. Export is bounded to 32 MiB;
inventory arrays are bounded to 100,000 ids each. Large streaming transfers remain
the separate Phase 6 workstream.

## Manifest and refusals

The version 1 manifest binds scope, exact branch tips, included and excluded object
ids, unknown omissions, archive SHA-256, signer and public key. Ed25519 signs
`pm-vcs/change-bundle\0v1\0` followed by canonical native-record JSON bytes. The
canonical envelope embeds that manifest, signature and native archive. Its distinct
format marker prevents accidental import through ordinary `vcs import`. The inner
archive carries no prerequisites, partial-history promises, clone identity or
erasure metadata. Native hashing and role-aware closure validation remain the
authority for objects, trees, conflicts and fragment manifests.

Both export and import validate every selected historical tree path. Native
checkpoint scope/dependency paths and `copiedFrom` file identities must also stay
within selected history. External repository links and non-history roots such as
series/tombstones refuse. Historical tracker attribution and ordinary record
field values are data, not grants to fetch or mutate their referenced resources.
No source tip, parent, payload, conflict side or fragment may be silently supplied
from the receiver's existing store. Duplicate, unrelated and missing objects
refuse before storage, even when signed by a trusted sender.

Excluded ids enumerate verified physical objects held by the source but outside
the selected closure at export time; their payloads are not included. This is a
signed source-inventory statement, not proof of all objects that ever existed or
independent proof of the sender's honesty. Partial-history or erasure state sets
`unknownOmissions: true`. `scopeComplete: true` certifies the validated selected
native closure only. `complete: true` additionally requires no excluded objects
and no unknown omissions. A selective archive therefore never claims to reproduce
the complete source project.

`ChangeBundleRefusal` exposes `code` and `remedy` for malformed contracts,
cross-scope references, untrusted/revoked/tampered signatures, incomplete closure
and stale leases. Fix the named input, narrow the selected history, independently
authorize all referenced scope, restore missing objects, or review fresh destination
values as directed. Core native integrity, erasure, signature and checkpoint
refusals retain their existing typed codes. Ordinary forge/tenant authorization
and durable upload receipt expiry are separate contracts.

## Public tracker validation

Measured against the committed public pm-vcs tracker at
`641d2d66d31308f0171df2c666e18dc1d27aee03`, using an archive copy in a plain
directory. The SDK read the selected real items; native commits first captured
the five authorized task files and then the remaining public item inventory.
Only the first native change was authorized for export. Both export and receiver
inspection/import ran with an empty executable search path and a Git discovery
ceiling around the scratch projects.

| Measurement | Result |
| --- | ---: |
| Source tracker items | 158 |
| Selected / excluded item files | 5 / 153 |
| Source native objects | 173 |
| Carried / excluded objects | 10 / 163 |
| Selected native changes / destination branches | 1 / 1 |
| Signed bundle bytes | 31,013 |
| Export + inspect + import elapsed time | 187 ms |
| Source item files verified unchanged | 158 |

The receipt reported `scopeComplete: true`, `complete: false` and
`unknownOmissions: false`. A subsequent cross-scope replay refused and the
receiver inventory stayed exact. All copied item bytes were compared after the
run; their combined path-and-content SHA-256 was
`1d3eb73203b89eaf0156c0c15478b063d96c494bbbef558be0f9e760a9b656b2`.
This bounded measurement establishes selected-history behavior, not large-file
streaming throughput or hosted-backend acceptance.
