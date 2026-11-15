/**
 * Allocation options for blocked builds, computed by WHAT-IF SIMULATION.
 *
 * The weekly report has to present Capacity Planning with options and
 * tradeoffs. If the LLM invented those ("move 20 switches from London") they
 * could be impossible. Instead, for every blocked build we re-run the
 * deterministic readiness engine on modified inputs and keep only options the
 * engine confirms actually work. The LLM then explains them in plain English.
 *
 * Three levers (the ones named in the role description):
 *  1. DELAY        push the build date out; find the smallest delay that
 *                  unblocks it. Impossible if nothing is committed at all.
 *  2. REALLOCATE   defer a lower-priority region's build that uses the same
 *                  part; keep it if that unblocks this build. Side effects
 *                  (other builds that get worse) are reported, not hidden.
 *  3. SHIP DIRECT  facts only: which BOM parts can ship direct to site as
 *                  L10 hardware instead of waiting for L11 integration, and
 *                  whether the short part is one of them.
 */
import {
  assessReadiness,
  type BomLine,
  type BuildInput,
  type BuildResult,
  type LotInput,
  type Status
} from "./readiness";
import { addDays } from "../db/seed";

export type PartInfo = {
  part_number: string;
  category: string;
  direct_ship_ok: number;
};

export type EngineInput = {
  asOf: string;
  builds: BuildInput[];
  bom: BomLine[];
  lots: LotInput[];
};

/** A build whose status changed because of an option (collateral impact). */
export type SideEffect = { build_id: string; from: Status; to: Status };

export type DelayOption =
  | {
      feasible: true;
      days: number;
      new_build_date: string;
      status_after: Status;
      side_effects: SideEffect[];
    }
  | { feasible: false; reason: string };

export type ReallocateOption = {
  defer_build_id: string;
  defer_region: string;
  defer_region_priority: number;
  status_after: Status;
  side_effects: SideEffect[];
};

export type BlockedBuildOptions = {
  build_id: string;
  region: string;
  region_priority: number;
  build_date: string;
  short_parts: {
    part_number: string;
    qty: number;
    kind: string;
    supplier_id?: string;
    days_late?: number;
  }[];
  delay: DelayOption;
  reallocate: ReallocateOption[];
  ship_direct: {
    short_parts_can_ship_direct: boolean;
    direct_ship_parts: string[];
  };
};

/** Longest delay we'll consider (beyond this, it is a replan, not a delay). */
const MAX_DELAY_DAYS = 42;
/** How many reallocation candidates to return per blocked build. */
const MAX_REALLOCATIONS = 2;

const RANK: Record<Status, number> = { ready: 0, at_risk: 1, blocked: 2 };

function statusMap(results: BuildResult[]) {
  return new Map(results.map((r) => [r.build_id, r.status]));
}

/** Builds (other than `except`) whose status got WORSE vs the baseline. */
function sideEffects(
  before: Map<string, Status>,
  after: BuildResult[],
  except: string[]
): SideEffect[] {
  return after
    .filter((r) => !except.includes(r.build_id))
    .filter((r) => {
      const prev = before.get(r.build_id);
      return prev !== undefined && RANK[r.status] > RANK[prev];
    })
    .map((r) => ({
      build_id: r.build_id,
      from: before.get(r.build_id)!,
      to: r.status
    }));
}

export function allocationOptions(
  input: EngineInput,
  parts: PartInfo[]
): BlockedBuildOptions[] {
  const base = assessReadiness(input);
  const baseStatus = statusMap(base);
  const directShip = new Set(
    parts.filter((p) => p.direct_ship_ok === 1).map((p) => p.part_number)
  );

  return base
    .filter((b) => b.status === "blocked")
    .map((blocked) => {
      const blockingIssues = blocked.issues.filter(
        (i) => i.severity === "blocked"
      );
      const shortParts = [...new Set(blockingIssues.map((i) => i.part_number))];
      const bomParts = input.bom
        .filter((l) => l.rack_type === blocked.rack_type)
        .map((l) => l.part_number);

      return {
        build_id: blocked.build_id,
        region: blocked.region,
        region_priority: blocked.region_priority,
        build_date: blocked.build_date,
        short_parts: blockingIssues.map((i) => ({
          part_number: i.part_number,
          qty: i.qty,
          kind: i.kind,
          supplier_id: i.supplier_id,
          days_late: i.days
        })),
        delay: delayOption(input, blocked, baseStatus),
        reallocate: reallocateOptions(input, blocked, shortParts, baseStatus),
        ship_direct: {
          short_parts_can_ship_direct: shortParts.every((p) =>
            directShip.has(p)
          ),
          direct_ship_parts: bomParts.filter((p) => directShip.has(p))
        }
      };
    });
}

/** 1. DELAY: smallest number of days that takes the build off "blocked". */
function delayOption(
  input: EngineInput,
  blocked: BuildResult,
  baseStatus: Map<string, Status>
): DelayOption {
  const noCommit = blocked.issues.find((i) => i.kind === "shortage");
  if (noCommit) {
    return {
      feasible: false,
      reason: `No supply committed for ${noCommit.qty} ${noCommit.part_number}; delaying cannot fix it. Needs a new PO or expedite.`
    };
  }
  for (let days = 1; days <= MAX_DELAY_DAYS; days++) {
    const newDate = addDays(blocked.build_date, days);
    const results = assessReadiness({
      ...input,
      builds: input.builds.map((b) =>
        b.build_id === blocked.build_id ? { ...b, build_date: newDate } : b
      )
    });
    const after = results.find((r) => r.build_id === blocked.build_id)!;
    if (after.status !== "blocked") {
      return {
        feasible: true,
        days,
        new_build_date: newDate,
        status_after: after.status,
        side_effects: sideEffects(baseStatus, results, [blocked.build_id])
      };
    }
  }
  return {
    feasible: false,
    reason: `Still blocked even after a ${MAX_DELAY_DAYS}-day delay.`
  };
}

/** 2. REALLOCATE: defer one lower-priority build that uses the short part. */
function reallocateOptions(
  input: EngineInput,
  blocked: BuildResult,
  shortParts: string[],
  baseStatus: Map<string, Status>
): ReallocateOption[] {
  const typesUsingShortPart = new Set(
    input.bom
      .filter((l) => shortParts.includes(l.part_number))
      .map((l) => l.rack_type)
  );
  const candidates = input.builds.filter(
    (d) =>
      d.build_id !== blocked.build_id &&
      d.region_priority > blocked.region_priority && // strictly less critical
      typesUsingShortPart.has(d.rack_type) &&
      baseStatus.has(d.build_id) // still upcoming
  );

  const options: ReallocateOption[] = [];
  for (const donor of candidates) {
    // "Defer" = take the donor out of this planning horizon.
    const results = assessReadiness({
      ...input,
      builds: input.builds.filter((b) => b.build_id !== donor.build_id)
    });
    const after = results.find((r) => r.build_id === blocked.build_id)!;
    if (after.status === "blocked") continue;
    options.push({
      defer_build_id: donor.build_id,
      defer_region: donor.region,
      defer_region_priority: donor.region_priority,
      status_after: after.status,
      side_effects: sideEffects(baseStatus, results, [blocked.build_id])
    });
  }
  // Best first: fewest collateral impacts, then the least critical donor.
  return options
    .sort(
      (a, b) =>
        a.side_effects.length - b.side_effects.length ||
        b.defer_region_priority - a.defer_region_priority
    )
    .slice(0, MAX_REALLOCATIONS);
}
