import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readHistoryEntries, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";

import { type Signature } from "../engine/model.ts";
import { mergeAppendOnlyLog } from "../engine/records.ts";
import { Repository } from "../engine/repo.ts";
import { mergePath, mergeTrees } from "../engine/rewrite.ts";
import { buildTree, flattenTree } from "../engine/worktree.ts";
import { createSandbox } from "./helpers/sandbox.ts";
import { makeTempDir } from "./helpers/tmp.ts";

const historyPath = ".agents/pm/history/example.jsonl";
const signature: Signature = { name: "Harness", email: "harness@example.invalid", timestamp: 1, timezoneOffsetMinutes: 0 };

/** Build a history tree with an optional independent file edit. */
function historyTree(repo: Repository, text: string, other = "base"): string {
  return buildTree(repo.objects, new Map([
    [historyPath, { id: repo.objects.write("blob", Buffer.from(text)), mode: "100644" as const }],
    ["other.txt", { id: repo.objects.write("blob", Buffer.from(other)), mode: "100644" as const }],
  ]));
}

/** Read the exact history bytes from a merged tree. */
function historyText(repo: Repository, tree: string): string {
  const entry = flattenTree(repo.objects, tree).get(historyPath);
  assert.ok(entry);
  return repo.objects.readTyped(entry.id, "blob").toString("utf8");
}

/** Count exact occurrences independently of the merge implementation. */
function occurrences(lines: readonly string[], event: string): number {
  return lines.filter((line) => line === event).length;
}

test("generated histories agree across identical blobs, union and unrelated edits", () => {
  const dir = makeTempDir();
  try {
    const repo = Repository.init(dir.root);
    const context = { store: repo.objects, config: repo.config, committer: signature };
    let seed = 0x3a7e;
    /** Use a seeded generator so failures reproduce without random fixtures. */
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 16;
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const events = Array.from({ length: 4 }, (_, index) => JSON.stringify({ ts: String(index), event: index }));
      const base = Array.from({ length: random() % 6 }, () => events[random() % events.length]);
      const extra = Array.from({ length: 1 + random() % 8 }, () => events[random() % events.length]).sort();
      const baseRaw = base.length === 0 ? "" : `${base.join("\n")}\n`;
      const raw = `${baseRaw}${extra.join("\n")}\n`;
      const baseTree = historyTree(repo, baseRaw);
      const side = historyTree(repo, raw);
      const shortcut = mergeTrees(context, baseTree, side, side);
      const elsewhere = mergeTrees(context, baseTree, side, historyTree(repo, raw, "independent edit"));
      assert.deepEqual(shortcut.conflicts, []);
      assert.deepEqual(elsewhere.conflicts, []);
      assert.equal(historyText(repo, shortcut.tree), raw);
      assert.equal(historyText(repo, elsewhere.tree), raw);
      const entry = flattenTree(repo.objects, side).get(historyPath);
      assert.ok(entry);
      const baseEntry = flattenTree(repo.objects, baseTree).get(historyPath);
      assert.ok(baseEntry);
      const forced = mergePath(context, historyPath, baseEntry.id, entry.id, entry.id);
      assert.equal(repo.objects.readTyped(forced.id, "blob").toString("utf8"), raw);
      // An unrelated event in this stream forces union instead of the shortcut.
      const unrelated = JSON.stringify({ ts: "9", unrelated: attempt });
      const union = mergeTrees(context, baseTree, side, historyTree(repo, raw + unrelated + "\n"));
      assert.deepEqual(union.conflicts, []);
      assert.equal(historyText(repo, union.tree).split("\n").filter((line) => line !== unrelated).join("\n"), raw);

      const leftExtra = Array.from({ length: random() % 10 }, () => events[random() % events.length]);
      const rightExtra = Array.from({ length: random() % 10 }, () => events[random() % events.length]);
      const leftRaw = baseRaw + (leftExtra.length === 0 ? "" : `${leftExtra.join("\n")}\n`);
      const rightRaw = baseRaw + (rightExtra.length === 0 ? "" : `${rightExtra.join("\n")}\n`);
      const leftTree = historyTree(repo, leftRaw);
      const normal = mergeTrees(context, baseTree, leftTree, historyTree(repo, rightRaw));
      const independent = mergeTrees(context, baseTree, leftTree, historyTree(repo, rightRaw, "other edit"));
      assert.deepEqual(normal.conflicts, []);
      assert.deepEqual(independent.conflicts, []);
      assert.equal(historyText(repo, independent.tree), historyText(repo, normal.tree));
      const merged = mergeAppendOnlyLog(base, [...base, ...leftExtra], [...base, ...rightExtra], "ts");
      assert.deepEqual(merged.slice(0, base.length), base);
      for (const event of events) {
        assert.equal(occurrences(merged, event), occurrences(base, event)
          + Math.max(occurrences(leftExtra, event), occurrences(rightExtra, event)));
      }
      assert.deepEqual(mergeAppendOnlyLog(base, [...base, ...rightExtra], [...base, ...leftExtra], "ts"), merged);
    }
  } finally {
    dir.cleanup();
  }
});

