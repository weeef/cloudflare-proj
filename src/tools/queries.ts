/**
 * Read-only queries behind the chat agent's tools.
 *
 * WHY THIS LAYER EXISTS
 * The LLM never writes SQL and never does supply math. It picks a tool and
 * fills in a few simple parameters; these functions do the exact work and
 * return compact JSON the model can summarise. That keeps answers grounded
 * in the data and stops the model inventing numbers.
 *
 * DESIGN RULES FOR LLM-FACING OUTPUT
 *  - Small: Llama 3.3's context is limited, so lists are capped and issues
 *    are reduced to their one-line messages.
 *  - Self-describing: field names a human would understand, dates included.
 *  - Forgiving input: "fra", "Frankfurt" and "FRA" all resolve to FRA.
 *
 * Same injected-`query` pattern as the engine, so it's tested on node:sqlite.
 */
import type { SqlQuery } from "../engine/load";
import {
  buildsForRun,
  latestRun,
  type RunSummary,
  type StoredBuildStatus
} from "../engine/persist";
import type { Status } from "../engine/readiness";
import { getReview, listReviews } from "../review/store";

export type Geo = "EU" | "APAC" | "NA";

/** Cap on rows returned to the model in one tool call. */
const MAX_ROWS = 25;

type RegionRow = { code: string; name: string; geo: Geo; priority: number };

function regions(query: SqlQuery): RegionRow[] {
  return query<RegionRow>(`SELECT code, name, geo, priority FROM regions`);
}

/** Resolve "fra" / "Frankfurt" / "FRA" to a region code, or null. */
export function resolveRegion(query: SqlQuery, input: string): string | null {
  const needle = input.trim().toLowerCase();
  const match = regions(query).find(
    (r) => r.code.toLowerCase() === needle || r.name.toLowerCase() === needle
  );
  return match?.code ?? null;
}

/** Latest run + its builds, or a clear message the model can relay. */
function latest(query: SqlQuery) {
  const run = latestRun(query);
  if (!run) return null;
  return { run, builds: buildsForRun(query, run.run_id) };
}

const NO_DATA = {
  error: "No readiness check has run yet. Ask the user to run one."
};

/** Week number -> date range, so the model can map "next month" to weeks. */
export function weekCalendar(query: SqlQuery) {
  return query<{ week: number; build_date: string }>(
    `SELECT DISTINCT week, build_date FROM forecast ORDER BY week`
  );
}

// ── 1. overview ─────────────────────────────────────────────────────────

export function readinessOverview(query: SqlQuery) {
  const data = latest(query);
  if (!data) return NO_DATA;
  const geoOf = new Map(regions(query).map((r) => [r.code, r.geo]));

  const blank = () => ({ ready: 0, at_risk: 0, blocked: 0 });
  const byGeo: Record<string, ReturnType<typeof blank>> = {};
  const byWeek: Record<string, ReturnType<typeof blank>> = {};
  // Units short (blocked issues only), grouped by part.
  const constrained = new Map<
    string,
    { units_short: number; builds: Set<string> }
  >();

  for (const b of data.builds) {
    const geo = geoOf.get(b.region) ?? "?";
    (byGeo[geo] ??= blank())[b.status]++;
    (byWeek[`W${b.week}`] ??= blank())[b.status]++;
    for (const i of b.issues) {
      if (i.severity !== "blocked") continue;
      const c = constrained.get(i.part_number) ?? {
        units_short: 0,
        builds: new Set()
      };
      c.units_short += i.qty;
      c.builds.add(b.build_id);
      constrained.set(i.part_number, c);
    }
  }

  return {
    as_of: data.run.as_of,
    checked_at: data.run.run_at,
    totals: pick(data.run, ["total", "ready", "at_risk", "blocked"]),
    by_geo: byGeo,
    by_week: byWeek,
    most_constrained_parts: [...constrained.entries()]
      .map(([part, c]) => ({
        part_number: part,
        units_short: c.units_short,
        blocked_builds: c.builds.size
      }))
      .sort((a, b) => b.units_short - a.units_short),
    week_calendar: weekCalendar(query)
  };
}

// ── 2. problem builds ───────────────────────────────────────────────────

