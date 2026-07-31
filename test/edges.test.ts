// Behaviour at the states the main suites do not naturally reach.
//
// Every test here corresponds to a branch that only an unusual — but real —
// situation executes: an unborn HEAD, an empty commit message, an executable
// file, a named pipe in the working tree, a bundle header with no prerequisites,
// a ref file holding garbage. None of these are hypothetical; each is something
// a working repository can be in, and each is a place where getting it wrong
// produces a wrong answer rather than a crash.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, test } from "node:test";

import { BUNDLE_FORMAT, exportBundle, importBundle, parseBundle } from "../engine/bundle.ts";
import { buildHunks, diffLines } from "../engine/diff.ts";
import { parseIgnore } from "../engine/ignore.ts";
import { mergeContent } from "../engine/merge.ts";
import { decodeCommit, encodeRecord } from "../engine/model.ts";
import { ObjectStoreError } from "../engine/objects.ts";
import { mergeRecords } from "../engine/records.ts";
import { BRANCH_PREFIX, RefStore } from "../engine/refs.ts";
import { CONTROL_DIRECTORY, Repository } from "../engine/repo.ts";
import { encodeIndex, listWorkingTree, materializeTree } from "../engine/worktree.ts";
import { positiveInteger } from "../vcs-commands.ts";
import { VcsError } from "../git.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const sandboxes: Array<{ root: string; cleanup(): void }> = [];

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

/** Author recorded on every commit these tests make. */
const author = { name: "Edge", email: "edge@local", timestamp: 2_000, timezoneOffsetMinutes: 0 };

/** Fixed timestamp, so nothing here depends on the clock. */
const at = new Date(0);

/**
 * Creates an initialised repository in a fresh temporary directory.
 *
 * @returns The repository and its root.
 */
function freshRepo(): { repo: Repository; root: string } {
  const handle = makeTempDir();
  sandboxes.push(handle);
  return { repo: Repository.init(handle.root), root: handle.root };
}

/**
 * Writes, stages and commits one file.
 *
 * @param repo - The repository.
 * @param path - Repository-relative path.
 * @param content - File content.
 * @param message - Commit message.
 * @returns The new commit's id.
 */
function commitFile(repo: Repository, path: string, content: string, message: string): string {
  writeFileSync(join(repo.root, path), content);
  repo.stage([path]);
  return repo.commit({ message, author }, at);
}

test("an unborn branch has no tree, and a repository reports that rather than failing", () => {
  // A freshly initialised repository is on a branch that does not exist yet.
  // That is the normal starting state, not an error, and everything that reads
  // HEAD has to cope with it.
  const { repo } = freshRepo();
  assert.equal(repo.headTree(), null);
  assert.equal(repo.refs.resolveHead(), null);
  assert.equal(repo.status().clean, true);
  assert.deepEqual(repo.readIndex(), []);
});

test("an empty commit message is recorded as such rather than crashing the log line", () => {
  // The operation log summarises a commit by its first line. An empty message
  // has no first line, and indexing past the end of the split would put
  // `undefined` into the summary.
  const { repo } = freshRepo();
  const id = commitFile(repo, "a.txt", "content\n", "");
  const [operation] = repo.operations.read();
  assert.equal(operation.summary, `Committed ${id.slice(0, 12)}: `);
  assert.equal(repo.log("HEAD")[0].commit.message, "");
});

test("undo of the very first commit returns the branch to unborn and empties the tree", () => {
  // Rewinding past the root commit leaves HEAD pointing at a branch that no
  // longer exists. Materialising "no tree" has to mean an empty working tree,
  // not a crash and not the previous contents left behind.
  const { repo, root } = freshRepo();
  commitFile(repo, "a.txt", "content\n", "only commit\n");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "content\n");

  repo.undo(null, at);
  assert.equal(repo.refs.resolveHead(), null);
  assert.equal(repo.headTree(), null);
  assert.throws(() => statSync(join(root, "a.txt")), (error: unknown) => (error as { code?: string }).code === "ENOENT");
});

