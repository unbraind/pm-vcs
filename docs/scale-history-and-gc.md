# Scale history and collection

`pm vcs gc` reports candidate content addresses and retained-object counts without
removing objects or hydrating promised payloads. `pm vcs gc --apply` replans under
the same interprocess object-store transaction used by push, staging, erasure,
lease changes and shared-instance writes, then removes only its unreachable
physical objects. It never trims refs or the operation log.

Roots include every ref namespace, detached HEAD, both endpoints of every oplog
transition, every current and retired shared instance's complete sparse index,
pending merge parents/bases, review series, terminal erasure audits and durable
upload receipts. Trees traverse all entries; manifests traverse pages and blobs.
An active receiver FileId lease conservatively retains the entire store because
unpublished arrivals need not yet have a tree attributing their FileId. Released
or expired leases stop that additional retention. Corrupt metadata, unavailable
instances, corrupt objects and interrupted erasure refuse collection before the
first deletion. Unknown physical storage layouts also refuse.

An upload records durable pins before accepting immutable objects. An interrupted
or disconnected upload can therefore resume after collection. Applied GC retires
pins only once a fresh graph walk proves durable ownership. Abandoned uploads
remain retained; expiring those receipts is a separate lifecycle policy. GC killed
during deletion leaves only an incomplete sweep of unreachable objects. Recover
the dead writer lock with `pm vcs recover-lock`, then rerun GC: no saved deletion
plan is replayed, so new refs and leases are always considered. GC never authorizes
obliteration, and its report does not claim physical erasure of retained history.

## Bounded transfer

```console
pm vcs clone source destination --depth 2
pm vcs clone source destination --filter blob:none
pm vcs fetch origin --depth 8
pm vcs fetch origin
```

Depth counts generations from each advertised tip, with the shortest distance
through merge parents. Commit IDs, trees, parent links and FileIds remain unchanged.
Clone-local `partial.json` records exactly the commits whose parents were omitted;
log and ancestry stop at those explicit boundaries. Fetching greater depth also
works when the remote tip has not moved. An ordinary fetch restores complete
advertised history. Operation-log history keeps its older boundaries until their
parents have actually arrived.

`blob:none` carries commits, trees, records, links and every manifest page; only
blob payloads become promises. Checkout retrieves the current files. Historical
reads fetch only requested missing blobs, and fragment range reads retrieve only
the overlapping fragments. The cache verifies kind and SHA-256 before publication,
obeys terminal erasure denials, and shares the same writer transaction. Corrupt
held data is never replaced silently. Unpromised missing objects remain errors.
Promises store a remote name; authentication remains in the existing remote
credential store. Filesystem and HTTP transports advertise `partial-history`;
a peer lacking it refuses bounded requests before publication.

Partial archives require opt-in fetch. Ordinary bundle imports and receiver push
validation still require complete history. A shallow clone can push to a receiver
holding its omitted ancestors; fetch complete history before pushing to an empty
receiver. Synchronous historical HTTP reads use an isolated bounded client process.
Use a separately running HTTP server when using the synchronous repository API.