export function listProblemBuilds(
  query: SqlQuery,
  filter: {
    geo?: Geo;
    region?: string;
    fromWeek?: number;
    toWeek?: number;
    severity?: "blocked" | "at_risk" | "both";
  }
) {
  const data = latest(query);
  if (!data) return NO_DATA;

  let regionCode: string | null = null;
  if (filter.region) {
    regionCode = resolveRegion(query, filter.region);
    if (!regionCode) {
      return {
        error: `Unknown region "${filter.region}".`,
        valid_regions: regions(query).map((r) => `${r.code} (${r.name})`)
      };
    }
  }
  const geoOf = new Map(regions(query).map((r) => [r.code, r.geo]));
  const wanted: Status[] =
    filter.severity === "blocked"
      ? ["blocked"]
      : filter.severity === "at_risk"
        ? ["at_risk"]
        : ["blocked", "at_risk"];

  const matches = data.builds.filter(
    (b) =>
      wanted.includes(b.status) &&
      (!filter.geo || geoOf.get(b.region) === filter.geo) &&
      (!regionCode || b.region === regionCode) &&
      (filter.fromWeek === undefined || b.week >= filter.fromWeek) &&
      (filter.toWeek === undefined || b.week <= filter.toWeek)
  );

  // Blocked first, then by week, so truncation drops the least urgent.
  matches.sort(
    (a, b) =>
      (a.status === "blocked" ? 0 : 1) - (b.status === "blocked" ? 0 : 1) ||
      a.week - b.week
  );

  return {
    as_of: data.run.as_of,
    filter,
    match_count: matches.length,
    truncated: matches.length > MAX_ROWS,
    builds: matches.slice(0, MAX_ROWS).map(compactBuild)
  };
}

function compactBuild(b: StoredBuildStatus) {
  return {
    build_id: b.build_id,
    region: b.region,
    week: b.week,
    build_date: b.build_date,
    rack_type: b.rack_type,
    racks: b.racks,
    status: b.status,
    // Message text already starts with the build id; strip it to save tokens.
    issues: b.issues.map((i) => i.message.replace(`${b.build_id}: `, ""))
  };
}

// ── 3. build detail ─────────────────────────────────────────────────────

export function buildDetail(query: SqlQuery, buildId: string) {
  const data = latest(query);
  if (!data) return NO_DATA;
  const id = buildId.trim().toUpperCase();
  const b = data.builds.find((x) => x.build_id === id);
  if (!b) {
    return {
      error: `No upcoming build "${buildId}". IDs look like FRA-W3-COMPUTE.`,
      example_ids: data.builds.slice(0, 5).map((x) => x.build_id)
    };
  }
  const [region] = query<RegionRow>(
    `SELECT code, name, geo, priority FROM regions WHERE code = ?`,
    b.region
  );
  const bom = query<{
    part_number: string;
    description: string;
    qty_per_rack: number;
    direct_ship_ok: number;
  }>(
    `SELECT b.part_number, p.description, b.qty_per_rack, p.direct_ship_ok
     FROM bom b JOIN parts p ON p.part_number = b.part_number
     WHERE b.rack_type = ? ORDER BY b.part_number`,
    b.rack_type
  );
  return {
    ...compactBuild(b),
    region_name: region?.name,
    region_priority: region?.priority,
    issues_detail: b.issues,
    bill_of_materials: bom.map((l) => ({
      part_number: l.part_number,
      description: l.description,
      required_qty: l.qty_per_rack * b.racks,
      can_ship_direct: l.direct_ship_ok === 1
    }))
  };
}

// ── 4. supplier scorecard ───────────────────────────────────────────────

export function supplierScorecard(query: SqlQuery) {
  const data = latest(query);
  const suppliers = query<{
    supplier_id: string;
    name: string;
    country: string;
    on_time_pct: number;
    avg_slip_days: number;
  }>(`SELECT * FROM suppliers`);

  // Commitment history: how many open commits, how many slipped, by how much.
  const commits = query<{
    supplier_id: string;
    open_commits: number;
    slipped_commits: number;
    total_slip_days: number;
    max_slip_days: number;
    parts: string;
  }>(
    `SELECT supplier_id,
            COUNT(*) AS open_commits,
            SUM(CASE WHEN commit_date > original_commit_date THEN 1 ELSE 0 END) AS slipped_commits,
            CAST(SUM(MAX(julianday(commit_date) - julianday(original_commit_date), 0)) AS INTEGER) AS total_slip_days,
            CAST(MAX(julianday(commit_date) - julianday(original_commit_date)) AS INTEGER) AS max_slip_days,
            GROUP_CONCAT(DISTINCT part_number) AS parts
     FROM supply WHERE status = 'committed'
     GROUP BY supplier_id`
  );
  const commitsBy = new Map(commits.map((c) => [c.supplier_id, c]));

  // Impact in the latest readiness run: builds whose issues name the supplier.
  const impact = new Map<
    string,
    { blocked: Set<string>; at_risk: Set<string> }
  >();
  for (const b of data?.builds ?? []) {
    for (const i of b.issues) {
      if (!i.supplier_id) continue;
      const m = impact.get(i.supplier_id) ?? {
        blocked: new Set(),
        at_risk: new Set()
      };
      m[i.severity].add(b.build_id);
      impact.set(i.supplier_id, m);
    }
  }

  return {
    as_of: data?.run.as_of ?? null,
    note: "Ranked by builds affected in the latest check, then total slip days. A late_commit issue names the supplier of the lot the build is waiting on; slip history shows root cause.",
    suppliers: suppliers
      .map((s) => {
        const c = commitsBy.get(s.supplier_id);
        const m = impact.get(s.supplier_id);
        return {
          supplier_id: s.supplier_id,
          name: s.name,
          country: s.country,
          parts: c?.parts.split(",") ?? [],
          on_time_pct: s.on_time_pct,
          avg_slip_days: s.avg_slip_days,
          open_commits: c?.open_commits ?? 0,
          slipped_commits: c?.slipped_commits ?? 0,
          total_slip_days: c?.total_slip_days ?? 0,
          max_slip_days: Math.max(c?.max_slip_days ?? 0, 0),
          builds_blocked: m?.blocked.size ?? 0,
          builds_at_risk: m?.at_risk.size ?? 0
        };
      })
      .sort(
        (a, b) =>
          b.builds_blocked - a.builds_blocked ||
          b.builds_at_risk - a.builds_at_risk ||
          b.total_slip_days - a.total_slip_days
      )
  };
}

