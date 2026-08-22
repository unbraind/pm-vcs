import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { type ObjectId, ObjectStoreError } from "../engine/objects.ts";
import { readCommit, readTree } from "../engine/model.ts";
import { BRANCH_PREFIX } from "../engine/refs.ts";
import { REPOSITORY_FORMAT, Repository } from "../engine/repo.ts";
import {
  type Advertisement,
  assertCompatiblePeer,
  type PushUpdate,
  REQUIRED_TRANSPORT_CAPABILITIES,
  type TransferObject,
  type Transport,
  FileTransport,
  translatePublicationRace,
} from "../engine/transport.ts";
import { pushTo } from "../engine/sync.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const handles: Array<{ root: string; cleanup(): void }> = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.cleanup();
});

const author = { name: "A", email: "a@b", timestamp: 1, timezoneOffsetMinutes: 0 };
const now = new Date("2026-08-22T00:00:00.000Z");

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
 * @returns The repository.
 */
function freshRepo(): Repository {
  return Repository.init(tempRoot(), "main");
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

/**
 * Every object id a commit reaches in the receiver's terms: the commit, its
 * tree, and every leaf object in that tree.
 *
 * @param repository - Repository holding the history.
 * @param commit - Tip commit to close over.
 * @returns Object ids, commits included.
 */
function closureOf(repository: Repository, commit: ObjectId): ObjectId[] {
  const ids = new Set<ObjectId>();
  const walkTree = (treeIdentifier: ObjectId): void => {
    if (ids.has(treeIdentifier)) return;
    ids.add(treeIdentifier);
    for (const entry of readTree(repository.objects, treeIdentifier)) {
      if (entry.mode === "40000") walkTree(entry.id);
      else ids.add(entry.id);
    }
  };
  const seenCommits = new Set<ObjectId>();
  const walkCommit = (commitId: ObjectId): void => {
    if (seenCommits.has(commitId)) return;
    seenCommits.add(commitId);
    ids.add(commitId);
    const decoded = readCommit(repository.objects, commitId);
    walkTree(decoded.tree);
    for (const parent of decoded.parents) walkCommit(parent);
  };
  walkCommit(commit);
  return [...ids].sort();
}

test("an advertisement names the peer's format version and capabilities", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const wire = new FileTransport(source.root, source.root);
  const advertisement = wire.advertise();
  assert.equal(advertisement.formatVersion, REPOSITORY_FORMAT);
  for (const capability of REQUIRED_TRANSPORT_CAPABILITIES) {
    assert.ok(advertisement.capabilities.includes(capability), `missing ${capability}`);
  }
});

test("an incompatible peer is refused before any data moves or any ref changes", () => {
  const source = freshRepo();
  commitFile(source, "a.txt", "one");
  const compatible = new FileTransport(source.root, source.root);
  let transferred = 0;
  const counting: Transport = {
    url: compatible.url,
    advertise: () => compatible.advertise(),
    fetch: () => {
      transferred += 1;
      return compatible.fetch([], []);
    },
    push: () => {
      transferred += 1;
      return compatible.push(Buffer.alloc(0), [], false, now);
    },
    missingObjects: compatible.missingObjects.bind(compatible),
    uploadObjects: compatible.uploadObjects.bind(compatible),
    publish: compatible.publish.bind(compatible),
  };

  const staleFormat: Advertisement = {
    ...counting.advertise(),
    formatVersion: "pmvcs-0",
  };
  assert.throws(() => assertCompatiblePeer(staleFormat), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(error.code, "incompatible_peer");
    return true;
  });
  // A future peer that speaks a newer format is equally incompatible: neither
  // side can know what the other's bytes mean.
  const futureFormat: Advertisement = {
    ...counting.advertise(),
    formatVersion: "pmvcs-2",
  };
  assert.throws(() => assertCompatiblePeer(futureFormat), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(error.code, "incompatible_peer");
    return true;
  });
  const missingCapability: Advertisement = {
    ...counting.advertise(),
    capabilities: ["fetch"],
  };
  assert.throws(() => assertCompatiblePeer(missingCapability), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(error.code, "incompatible_peer");
    return true;
  });
  // The refusals happened at the handshake: no bundle was built or sent.
  assert.equal(transferred, 0);
  // And a matching peer passes.
  assert.equal(assertCompatiblePeer(counting.advertise()), true);
});

