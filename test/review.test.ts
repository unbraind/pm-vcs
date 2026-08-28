// Review state merge tests: two reviewers, two branches, one record.
//
// The acceptance criteria require that review state is a record that merges per
// field so two reviewers writing different fields concurrently never conflict,
// and that a genuinely conflicting single field is still reported as a conflict.
// These tests build real repositories with configured review record paths, fork
// branches, and merge them through the real engine — proving both properties.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";

import { type Signature } from "../engine/model.ts";
import { type RepositoryConfig } from "../engine/config.ts";
import { Repository } from "../engine/repo.ts";
import { REVIEW_CONFIG, REVIEW_PATH_PATTERN, createReviewRecord, reviewField } from "../engine/review.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

/**
 * Creates a fresh empty directory and returns its path.
 *
 * @returns The directory handle.
 */
function freshDir(): { root: string } {
  dir = makeTempDir();
  return { root: dir.root };
}

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const author: Signature = { name: "Reviewer Agent", email: "review@local", timestamp: 1_000, timezoneOffsetMinutes: 0 };

/**
 * Writes a JSON review record to the working tree.
 *
 * @param root - Repository root.
 * @param path - Relative path within the repository.
 * @param document - The review record fields.
 */
function writeReview(root: string, path: string, document: object): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Reads and parses a JSON review record from the working tree.
 *
 * @param root - Repository root.
 * @param path - Relative path within the repository.
 * @returns The parsed record document.
 */
