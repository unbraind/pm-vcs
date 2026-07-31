// Behaviour a review round exposed, and the behaviour that replaced it.
//
// Every test here pins a defect that shipped in the first draft of the engine and
// was found by reading rather than by running: the suite reached 100% of lines,
// branches and functions while `pm vcs diff` was unusable in any repository that
// configured a record path. Coverage says every line ran; it does not say every
// line ran in every configuration that matters. These tests are the configurations
// that were missing.
//
// They are grouped by finding rather than by module on purpose. A regression here
// should read as "the thing we fixed came back", not as an anonymous assertion
// failure somewhere in the object store.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { exportBundle, importBundle, parseBundle } from "../engine/bundle.ts";
import { diffLines } from "../engine/diff.ts";
import { readIgnoreRules } from "../engine/ignore.ts";
import { mergeContent } from "../engine/merge.ts";
import { decodeCommit, decodeRecord, decodeTree, encodeCommit, type Signature } from "../engine/model.ts";
import { ObjectStore, ObjectStoreError } from "../engine/objects.ts";
import { OperationLog } from "../engine/oplog.ts";
import { mergeAppendOnlyLog } from "../engine/records.ts";
import { BRANCH_PREFIX, RefStore, TAG_PREFIX } from "../engine/refs.ts";
import { CONTROL_DIRECTORY, Repository } from "../engine/repo.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const sandboxes: Array<{ cleanup(): void }> = [];

afterEach(() => {
  for (const sandbox of sandboxes) sandbox.cleanup();
  sandboxes.length = 0;
});

/** A signature with values the encoder accepts, so tests vary only the field under test. */
const SIGNATURE: Signature = {
  name: "Reviewer",
  email: "reviewer@pm-vcs.invalid",
  timestamp: 1_700_000_000_000,
  timezoneOffsetMinutes: 60,
};

/**
 * Creates a temporary directory tracked for teardown.
 *
 * @returns The absolute path.
 */
function tempRoot(): string {
  const handle = makeTempDir();
  sandboxes.push(handle);
  return handle.root;
}

/**
 * Creates a repository whose `items/` paths are records, with one committed record.
 *
 * @returns The repository, and the commit id of the first revision.
 */
function repositoryWithRecord(): { repository: Repository; first: string } {
  const root = tempRoot();
  const repository = Repository.init(root, "main", { recordPaths: ["items/*.json"], recordPolicy: {} });
  mkdirSync(join(root, "items"), { recursive: true });
  writeFileSync(join(root, "items", "a.json"), JSON.stringify({ id: "x", status: "open", priority: 3 }));
  repository.stage(["items/a.json"]);
  const first = repository.commit({ message: "add record", author: SIGNATURE }, new Date(1_000));
  return { repository, first };
}

test("diff renders a record per field instead of demanding a blob", () => {
  // The defect: `diff` read both sides with readTyped(id, "blob"), but a configured
  // record path is stored as a `record` object. Every repository that used the
  // feature the package exists for therefore failed on `diff` outright.
  const { repository, first } = repositoryWithRecord();
  writeFileSync(join(repository.root, "items", "a.json"), JSON.stringify({ id: "x", status: "closed", priority: 3 }));
  repository.stage(["items/a.json"]);
  const second = repository.commit({ message: "close it", author: SIGNATURE }, new Date(2_000));

  const diff = repository.diff(first, second);
  // One field changed, so exactly one line changed: a record rendered as its
  // canonical single line would report the whole document as replaced, which tells
  // the reader nothing about what moved.
  assert.match(diff, /^-"status": "open"$/m);
  assert.match(diff, /^\+"status": "closed"$/m);
  assert.match(diff, /^ "priority": 3$/m);
  assert.doesNotMatch(diff, /^[-+] "id"/m);
});

test("diff still reports a record added on one side only", () => {
  const { repository, first } = repositoryWithRecord();
  writeFileSync(join(repository.root, "items", "b.json"), JSON.stringify({ id: "y", status: "open" }));
  repository.stage(["items/b.json"]);
  const second = repository.commit({ message: "add another", author: SIGNATURE }, new Date(2_000));

  const forward = repository.diff(first, second);
  assert.match(forward, /--- \/dev\/null/);
  assert.match(forward, /\+\+\+ b\/items\/b\.json/);
  // And the reverse direction reports it as a deletion rather than throwing.
  assert.match(repository.diff(second, first), /\+\+\+ \/dev\/null/);
});