test("an interrupted upload resumes by sending only the objects the receiver still lacks", () => {
  const sender = freshRepo();
  commitFile(sender, "a.txt", "one");
  const tip = commitFile(sender, "b.txt", "two");
  const receiver = freshRepo();

  const wire = new FileTransport(receiver.root, receiver.root);
  const ids = closureOf(sender, tip);
  // Nothing has arrived yet, so the receiver lacks the whole closure.
  const firstAsk = wire.missingObjects(ids);
  assert.deepEqual(firstAsk, ids);

  // The upload starts and is interrupted after the first object.
  const objects: TransferObject[] = ids.map((id) => {
    const stored = sender.objects.read(id);
    return { id: id, type: stored.type, payload: stored.payload };
  });
  wire.uploadObjects(objects.slice(0, 1));
  // Resuming asks again, and the receiver only names what it still lacks.
  const secondAsk = wire.missingObjects(ids);
  assert.deepEqual(secondAsk, ids.slice(1));
  wire.uploadObjects(objects.slice(1));

  const updates: PushUpdate[] = [{ ref: `${BRANCH_PREFIX}main`, expected: null, next: tip }];
  const receipt = wire.publish(updates, false, now);
  assert.deepEqual(receipt.updated, updates);
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), tip);
  // Every object arrived exactly once: the resumed transfer did not resend
  // what the interruption had already delivered.
  assert.equal(receipt.added.length, ids.length);
});

test("each uploaded object is verified against its id on arrival", () => {
  const sender = freshRepo();
  commitFile(sender, "a.txt", "one");
  const tip = commitFile(sender, "b.txt", "two");
  const receiver = freshRepo();
  const wire = new FileTransport(receiver.root, receiver.root);

  const ids = closureOf(sender, tip);
  const objects: TransferObject[] = ids.map((id) => {
    const stored = sender.objects.read(id);
    return { id: id, type: stored.type, payload: stored.payload };
  });
  // A flipped byte in transit: the payload no longer hashes to its claimed id.
  const corrupted = objects.map((object) => ({ ...object }));
  corrupted[1] = {
    id: corrupted[1]!.id,
    type: corrupted[1]!.type,
    payload: Buffer.from(`tampered-${corrupted[1]!.payload.toString("hex")}`, "utf8"),
  };
  assert.throws(
    () => wire.uploadObjects(corrupted),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "corrupt_object");
      return true;
    },
  );
  // The tampered object must not be stored under a name that does not
  // describe it — the store holds nothing for the claimed id.
  assert.equal(receiver.objects.has(corrupted[1]!.id), false);
  // The objects before the corrupt one were verified and stored; the ones
  // after it never arrived, and a clean resend completes the transfer.
  wire.uploadObjects(objects);
  const updates: PushUpdate[] = [{ ref: `${BRANCH_PREFIX}main`, expected: null, next: tip }];
  wire.publish(updates, false, now);
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), tip);
});

test("publication is refused until the uploaded closure is complete, leaving no ref moved", () => {
  const sender = freshRepo();
  commitFile(sender, "a.txt", "one");
  const tip = commitFile(sender, "b.txt", "two");
  const receiver = freshRepo();
  const wire = new FileTransport(receiver.root, receiver.root);

  const ids = closureOf(sender, tip);
  const objects: TransferObject[] = ids.map((id) => {
    const stored = sender.objects.read(id);
    return { id: id, type: stored.type, payload: stored.payload };
  });
  // Everything except the tip commit: the branch would name a commit whose
  // object is absent, which is exactly the state publication must refuse.
  wire.uploadObjects(objects.filter((object) => object.id !== tip));
  const updates: PushUpdate[] = [{ ref: `${BRANCH_PREFIX}main`, expected: null, next: tip }];
  assert.throws(
    () => wire.publish(updates, false, now),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "incomplete_bundle");
      return true;
    },
  );
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), null);
  // Completing the upload makes the same publication succeed.
  const missing = objects.find((object) => object.id === tip)!;
  wire.uploadObjects([missing]);
  wire.publish(updates, false, now);
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), tip);
});

test("a lost publication race keeps the winner's tip and the loser's history, and is retryable", () => {
  // Two agents observed the same unborn branch and both prepared a push.
  const winnerSource = freshRepo();
  const winnerTip = commitFile(winnerSource, "winner.txt", "winner work");
  const loserSource = freshRepo();
  const loserTip = commitFile(loserSource, "loser.txt", "loser work");

  const remote = freshRepo();
  const wire = new FileTransport(remote.root, remote.root);

  const winnerObjects = closureOf(winnerSource, winnerTip);
  const loserObjects = closureOf(loserSource, loserTip);
  wire.uploadObjects(
    winnerObjects.map((id) => {
      const stored = winnerSource.objects.read(id);
      return { id: id, type: stored.type, payload: stored.payload };
    }),
  );
  wire.uploadObjects(
    loserObjects.map((id) => {
      const stored = loserSource.objects.read(id);
      return { id: id, type: stored.type, payload: stored.payload };
    }),
  );

  const winnerUpdate: PushUpdate = { ref: `${BRANCH_PREFIX}main`, expected: null, next: winnerTip };
  wire.publish([winnerUpdate], false, now);

  // The loser still believes main is unborn (it observed nothing there). The publication must refuse
  // as a retryable race, keep the winner's tip exactly where it landed, and
  // leave the loser's own repository untouched.
  const loserUpdate: PushUpdate = { ref: `${BRANCH_PREFIX}main`, expected: null, next: loserTip };
  assert.throws(
    () => wire.publish([loserUpdate], false, now),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "publication_race");
      return true;
    },
  );
  assert.equal(remote.refs.read(`${BRANCH_PREFIX}main`), winnerTip);
  assert.equal(loserSource.refs.read(`${BRANCH_PREFIX}main`), loserTip);
});

