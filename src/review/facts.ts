/**
 * The "facts pack" for the weekly shortage review.
 *
 * Everything the LLM is allowed to say comes from this object, built by
 * deterministic code: readiness totals, what changed vs last week, every
 * blocked build with engine-verified options, and which suppliers to
 * escalate (with their slipped commits). The LLM's job is narrative and
 * judgement on top of these facts, not arithmetic.
 *
 * The same object is stored with the review, so anyone can audit exactly
 * what the model was given.
 */
import type { SqlQuery } from "../engine/load";
import { loadEngineInput } from "../engine/load";
import { allocationOptions, type PartInfo } from "../engine/options";
import {
  readinessOverview,
  supplierScorecard,
  whatChanged
} from "../tools/queries";

export function buildReviewFacts(query: SqlQuery, asOf: string) {
  const overview = readinessOverview(query);
  if ("error" in overview) throw new Error(overview.error);

  const changed = whatChanged(query);
  const parts = query<PartInfo>(
    `SELECT part_number, category, direct_ship_ok FROM parts`
  );
  const options = allocationOptions({ asOf, ...loadEngineInput(query) }, parts);

  // Escalate suppliers that have slipped commits AND are hurting builds now.
  // (A reliable supplier whose on-time lot is simply next in the queue, like
  // Orbit, is not at fault and does not get an escalation email.)
  const scorecard = supplierScorecard(query).suppliers;
  const slips = query<{
    supplier_id: string;
    part_number: string;
    qty: number;
    original_commit_date: string;
    commit_date: string;
    slip_days: number;
  }>(
    `SELECT supplier_id, part_number, qty, original_commit_date, commit_date,
            CAST(julianday(commit_date) - julianday(original_commit_date) AS INTEGER) AS slip_days
     FROM supply
     WHERE status = 'committed' AND commit_date > original_commit_date
     ORDER BY supplier_id, commit_date`
  );
  const escalations = scorecard
    .filter(
      (s) => s.slipped_commits > 0 && s.builds_blocked + s.builds_at_risk > 0
    )
    .map((s) => ({
      supplier_id: s.supplier_id,
      name: s.name,
      country: s.country,
      parts: s.parts,
      on_time_pct: s.on_time_pct,
      avg_slip_days: s.avg_slip_days,
      builds_blocked: s.builds_blocked,
      builds_at_risk: s.builds_at_risk,
      slipped_commits: slips
        .filter((x) => x.supplier_id === s.supplier_id)
        .map(({ supplier_id: _, ...rest }) => rest),
      // Blocked builds whose shortage is in a part this supplier makes.
      blocked_builds_on_their_parts: options
        .filter((o) =>
          o.short_parts.some((p) => s.parts.includes(p.part_number))
        )
        .map((o) => o.build_id)
    }));

  return {
    as_of: asOf,
    totals: overview.totals,
    by_geo: overview.by_geo,
    most_constrained_parts: overview.most_constrained_parts,
    change_vs_last_week:
      "error" in changed
        ? null
        : {
            baseline_date: changed.baseline.run_at.slice(0, 10),
            baseline_is_reconstructed: changed.baseline.trigger === "baseline",
            delta: changed.delta,
            builds_worse: changed.changed_builds
              .filter((b) => b.direction === "worse")
              .map((b) => `${b.build_id}: ${b.previous_status} -> ${b.status}`),
            builds_better: changed.changed_builds
              .filter((b) => b.direction === "better")
              .map((b) => `${b.build_id}: ${b.previous_status} -> ${b.status}`)
          },
    blocked_builds: options,
    supplier_escalations: escalations
  };
}

export type ReviewFacts = ReturnType<typeof buildReviewFacts>;
export type SupplierEscalation = ReviewFacts["supplier_escalations"][number];