test("an unreadable ignore file fails loudly instead of silently ignoring nothing", () => {
  // Returning empty rules for any read failure let `stage` add paths the project
  // excluded and let `materializeTree` write over them — the exact damage the
  // module exists to prevent, arrived at silently.
  const root = tempRoot();
  mkdirSync(join(root, ".pmvcsignore"));
  assert.throws(
    () => readIgnoreRules(root),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
  );
  // An absent file remains the ordinary case.
  const empty = tempRoot();
  assert.deepEqual(readIgnoreRules(empty), { patterns: [], negations: [] });
});

test("an unreadable operation log fails loudly instead of reporting no operations", () => {
  // "No operations" and "the record of what to undo is unreachable" call for
  // opposite responses, and only one of them is safe to act on.
  const root = tempRoot();
  const path = join(root, "oplog.jsonl");
  mkdirSync(path);
  assert.throws(
    () => new OperationLog(path).read(),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
  );
});

test("the operation log refuses to append while another process holds its lock", () => {
  // The sequence number comes from the log's length, so an unlocked append is a
  // read-modify-write and two of them assign one number twice — after which
  // `undo <n>` can only ever address the first.
  const root = tempRoot();
  const path = join(root, "oplog.jsonl");
  const log = new OperationLog(path);
  log.append("commit", "first", [], new Date(1_000));
  writeFileSync(`${path}.lock`, "held by another process");
  assert.throws(
    () => log.append("commit", "second", [], new Date(2_000)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "oplog_locked",
  );
  // The refusal wrote nothing: the log still holds exactly the first operation.
  assert.equal(log.read().length, 1);
});

test("a ref transaction refuses the whole set when one expectation is stale", () => {
  const root = tempRoot();
  const refs = new RefStore(root);
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  refs.compareAndSwap(`${BRANCH_PREFIX}one`, null, first);
  refs.compareAndSwap(`${BRANCH_PREFIX}two`, null, first);

  assert.throws(
    () => refs.transaction([
      { name: `${BRANCH_PREFIX}one`, expected: first, next: second },
      // Stale: `two` holds `first`, not `second`.
      { name: `${BRANCH_PREFIX}two`, expected: second, next: first },
    ]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "ref_changed",
  );
  // Neither ref moved. A loop of independent swaps would have moved the first one
  // and left a state no operation-log entry describes.
  assert.equal(refs.read(`${BRANCH_PREFIX}one`), first);
  assert.equal(refs.read(`${BRANCH_PREFIX}two`), first);
  // Every lock it took is released, so the refs are still writable afterwards.
  refs.compareAndSwap(`${BRANCH_PREFIX}one`, first, second);
  assert.equal(refs.read(`${BRANCH_PREFIX}one`), second);
});

test("a ref transaction applies every update when all expectations hold", () => {
  const root = tempRoot();
  const refs = new RefStore(root);
  const first = "c".repeat(64);
  const second = "d".repeat(64);
  refs.transaction([
    { name: `${BRANCH_PREFIX}alpha`, expected: null, next: first },
    { name: `${TAG_PREFIX}v1`, expected: null, next: second },
  ]);
  assert.equal(refs.read(`${BRANCH_PREFIX}alpha`), first);
  assert.equal(refs.read(`${TAG_PREFIX}v1`), second);
  // Deleting through a transaction works the same way.
  refs.transaction([{ name: `${TAG_PREFIX}v1`, expected: second, next: null }]);
  assert.equal(refs.read(`${TAG_PREFIX}v1`), null);
});

test("a ref transaction refuses two updates to one ref", () => {
  // Two updates to one ref make "the value the caller believes it holds"
  // ambiguous, and the second check would be reading the first one's write.
  const root = tempRoot();
  const refs = new RefStore(root);
  const target = "e".repeat(64);
  assert.throws(
    () => refs.transaction([
      { name: `${BRANCH_PREFIX}main`, expected: null, next: target },
      { name: `${BRANCH_PREFIX}main`, expected: target, next: null },
    ]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "duplicate_ref_update",
  );
  assert.equal(refs.read(`${BRANCH_PREFIX}main`), null);
});

test("a ref transaction reports a lock held on its second ref and releases the first", () => {
  const root = tempRoot();
  const refs = new RefStore(root);
  const target = "f".repeat(64);
  const contested = join(root, ...`${BRANCH_PREFIX}second`.split("/"));
  mkdirSync(join(root, "refs", "heads"), { recursive: true });
  writeFileSync(`${contested}.lock`, "held");
  assert.throws(
    () => refs.transaction([
      { name: `${BRANCH_PREFIX}first`, expected: null, next: target },
      { name: `${BRANCH_PREFIX}second`, expected: null, next: target },
    ]),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "ref_locked",
  );
  assert.equal(refs.read(`${BRANCH_PREFIX}first`), null);
  // The lock it did acquire on `first` was released, so `first` is not wedged.
  refs.compareAndSwap(`${BRANCH_PREFIX}first`, null, target);
});

test("undo puts HEAD back after a switch, on a branch and detached", () => {
  // The defect: `switch` recorded an empty transition list, so `undo` iterated
  // nothing, appended an undo entry, and reported success with HEAD unmoved. An
  // undo that claims to have worked is worse than one that refuses.
  const root = tempRoot();
  const repository = Repository.init(root);
  writeFileSync(join(root, "file.txt"), "one\n");
  repository.stage(["file.txt"]);
  const first = repository.commit({ message: "first", author: SIGNATURE }, new Date(1_000));
  repository.createBranch("side", first, new Date(1_100));

  repository.switchTo("side", new Date(1_200));
  assert.equal(repository.refs.rawHead(), `ref: ${BRANCH_PREFIX}side`);
  repository.undo(null, new Date(1_300));
  assert.equal(repository.refs.rawHead(), `ref: ${BRANCH_PREFIX}main`);

  // A detached switch records a bare object id, and undo restores the symbolic form
  // rather than leaving HEAD detached at the same commit — which would look
  // identical by resolved target and behave differently on the next commit.
  repository.switchTo(first, new Date(1_400));
  assert.equal(repository.refs.rawHead(), first);
  repository.undo(null, new Date(1_500));
  assert.equal(repository.refs.rawHead(), `ref: ${BRANCH_PREFIX}main`);
});

test("undo refuses to reverse a switch when HEAD has moved since", () => {
  const root = tempRoot();
  const repository = Repository.init(root);
  writeFileSync(join(root, "file.txt"), "one\n");
  repository.stage(["file.txt"]);
  const first = repository.commit({ message: "first", author: SIGNATURE }, new Date(1_000));
  repository.createBranch("side", first, new Date(1_100));
  repository.switchTo("side", new Date(1_200));
  // Something else moved HEAD after the switch was recorded.
  repository.refs.setHeadDetached(first);

  // The most recent operation is the switch; reversing it must refuse.
  assert.throws(
    () => repository.undo(null, new Date(1_300)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "head_changed",
  );
  // Refused having written nothing: HEAD is still where the other writer left it.
  assert.equal(repository.refs.rawHead(), first);
});

test("undo restores a detached HEAD when that is what the switch moved away from", () => {
  // The `before` side of a recorded HEAD transition can itself be a bare object id,
  // not only a symbolic ref: switching while already detached produces exactly that.
  // Restoring it as a symbolic ref would silently re-attach HEAD to a branch the
  // agent had deliberately left.
  const root = tempRoot();
  const repository = Repository.init(root);
  writeFileSync(join(root, "file.txt"), "one\n");
  repository.stage(["file.txt"]);
  const first = repository.commit({ message: "first", author: SIGNATURE }, new Date(1_000));
  writeFileSync(join(root, "file.txt"), "two\n");
  repository.stage(["file.txt"]);
  const second = repository.commit({ message: "second", author: SIGNATURE }, new Date(1_100));

  repository.switchTo(first, new Date(1_200));
  assert.equal(repository.refs.rawHead(), first);
  repository.switchTo(second, new Date(1_300));
  assert.equal(repository.refs.rawHead(), second);
  repository.undo(null, new Date(1_400));
  // Back to detached at `first`, not attached to main.
  assert.equal(repository.refs.rawHead(), first);
});

test("switch refuses rather than overwrite an untracked file the target tree carries", () => {
  // `materializeTree` writes every path in the target tree and removes every
  // working-tree path outside it, so without this guard a switch could destroy a
  // file whose content exists in no object and which no undo can bring back.
  const root = tempRoot();
  const repository = Repository.init(root);
  writeFileSync(join(root, "shared.txt"), "from main\n");
  repository.stage(["shared.txt"]);
  const first = repository.commit({ message: "first", author: SIGNATURE }, new Date(1_000));
  repository.createBranch("side", first, new Date(1_050));
  // On main, remove the file so the two trees differ on it.
  rmSync(join(root, "shared.txt"));
  repository.stage(["shared.txt"]);
  repository.commit({ message: "drop it", author: SIGNATURE }, new Date(1_100));
  // Now an untracked file of the same name appears, holding work no commit has.
  writeFileSync(join(root, "shared.txt"), "unsaved local work\n");

  assert.throws(
    () => repository.switchTo("side", new Date(1_200)),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "switch_would_overwrite",
  );
  // The file is untouched and HEAD did not move.
  assert.equal(repository.refs.rawHead(), `ref: ${BRANCH_PREFIX}main`);
});

test("importing a bundle that advertises a ref it does not carry is refused", () => {
  // A bundle is a claim, not a fact. Publishing a ref at an absent object leaves a
  // branch pointing at nothing, which every later read reports as a corrupt
  // repository rather than as the bad import it was.
  const root = tempRoot();
  const store = new ObjectStore(join(root, "objects"));
  const refs = new RefStore(root);
  const absent = "a".repeat(64);
  const forged = Buffer.from(
    `pmvcs-bundle-1\n${JSON.stringify({ refs: { [`${BRANCH_PREFIX}main`]: absent }, prerequisites: [], objects: [] })}\n`,
    "utf8",
  );
  assert.throws(
    () => importBundle(store, refs, forged),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "incomplete_bundle",
  );
  assert.equal(refs.read(`${BRANCH_PREFIX}main`), null);
});

test("importing a bundle whose tree is missing a blob is refused", () => {
  // Not only the commits: a bundle missing one blob deep inside a tree imports
  // history that fails at checkout, arbitrarily far from the cause.
  const source = tempRoot();
  const repository = Repository.init(source);
  writeFileSync(join(source, "file.txt"), "content\n");
  repository.stage(["file.txt"]);
  repository.commit({ message: "first", author: SIGNATURE }, new Date(1_000));
  const bundle = exportBundle(repository.objects, repository.refs, [`${BRANCH_PREFIX}main`]);

  const { lines } = parseBundle(bundle);
  const withoutBlob = lines.filter((line) => line.type !== "blob");
  assert.equal(withoutBlob.length, lines.length - 1, "the fixture must actually drop one blob");
  const header = JSON.parse(bundle.toString("utf8").split("\n")[1]!) as { refs: Record<string, string> };
  const trimmed = Buffer.from(
    [
      "pmvcs-bundle-1",
      JSON.stringify({ refs: header.refs, prerequisites: [], objects: withoutBlob.map((line) => line.id) }),
      ...withoutBlob.map((line) => `${line.type} ${line.id} ${line.payload.toString("base64")}`),
      "",
    ].join("\n"),
    "utf8",
  );

  const target = tempRoot();
  const store = new ObjectStore(join(target, "objects"));
  const refs = new RefStore(target);
  assert.throws(
    () => importBundle(store, refs, trimmed),
    (error: unknown) => error instanceof ObjectStoreError && error.code === "incomplete_bundle",
  );
  assert.equal(refs.read(`${BRANCH_PREFIX}main`), null);
});

test("a bundle header is validated as a schema, not trusted as a type", () => {
  // `typeof null` is "object" and so is an array, so the obvious shape check
  // admitted these and they crashed downstream as a TypeError — reported to the
  // user as a bug in the tool rather than as a malformed bundle.
  const cases: Array<[string, string]> = [
    [JSON.stringify(["not", "an", "object"]), "Bundle header is not a JSON object."],
    [JSON.stringify({ refs: null }), "Bundle header does not describe any refs."],
    [JSON.stringify({ refs: [] }), "Bundle header does not describe any refs."],
    [JSON.stringify({ refs: { "refs/heads/main": "not-an-id" } }), "which is not an object id"],
    [JSON.stringify({ refs: { "refs/heads/main": "a".repeat(64) }, prerequisites: "nope" }), "prerequisites are not a list"],
    [
      JSON.stringify({ refs: { "refs/heads/main": "a".repeat(64) }, prerequisites: ["short"] }),
      "declares prerequisite",
    ],
  ];
  for (const [headerText, expected] of cases) {
    assert.throws(
      () => parseBundle(Buffer.from(`pmvcs-bundle-1\n${headerText}\n`, "utf8")),
      (error: unknown) => error instanceof ObjectStoreError
        && error.code === "bad_bundle"
        && error.message.includes(expected),
      `header ${headerText} should be rejected with ${expected}`,
    );
  }
});

test("a signature that cannot be decoded back is refused at encode time", () => {
  // The commit header block is line-oriented, so a separator in a name forges
  // further headers; the decoder reads the numbers with a decimal-integer pattern,
  // so anything it cannot express would encode a commit that no longer decodes.
  const cases: Array<[Partial<Signature>, string]> = [
    [{ name: "Line\nBreak" }, "name cannot contain a line separator"],
    [{ email: "carriage\rreturn@x.invalid" }, "email cannot contain a line separator"],
    [{ email: "brackets<@x.invalid" }, "email cannot contain an angle bracket"],
    [{ timestamp: 1.5 }, "timestamp must be a safe integer"],
    [{ timestamp: Number.NaN }, "timestamp must be a safe integer"],
    [{ timestamp: Number.POSITIVE_INFINITY }, "timestamp must be a safe integer"],
    [{ timezoneOffsetMinutes: Number.MAX_SAFE_INTEGER + 2 }, "timezone offset must be a safe integer"],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(
      () => encodeCommit({
        tree: "a".repeat(64),
        parents: [],
        author: { ...SIGNATURE, ...overrides },
        committer: SIGNATURE,
        message: "message\n",
      }),
      (error: unknown) => error instanceof ObjectStoreError
        && error.code === "invalid_signature"
        && error.message.includes(expected),
      `${JSON.stringify(overrides)} should be rejected with ${expected}`,
    );
  }
});

test("an append-only log union keeps a line that legitimately occurs twice", () => {
  // Keyed on content alone, the union collapsed two identical events into one and
  // lost one that was really there. Two identical state transitions at the same
  // instant are two events.
  const base = ['{"at":"1","event":"start"}'];
  const ours = [...base, '{"at":"2","event":"tick"}', '{"at":"2","event":"tick"}'];
  const theirs = [...base, '{"at":"3","event":"stop"}'];
  const merged = mergeAppendOnlyLog(base, ours, theirs);
  assert.equal(merged.filter((line) => line.includes('"tick"')).length, 2);
  assert.equal(merged.length, 4);
  // A line both sides merely inherited from the base is still not duplicated.
  assert.equal(merged.filter((line) => line.includes('"start"')).length, 1);

  // Blank lines carry no event and are dropped from both the tally and the output,
  // so a trailing newline on one side does not read as a change to the log.
  const padded = mergeAppendOnlyLog(["", ...base, ""], ["  ", ...ours], theirs);
  assert.deepEqual(padded, merged);
  assert.ok(padded.every((line) => line.trim().length > 0));
});

test("a merge does not invent a trailing newline no side wrote", () => {
  // The merged text was always terminated, so merging two unterminated files
  // recorded a one-byte content change neither side made — which then shows up as
  // a diff against both parents forever.
  const unterminated = mergeContent("one\ntwo", "one\ntwo", "one\ntwo\nthree");
  assert.equal(unterminated.clean, true);
  assert.equal(unterminated.text, "one\ntwo\nthree");
  // A terminated side still yields a terminated result.
  const terminated = mergeContent("one\n", "one\n", "one\ntwo\n");
  assert.equal(terminated.text, "one\ntwo\n");
});

test("diffing two empty inputs returns an empty script without reading out of bounds", () => {
  // The search sized its diagonal array for the inputs and then read one past it
  // when both were empty, producing NaN cursors and falling out of the loop.
  assert.deepEqual(diffLines([], []), []);
  assert.deepEqual(diffLines([], ["only right"]).map((edit) => edit.kind), ["insert"]);
  assert.deepEqual(diffLines(["only left"], []).map((edit) => edit.kind), ["delete"]);
});

test("paths and refs sort in one order, including above the Basic Multilingual Plane", () => {
  // `<` on strings compares UTF-16 code units, which disagrees with the UTF-8 byte
  // order the tree encoder hashes by: "\u{1F600}" precedes "～" by code unit
  // and follows it by byte. Two names could therefore order one way inside a tree
  // and the other way in a status listing.
  const root = mkdtempSync(join(tmpdir(), "pm-vcs-order-"));
  sandboxes.push({ cleanup: () => rmSync(root, { recursive: true, force: true }) });
  const repository = Repository.init(root);
  const astral = "\u{1F600}.txt";
  const bmp = "～.txt";
  writeFileSync(join(root, astral), "astral\n");
  writeFileSync(join(root, bmp), "bmp\n");
  repository.stage([astral, bmp]);

  const staged = repository.readIndex().map((entry) => entry.path);
  assert.deepEqual(staged, [bmp, astral], "byte order puts U+FF5E before U+1F600");
  // The same order the index used is the order status reports, which is the
  // property that was broken: the two disagreed.
  const first = repository.commit({ message: "two names", author: SIGNATURE }, new Date(1_000));
  writeFileSync(join(root, astral), "changed\n");
  writeFileSync(join(root, bmp), "changed\n");
  const unstaged = repository.status().unstaged.map((change) => change.path);
  assert.deepEqual(unstaged, [bmp, astral]);
  // And the diff walks paths in that same order.
  repository.stage([astral, bmp]);
  const second = repository.commit({ message: "both changed", author: SIGNATURE }, new Date(2_000));
  const diff = repository.diff(first, second);
  assert.ok(diff.indexOf(bmp) < diff.indexOf(astral), "diff must follow the same order");
  assert.ok(diff.includes(CONTROL_DIRECTORY) === false, "the control directory is never diffed");
});

test("a decoder refuses a payload its own return type says cannot exist", () => {
  // Every one of these arrives from a bundle in practice, so the decoders are the
  // trust boundary. Accepting them let a tampered bundle put a value into the store
  // that the type system says cannot be there, and the first thing to notice would
  // be a crash in the record merge, arbitrarily later.
  const id = "a".repeat(64);
  const signature = `Author <a@b.invalid> 1 0`;

  // A tree entry name that is not one usable path segment, or a duplicate.
  const treeEntry = (name: string): Buffer => Buffer.concat([
    Buffer.from(`100644 ${name}\0`, "utf8"),
    Buffer.from(id, "utf8"),
  ]);
  for (const name of ["", ".", ".."]) {
    assert.throws(
      () => decodeTree(treeEntry(name)),
      (error: unknown) => error instanceof ObjectStoreError && /not a single usable path segment/.test(error.message),
      `tree entry named ${JSON.stringify(name)} must be refused`,
    );
  }
  assert.throws(
    () => decodeTree(Buffer.concat([treeEntry("same.txt"), treeEntry("same.txt")])),
    (error: unknown) => error instanceof ObjectStoreError && /appears more than once/.test(error.message),
  );
  assert.throws(
    () => decodeTree(Buffer.concat([
      Buffer.from("100644 file.txt\0", "utf8"),
      Buffer.from("z".repeat(64), "utf8"),
    ])),
    (error: unknown) => error instanceof ObjectStoreError && /not an object id/.test(error.message),
  );

  // A repeated singleton header makes the commit's meaning depend on which
  // occurrence a parser keeps.
  const commit = (headers: string): Buffer => Buffer.from(`${headers}\n\nmessage\n`, "utf8");
  const base = `tree ${id}\nauthor ${signature}\ncommitter ${signature}`;
  for (const [headers, expected] of [
    [`${base}\ntree ${id}`, /more than one tree header/],
    [`${base}\nauthor ${signature}`, /more than one author header/],
    [`${base}\ncommitter ${signature}`, /more than one committer header/],
    [`tree not-an-id\nauthor ${signature}\ncommitter ${signature}`, /names tree/],
    [`${base}\nparent not-an-id`, /names parent/],
  ] as Array<[string, RegExp]>) {
    assert.throws(
      () => decodeCommit(commit(headers)),
      (error: unknown) => error instanceof ObjectStoreError && expected.test(error.message),
      `headers ${headers} must be refused by ${expected}`,
    );
  }

  // A record field holding something RecordValue excludes.
  for (const [payload, expected] of [
    ['{"nested":{"a":1}}', /a value a record cannot carry/],
    ['{"list":[{"a":1}]}', /list\[0\] holds a value/],
    ['{"tags":[1,null,"ok",true]}', null],
  ] as Array<[string, RegExp | null]>) {
    if (expected === null) {
      assert.ok(decodeRecord(Buffer.from(payload, "utf8")));
      continue;
    }
    assert.throws(
      () => decodeRecord(Buffer.from(payload, "utf8")),
      (error: unknown) => error instanceof ObjectStoreError && expected.test(error.message),
      `record ${payload} must be refused`,
    );
  }
  // JSON cannot express a non-finite number, so the only route in is a value that
  // parses as one; `1e999` is Infinity after JSON.parse.
  assert.throws(
    () => decodeRecord(Buffer.from('{"ratio":1e999}', "utf8")),
    (error: unknown) => error instanceof ObjectStoreError && /non-finite number/.test(error.message),
  );
});
