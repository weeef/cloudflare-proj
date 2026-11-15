/**
 * Readiness engine: decides whether each upcoming rack build has its parts.
 *
 * This is deliberately plain, deterministic code and NOT the LLM.
 * Supply math must be exact and repeatable: same inputs give the same answer
 * every time, and every number can be traced. The LLM's job (later steps) is
 * to *explain* these results and propose options, never to compute them.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────
 * 1. Sort builds by build date, then region priority (1 first). That order
 *    is the allocation policy: earlier builds get first claim on supply, and
 *    on the same day a priority-1 region beats a priority-3 region.
 * 2. For each part, line up supply lots by when they become available
 *    (on-hand stock = available now).
 * 3. Walk the builds in order. Each BOM line (part × qty × racks) draws
 *    units from the earliest lots first, like a FIFO queue.
 * 4. Grade each draw against the build date:
 *      lands ≥ BUFFER days before build      -> fine
 *      lands inside the buffer window        -> at_risk (thin buffer)
 *      unreliable supplier whose *usual* slip
 *      would push it past the buffer         -> at_risk (unreliable supplier)
 *      commit date already passed, not here  -> at_risk (overdue commit)
 *      lands after the build date            -> blocked (late commit)
 *      no lot left at all                    -> blocked (shortage)
 * 5. A build's status is its worst line: blocked > at_risk > ready.
 *
 * POLICY NOTE: a blocked build still *reserves* the late lot it is waiting
 * on (it will build late rather than not at all). The alternative, letting
 * later builds jump the queue, is exactly the kind of reallocation tradeoff
 * the weekly review proposes to a human instead of doing silently.
 *
 * SIMPLIFICATION: one global supply pool at the integrator; no regional
 * stock or transit lead times.
 */

export type Status = "ready" | "at_risk" | "blocked";

export type BuildInput = {
  build_id: string;
  region: string;
  region_priority: number;
  week: number;
  rack_type: string;
  racks: number;
  build_date: string; // YYYY-MM-DD
};

export type BomLine = {
  rack_type: string;
  part_number: string;
  qty_per_rack: number;
};

export type LotInput = {
  lot_id: number;
  supplier_id: string;
  supplier_on_time_pct: number;
  supplier_avg_slip_days: number;
  part_number: string;
  qty: number;
  status: "on_hand" | "committed";
  commit_date: string | null; // NULL for on_hand
};

export type IssueKind =
  | "shortage"
  | "late_commit"
  | "thin_buffer"
  | "unreliable_supplier"
  | "overdue_commit";

export type Issue = {
  kind: IssueKind;
  severity: Exclude<Status, "ready">;
  part_number: string;
  qty: number; // units affected
  supplier_id?: string;
  days?: number; // days late (late_commit) or days of buffer (thin_buffer)
  message: string; // human-readable, e.g. for the dashboard tooltip
};

export type BuildResult = BuildInput & {
  status: Status;
  issues: Issue[];
};

export type ReadinessConfig = {
  /** Parts should land this many days before the build starts (kitting, receiving, QA). */
  bufferDays: number;
  /**
   * Suppliers below this on-time % get a "risk-adjusted" arrival date:
   * commit date + their average slip. If that adjusted date falls inside the
   * buffer window, the build is at risk even though the commit looks fine.
   */
  unreliableOnTimePct: number;
};

export const DEFAULT_CONFIG: ReadinessConfig = {
  bufferDays: 7,
  unreliableOnTimePct: 80
};

// ── helpers ─────────────────────────────────────────────────────────────

/** Whole days from a to b (positive if b is later). Dates are YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

const SEVERITY_RANK: Record<Status, number> = {
  ready: 0,
  at_risk: 1,
  blocked: 2
};

/** Mutable working copy of a lot while we allocate from it. */
type LotState = LotInput & {
  remaining: number;
  available_date: string; // when the units can actually be used
  overdue: boolean; // commit date passed but still not received
};

// ── main entry point ────────────────────────────────────────────────────

export function assessReadiness(input: {
  asOf: string; // "today" for the check, YYYY-MM-DD
  builds: BuildInput[];
  bom: BomLine[];
  lots: LotInput[];
  config?: ReadinessConfig;
}): BuildResult[] {
  const { asOf, config = DEFAULT_CONFIG } = input;

  // Only assess builds that haven't started yet.
  const builds = input.builds
    .filter((b) => b.build_date >= asOf)
    .sort(
      (a, b) =>
        a.build_date.localeCompare(b.build_date) ||
        a.region_priority - b.region_priority ||
        a.build_id.localeCompare(b.build_id)
    );

  // BOM lookup: rack_type -> lines.
  const bomByType = new Map<string, BomLine[]>();
  for (const line of input.bom) {
    const list = bomByType.get(line.rack_type) ?? [];
    list.push(line);
    bomByType.set(line.rack_type, list);
  }

  // Supply queue per part, earliest-available first.
  const lotsByPart = new Map<string, LotState[]>();
  for (const lot of input.lots) {
    const commit = lot.commit_date ?? asOf;
    const overdue = lot.status === "committed" && commit < asOf;
    const state: LotState = {
      ...lot,
      remaining: lot.qty,
      // Overdue lots: best case they arrive today. Flagged as a risk below.
      available_date: commit < asOf ? asOf : commit,
      overdue
    };
    const list = lotsByPart.get(lot.part_number) ?? [];
    list.push(state);
    lotsByPart.set(lot.part_number, list);
  }
  for (const list of lotsByPart.values()) {
    list.sort(
      (a, b) =>
        a.available_date.localeCompare(b.available_date) || a.lot_id - b.lot_id
    );
  }

  return builds.map((build) => {
    const issues: Issue[] = [];

    for (const line of bomByType.get(build.rack_type) ?? []) {
      issues.push(
        ...allocateLine(
          build,
          line,
          lotsByPart.get(line.part_number) ?? [],
          config
        )
      );
    }

    const status = issues.reduce<Status>(
      (worst, i) =>
        SEVERITY_RANK[i.severity] > SEVERITY_RANK[worst] ? i.severity : worst,
      "ready"
    );
    return { ...build, status, issues };
  });
}