// ── 5. what changed ─────────────────────────────────────────────────────

/**
 * Compare the latest run against a baseline about a week older: the most
 * recent run at least 6 days before the latest one, else the oldest run.
 */
export function whatChanged(query: SqlQuery) {
  const latestR = latestRun(query);
  if (!latestR) return NO_DATA;
  // Prefer the newest run that is at least 6 days older than the latest...
  const [weekOld] = query<RunSummary>(
    `SELECT * FROM readiness_runs
     WHERE julianday(?) - julianday(run_at) >= 6
     ORDER BY run_id DESC LIMIT 1`,
    latestR.run_at
  );
  // ...otherwise fall back to the oldest other run.
  const [oldest] = query<RunSummary>(
    `SELECT * FROM readiness_runs WHERE run_id <> ? ORDER BY run_id ASC LIMIT 1`,
    latestR.run_id
  );
  const baseline = weekOld ?? oldest;
  if (!baseline) {
    return {
      error:
        "Only one readiness check exists, so there is nothing to compare yet."
    };
  }

  const before = new Map(
    buildsForRun(query, baseline.run_id).map((b) => [b.build_id, b])
  );
  const after = buildsForRun(query, latestR.run_id);

  const changes = after
    .filter(
      (b) =>
        before.has(b.build_id) && before.get(b.build_id)!.status !== b.status
    )
    .map((b) => ({
      ...compactBuild(b),
      previous_status: before.get(b.build_id)!.status,
      direction:
        rank(b.status) > rank(before.get(b.build_id)!.status)
          ? "worse"
          : "better"
    }));

  // Supplier slips are the usual root cause; include them for context.
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
     ORDER BY slip_days DESC`
  );

  return {
    baseline: pick(baseline, [
      "run_id",
      "run_at",
      "trigger",
      "ready",
      "at_risk",
      "blocked"
    ]),
    latest: pick(latestR, [
      "run_id",
      "run_at",
      "trigger",
      "ready",
      "at_risk",
      "blocked"
    ]),
    baseline_note:
      baseline.trigger === "baseline"
        ? "Baseline is a reconstructed snapshot from suppliers' original commit dates (before slips)."
        : undefined,
    delta: {
      ready: latestR.ready - baseline.ready,
      at_risk: latestR.at_risk - baseline.at_risk,
      blocked: latestR.blocked - baseline.blocked
    },
    changed_builds: changes.slice(0, MAX_ROWS),
    changed_count: changes.length,
    supplier_commit_slips: slips
  };
}

const rank = (s: Status) => ({ ready: 0, at_risk: 1, blocked: 2 })[s];

function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]])) as Pick<T, K>;
}

// ── 6. weekly reviews (long-term memory) ────────────────────────────────

/**
 * A past weekly review: the report that went to leadership and what was
 * decided. Together with chat history and run history, this is how the
 * agent "remembers" previous weeks.
 */
export function weeklyReview(query: SqlQuery, which: "latest" | "previous") {
  const reviews = listReviews(query, 2);
  const pick = which === "previous" ? reviews[1] : reviews[0];
  if (!pick) {
    return {
      error:
        which === "previous"
          ? "There is no earlier weekly review yet."
          : "No weekly review has been run yet. The user can start one from the dashboard."
    };
  }
  const r = getReview(query, pick.review_id)!;
  return {
    review_id: r.review_id,
    created_at: r.created_at,
    status: r.status,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    report_markdown: r.report_md ?? "(report still being drafted)",
    supplier_emails: r.emails.map((e) => ({
      supplier: e.supplier_name,
      subject: e.subject,
      status: e.status
    }))
  };
}