function readReview(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

/**
 * Stages and commits one file with the given content.
 *
 * @param repo - The repository.
 * @param path - Path to stage.
 * @param content - Content to write.
 * @param message - Commit message.
 * @param now - Timestamp.
 * @returns The commit id.
 */
function commitReview(repo: Repository, path: string, content: object, message: string, now: Date): string {
  writeReview(repo.root, path, content);
  repo.stage([path]);
  return repo.commit({ message: `${message}\n`, author }, now);
}

test("two reviewers writing different fields of one review record merge cleanly", () => {
  const config: RepositoryConfig = { ...REVIEW_CONFIG };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  const reviewPath = "reviews/series-abc.json";

  // Base: a review record with series and status=pending.
  const baseRecord = createReviewRecord("series-abc-123", "pending");
  commitReview(repo, reviewPath, baseRecord, "base review", new Date(0));

  // Branch feature: reviewer 1 approves (sets status and reviewer).
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  writeReview(root, reviewPath, createReviewRecord("series-abc-123", "approved", {
    reviewer: "reviewer-1",
    approved_at: "2026-08-01T10:00:00.000Z",
  }));
  repo.stage([reviewPath]);
  repo.commit({ message: "reviewer 1 approves\n", author }, new Date(3));

  // Back on main: reviewer 2 adds a comment (different field).
  repo.switchTo("main", new Date(4));
  writeReview(root, reviewPath, createReviewRecord("series-abc-123", "pending", {
    comments: ["looks mostly good, minor nit on line 42"],
  }));
  repo.stage([reviewPath]);
  repo.commit({ message: "reviewer 2 comments\n", author }, new Date(5));

  // Merge: disjoint field changes must converge.
  const report = repo.merge("feature", { message: "merge reviews\n", author }, new Date(6));
  assert.equal(report.kind, "merged");
  assert.equal(report.clean, true, JSON.stringify(report.conflicts));

  const merged = readReview(root, reviewPath);
  assert.equal(merged.status, "approved", "reviewer 1's status change survives the merge");
  assert.equal(merged.reviewer, "reviewer-1", "reviewer 1's reviewer field survives the merge");
  assert.deepEqual(merged.comments, ["looks mostly good, minor nit on line 42"], "reviewer 2's comment survives the merge");
  assert.equal(merged.approved_at, "2026-08-01T10:00:00.000Z", "reviewer 1's timestamp survives the merge");
});

test("two reviewers adding to the reviewers set both survive the merge", () => {
  const config: RepositoryConfig = { ...REVIEW_CONFIG };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  const reviewPath = "reviews/series-set.json";

  const baseRecord = createReviewRecord("series-set-456", "pending", { reviewers: ["initial-reviewer"] });
  commitReview(repo, reviewPath, baseRecord, "base review", new Date(0));

  // Branch feature: reviewer 2 is added to the reviewers set.
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  writeReview(root, reviewPath, createReviewRecord("series-set-456", "pending", {
    reviewers: ["initial-reviewer", "reviewer-2"],
  }));
  repo.stage([reviewPath]);
  repo.commit({ message: "add reviewer 2\n", author }, new Date(3));

  // Main: reviewer 3 is added to the reviewers set (different addition, same field).
  repo.switchTo("main", new Date(4));
  writeReview(root, reviewPath, createReviewRecord("series-set-456", "pending", {
    reviewers: ["initial-reviewer", "reviewer-3"],
  }));
  repo.stage([reviewPath]);
  repo.commit({ message: "add reviewer 3\n", author }, new Date(5));

  // Merge: set strategy unions both additions.
  const report = repo.merge("feature", { message: "merge reviewers\n", author }, new Date(6));
  assert.equal(report.clean, true, JSON.stringify(report.conflicts));

  const merged = readReview(root, reviewPath);
  const reviewers = merged.reviewers as string[];
  assert.deepEqual([...reviewers].sort(), ["initial-reviewer", "reviewer-2", "reviewer-3"].sort(),
    "both reviewers' additions survive the set merge");
});

test("a genuinely conflicting scalar field is reported as a conflict while other fields still merge", () => {
  const config: RepositoryConfig = { ...REVIEW_CONFIG };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  const reviewPath = "reviews/series-conflict.json";

  const baseRecord = createReviewRecord("series-conflict-789", "pending", { verdict: "" });
  commitReview(repo, reviewPath, baseRecord, "base review", new Date(0));

  // Branch feature: reviewer 1 sets verdict to "pass".
  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  writeReview(root, reviewPath, createReviewRecord("series-conflict-789", "approved", { verdict: "pass" }));
  repo.stage([reviewPath]);
  repo.commit({ message: "verdict pass\n", author }, new Date(3));

  // Main: reviewer 2 sets verdict to "fail" (same field, different value → conflict).
  repo.switchTo("main", new Date(4));
  writeReview(root, reviewPath, createReviewRecord("series-conflict-789", "changes-requested", { verdict: "fail" }));
  repo.stage([reviewPath]);
  repo.commit({ message: "verdict fail\n", author }, new Date(5));

  // Merge: the status field conflicts (approved vs changes-requested), and the
  // verdict field conflicts (pass vs fail). Both are scalar disagreements on the
  // same field, so both must be reported as conflicts. Record conflicts are
  // advisory — the merge completes and records a commit, but reports the
  // conflicting fields so a human knows a resolution is owed. This is by design:
  // no conflict markers are ever written into a record, because markers would
  // make the record unparseable.
  const report = repo.merge("feature", { message: "merge conflicting reviews\n", author }, new Date(6));
  assert.equal(report.kind, "merged");
  assert.equal(report.clean, false, "a merge with record conflicts must not be clean");

  // At least one conflict must be on the verdict field (the genuinely conflicting
  // scalar). The status field may also conflict since both sides changed it.
  const conflictFields = report.conflicts.map((c) => c.fields ?? []).flat();
  assert.ok(conflictFields.includes("verdict"), "the verdict field must be in the conflicts");
  assert.ok(conflictFields.includes("status"), "the status field must also conflict");
});

test("the review merge policy treats approved_at as a timestamp that converges to the latest", () => {
  const config: RepositoryConfig = { ...REVIEW_CONFIG };
  const { root } = freshDir();
  const repo = Repository.init(root, "main", config);
  const reviewPath = "reviews/series-ts.json";

  const baseRecord = createReviewRecord("series-ts-000", "pending", { approved_at: "2026-08-01T00:00:00.000Z" });
  commitReview(repo, reviewPath, baseRecord, "base review", new Date(0));

  repo.createBranch("feature", "HEAD", new Date(1));
  repo.switchTo("feature", new Date(2));
  writeReview(root, reviewPath, createReviewRecord("series-ts-000", "pending", {
    approved_at: "2026-08-01T10:00:00.000Z",
    reviewer: "reviewer-1",
  }));
  repo.stage([reviewPath]);
  repo.commit({ message: "earlier approval\n", author }, new Date(3));

  repo.switchTo("main", new Date(4));
  writeReview(root, reviewPath, createReviewRecord("series-ts-000", "pending", {
    approved_at: "2026-08-01T12:00:00.000Z",
    comments: ["later review"],
  }));
  repo.stage([reviewPath]);
  repo.commit({ message: "later approval\n", author }, new Date(5));

  const report = repo.merge("feature", { message: "merge timestamps\n", author }, new Date(6));
  assert.equal(report.clean, true, JSON.stringify(report.conflicts));

  const merged = readReview(root, reviewPath);
  assert.equal(merged.approved_at, "2026-08-01T12:00:00.000Z", "the latest timestamp wins");
  assert.equal(merged.reviewer, "reviewer-1", "the reviewer field from feature survives");
  assert.deepEqual(merged.comments, ["later review"], "the comments field from main survives");
});

test("createReviewRecord omits absent optional fields so they do not appear as deletions", () => {
  const minimal = createReviewRecord("series-x", "pending");
  assert.equal(minimal.series, "series-x");
  assert.equal(minimal.status, "pending");
  assert.equal("reviewer" in minimal, false, "optional fields are absent, not undefined");
  assert.equal("comments" in minimal, false);

  const full = createReviewRecord("series-y", "approved", {
    reviewer: "reviewer-1",
    approved_at: "2026-08-01T00:00:00.000Z",
    reviewers: ["reviewer-1"],
    comments: ["looks good"],
    verdict: "pass",
  });
  assert.equal(full.reviewer, "reviewer-1");
  assert.equal(full.approved_at, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(full.reviewers, ["reviewer-1"]);
  assert.deepEqual(full.comments, ["looks good"]);
  assert.equal(full.verdict, "pass");
});

test("reviewField returns undefined for an absent field", () => {
  const doc = createReviewRecord("series-z", "pending");
  assert.equal(reviewField(doc, "series"), "series-z");
  assert.equal(reviewField(doc, "reviewer"), undefined);
  assert.equal(reviewField(doc, "comments"), undefined);
});