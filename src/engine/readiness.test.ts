/**
 * Readiness engine tests.
 *
 * Part 1: tiny hand-built scenarios, one per rule, so each rule's behaviour
 *         is pinned down exactly.
 * Part 2: the real mock dataset, asserting the designed "stories" hold
 *         (so a later data edit can't silently break the demo).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MOCK_CSVS } from "../db/data";
import { buildSeedRows, writeSeed } from "../db/seed";
import { loadEngineInput, type SqlQuery } from "./load";
import { buildsForRun, latestRun, saveRun } from "./persist";
import {
  assessReadiness,
  daysBetween,
  type BuildInput,
  type LotInput
} from "./readiness";

// ── Part 1: rule-by-rule ────────────────────────────────────────────────

const AS_OF = "2026-12-01";

// One rack type that needs 10 switches per rack.
const BOM = [{ rack_type: "T", part_number: "SW", qty_per_rack: 10 }];

function build(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    build_id: "FRA-W1-T",
    region: "FRA",
    region_priority: 1,
    week: 1,
    rack_type: "T",
    racks: 1,
    build_date: "2026-12-20",
    ...overrides
  };
}

let lotSeq = 0;
function lot(overrides: Partial<LotInput> = {}): LotInput {
  return {
    lot_id: ++lotSeq,
    supplier_id: "GOOD",
    supplier_on_time_pct: 95,
    supplier_avg_slip_days: 1,
    part_number: "SW",
    qty: 10,
    status: "committed",
    commit_date: "2026-12-05",
    ...overrides
  };
}

const run = (builds: BuildInput[], lots: LotInput[]) =>
  assessReadiness({ asOf: AS_OF, builds, bom: BOM, lots });

describe("readiness rules", () => {
  it("ready: on-hand stock covers the build", () => {
    const [r] = run([build()], [lot({ status: "on_hand", commit_date: null })]);
    expect(r.status).toBe("ready");
    expect(r.issues).toEqual([]);
  });

  it("ready: on-hand stock is never 'thin buffer', even for a build in 2 days", () => {
    const [r] = run(
      [build({ build_date: "2026-12-03" })],
      [lot({ status: "on_hand", commit_date: null })]
    );
    expect(r.status).toBe("ready");
  });

  it("ready: reliable commit lands well before the buffer", () => {
    const [r] = run([build()], [lot({ commit_date: "2026-12-05" })]); // 15 days early
    expect(r.status).toBe("ready");
  });

  it("at_risk: commit lands inside the 7-day buffer", () => {
    const [r] = run([build()], [lot({ commit_date: "2026-12-17" })]); // 3 days early
    expect(r.status).toBe("at_risk");
    expect(r.issues[0]).toMatchObject({
      kind: "thin_buffer",
      qty: 10,
      days: 3
    });
  });

  it("blocked: commit lands after the build date", () => {
    const [r] = run([build()], [lot({ commit_date: "2026-12-29" })]);
    expect(r.status).toBe("blocked");
    expect(r.issues[0]).toMatchObject({
      kind: "late_commit",
      qty: 10,
      days: 9
    });
    expect(r.issues[0].message).toContain("lands 9 days after build date");
  });

  it("blocked: no supply at all", () => {
    const [r] = run(
      [build({ racks: 2 })],
      [lot({ qty: 15, commit_date: "2026-12-01" })]
    );
    expect(r.status).toBe("blocked");
    expect(r.issues[0]).toMatchObject({ kind: "shortage", qty: 5 });
  });

  it("at_risk: unreliable supplier whose usual slip eats the buffer", () => {
    // Commit is 10 days early (fine on paper), but they usually slip 8 days.
    const [r] = run(
      [build()],
      [
        lot({
          supplier_id: "BAD",
          supplier_on_time_pct: 60,
          supplier_avg_slip_days: 8,
          commit_date: "2026-12-10"
        })
      ]
    );
    expect(r.status).toBe("at_risk");
    expect(r.issues[0]).toMatchObject({
      kind: "unreliable_supplier",
      supplier_id: "BAD",
      days: 2
    });
  });

  it("ready: unreliable supplier with enough slack to absorb their usual slip", () => {
    const [r] = run(
      [build()],
      [
        lot({
          supplier_id: "BAD",
          supplier_on_time_pct: 60,
          supplier_avg_slip_days: 3,
          commit_date: "2026-12-02"
        })
      ]
    );
    expect(r.status).toBe("ready");
  });

  it("at_risk: commit date already passed but not received", () => {
    const [r] = run([build()], [lot({ commit_date: "2026-11-25" })]);
    expect(r.status).toBe("at_risk");
    expect(r.issues[0].kind).toBe("overdue_commit");
  });

  it("allocates by date, then region priority", () => {
    // 10 switches, two builds on the same day: priority 1 wins.
    const results = run(
      [
        build({ build_id: "SEA-W1-T", region: "SEA", region_priority: 3 }),
        build({ build_id: "FRA-W1-T", region: "FRA", region_priority: 1 })
      ],
      [lot({ status: "on_hand", commit_date: null })]
    );
    const byId = Object.fromEntries(results.map((r) => [r.build_id, r.status]));
    expect(byId).toEqual({ "FRA-W1-T": "ready", "SEA-W1-T": "blocked" });
  });

  it("a blocked build still reserves the late lot it waits on", () => {
    // Early build gets nothing on time; the late lot is reserved for it, so
    // the later build that could have used that lot is short.
    const results = run(
      [
        build({ build_id: "A", build_date: "2026-12-10" }),
        build({ build_id: "B", build_date: "2026-12-30" })
      ],
      [lot({ commit_date: "2026-12-15" })]
    );
    expect(results.map((r) => [r.build_id, r.status])).toEqual([
      ["A", "blocked"],
      ["B", "blocked"]
    ]);
    expect(results[1].issues[0].kind).toBe("shortage");
  });

  it("skips builds whose date is already past", () => {
    expect(run([build({ build_date: "2026-11-30" })], [])).toEqual([]);
  });

  it("daysBetween", () => {
    expect(daysBetween("2026-12-01", "2026-12-10")).toBe(9);
    expect(daysBetween("2026-12-10", "2026-12-01")).toBe(-9);
  });
});

// ── Part 2: the mock dataset's stories ──────────────────────────────────

// Seeded on Wed 2026-11-18 -> week 1 starts Mon 2026-11-23.
const SEED_NOW = new Date("2026-11-18T12:00:00Z");

function seeded() {
  const db = new DatabaseSync(":memory:");
  writeSeed(
    (q, ...b) => {
      db.prepare(q).run(...b);
    },
    buildSeedRows(MOCK_CSVS, SEED_NOW)
  );
  const query: SqlQuery = (q, ...b) => db.prepare(q).all(...b) as never[];
  return query;
}

function mockResults() {
  const query = seeded();
  const results = assessReadiness({
    asOf: "2026-11-18",
    ...loadEngineInput(query)
  });
  return { query, results, byId: new Map(results.map((r) => [r.build_id, r])) };
}

describe("mock dataset", () => {
  it("assesses all 40 builds with a mix of statuses", () => {
    const { results } = mockResults();
    expect(results).toHaveLength(40);
    const statuses = new Set(results.map((r) => r.status));
    expect(statuses).toEqual(new Set(["ready", "at_risk", "blocked"]));
  });

  it("week 1 is fully ready (covered by stock on hand)", () => {
    const { results } = mockResults();
    expect(
      results.filter((r) => r.week === 1).every((r) => r.status === "ready")
    ).toBe(true);
  });

  it("story 1: week-3 switch shortage hits SIN and SEA, not FRA", () => {
    const { byId } = mockResults();
    for (const id of ["SIN-W3-COMPUTE", "SEA-W3-COMPUTE"]) {
      const b = byId.get(id)!;
      expect(b.status).toBe("blocked");
      expect(
        b.issues.some(
          (i) => i.part_number === "SW-TOR-100G" && i.kind === "late_commit"
        )
      ).toBe(true);
    }
    expect(byId.get("FRA-W3-COMPUTE")!.status).not.toBe("blocked");
  });

  it("story 2: AMS wk6 is bumped by a late Lumora optics commit", () => {
    const { byId } = mockResults();
    const b = byId.get("AMS-W6-STORAGE")!;
    expect(b.status).toBe("blocked");
    expect(b.issues).toContainEqual(
      expect.objectContaining({
        kind: "late_commit",
        part_number: "OPT-100G-SR4",
        supplier_id: "LUM"
      })
    );
  });

  it("story 3: week-8 optics demand has no commit at all", () => {
    const { byId } = mockResults();
    expect(byId.get("SIN-W8-EDGE")!.issues).toContainEqual(
      expect.objectContaining({ kind: "shortage", part_number: "OPT-100G-SR4" })
    );
  });

  it("saves a run and reads it back", () => {
    const { query, results } = mockResults();
    const saved = saveRun(query, results, {
      runAt: "2026-11-18T06:00:00Z",
      asOf: "2026-11-18",
      trigger: "daily"
    });
    expect(saved.run_id).toBe(1);
    expect(saved.total).toBe(40);
    expect(latestRun(query)).toEqual(saved);
    const rows = buildsForRun(query, saved.run_id);
    expect(rows).toHaveLength(40);
    expect(
      rows.find((r) => r.build_id === "SIN-W3-COMPUTE")!.issues.length
    ).toBeGreaterThan(0);
  });
});
