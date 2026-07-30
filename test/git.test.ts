import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  VcsError,
  changedPaths,
  mergeAttributes,
  parseCheckAttr,
  parseLogRecords,
  parsePathChanges,
  readBlob,
  requireGit,
  resolveCommit,
  resolveRepoRoot,
  runGit,
  splitNulList,
} from "../git.ts";
import { type Sandbox, createSandbox } from "./helpers/sandbox.ts";

const sandboxes: Sandbox[] = [];

/**
 * Registers a sandbox for teardown and returns it.
 *
 * @param sandbox - Sandbox to track.
 * @returns The same sandbox.
 */
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

after(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
});

test("runGit reports a non-zero status without throwing", () => {
  const sandbox = track(createSandbox());
  const result = runGit(["cat-file", "-e", "HEAD:definitely-absent"], sandbox.root);
  assert.notEqual(result.status, 0, "a missing object is a meaningful answer, not a crash");
  assert.equal(typeof result.stdout, "string");
});

test("runGit surfaces an unusable working directory as a remediable failure", () => {
  // The one case where the process cannot start at all. Node reports it as a
  // spawn error with no exit status, which would otherwise read as success.
  assert.throws(
    () => runGit(["status"], join("/", "nonexistent-directory-for-pm-vcs-tests")),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "git_unavailable");
      assert.match(error.message, /on PATH/);
      return true;
    },
  );
});

test("requireGit turns a failed command into an error carrying git's own stderr", () => {
  const sandbox = track(createSandbox());
  assert.throws(
    () => requireGit(["rev-parse", "--verify", "no-such-ref"], sandbox.root, "Try a real ref."),
    (error: unknown) => {
      assert.ok(error instanceof VcsError);
      assert.equal(error.code, "git_command_failed");
      assert.match(error.message, /rev-parse/);
      assert.equal(error.remediation, "Try a real ref.");
      // The remediation is folded into the message too, because the host
      // discards a thrown handler error's structured fields.
      assert.match(error.message, /Try a real ref\./);
      return true;
    },
  );
});

test("requireGit returns stdout when the command succeeds", () => {
  const sandbox = track(createSandbox());
  const head = requireGit(["rev-parse", "HEAD"], sandbox.root, "unused").trim();
  assert.match(head, /^[0-9a-f]{40}$/);
});

test("repository and commit resolution answer null outside their domain", () => {
  const sandbox = track(createSandbox());
  assert.equal(resolveRepoRoot(sandbox.root), sandbox.root);
  assert.equal(resolveRepoRoot(sandbox.pmRoot), sandbox.root, "resolves from a subdirectory");
  // The OS temp root itself is not a git repository.
  assert.equal(resolveRepoRoot(join(sandbox.root, "..")), null);

  assert.match(resolveCommit("HEAD", sandbox.root) ?? "", /^[0-9a-f]{40}$/);
  assert.equal(resolveCommit("no-such-ref", sandbox.root), null);
  // A ref that resolves to a non-commit object must not be accepted.
  const treeish = requireGit(["rev-parse", "HEAD^{tree}"], sandbox.root, "unused").trim();
  assert.equal(resolveCommit(treeish, sandbox.root), null);
});

test("readBlob returns contents, and null for a path absent at that commit", () => {
  const sandbox = track(createSandbox());
  const head = requireGit(["rev-parse", "HEAD"], sandbox.root, "unused").trim();

  const fence = readBlob(head, ".gitattributes", sandbox.root);
  assert.ok(fence, ".gitattributes is committed in the fixture");
  assert.match(fence, /merge=pm-item-toon/);

  // A one-sided add is the normal case this must not throw on.
  assert.equal(readBlob(head, "never-existed.txt", sandbox.root), null);
});

test("changedPaths lists what differs between two commits", () => {
  const sandbox = track(createSandbox());
  const before = requireGit(["rev-parse", "HEAD"], sandbox.root, "unused").trim();
  const itemId = sandbox.createItem("Task", "Item for the diff");
  const after_ = sandbox.commit("Add an item");

  const paths = changedPaths(before, after_, sandbox.root);
  assert.ok(paths.some((path) => path.endsWith(`${itemId}.toon`)));
  assert.ok(paths.some((path) => path.endsWith(`${itemId}.jsonl`)));
  assert.equal(changedPaths(before, before, sandbox.root).length, 0);
});

