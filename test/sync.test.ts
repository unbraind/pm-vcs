import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import type { RepositoryConfig } from "../engine/config.ts";
import { type Signature } from "../engine/model.ts";
import { type ObjectId, ObjectStoreError } from "../engine/objects.ts";
import { BRANCH_PREFIX, TAG_PREFIX } from "../engine/refs.ts";
import { trackingRef } from "../engine/remotes.ts";
import { Repository } from "../engine/repo.ts";
import { cloneFrom, fetchFrom, pushTo } from "../engine/sync.ts";
import { FileTransport, openTransport } from "../engine/transport.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const handles: Array<{ root: string; cleanup(): void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.cleanup();
});

const author: Signature = { name: "A", email: "a@b", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date("2026-08-02T00:00:00.000Z");

/**
 * Creates an empty temporary directory that is cleaned up after the test.
 *
 * @returns Its absolute path.
 */
function tempRoot(): string {
  const handle = makeTempDir();
  handles.push(handle);
  return handle.root;
}

/**
 * Initialises a repository in a fresh temporary directory.
 *
 * @param config - Record configuration to store.
 * @returns The repository.
 */
function freshRepo(config?: RepositoryConfig): Repository {
  return Repository.init(tempRoot(), "main", config);
}

/**
 * Writes a file, stages it and commits, returning the new commit.
 *
 * @param repository - Repository to commit in.
 * @param path - Repository-relative path to write.
 * @param text - Contents to write.
 * @returns The commit id.
 */
function commitFile(repository: Repository, path: string, text: string): ObjectId {
  const absolute = join(repository.root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
  repository.stage([path]);
  return repository.commit({ message: `add ${path}\n`, author }, now);
}

test("clone reproduces the source's history, branch and record configuration", () => {
  const config: RepositoryConfig = { recordPaths: [".agents/pm/**/*.toon"], recordPolicy: { fields: {} } };
  const source = freshRepo(config);
  const first = commitFile(source, "a.txt", "one");
  const tip = commitFile(source, "b.txt", "two");
  source.refs.compareAndSwap(`${TAG_PREFIX}v1`, null, first);

  const destination = join(tempRoot(), "clone");
  const report = cloneFrom(source.root, destination, now);

  assert.equal(report.branch, "main");
  const clone = Repository.open(destination);
  assert.equal(clone.refs.read(`${BRANCH_PREFIX}main`), tip);
  assert.equal(clone.refs.read(trackingRef("origin", "main")), tip);
  // The configuration has to arrive with the history: a clone that stored
  // .toon paths as blobs would merge project records line by line while the
  // source merged them field by field.
  assert.deepEqual(clone.config, config);
  assert.equal(clone.remotes.require("origin").url, source.root);
  // Tags travel under their own name, because a tag identifies a point in history
  // rather than one repository's opinion about a line of work.
  assert.equal(clone.refs.read(`${TAG_PREFIX}v1`), first);
  assert.equal(readFileSync(join(destination, "b.txt"), "utf8"), "two");
});

test("cloning a repository with no commits yields an empty working tree, not an error", () => {
  const source = freshRepo();
  const destination = join(tempRoot(), "clone");
  const report = cloneFrom(source.root, destination, now);
  assert.equal(report.branch, null);
  assert.equal(report.fetched.upToDate, true);
  assert.equal(Repository.open(destination).refs.readHead().target, null);
});

test("cloning from a source whose HEAD is detached checks out nothing", () => {
  const source = freshRepo();
  const first = commitFile(source, "a.txt", "one");
  source.refs.setHeadDetached(first);
  const destination = join(tempRoot(), "clone");
  const report = cloneFrom(source.root, destination, now);
  assert.equal(report.branch, null);
  // The branch still arrived as a tracking ref, so nothing was lost — only the
  // choice of what to check out was left to the agent.
  assert.equal(Repository.open(destination).refs.read(trackingRef("origin", "main")), first);
  assert.equal(existsSync(join(destination, "a.txt")), false);
});

test("cloning into a directory that already holds a repository is refused", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const destination = freshRepo().root;
  assert.throws(() => cloneFrom(source.root, destination, now), (error: ObjectStoreError) => {
    assert.equal(error.code, "already_initialised");
    return true;
  });
});

test("clone accepts a file URL and a custom remote name", () => {
  const source = freshRepo();
  const tip = commitFile(source, "a.txt", "one");
  const destination = join(tempRoot(), "clone");
  const report = cloneFrom(pathToFileURL(source.root).href, destination, now, "upstream");
  assert.equal(report.branch, "main");
  const clone = Repository.open(destination);
  assert.equal(clone.refs.read(trackingRef("upstream", "main")), tip);
});

test("fetch leaves a diverged local branch alone and lands only on tracking refs", () => {
  const source = freshRepo();
  const shared = commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);

  // Both sides commit on main. This is the case a plain bundle import gets wrong:
  // the bundle names `refs/heads/main`, so importing it would move the clone's own
  // main onto the source's tip and the clone's commit would be reachable from
  // nothing at all.
  const remoteTip = commitFile(source, "b.txt", "two");
  const localTip = commitFile(clone, "c.txt", "three");

  const report = fetchFrom(clone, "origin", now);
  assert.equal(clone.refs.read(`${BRANCH_PREFIX}main`), localTip, "fetch moved the local branch");
  assert.equal(clone.refs.read(trackingRef("origin", "main")), remoteTip);
  assert.deepEqual(report.updated, [
    { ref: trackingRef("origin", "main"), before: shared, after: remoteTip },
  ]);
  assert.equal(report.upToDate, false);
  assert.equal(clone.operations.read().at(-1)?.command, "fetch");
});