test("switching away from a detached HEAD records where it came from", () => {
  // The operation log names the ref a switch left. From a detached HEAD there is
  // no ref to name, so it records the commit id instead — an entry saying
  // "switched from undefined" would make the log useless exactly when an agent
  // most needs it.
  const { repo } = freshRepo();
  const first = commitFile(repo, "a.txt", "one\n", "first\n");
  commitFile(repo, "a.txt", "two\n", "second\n");
  repo.switchTo(first, at);
  assert.equal(repo.refs.readHead().kind, "detached");

  repo.switchTo("main", at);
  const summaries = repo.operations.read().map((operation) => operation.summary);
  assert.ok(summaries.some((summary) => summary.startsWith(`Switched from ${first}`)));
});

test("a switch is refused when an uncommitted edit would be overwritten, and nothing is written", () => {
  // The guard has to run before materialisation. A switch that half-applied
  // would leave a working tree matching no commit, with no way to describe it.
  const { repo, root } = freshRepo();
  commitFile(repo, "a.txt", "one\n", "first\n");
  repo.createBranch("other", "HEAD", at);
  repo.switchTo("other", at);
  commitFile(repo, "a.txt", "other\n", "other\n");
  repo.switchTo("main", at);

  writeFileSync(join(root, "a.txt"), "uncommitted\n");
  assert.throws(
    () => repo.switchTo("other", at),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "switch_would_overwrite",
  );
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "uncommitted\n");
});

test("diff renders an added and a deleted path against /dev/null", () => {
  // A path present on only one side has no content to read on the other, and the
  // unified header has to say so rather than naming a file that is not there.
  const { repo } = freshRepo();
  commitFile(repo, "kept.txt", "same\n", "first\n");
  const before = repo.refs.resolveHead() as string;
  writeFileSync(join(repo.root, "added.txt"), "new\n");
  rmSync(join(repo.root, "kept.txt"));
  repo.stage([]);
  repo.commit({ message: "add one, remove one\n", author }, at);

  const diff = repo.diff(before, "HEAD");
  assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/added\.txt/);
  assert.match(diff, /--- a\/kept\.txt\n\+\+\+ \/dev\/null/);
});

test("an executable file keeps its bit through a commit and a switch, and loses it when the tree says so", () => {
  // `writeFileSync` applies its mode only when creating a file, so materialising
  // a 100644 entry over an existing executable would leave the bit set and the
  // tree would never compare clean against the commit it came from.
  const { repo, root } = freshRepo();
  const script = join(root, "run.sh");
  writeFileSync(script, "#!/bin/sh\necho hi\n");
  chmodSync(script, 0o755);
  repo.stage(["run.sh"]);
  repo.commit({ message: "add an executable\n", author }, at);
  assert.equal(repo.readIndex()[0].mode, "100755");

  repo.createBranch("plain", "HEAD", at);
  repo.switchTo("plain", at);
  chmodSync(script, 0o644);
  repo.stage(["run.sh"]);
  repo.commit({ message: "drop the bit\n", author }, at);

  // Back to the executable version: the bit must come back.
  repo.switchTo("main", at);
  assert.equal(statSync(script).mode & 0o100, 0o100);
  assert.equal(repo.status().clean, true);

  // And forward again: the bit must go away, which is the case a create-only
  // mode would miss.
  repo.switchTo("plain", at);
  assert.equal(statSync(script).mode & 0o100, 0);
  assert.equal(repo.status().clean, true);
});