test("pushTo surfaces the peer handshake before building or sending a bundle", () => {
  const sender = freshRepo();
  commitFile(sender, "a.txt", "one");
  const remote = freshRepo();
  sender.remotes.add("origin", remote.root);

  const compatible = new FileTransport(remote.root, remote.root);
  let pushed = 0;
  const stale: Transport = {
    url: compatible.url,
    advertise: () => ({ ...compatible.advertise(), formatVersion: "pmvcs-9" }),
    fetch: compatible.fetch.bind(compatible),
    push: () => {
      pushed += 1;
      return compatible.push(Buffer.alloc(0), [], false, now);
    },
    missingObjects: compatible.missingObjects.bind(compatible),
    uploadObjects: compatible.uploadObjects.bind(compatible),
    publish: compatible.publish.bind(compatible),
  };
  assert.throws(
    () => pushTo(sender, "origin", ["main"], false, now, stale),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "incompatible_peer");
      return true;
    },
  );
  assert.equal(pushed, 0);
  assert.equal(remote.refs.read(`${BRANCH_PREFIX}main`), null);
});

test("publication refuses refs it cannot own and moves that are not fast-forwards", () => {
  const sender = freshRepo();
  commitFile(sender, "a.txt", "one");
  const tip = commitFile(sender, "b.txt", "two");
  const receiver = freshRepo();
  const wire = new FileTransport(receiver.root, receiver.root);

  // Objects first, so the ref-kind refusal is what fires rather than a
  // missing-closure refusal.
  const objects: TransferObject[] = closureOf(sender, tip).map((id) => {
    const stored = sender.objects.read(id);
    return { id: id, type: stored.type, payload: stored.payload };
  });
  wire.uploadObjects(objects);

  assert.throws(
    () => wire.publish([{ ref: "refs/remotes/other/main", expected: null, next: tip }], false, now),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "unpushable_ref");
      return true;
    },
  );
  assert.equal(receiver.refs.read("refs/remotes/other/main"), null);

  // An unrelated history is not a fast-forward from nothing... but an unborn
  // branch has no commits to discard, so the unrelated move lands; the real
  // non-fast-forward case needs a receiver that already holds other history.
  wire.publish([{ ref: `${BRANCH_PREFIX}main`, expected: null, next: tip }], false, now);
  const divergent = freshRepo();
  commitFile(divergent, "c.txt", "divergent");
  const divergentTip = divergent.refs.read(`${BRANCH_PREFIX}main`)!;
  const divergentObjects: TransferObject[] = closureOf(divergent, divergentTip).map((id) => {
    const stored = divergent.objects.read(id);
    return { id: id, type: stored.type, payload: stored.payload };
  });
  wire.uploadObjects(divergentObjects);
  assert.throws(
    () => wire.publish([{ ref: `${BRANCH_PREFIX}main`, expected: tip, next: divergentTip }], false, now),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.code, "non_fast_forward");
      return true;
    },
  );
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), tip);
  // Republishing a ref that already holds the requested value is a no-op, not
  // an error: the receiver answers with the receipt and moves nothing.
  const noOp = wire.publish([{ ref: `${BRANCH_PREFIX}main`, expected: tip, next: tip }], false, now);
  assert.deepEqual(noOp.updated, [{ ref: `${BRANCH_PREFIX}main`, expected: tip, next: tip }]);
  // The no-op publication consumed nothing new, so its receipt is empty too -
  // a stale accumulator here would name the divergent closure uploaded before
  // the fast-forward refusal.
  assert.deepEqual(noOp.added, []);
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), tip);
  // Every publication attempt claims and clears the arrival accumulator at
  // entry, refusals included, so retrying with force reports an empty added
  // list rather than naming objects an earlier attempt delivered.
  const forced = wire.publish([{ ref: `${BRANCH_PREFIX}main`, expected: tip, next: divergentTip }], true, now);
  assert.deepEqual(forced.updated, [{ ref: `${BRANCH_PREFIX}main`, expected: tip, next: divergentTip }]);
  assert.deepEqual(forced.added, []);
  assert.equal(receiver.refs.read(`${BRANCH_PREFIX}main`), divergentTip);
});


test("a transaction-level race is translated into a retryable publication failure", () => {
  const race = new ObjectStoreError(
    "ref_changed",
    "Ref refs/heads/main holds something else. Re-read the ref and retry.",
  );
  const translated = translatePublicationRace(race);
  assert.ok(translated instanceof ObjectStoreError);
  assert.equal((translated as ObjectStoreError).code, "publication_race");
  assert.match((translated as ObjectStoreError).message, /Nothing was published/);
  // Every other refusal passes through unchanged: translation exists for the
  // retryable race alone, not to rebrand arbitrary failures.
  const foreign = new ObjectStoreError("ref_locked", "locked");
  assert.equal(translatePublicationRace(foreign), foreign);
  const raw = new Error("raw");
  assert.equal(translatePublicationRace(raw), raw);
});