test("a second fetch with nothing new transfers no objects at all", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const report = fetchFrom(clone, "origin", now);
  assert.deepEqual(report, {
    remote: "origin", url: source.root, updated: [], conflictingTags: [], added: [], upToDate: true,
  });
});

test("negotiation excludes history the fetching repository already holds", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  commitFile(source, "b.txt", "two");

  const cold = Repository.init(tempRoot(), "main");
  cold.remotes.add("origin", source.root);
  const coldReport = fetchFrom(cold, "origin", now);

  const warm = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  commitFile(source, "c.txt", "three");
  const warmReport = fetchFrom(warm, "origin", now);

  // The whole point of negotiation: the warm repository shares two commits with
  // the source and must be sent strictly less than a repository that shares none.
  assert.ok(
    warmReport.added.length < coldReport.added.length,
    `warm fetch transferred ${warmReport.added.length} objects, cold transferred ${coldReport.added.length}`,
  );
  assert.equal(warm.refs.read(trackingRef("origin", "main")), source.refs.read(`${BRANCH_PREFIX}main`));
});

test("a candidate the remote does not hold is dropped rather than failing the fetch", () => {
  const source = freshRepo();
  const remoteTip = commitFile(source, "a.txt", "one");
  const clone = Repository.init(tempRoot(), "main");
  clone.remotes.add("origin", source.root);
  // Local work the source has never seen. Offered as a candidate `have` and, if
  // the remote trusted the offer, used as an exclusion boundary it cannot walk.
  const localOnly = commitFile(clone, "local.txt", "local");
  assert.equal(source.objects.has(localOnly), false);

  const report = fetchFrom(clone, "origin", now);
  assert.equal(clone.refs.read(trackingRef("origin", "main")), remoteTip);
  assert.equal(report.upToDate, false);
});

test("a tag the local repository already uses at another value is reported, not moved", () => {
  const source = freshRepo();
  const sourceTip = commitFile(source, "a.txt", "one");
  source.refs.compareAndSwap(`${TAG_PREFIX}v1`, null, sourceTip);

  const clone = Repository.init(tempRoot(), "main");
  clone.remotes.add("origin", source.root);
  const localTip = commitFile(clone, "local.txt", "local");
  clone.refs.compareAndSwap(`${TAG_PREFIX}v1`, null, localTip);

  const report = fetchFrom(clone, "origin", now);
  assert.deepEqual(report.conflictingTags, ["v1"]);
  assert.equal(clone.refs.read(`${TAG_PREFIX}v1`), localTip);
});