test("mergeAttributes asks git which driver applies, and short-circuits on no paths", () => {
  const sandbox = track(createSandbox());
  // No paths means no git invocation at all: asking check-attr for nothing is an
  // error, so the guard is load-bearing rather than an optimisation.
  assert.deepEqual(mergeAttributes([], sandbox.root), []);

  const attributes = mergeAttributes(
    [".agents/pm/tasks/x.toon", ".agents/pm/history/x.jsonl", ".agents/pm/settings.json", "src.ts"],
    sandbox.root,
  );
  assert.deepEqual(
    attributes.map((attribute) => attribute.driver),
    ["pm-item-toon", "pm-history", "pm-json", null],
  );
  // Input order is preserved so callers can zip results against their own list.
  assert.equal(attributes[0]?.path, ".agents/pm/tasks/x.toon");
});

test("check-attr parsing distinguishes a driver name from git's state words", () => {
  const paths = ["a", "b", "c", "d"];
  // `unspecified`, `unset` and `set` all mean "no driver named here"; only a
  // real driver name counts. Treating `set` as a driver would classify a path as
  // an artifact class it has no merge function for.
  const raw = [
    "a", "merge", "pm-item-toon",
    "b", "merge", "unspecified",
    "c", "merge", "unset",
    "d", "merge", "set",
  ].join("\0");
  assert.deepEqual(parseCheckAttr(raw, paths).map((entry) => entry.driver), [
    "pm-item-toon",
    null,
    null,
    null,
  ]);

  // A truncated stream must not invent drivers for the paths it never reached.
  assert.deepEqual(parseCheckAttr("a\0merge", paths).map((entry) => entry.driver), [
    null,
    null,
    null,
    null,
  ]);
  assert.deepEqual(parseCheckAttr("", paths).map((entry) => entry.driver), [
    null,
    null,
    null,
    null,
  ]);
});

test("NUL list splitting drops the empty trailing entry", () => {
  assert.deepEqual(splitNulList("a\0b\0"), ["a", "b"]);
  assert.deepEqual(splitNulList(""), []);
  assert.deepEqual(splitNulList("\0"), []);
});

test("log record parsing tolerates a truncated stream", () => {
  // Real records are exercised end to end by the ledger suite; this pins the
  // robustness edges, which a truncated read (a killed pager, a full pipe) can
  // produce and which must not surface as a wrong answer.
  assert.deepEqual(parseLogRecords(""), []);
  // A record missing its trailing fields is skipped rather than half-reported.
  assert.deepEqual(parseLogRecords("\x01sha\0short\0author"), []);
  assert.deepEqual(parseLogRecords("\x01sha\0short\0author\0date"), []);

  const complete = parseLogRecords("\x01sha\0short\0author\0date\0subject");
  assert.equal(complete.length, 1);
  assert.deepEqual(complete[0]?.changes, []);
  assert.equal(complete[0]?.subject, "subject");
});

test("path-change parsing handles renames, copies and truncation", () => {
  // A rename or copy emits the letter then two paths; the destination is the one
  // that exists after the commit.
  assert.deepEqual(parsePathChanges(["R100", "old.toon", "new.toon"]), [
    { status: "R100", path: "new.toon" },
  ]);
  assert.deepEqual(parsePathChanges(["C75", "src.toon", "copy.toon"]), [
    { status: "C75", path: "copy.toon" },
  ]);
  // The leading newline git emits before the first entry is stripped, or an
  // added file would read as modified.
  assert.deepEqual(parsePathChanges(["\nA", "added.toon"]), [
    { status: "A", path: "added.toon" },
  ]);
  // Empty separator entries are skipped.
  assert.deepEqual(parsePathChanges(["", "M", "changed.toon", ""]), [
    { status: "M", path: "changed.toon" },
  ]);
  // A status with no path is dropped rather than paired with the next status.
  assert.deepEqual(parsePathChanges(["M"]), []);
  assert.deepEqual(parsePathChanges(["R100", "only-source.toon"]), []);
  assert.deepEqual(parsePathChanges([]), []);
});