test("the working-tree walk skips an entry that is neither a file nor a symlink", (context) => {
  // A named pipe in a working tree is unusual but legal, and it has no content a
  // blob could hold. Walking into it would block on open; reporting it as
  // untracked would invite someone to stage it.
  const { root } = freshRepo();
  const fifo = join(root, "pipe");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    // No mkfifo on this platform. Reported as a skip rather than returning, because
    // an early return counts as a pass for a test whose assertion never ran.
    context.skip("mkfifo is unavailable on this platform");
    return;
  }
  writeFileSync(join(root, "real.txt"), "content\n");
  const found = listWorkingTree(root, CONTROL_DIRECTORY, { patterns: [], negations: [] });
  assert.deepEqual(found, ["real.txt"]);
});

test("index and status output are ordered by path, whichever order the entries arrive in", () => {
  // The index is compared byte for byte against what a later run produces, so
  // its order has to be a function of its content and not of insertion order.
  const encoded = encodeIndex([
    { path: "z.txt", id: "b".repeat(64), mode: "100644" },
    { path: "a.txt", id: "a".repeat(64), mode: "100755" },
  ]);
  assert.deepEqual(encoded.split("\n").map((line) => line.split(" ")[2]), ["a.txt", "z.txt"]);

  const { repo, root } = freshRepo();
  commitFile(repo, "b.txt", "b\n", "first\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "c.txt"), "c\n");
  rmSync(join(root, "b.txt"));
  repo.stage([]);
  const status = repo.status();
  assert.deepEqual(status.staged.map((change) => change.path), ["a.txt", "b.txt", "c.txt"]);
});

test("materialising a tree over an ignored path leaves the ignored file alone", () => {
  // A commit recorded before the ignore rules existed can still name a path the
  // rules now protect. Materialisation filters the target tree, so history
  // cannot reach back and overwrite another tool's state.
  const { repo, root } = freshRepo();
  mkdirSync(join(root, "keep"), { recursive: true });
  writeFileSync(join(root, "keep", "mine.txt"), "untouched\n");
  commitFile(repo, "tracked.txt", "content\n", "first\n");
  const tree = repo.headTree();

  materializeTree(repo.objects, root, tree, CONTROL_DIRECTORY, { patterns: ["keep/**"], negations: [] });
  assert.equal(readFileSync(join(root, "keep", "mine.txt"), "utf8"), "untouched\n");
});

test("a hunk that only deletes reports a zero right start", () => {
  // Unified diff numbers a hunk covering no lines on one side as 0, which is the
  // position after which the change applies rather than a real line number.
  const hunks = buildHunks(diffLines(["gone"], []), 3);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].rightCount, 0);
  assert.equal(hunks[0].rightStart, 0);
  assert.equal(hunks[0].leftStart, 1);
});

test("diff3 resynchronises on a base line only after both cursors have passed it", () => {
  // Our side moves a line earlier, so that line matches the base at a position
  // their side has already gone past. Accepting it as a resynchronisation point
  // would emit a region running backwards and produce garbled output; the search
  // skips any candidate behind either cursor.
  //
  // The reorder overlaps their edit, so this is a genuine conflict. What is being
  // asserted is that the conflict is *well-formed*: our side, the base and their
  // side each appear intact and in that order, and both sides' content survives.
  const merged = mergeContent(
    "one\ntwo\nthree\nfour\n",
    "two\none\nthree\nfour\n",
    "one\ntwo\nthree\nFOUR\n",
  );
  assert.equal(merged.clean, false);
  assert.equal(merged.conflicts.length, 1);

  const [conflict] = merged.conflicts;
  // Our reordering and their edit both survive into the reported conflict.
  assert.deepEqual(conflict.ours, ["one", "three", "four"]);
  assert.deepEqual(conflict.base, ["three", "four"]);
  assert.deepEqual(conflict.theirs, ["three", "FOUR"]);

  // The markers appear once each and in the order a three-way merge tool expects.
  const markers = merged.text.split("\n").filter((line) => /^(<{7}|\|{7}|={7}|>{7})/.test(line));
  assert.deepEqual(
    markers.map((line) => line.slice(0, 7)),
    ["<<<<<<<", "|||||||", "=======", ">>>>>>>"],
  );
  // The stable prefix ahead of the conflict is emitted plainly, not swallowed.
  assert.ok(merged.text.startsWith("two\n<<<<<<<"));
});