/**
 * Draw one BOM line's units from the part's lot queue and grade the draws.
 * Mutates `lots` (decrements remaining) so later builds see what's left.
 */
function allocateLine(
  build: BuildInput,
  line: BomLine,
  lots: LotState[],
  config: ReadinessConfig
): Issue[] {
  const part = line.part_number;
  let needed = line.qty_per_rack * build.racks;

  // Units grouped by problem so one part yields at most one issue per kind.
  let lateQty = 0;
  let worstLateDays = 0;
  let lateSupplier: string | undefined;
  let thinQty = 0;
  let minBufferDays = Infinity;
  let thinSupplier: string | undefined;
  const unreliable = new Map<
    string,
    { qty: number; pct: number; slip: number; adjustedLead: number }
  >();
  const overdue = new Map<string, number>();

  for (const lot of lots) {
    if (needed === 0) break;
    if (lot.remaining === 0) continue;

    const take = Math.min(lot.remaining, needed);
    lot.remaining -= take;
    needed -= take;

    // Positive = lands before build date; negative = lands after.
    const lead = daysBetween(lot.available_date, build.build_date);

    if (lead < 0) {
      lateQty += take;
      if (-lead > worstLateDays) {
        worstLateDays = -lead;
        lateSupplier = lot.supplier_id;
      }
      continue; // already blocked for these units; skip softer checks
    }
    // The buffer protects against *delivery* risk. On-hand stock is already
    // physically at the integrator, so it can't land late.
    if (lot.status === "committed" && lead < config.bufferDays) {
      thinQty += take;
      if (lead < minBufferDays) {
        minBufferDays = lead;
        thinSupplier = lot.supplier_id;
      }
    }
    if (lot.status === "committed") {
      // Risk-adjusted check: only matters if the usual slip would bite.
      const adjustedLead = lead - lot.supplier_avg_slip_days;
      if (
        lot.supplier_on_time_pct < config.unreliableOnTimePct &&
        adjustedLead < config.bufferDays
      ) {
        const u = unreliable.get(lot.supplier_id) ?? {
          qty: 0,
          pct: lot.supplier_on_time_pct,
          slip: lot.supplier_avg_slip_days,
          adjustedLead
        };
        u.qty += take;
        u.adjustedLead = Math.min(u.adjustedLead, adjustedLead);
        unreliable.set(lot.supplier_id, u);
      }
      if (lot.overdue) {
        overdue.set(
          lot.supplier_id,
          (overdue.get(lot.supplier_id) ?? 0) + take
        );
      }
    }
  }

  const issues: Issue[] = [];
  const tag = `${build.build_id}`;

  if (needed > 0) {
    issues.push({
      kind: "shortage",
      severity: "blocked",
      part_number: part,
      qty: needed,
      message: `${tag}: short ${needed} ${part}, no supply committed`
    });
  }
  if (lateQty > 0) {
    issues.push({
      kind: "late_commit",
      severity: "blocked",
      part_number: part,
      qty: lateQty,
      supplier_id: lateSupplier,
      days: worstLateDays,
      message: `${tag}: short ${lateQty} ${part} by build date; ${lateSupplier} commit lands ${worstLateDays} day${worstLateDays === 1 ? "" : "s"} after build date`
    });
  }
  if (thinQty > 0) {
    issues.push({
      kind: "thin_buffer",
      severity: "at_risk",
      part_number: part,
      qty: thinQty,
      supplier_id: thinSupplier,
      days: minBufferDays,
      message: `${tag}: ${thinQty} ${part} from ${thinSupplier} land only ${minBufferDays} day${minBufferDays === 1 ? "" : "s"} before build (need ${config.bufferDays})`
    });
  }
  for (const [supplier, u] of unreliable) {
    issues.push({
      kind: "unreliable_supplier",
      severity: "at_risk",
      part_number: part,
      qty: u.qty,
      supplier_id: supplier,
      days: u.adjustedLead,
      message:
        u.adjustedLead < 0
          ? `${tag}: ${u.qty} ${part} from ${supplier} (${u.pct}% on-time); at their usual ${u.slip}-day slip they land ${-u.adjustedLead} day${u.adjustedLead === -1 ? "" : "s"} after build date`
          : `${tag}: ${u.qty} ${part} from ${supplier} (${u.pct}% on-time); at their usual ${u.slip}-day slip only ${u.adjustedLead} day${u.adjustedLead === 1 ? "" : "s"} of buffer remain`
    });
  }
  for (const [supplier, qty] of overdue) {
    issues.push({
      kind: "overdue_commit",
      severity: "at_risk",
      part_number: part,
      qty,
      supplier_id: supplier,
      message: `${tag}: ${qty} ${part} from ${supplier} are past their commit date and not received`
    });
  }
  return issues;
}

/** Roll-up counts for dashboards and the LLM report. */
export function summarize(results: BuildResult[]) {
  const counts = { ready: 0, at_risk: 0, blocked: 0 };
  for (const r of results) counts[r.status]++;
  return { total: results.length, ...counts };
}