test("a ref kind fetch does not understand is ignored rather than fetched somewhere arbitrary", () => {
  const source = freshRepo();
  const tip = commitFile(source, "a.txt", "one");
  const clone = Repository.init(tempRoot(), "main");
  clone.remotes.add("origin", source.root);

  // `Transport` is a published interface, so an implementation that advertises a
  // ref namespace this build has no mapping for is a case that will occur. It must
  // be skipped: inventing a local name for it would put a ref the fetching
  // repository cannot interpret into its own namespace.
  const extended = new FileTransport(source.root, source.root);
  const advertiseBranches = extended.advertise.bind(extended);
  extended.advertise = () => {
    const advertisement = advertiseBranches();
    return { ...advertisement, refs: [...advertisement.refs, { name: "refs/notes/commits", target: tip }] };
  };

  const report = fetchFrom(clone, "origin", now, extended);
  assert.deepEqual(report.updated.map((entry) => entry.ref), [trackingRef("origin", "main")]);
  assert.equal(clone.refs.read("refs/notes/commits"), null);
});

test("fetch from a remote that is not configured names the remote", () => {
  assert.throws(() => fetchFrom(freshRepo(), "origin", now), (error: ObjectStoreError) => {
    assert.equal(error.code, "unknown_remote");
    return true;
  });
});

test("push fast-forwards the remote branch and advances the tracking ref", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const pushed = commitFile(clone, "b.txt", "two");

  const report = pushTo(clone, "origin", [], false, now);
  assert.equal(source.refs.read(`${BRANCH_PREFIX}main`), pushed);
  assert.equal(clone.refs.read(trackingRef("origin", "main")), pushed);
  assert.equal(report.upToDate, false);
  assert.equal(report.updated[0]?.ref, `${BRANCH_PREFIX}main`);
  // Recorded on the receiving side too, which is what makes an unwanted push
  // reversible in the repository that received it.
  assert.equal(Repository.open(source.root).operations.read().at(-1)?.command, "push");
  assert.ok(report.added.length > 0);
});

test("push creates a branch the remote does not have", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  clone.createBranch("feature", "main", now);
  clone.switchTo("feature", now);
  const tip = commitFile(clone, "b.txt", "two");

  pushTo(clone, "origin", ["feature"], false, now);
  assert.equal(source.refs.read(`${BRANCH_PREFIX}feature`), tip);
});

test("a push that would discard commits the remote has is refused", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const remoteTip = commitFile(source, "remote.txt", "remote");
  const localTip = commitFile(clone, "local.txt", "local");

  assert.throws(() => pushTo(clone, "origin", [], false, now), (error: ObjectStoreError) => {
    assert.equal(error.code, "non_fast_forward");
    assert.match(error.message, /refs\/heads\/main/);
    return true;
  });
  assert.equal(source.refs.read(`${BRANCH_PREFIX}main`), remoteTip, "the refused push still moved the remote");
  // A refused push must leave no local trace suggesting it landed, or the next
  // fetch would consider the tracking ref current and never correct it.
  assert.notEqual(clone.refs.read(trackingRef("origin", "main")), localTip);
});

test("force overrides the refusal and the remote can still undo it", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const remoteTip = commitFile(source, "remote.txt", "remote");
  const localTip = commitFile(clone, "local.txt", "local");

  pushTo(clone, "origin", [], true, now);
  assert.equal(source.refs.read(`${BRANCH_PREFIX}main`), localTip);
  const received = Repository.open(source.root).operations.read().at(-1);
  assert.deepEqual(received?.refs, [{ ref: `${BRANCH_PREFIX}main`, before: remoteTip, after: localTip }]);
});

test("a push of a branch already at the remote's value transfers nothing", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const report = pushTo(clone, "origin", [], false, now);
  assert.deepEqual(report, { remote: "origin", url: source.root, updated: [], added: [], upToDate: true });
});

