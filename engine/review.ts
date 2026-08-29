// Review state as a native record.
//
// Forgejo's insight is that project metadata belongs inside the repository. A
// review is a record — not a row in an attached database — and because records
// merge per field, two reviewers writing different fields concurrently converge
// instead of conflicting. Only a genuine disagreement on the same field is
// reported as a conflict, and it conflicts alone rather than taking the document
// with it.
//
// This module defines the review record shape, its field merge strategies, and
// helpers for constructing and reading review records. The merge itself is done
// by the existing record merge infrastructure (`engine/records.ts`); this module
// provides the vocabulary and the policy that make a review a review.

import { type RecordDocument, type RecordValue } from "./model.ts";
import { type MergePolicy, type FieldStrategy } from "./records.ts";

/** Glob pattern for paths that hold review records. */
export const REVIEW_PATH_PATTERN = "reviews/*.json";

/** Field names a review record carries. */
export const REVIEW_FIELDS = [
  "series",
  "status",
  "reviewer",
  "approved_at",
  "reviewers",
  "comments",
  "verdict",
] as const;

/** The status of a review, tracking its lifecycle from proposal to resolution. */
export const REVIEW_STATUSES = ["pending", "approved", "changes-requested", "rejected"] as const;

/** One field name from the review record vocabulary. */
export type ReviewField = (typeof REVIEW_FIELDS)[number];

/**
 * Merge strategies for each review field.
 *
 * Two reviewers writing different fields never conflict: `reviewer` and
 * `approved_at` are scalar (one side's change wins when only one side touched
 * them), `reviewers` is a set (both sides' additions survive, de-duplicated),
 * `comments` is a sequence (both sides' additions survive in order), and
 * `status` is a scalar (a genuine disagreement on the same field conflicts
 * alone). The `series` field identifies which patch series the review is for and
 * is scalar so two branches that agree on the series converge.
 */
export const REVIEW_MERGE_POLICY: MergePolicy = {
  fields: {
    series: "scalar" as FieldStrategy,
    status: "scalar" as FieldStrategy,
    reviewer: "scalar" as FieldStrategy,
    approved_at: "timestamp" as FieldStrategy,
    reviewers: "set" as FieldStrategy,
    comments: "sequence" as FieldStrategy,
    verdict: "scalar" as FieldStrategy,
  },
};

/** Repository configuration that treats review paths as records with review merge policy. */
export const REVIEW_CONFIG = {
  recordPaths: [REVIEW_PATH_PATTERN],
  recordPolicy: REVIEW_MERGE_POLICY,
} as const;

/**
 * Creates a review record document from the given fields.
 *
 * Only `series` and `status` are required; other fields are optional and
 * omitted when not provided, which is what lets two branches that each set a
 * different subset of fields merge cleanly — a field absent on one side is a
 * field that side did not touch, not a field that side deleted.
 *
 * @param series - The patch series object id this review is for.
 * @param status - The initial review status.
 * @param fields - Optional additional fields (reviewer, approved_at, reviewers, comments, verdict).
 * @returns A record document suitable for storage as a pm-vcs record object.
 */
export function createReviewRecord(
  series: string,
  status: (typeof REVIEW_STATUSES)[number],
  fields?: Partial<Pick<RecordDocument, Exclude<ReviewField, "series" | "status">>>,
): RecordDocument {
  const document: Record<string, RecordValue> = { series, status };
  for (const field of ["reviewer", "approved_at", "reviewers", "comments", "verdict"] as const) {
    const value = fields?.[field];
    if (value !== undefined) document[field] = value;
  }
  return document;
}

/**
 * Reads a field from a review record, returning undefined when absent.
 *
 * @param document - The review record.
 * @param field - The field to read.
 * @returns The field's value, or undefined.
 */
export function reviewField(document: RecordDocument, field: ReviewField): RecordValue | undefined {
  return document[field];
}