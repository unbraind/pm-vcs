The operational entry-point failure on action-only Dependabot PRs came from the
committed self-host archive, not a missing CLI. Failed CI jobs 116966419723,
116965719699 and 116965854973 report workflow byte mismatches in the self-host
audit. Green main job 116965011838 passes the audit. All four also print the
missing-CLI diagnostic from an intentionally passing negative acceptance test.

The archive still retains its exact original workflow bytes. Verification reads
committed source, independently imports the archive into an isolated store and
checks every reachable object, path and file mode. A YAML syntax-tree walk limits masking to actual job and step references,
excluding shell scalars, action inputs and malformed YAML. A content difference
is accepted only if masking full lowercase 40-hex SHA and version tokens on
trusted external `uses:` lines leaves every other byte identical on both sides.
The allowed owners are actions, github, oven-sh, dependabot and unbraind. Major, minor and
full version comments, plus the existing pm-github calendar-version annotations,
are supported because Dependabot preserves their format.
This permits action revision updates; it does not attest upstream code safety.

Action names, local and Docker references, unknown owners, malformed pins,
commands, permissions, whitespace, other comments and ordinary source remain
covered by the exact comparison. There is no workflow-directory exclusion, bot
identity bypass, branch-name condition, network lookup or automatic regeneration.
The existing package-manifest exclusions and coverage thresholds are unchanged.

Regression tests exercise both real archive verification and a copied production
CLI in a disposable committed Git repository. CodeQL, setup-node and
upload-artifact revision-only commits pass without changing the archived bytes;
mutable refs and operational edits fail. Reverting only the comparison exception
makes both regression tests fail with normal assertion failures.
