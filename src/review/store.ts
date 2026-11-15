/**
 * Database access for weekly reviews (the approval queue).
 *
 * Status lifecycle, driven by the Workflow (src/workflows/weekly-review.ts):
 *
 *   drafting -> pending_approval -> approved
 *                                -> rejected
 *                                -> expired   (nobody decided within 7 days)
 *   (any)    -> failed            (workflow errored)
 *
 * Every write is guarded by the expected current status, so a retried
 * workflow step or a double-clicked button can't move a review backwards.
 */
import type { SqlQuery } from "../engine/load";
import type { ReviewFacts } from "./facts";

export type ReviewStatus =
  | "drafting"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "failed";

export type EmailDraft = {
  supplier_id: string;
  supplier_name: string;
  subject: string;
  body: string;
  /** draft -> approved (ready to send; this demo never really sends) | discarded */
  status: "draft" | "approved" | "discarded";
};

export type Review = {
  review_id: number;
  workflow_id: string;
  created_at: string;
  trigger: string;
  run_id: number | null;
  status: ReviewStatus;
  facts: ReviewFacts | null;
  report_md: string | null;
  report_source: "llm" | "fallback" | null;
  emails: EmailDraft[];
  decided_at: string | null;
  decision_note: string | null;
};

type Row = Omit<Review, "facts" | "emails"> & {
  facts_json: string | null;
  emails_json: string | null;
};

const toReview = ({ facts_json, emails_json, ...r }: Row): Review => ({
  ...r,
  facts: facts_json ? JSON.parse(facts_json) : null,
  emails: emails_json ? JSON.parse(emails_json) : []
});

/**
 * Create the review row BEFORE the workflow starts (the agent picks the
 * workflow id), so a second "run review" click immediately sees an open
 * review. Idempotent on workflow_id.
 */
export function createReview(
  query: SqlQuery,
  r: { workflowId: string; trigger: string }
): Review {
  query(
    `INSERT INTO weekly_reviews (workflow_id, created_at, trigger, status)
     VALUES (?, ?, ?, 'drafting')
     ON CONFLICT (workflow_id) DO NOTHING`,
    r.workflowId,
    new Date().toISOString(),
    r.trigger
  );
  return getReviewByWorkflow(query, r.workflowId)!;
}

/** Step 1 of the workflow: record which readiness run + facts it used. */
export function attachFacts(
  query: SqlQuery,
  workflowId: string,
  runId: number,
  facts: ReviewFacts
) {
  query(
    `UPDATE weekly_reviews SET run_id = ?, facts_json = ?
     WHERE workflow_id = ? AND status = 'drafting'`,
    runId,
    JSON.stringify(facts),
    workflowId
  );
}

export function saveDraft(
  query: SqlQuery,
  workflowId: string,
  draft: {
    reportMd: string;
    reportSource: "llm" | "fallback";
    emails: EmailDraft[];
  }
): Review | null {
  query(
    `UPDATE weekly_reviews
     SET report_md = ?, report_source = ?, emails_json = ?, status = 'pending_approval'
     WHERE workflow_id = ? AND status = 'drafting'`,
    draft.reportMd,
    draft.reportSource,
    JSON.stringify(draft.emails),
    workflowId
  );
  return getReviewByWorkflow(query, workflowId);
}

/** Final decision. Emails follow the decision: approved or discarded. */
export function decide(
  query: SqlQuery,
  workflowId: string,
  status: "approved" | "rejected" | "expired" | "failed",
  note?: string
): Review | null {
  const review = getReviewByWorkflow(query, workflowId);
  if (!review) return null;
  const from: ReviewStatus[] =
    status === "failed"
      ? ["drafting", "pending_approval"]
      : ["pending_approval"];
  if (!from.includes(review.status)) return review; // already decided: no-op

  const emails = review.emails.map((e) => ({
    ...e,
    status:
      status === "approved" ? ("approved" as const) : ("discarded" as const)
  }));
  query(
    `UPDATE weekly_reviews
     SET status = ?, decided_at = ?, decision_note = ?, emails_json = ?
     WHERE workflow_id = ?`,
    status,
    new Date().toISOString(),
    note ?? null,
    JSON.stringify(emails),
    workflowId
  );
  return getReviewByWorkflow(query, workflowId);
}

export function getReviewByWorkflow(query: SqlQuery, workflowId: string) {
  const [row] = query<Row>(
    `SELECT * FROM weekly_reviews WHERE workflow_id = ?`,
    workflowId
  );
  return row ? toReview(row) : null;
}

export function getReview(query: SqlQuery, reviewId: number) {
  const [row] = query<Row>(
    `SELECT * FROM weekly_reviews WHERE review_id = ?`,
    reviewId
  );
  return row ? toReview(row) : null;
}

/** Newest first, without the bulky facts (for lists and the approval queue). */
export function listReviews(query: SqlQuery, limit = 10) {
  return query<Row>(
    `SELECT * FROM weekly_reviews ORDER BY review_id DESC LIMIT ?`,
    limit
  ).map((row) => {
    const { facts: _, ...rest } = toReview(row);
    return rest;
  });
}

/** A review still in flight (drafting or awaiting a decision), if any. */
export function openReview(query: SqlQuery) {
  const [row] = query<Row>(
    `SELECT * FROM weekly_reviews
     WHERE status IN ('drafting', 'pending_approval')
     ORDER BY review_id DESC LIMIT 1`
  );
  return row ? toReview(row) : null;
}
