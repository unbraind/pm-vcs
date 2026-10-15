# Agent forge workflow: propose → review → land

The file and HTTP transports advertise `forge`. A proposal is a named native
series object. Its review is a native record, accompanied by an outcome record
in a commit whose parent is the previous review revision. Both live in the
repository's object store. Catalog refs and immutable proposal archive refs
keep their history reachable through collection, including after leases expire.

Configure an authenticated served remote with `pm vcs remote origin <url>`.
Resolve credentials with `PM_VCS_TOKEN` or the existing per-remote credential
configuration. The operator's token file assigns repository grants and stable
principals. A client cannot choose its review or lease principal in request JSON.

## Propose

```console
pm vcs series create <base> <tip> --description "Describe the proposed change"
pm vcs lease acquire <FileId> origin --refs refs/heads/main --ttl-ms 60000
pm vcs series push proposal <series-id> origin --branch refs/heads/main
pm vcs series list origin
```

Acquire a live lease for **every stable FileId in the proposed history**, including
the base and intermediate patches, under the branch you intend to publish to.
`series push` carries the explicitly saved proofs; it never acquires a lease
implicitly. Receiver-clock expiration, foreign ownership, missing proofs and
out-of-scope branches return HTTP 400, as does a stale generation. These refusals
use separate wire `error.code` and `error.reason` fields, exactly as ordinary ref
publication does:

| `error.code` | `error.reason` |
| --- | --- |
| `lease_expired` | `expired` |
| `lease_wrong_principal` | `wrong_principal` |
| `lease_missing` | `missing` |
| `lease_out_of_scope` | `out_of_scope` |
| `lease_fenced` | `fenced` |

To revise a proposal, create its new series and push with
`--expected <observed-series-id>`. A changed catalog returns `publication_race`.
An accepted update resets the review to pending and preserves its old native
history. Earlier proposal versions stay reachable through immutable archive refs.

## Review

```console
pm vcs series fetch proposal origin
pm vcs review list origin
pm vcs review fetch proposal origin
pm vcs review update proposal origin --base <review-revision> --fields '{"comments":["Checked the invariants"],"reviewers":["agent-a"]}'
pm vcs review update proposal origin --base <review-revision> --fields '{"status":"approved","verdict":"pass"}'
```

Fetch verifies and imports native bundle objects, then validates the returned
root's object id, local presence and native kind before moving a catalog ref.
Series roots must decode as series; review revisions must decode as commits
containing native `review.json` and `outcome.json` records. Invalid roots raise
a typed object-store error and leave the catalog ref and operation log unchanged.
Successful fetches retain objects with local
catalog refs and operation-log transitions. It moves no working branch. The
review fetch receipt contains its record, revision and recorded outcome.
Send only changed fields in `--fields`; `--base` must be a revision from that
proposal's own review history. A revision from a prior series version returns
`stale_review_series`. The receiver owns the `series` field.

Reviewers may submit against the same base concurrently. The server merges each
field with `REVIEW_MERGE_POLICY`: different scalar fields both survive; reviewer
sets union; comments merge as a sequence; valid approval timestamps converge to
the latest. Genuine same-field scalar disagreement resolves to the smaller
canonical JSON value in byte order. The outcome records the field, base, both
values, chosen value, `canonical-min` rule, authenticated principal and previous
revision. `clean: false` identifies that disagreement even though publication
succeeds. Inspect it before landing; an approved status alone does not establish
unanimous approval. A subsequent update against the latest revision can record
an explicit resolution without silently replaying stale approval.

## Land

```console
pm vcs series fetch proposal origin
pm vcs review fetch proposal origin
pm vcs series rederive <series-id>
pm vcs series apply <series-id>
pm vcs lease renew <FileId> origin --ttl-ms 60000
pm vcs push origin --branch main
```

Start from a clean clone on the desired landing base. Inspect review status and
recorded disagreements before applying. `rederive` uses the original series
author, description and commit range, then compares canonical bytes. `apply`
fast-forwards when HEAD is the original base, preserving the exact commit IDs so
rederivation from the applied branch is byte-identical. On another HEAD it uses
native cherry-picks, preserving change attribution and updating the index and
working tree. It inherits native refusal of dirty work, untracked collisions,
layer violations and conflicting patches. Cherry-pick application rewrites commit
identity; the fetched original range remains available for byte-identical rederivation.
If a later patch refuses, earlier successfully applied patches remain native
commits and operation-log entries. The normal push performs branch CAS and
receiver lease validation; the forge does not automatically publish a branch or
enforce an approval policy.

## Wire contract and evidence

All forge operations are POST JSON requests. HTTP clients negotiate the optional
`explicit-endpoints` advertisement capability and address
`/<repository>/.pmvcs/forge/read` or `/<repository>/.pmvcs/forge/write`;
omit the repository and its slash for the root. The `.pmvcs` segment is reserved
and cannot be registered in the repository catalogue at any depth. This also
makes parent `objects/fetch` and nested `objects` repositories independently
reachable with open access or overlapping grants. Legacy endpoint aliases keep
scope-first, deepest-catalogued routing for compatibility; older servers without
the capability use those aliases. See the README serving contract for the
ambiguous legacy case and deterministic denial-header policy.

`forge/read` accepts `list` and
`fetch` for `kind: series | review`; `forge/write` accepts `publish`, which also
updates existing named entries. Series publication carries `name`, `series`,
`expected`, `branch`, optional base64 `bundle`, and explicit lease `proofs`.
Review publication carries `name`, `expected` review revision and a `fields`
record. Publishing through the read endpoint is refused before mutation.

The existing repository authorization runs before body reads and catalog I/O.
Wrong-tenant and absent repositories receive identical 404 status, content type
and denial bytes. Read grants cannot publish. Body size, imported object count,
safe catalog names, native object hash and complete closure checks still apply.
There is no server-side foreign-repository copy bypass: copy requires an
authorized source fetch and an authorized destination publication.

`test/served-forge.test.ts` uses an actual separate `pm vcs serve` process and
temporary repositories. Its named scenarios cover:

- `installed pm vcs commands propose fetch apply rederive review and land through a real served process`;
- `served forge concurrent reviewers preserve disjoint fields and record deterministic same-field outcomes`;
- `real served process denies every cross-tenant object ref series and review operation without an existence oracle`;
- `real served forge and ref publication reject missing expired foreign and out-of-branch leases with typed reasons`;
- `native forge CAS updates reset review state and reject foreign or stale review bases`;
- `series bundles include fragment closure and rederive identical binary proposal bytes in a fresh served store`.
- `forge fetch validates remote roots before catalog CAS`, with refusal cases
  for non-string, malformed, absent and wrong-kind roots for both catalog kinds,
  plus commits missing required review records.

The tenant regression checks all five operation classes for all four resource
kinds against existing and absent tenants, exact denial bytes and median local
HTTP timing class. It separately rejects source object IDs unavailable in the
authorized destination and attempts to smuggle writes through read grants.
Timing checks use a tolerance for scheduler noise; they establish comparable
local response classes, rather than cryptographic constant-time HTTP behavior.

For delivery, stage new files before `self-host:write`, generate the full
changelog after tracker writes, commit source and bundle together, then verify
`accept:self-host` against committed `HEAD`. Both release checks retain the
repository's per-file 100% coverage and all lint, duplicate and docstring gates.