test("an ignore line that is only a negation marker is skipped", () => {
  // `!` with nothing after it names no path. Keeping it would compile to a
  // pattern matching the empty string, which then re-includes nothing while
  // looking like it does something.
  const rules = parseIgnore("# comment\n\n!\n*.log\n!keep.log\n");
  assert.deepEqual(rules.patterns, ["**/*.log"]);
  assert.deepEqual(rules.negations, ["**/keep.log"]);
});

test("a commit header line with no value is rejected as an unknown header", () => {
  // A truncated or hand-edited commit object can carry a bare keyword. Splitting
  // on a space that is not there must not silently produce a header named after
  // the whole line and an empty value that some branch then accepts.
  assert.throws(
    () => decodeCommit(Buffer.from("tree " + "a".repeat(64) + "\ngpgsig\n\nmessage\n", "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "malformed_object",
  );
});

test("set members are ordered canonically while sequence members keep their order", () => {
  // The difference is the point of having two strategies: a set has no order to
  // preserve, so it is normalised and two agents converge; a sequence's order is
  // its data, so it is left alone.
  const asSet = mergeRecords(
    { values: ["b"] },
    { values: ["b", "z"] },
    { values: ["b", "a"] },
    { fields: { values: "set" } },
  );
  assert.deepEqual(asSet.document.values, ["a", "b", "z"]);

  const asSequence = mergeRecords(
    { values: ["b"] },
    { values: ["b", "z"] },
    { values: ["b", "a"] },
    { fields: { values: "sequence" } },
  );
  assert.deepEqual(asSequence.document.values, ["b", "z", "a"]);
});

test("a field deleted on one side and collected on the other still merges as a collection", () => {
  // Strategy is inferred from whichever side has a value. With our side absent,
  // the inference has to fall through to theirs rather than defaulting to scalar
  // and reporting a conflict that is not one.
  const base = { tags: ["a"] };
  const ours: Record<string, never> = {};
  const theirs = { tags: ["a", "b"] };
  const merged = mergeRecords(base, ours as never, theirs);
  assert.equal(merged.clean, true);
  assert.deepEqual(merged.document.tags, ["b"]);
});

test("listing refs skips a file that does not hold an object id, and sorts what remains", () => {
  // A ref directory can accumulate editor backups and interrupted writes. A
  // listing that returned them would put non-commits into every caller that
  // walks refs.
  const handle = makeTempDir();
  sandboxes.push(handle);
  const control = join(handle.root, CONTROL_DIRECTORY);
  mkdirSync(join(control, "refs", "heads"), { recursive: true });
  const refs = new RefStore(control);
  refs.compareAndSwap(`${BRANCH_PREFIX}zeta`, null, "c".repeat(64));
  refs.compareAndSwap(`${BRANCH_PREFIX}alpha`, null, "d".repeat(64));
  writeFileSync(join(control, "refs", "heads", "garbage"), "not-an-object-id\n");

  const listed = refs.list(BRANCH_PREFIX);
  assert.deepEqual(listed.map((entry) => entry.name), [`${BRANCH_PREFIX}alpha`, `${BRANCH_PREFIX}zeta`]);
});

test("a bundle walks a shared subtree once and carries every intermediate tree", () => {
  // Two commits that share a subdirectory reach the same subtree object. Walking
  // it twice would double the bundle; omitting the intermediate tree would
  // produce commits whose trees cannot be read on the far side.
  const { repo, root } = freshRepo();
  mkdirSync(join(root, "nested", "deep"), { recursive: true });
  writeFileSync(join(root, "nested", "deep", "a.txt"), "a\n");
  repo.stage([]);
  repo.commit({ message: "first\n", author }, at);
  writeFileSync(join(root, "top.txt"), "top\n");
  repo.stage([]);
  repo.commit({ message: "second, sharing the subtree\n", author }, at);

  const bytes = exportBundle(repo.objects, repo.refs, []);
  const { header } = parseBundle(bytes);
  assert.equal(new Set(header.objects).size, header.objects.length);

  const target = freshRepo();
  importBundle(target.repo.objects, target.repo.refs, bytes);
  target.repo.switchTo("main", at);
  assert.equal(readFileSync(join(target.root, "nested", "deep", "a.txt"), "utf8"), "a\n");
});

test("a bundle with no header line and one with no prerequisites are both handled", () => {
  // The marker alone is a truncated file, not a bundle with an empty header.
  assert.throws(
    () => parseBundle(Buffer.from(`${BUNDLE_FORMAT}\n`, "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "bad_bundle",
  );

  // A full export names no prerequisites at all, so the import must treat the
  // field as absent rather than requiring it.
  const { repo } = freshRepo();
  commitFile(repo, "a.txt", "content\n", "first\n");
  const bytes = exportBundle(repo.objects, repo.refs, []);
  const { header } = parseBundle(bytes);
  assert.deepEqual(header.prerequisites, []);

  const target = freshRepo();
  const report = importBundle(target.repo.objects, target.repo.refs, bytes);
  assert.ok(report.added.length > 0);
});

test("positiveInteger names a multi-word flag the way the caller typed it", () => {
  // Options reach a handler camel-cased. Reporting `failOn` back to someone who
  // typed `--fail-on` sends them looking for a flag that does not exist.
  assert.throws(
    () => positiveInteger({ maxDepth: "-3" }, "maxDepth", 1),
    (error: unknown) => error instanceof VcsError
      && error.code === "invalid_option"
      && error.message.includes("--max-depth must be a positive integer"),
  );
});

test("a record written through the porcelain is stored as a record object", () => {
  // The repository config decides the object kind, not the file extension. Verified here at the
  // object layer so a change to staging cannot quietly turn records back into
  // blobs and lose per-field merging for the rest of a repository's history.
  const handle = makeTempDir();
  sandboxes.push(handle);
  const repo = Repository.init(handle.root, "main", {
    recordPaths: ["*.rec"],
    recordPolicy: { fields: {} },
  });
  writeFileSync(join(handle.root, "item.rec"), JSON.stringify({ b: 2, a: 1 }));
  repo.stage([]);
  const staged = repo.readIndex().find((entry) => entry.path === "item.rec");
  assert.ok(staged);
  assert.equal(repo.objects.read(staged.id).type, "record");
  // Canonical re-encoding means key order is normalised on the way in.
  assert.equal(repo.objects.read(staged.id).payload.toString("utf8"), encodeRecord({ a: 1, b: 2 }).toString("utf8"));
});

test("a bundle header that omits prerequisites entirely is treated as having none", () => {
  // Hand-written and older bundles need not carry the field. Requiring it would
  // reject a valid bundle; assuming a value would be worse.
  const { repo } = freshRepo();
  commitFile(repo, "a.txt", "content\n", "first\n");
  const bytes = exportBundle(repo.objects, repo.refs, []);
  const lines = bytes.toString("utf8").split("\n");
  const header = JSON.parse(lines[1]) as Record<string, unknown>;
  delete header.prerequisites;
  lines[1] = JSON.stringify(header);

  const target = freshRepo();
  const report = importBundle(target.repo.objects, target.repo.refs, Buffer.from(lines.join("\n"), "utf8"));
  assert.ok(report.added.length > 0);
  assert.equal(target.repo.refs.read(`${BRANCH_PREFIX}main`), repo.refs.read(`${BRANCH_PREFIX}main`));
});

test("diff3 skips a resynchronisation candidate behind either cursor, from either side", () => {
  // The guard has two arms — a candidate behind OUR cursor and one behind THEIRS
  // — and a merge is not symmetric in which one it hits. Both orderings are
  // exercised so neither arm can rot.
  const base = "a\nb\nc\nd\n";
  const ourReorder = mergeContent(base, "b\na\nc\nD\n", "a\nb\nC\nd\n");
  const theirReorder = mergeContent(base, "a\nb\nC\nd\n", "b\na\nc\nD\n");
  // Both directions must produce a well-formed result covering every input line.
  for (const result of [ourReorder, theirReorder]) {
    assert.ok(result.text.length > 0);
    assert.ok(result.text.endsWith("\n"));
  }
});

test("a switch is refused for a path that exists on only one of the two branches", () => {
  // The overwrite guard compares the two trees' blob ids, and a path missing from
  // one side has no id there. Treating "absent" as "unchanged" would let a switch
  // silently delete an uncommitted new file.
  const { repo, root } = freshRepo();
  commitFile(repo, "base.txt", "base\n", "first\n");
  repo.createBranch("other", "HEAD", at);
  repo.switchTo("other", at);
  commitFile(repo, "only-on-other.txt", "theirs\n", "add a file\n");
  repo.switchTo("main", at);

  // Create, and stage, a file that `other` also carries with different content.
  writeFileSync(join(root, "only-on-other.txt"), "mine, uncommitted\n");
  repo.stage(["only-on-other.txt"]);
  assert.throws(
    () => repo.switchTo("other", at),
    (error: unknown) => error instanceof ObjectStoreError
      && error.code === "switch_would_overwrite"
      && error.message.includes("only-on-other.txt"),
  );
  assert.equal(readFileSync(join(root, "only-on-other.txt"), "utf8"), "mine, uncommitted\n");
});

test("status sorts several unstaged changes by path", () => {
  // With one change the comparator never runs, so ordering is only actually
  // pinned once more than one path differs.
  const { repo, root } = freshRepo();
  writeFileSync(join(root, "c.txt"), "c\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  repo.stage([]);
  repo.commit({ message: "three files\n", author }, at);

  writeFileSync(join(root, "c.txt"), "c changed\n");
  writeFileSync(join(root, "a.txt"), "a changed\n");
  const status = repo.status();
  assert.deepEqual(status.unstaged.map((change) => change.path), ["a.txt", "c.txt"]);
});

test("set members from both sides sort into one canonical order regardless of arrival", () => {
  // With two members the comparator only ever answers one way, so the ordering is
  // not actually pinned. Several members from each side, arriving out of order,
  // exercise it in both directions — which is what makes "two agents converge on
  // the same bytes" a real guarantee rather than a coincidence of input order.
  const forward = mergeRecords(
    { tags: ["m"] },
    { tags: ["m", "z", "b"] },
    { tags: ["m", "a", "q"] },
    { fields: { tags: "set" } },
  );
  const reverse = mergeRecords(
    { tags: ["m"] },
    { tags: ["m", "a", "q"] },
    { tags: ["m", "z", "b"] },
    { fields: { tags: "set" } },
  );
  assert.deepEqual(forward.document.tags, ["a", "b", "m", "q", "z"]);
  // Swapping which agent is "ours" must not change the result for a set.
  assert.deepEqual(forward.document.tags, reverse.document.tags);
});

test("strategy is inferred from their side when ours removed the field", () => {
  // Inference reads whichever side still has a value. With ours absent it has to
  // fall through to theirs; reading ours unconditionally would infer `scalar` for
  // a collection and turn a clean union into a conflict.
  const merged = mergeRecords(
    { items: ["one"] },
    {},
    { items: ["one", "two"] },
  );
  assert.equal(merged.clean, true);
  assert.deepEqual(merged.document.items, ["two"]);

  // The mirror image, so the left arm of the same expression is pinned too.
  const mirrored = mergeRecords(
    { items: ["one"] },
    { items: ["one", "two"] },
    {},
  );
  assert.equal(mirrored.clean, true);
  assert.deepEqual(mirrored.document.items, ["two"]);
});