test("byte-exact identity preserves whitespace differences, repeated base and one-side appends", () => {
  const event = '{"ts":"2","event":"repeat"}';
  const spaced = ` ${event} `;
  const base = [event, event, "", spaced];
  const result = mergeAppendOnlyLog(base, [...base, event, event, spaced], [...base, event], "ts");
  assert.deepEqual(result, [...base, event, event, spaced]);
  assert.deepEqual(mergeAppendOnlyLog([], [event], [spaced], "ts"), [event, spaced]);
  // Timestamp inheritance and stable arrival ordering survive overlap removal.
  const later = '{"ts":"3","event":"later"}';
  assert.deepEqual(mergeAppendOnlyLog([], [event, "plain", "plain"], [event, "plain", later], "ts"),
    [event, "plain", "plain", later]);
});

for (const scenario of ["cherry-pick", "double-merge"] as const) {
  test(`${scenario} keeps one shared event after branch-specific edits`, () => {
    const dir = makeTempDir();
    try {
      const repo = Repository.init(dir.root);
      mkdirSync(join(dir.root, ".agents/pm/history"), { recursive: true });
      const baseRaw = '{"ts":"0","event":"base"}\n';
      const shared = '{"ts":"1","event":"shared"}\n';
      const file = join(dir.root, historyPath);
      writeFileSync(file, baseRaw);
      repo.stage([historyPath]);
      repo.commit({ message: "base", author: signature }, new Date(1));
      repo.createBranch("event", "HEAD", new Date(1));
      repo.createBranch("left", "HEAD", new Date(1));
      repo.createBranch("right", "HEAD", new Date(1));
      repo.switchTo("event", new Date(2));
      writeFileSync(file, baseRaw + shared);
      repo.stage([historyPath]);
      const picked = repo.commit({ message: "shared event", author: signature }, new Date(3));
      for (const [index, branch] of ["left", "right"].entries()) {
        repo.switchTo(branch, new Date(4 + index * 3));
        writeFileSync(join(dir.root, `${branch}.txt`), branch);
        repo.stage([`${branch}.txt`]);
        repo.commit({ message: `${branch} work`, author: signature }, new Date(5 + index * 3));
        if (scenario === "cherry-pick") repo.cherryPick(picked, signature, new Date(6 + index * 3));
        else repo.merge("event", { message: "merge shared event", author: signature }, new Date(6 + index * 3));
        writeFileSync(file, baseRaw + shared + `{"ts":"${index + 2}","event":"${branch}"}\n`);
        repo.stage([historyPath]);
        repo.commit({ message: `${branch} event`, author: signature }, new Date(10 + index));
      }
      repo.switchTo("left", new Date(12));
      const merged = repo.merge("right", { message: "combine branches", author: signature }, new Date(13));
      assert.deepEqual(merged.conflicts, []);
      assert.equal(readFileSync(file, "utf8"), baseRaw + shared
        + '{"ts":"2","event":"left"}\n{"ts":"3","event":"right"}\n');
    } finally {
      dir.cleanup();
    }
  });
}

test("pm-history driver agrees on pm-written hash-chain-valid shared events", async () => {
  const sandbox = createSandbox({ mergeInstall: false, commitFence: false });
  try {
    const id = sandbox.createItem("Issue", "Shared history event");
    const history = join(sandbox.pmRoot, "history", `${id}.jsonl`);
    const item = join(sandbox.pmRoot, "issues", `${id}.toon`);
    const base = readFileSync(history, "utf8");
    sandbox.pm("comment", id, "Shared event copied to both branches");
    const shared = readFileSync(history, "utf8");
    const sharedItem = readFileSync(item);
    sandbox.pm("update", id, "--priority", "1");
    const ours = readFileSync(history, "utf8");
    writeFileSync(item, sharedItem);
    writeFileSync(history, shared);
    sandbox.pm("update", id, "--priority", "3");
    const theirs = readFileSync(history, "utf8");
    const sides = [base, ours, theirs];
    const paths = sides.map((raw, index) => {
      const path = join(sandbox.root, `side-${index}.jsonl`);
      writeFileSync(path, raw);
      return path;
    });
    for (const path of paths) assert.equal(verifyHistoryEntries(await readHistoryEntries(path, id)).ok, true);
    sandbox.pm("merge", "driver", "history", ...paths);
    const driver = await readHistoryEntries(paths[1], id);
    assert.equal(verifyHistoryEntries(driver).ok, true);
    const merged = mergeAppendOnlyLog(base.trimEnd().split("\n"), ours.trimEnd().split("\n"), theirs.trimEnd().split("\n"), "ts");
    // The CLI reanchors divergent hashes; compare event payloads, not new hashes.
    /** Compare original event payloads while excluding regenerated chain evidence. */
    const payloads = (lines: readonly string[]): unknown[] => lines.map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      delete entry.before_hash;
      delete entry.after_hash;
      delete entry.record_hash;
      delete entry.reanchor_evidence;
      return entry;
    });
    assert.deepEqual(payloads(merged), payloads(readFileSync(paths[1], "utf8").trimEnd().split("\n")));
    assert.equal(merged.length, shared.trimEnd().split("\n").length + 2);
  } finally {
    sandbox.cleanup();
  }
});