test("a push decided against a stale observation is refused rather than landing on it", () => {
  const source = freshRepo();
  const first = commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const second = commitFile(clone, "b.txt", "two");
  pushTo(clone, "origin", [], false, now);
  const third = commitFile(clone, "c.txt", "three");

  // The remote moved from `first` to `second` after this pusher looked. Pushing
  // `third` is still a fast-forward over `second`, so the fast-forward check alone
  // would wave it through — and every later report would say the push replaced
  // `first`, which is a lie about what the branch contained. The compare-and-swap
  // is what makes the check's verdict apply to the state it was computed against.
  const stale = new FileTransport(source.root, source.root);
  const truthful = stale.advertise.bind(stale);
  stale.advertise = () => {
    const advertisement = truthful();
    return {
      ...advertisement,
      refs: advertisement.refs.map((entry) => (
        entry.name === `${BRANCH_PREFIX}main` ? { ...entry, target: first } : entry
      )),
    };
  };

  assert.throws(() => pushTo(clone, "origin", [], false, now, stale), (error: ObjectStoreError) => {
    assert.equal(error.code, "ref_changed");
    return true;
  });
  assert.equal(source.refs.read(`${BRANCH_PREFIX}main`), second);
  assert.notEqual(source.refs.read(`${BRANCH_PREFIX}main`), third);
});

test("pushing a branch that does not exist names it", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  assert.throws(() => pushTo(clone, "origin", ["nope"], false, now), (error: ObjectStoreError) => {
    assert.equal(error.code, "unknown_branch");
    return true;
  });
});

test("pushing from a detached HEAD without naming a branch is refused", () => {
  const source = freshRepo();
  const tip = commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  clone.refs.setHeadDetached(tip);
  assert.throws(() => pushTo(clone, "origin", [], false, now), (error: ObjectStoreError) => {
    assert.equal(error.code, "detached_head");
    return true;
  });
});

test("a transport pointing at a directory that holds no repository says so", () => {
  const repository = freshRepo();
  repository.remotes.add("origin", tempRoot());
  assert.throws(() => fetchFrom(repository, "origin", now), (error: ObjectStoreError) => {
    assert.equal(error.code, "unreachable_remote");
    assert.match(error.message, /does not hold a repository/);
    return true;
  });
});

test("an unreadable remote surfaces its own failure rather than an unreachable one", () => {
  // A file where the repository root belongs: `format` cannot be read because the
  // path is not a directory, and the store must not rewrite every failure as a
  // missing repository.
  const path = join(tempRoot(), "not-a-dir");
  writeFileSync(path, "");
  const repository = freshRepo();
  repository.remotes.add("origin", path);
  assert.throws(() => fetchFrom(repository, "origin", now), (error: ObjectStoreError) => {
    assert.equal(error.code, "unreachable_remote");
    return true;
  });
});

test("a URL naming a scheme this build cannot serve is refused by name", () => {
  for (const url of ["https://example.com/repo", "ssh://host/repo", "git://host/repo"]) {
    assert.throws(() => openTransport(url, "/tmp"), (error: ObjectStoreError) => {
      assert.equal(error.code, "unsupported_transport");
      assert.match(error.message, /filesystem paths and file: URLs/);
      return true;
    }, url);
  }
});

test("a relative remote URL resolves against the repository, not the process cwd", () => {
  const base = tempRoot();
  const source = Repository.init(join(base, "source"), "main");
  const tip = commitFile(source, "a.txt", "one");
  const clone = Repository.init(join(base, "clone"), "main");
  clone.remotes.add("origin", "../source");
  fetchFrom(clone, "origin", now);
  assert.equal(clone.refs.read(trackingRef("origin", "main")), tip);
});

test("an absolute path and a file URL reach the same repository", () => {
  const source = freshRepo();
  const tip = commitFile(source, "a.txt", "one");
  for (const url of [source.root, pathToFileURL(source.root).href]) {
    assert.equal(openTransport(url, "/tmp").advertise().refs[0]?.target, tip);
  }
});

test("push refuses a ref whose history the bundle did not carry", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const clone = Repository.open(cloneFrom(source.root, join(tempRoot(), "clone"), now).root);
  const orphan = commitFile(clone, "b.txt", "two");
  // An empty bundle with a ref update naming a commit the remote cannot reach:
  // publishing it would leave the remote advertising a branch pointing at nothing.
  const transport = new FileTransport(source.root, source.root);
  assert.throws(
    () => transport.push(Buffer.from('pmvcs-bundle-1\n{"refs":{},"prerequisites":[],"objects":[]}\n'), [
      { ref: `${BRANCH_PREFIX}main`, expected: source.refs.read(`${BRANCH_PREFIX}main`), next: orphan },
    ], false, now),
    (error: ObjectStoreError) => {
      assert.equal(error.code, "incomplete_bundle");
      return true;
    },
  );
});
