/**
 * Saves and reads readiness runs.
 *
 * Same injected-`query` pattern as load.ts, so it runs against the Durable
 * Object's SQLite in production and node:sqlite in tests.
 */
import type { SqlQuery } from "./load";
import {
  summarize,
  type BuildResult,
  type Issue,
  type Status
} from "./readiness";

/**
 * seed     = first check after loading data
 * baseline = reconstructed "last week" snapshot (see agent.ts seed())
 * daily    = cron schedule
 * manual   = "run check now" button / chat request
 * weekly   = fresh check at the start of a weekly review workflow
 */
export type RunTrigger = "seed" | "baseline" | "daily" | "manual" | "weekly";

export type RunSummary = {
  run_id: number;
  run_at: string;
  as_of: string;
  trigger: RunTrigger;
  total: number;
  ready: number;
  at_risk: number;
  blocked: number;
};

/** Insert one run + its per-build rows. Returns the stored summary. */
export function saveRun(
  query: SqlQuery,
  results: BuildResult[],
  meta: { runAt: string; asOf: string; trigger: RunTrigger }
): RunSummary {
  const s = summarize(results);
  // RETURNING gives us the auto-generated run_id in the same statement.
  const [run] = query<RunSummary>(
    `INSERT INTO readiness_runs (run_at, as_of, trigger, total, ready, at_risk, blocked)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    meta.runAt,
    meta.asOf,
    meta.trigger,
    s.total,
    s.ready,
    s.at_risk,
    s.blocked
  );
  for (const r of results) {
    query(
      `INSERT INTO build_status
         (run_id, build_id, region, week, rack_type, racks, build_date, status, issues_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.run_id,
      r.build_id,
      r.region,
      r.week,
      r.rack_type,
      r.racks,
      r.build_date,
      r.status,
      JSON.stringify(r.issues)
    );
  }
  return run;
}

export type StoredBuildStatus = {
  build_id: string;
  region: string;
  week: number;
  rack_type: string;
  racks: number;
  build_date: string;
  status: Status;
  issues: Issue[];
};

/** Most recent run, or null if none has run yet. */
export function latestRun(query: SqlQuery): RunSummary | null {
  return (
    query<RunSummary>(
      `SELECT * FROM readiness_runs ORDER BY run_id DESC LIMIT 1`
    )[0] ?? null
  );
}

/** Per-build rows for a run, ordered for display (week, then region). */
export function buildsForRun(
  query: SqlQuery,
  runId: number
): StoredBuildStatus[] {
  return query<Omit<StoredBuildStatus, "issues"> & { issues_json: string }>(
    `SELECT build_id, region, week, rack_type, racks, build_date, status, issues_json
     FROM build_status WHERE run_id = ? ORDER BY week, region, rack_type`,
    runId
  ).map(({ issues_json, ...rest }) => ({
    ...rest,
    issues: JSON.parse(issues_json) as Issue[]
  }));
}
