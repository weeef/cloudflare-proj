/**
 * Loads engine inputs from SQLite.
 *
 * `query` is injected (same pattern as db/seed.ts): in the Durable Object it
 * wraps ctx.storage.sql.exec(...).toArray(), in tests it wraps node:sqlite.
 * The engine itself never touches the database, which keeps it pure.
 */
import type { BomLine, BuildInput, LotInput } from "./readiness";

export type SqlQuery = <T>(
  query: string,
  ...bindings: (string | number | null)[]
) => T[];

/**
 * @param opts.asOriginallyPromised use each lot's ORIGINAL commit date instead
 *   of the current one, i.e. the supply picture before any supplier slipped.
 *   Used to reconstruct a "last week" baseline for the demo.
 */
export function loadEngineInput(
  query: SqlQuery,
  opts: { asOriginallyPromised?: boolean } = {}
) {
  const commitCol = opts.asOriginallyPromised
    ? "s.original_commit_date"
    : "s.commit_date";

  // Forecast joined to region priority (the allocation tiebreaker).
  const builds = query<BuildInput>(
    `SELECT f.build_id, f.region, r.priority AS region_priority, f.week,
            f.rack_type, f.racks, f.build_date
     FROM forecast f JOIN regions r ON r.code = f.region`
  );

  const bom = query<BomLine>(
    `SELECT rack_type, part_number, qty_per_rack FROM bom`
  );

  // Supply lots joined to supplier on-time % and average slip (the
  // risk-adjusted reliability check).
  const lots = query<LotInput>(
    `SELECT s.lot_id, s.supplier_id, sup.on_time_pct AS supplier_on_time_pct,
            sup.avg_slip_days AS supplier_avg_slip_days,
            s.part_number, s.qty, s.status, ${commitCol} AS commit_date
     FROM supply s JOIN suppliers sup ON sup.supplier_id = s.supplier_id`
  );

  return { builds, bom, lots };
}
