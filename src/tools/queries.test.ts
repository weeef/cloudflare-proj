/**
 * Tests for the chat tools' query layer, on the real mock dataset.
 * Mirrors what the agent does at seed time: a reconstructed baseline run
 * (original commit dates, 7 days earlier) followed by today's run.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MOCK_CSVS } from "../db/data";
import { buildSeedRows, writeSeed } from "../db/seed";
import { loadEngineInput, type SqlQuery } from "../engine/load";
import { saveRun } from "../engine/persist";
import { assessReadiness } from "../engine/readiness";
import { createChatTools } from "./chat-tools";
import {
  buildDetail,
  listProblemBuilds,
  readinessOverview,
  resolveRegion,
  supplierScorecard,
  whatChanged
} from "./queries";

let query: SqlQuery;

function seed(withRuns = true) {
  const db = new DatabaseSync(":memory:");
  writeSeed(
    (q, ...b) => {
      db.prepare(q).run(...b);
    },
    buildSeedRows(MOCK_CSVS, new Date("2026-11-18T12:00:00Z"))
  );
  query = (q, ...b) => db.prepare(q).all(...b) as never[];
  if (!withRuns) return;
  const baseline = assessReadiness({
    asOf: "2026-11-11",
    ...loadEngineInput(query, { asOriginallyPromised: true })
  });
  saveRun(query, baseline, {
    runAt: "2026-11-11T12:00:00Z",
    asOf: "2026-11-11",
    trigger: "baseline"
  });
  const today = assessReadiness({
    asOf: "2026-11-18",
    ...loadEngineInput(query)
  });
  saveRun(query, today, {
    runAt: "2026-11-18T12:00:00Z",
    asOf: "2026-11-18",
    trigger: "seed"
  });
}

beforeEach(() => seed());

describe("resolveRegion", () => {
  it("accepts code, lowercase code, or city name", () => {
    expect(resolveRegion(query, "FRA")).toBe("FRA");
    expect(resolveRegion(query, "fra")).toBe("FRA");
    expect(resolveRegion(query, " Frankfurt ")).toBe("FRA");
    expect(resolveRegion(query, "Paris")).toBeNull();
  });
});

describe("readinessOverview", () => {
  it("rolls up the latest run by geo and week", () => {
    const o = readinessOverview(query);
    if ("error" in o) throw new Error(o.error);
    expect(o.totals).toEqual({ total: 40, ready: 10, at_risk: 22, blocked: 8 });
    const geoTotal = Object.values(o.by_geo).reduce(
      (n, g) => n + g.ready + g.at_risk + g.blocked,
      0
    );
    expect(geoTotal).toBe(40);
    expect(o.most_constrained_parts.map((p) => p.part_number)).toContain(
      "SW-TOR-100G"
    );
    expect(o.week_calendar[0]).toEqual({ week: 1, build_date: "2026-11-26" });
  });

  it("explains itself when no check has run", () => {
    seed(false);
    expect(readinessOverview(query)).toHaveProperty("error");
  });
});

describe("listProblemBuilds", () => {
  it("'at risk in Europe next month' = EU, weeks 1-4", () => {
    const r = listProblemBuilds(query, { geo: "EU", fromWeek: 1, toWeek: 4 });
    if ("error" in r) throw new Error(r.error);
    expect(r.match_count).toBeGreaterThan(0);
    for (const b of r.builds) {
      expect(["FRA", "LHR", "AMS"]).toContain(b.region);
      expect(b.week).toBeLessThanOrEqual(4);
      expect(b.status).not.toBe("ready");
    }
  });

  it("lists blocked builds first", () => {
    const r = listProblemBuilds(query, {});
    if ("error" in r) throw new Error(r.error);
    const firstAtRisk = r.builds.findIndex((b) => b.status === "at_risk");
    expect(
      r.builds.slice(0, firstAtRisk).every((b) => b.status === "blocked")
    ).toBe(true);
  });

  it("caps output and says so", () => {
    const r = listProblemBuilds(query, {});
    if ("error" in r) throw new Error(r.error);
    expect(r.builds.length).toBeLessThanOrEqual(25);
    expect(r.truncated).toBe(r.match_count > 25);
  });

  it("returns valid regions for an unknown one", () => {
    expect(listProblemBuilds(query, { region: "Paris" })).toHaveProperty(
      "valid_regions"
    );
  });
});

describe("buildDetail", () => {
  it("shows BOM requirements and direct-ship eligibility", () => {
    const d = buildDetail(query, "sin-w3-compute");
    if ("error" in d) throw new Error(d.error);
    expect(d.status).toBe("blocked");
    const servers = d.bill_of_materials.find(
      (l) => l.part_number === "SRV-C1"
    )!;
    expect(servers.required_qty).toBe(36 * 5);
    expect(servers.can_ship_direct).toBe(true);
    expect(d.region_priority).toBe(1);
  });

  it("explains an unknown build id", () => {
    expect(buildDetail(query, "XYZ")).toHaveProperty("error");
  });
});

describe("supplierScorecard", () => {
  it("ranks a known-unreliable supplier at the top", () => {
    const s = supplierScorecard(query);
    expect(["NXW", "LUM"]).toContain(s.suppliers[0].supplier_id);
    const nxw = s.suppliers.find((x) => x.supplier_id === "NXW")!;
    expect(nxw.slipped_commits).toBe(3);
    expect(nxw.max_slip_days).toBe(14);
    expect(nxw.parts).toEqual(["SW-TOR-100G"]);
  });
});

describe("whatChanged", () => {
  it("compares against the baseline and shows builds that got worse", () => {
    const w = whatChanged(query);
    if ("error" in w) throw new Error(w.error);
    expect(w.baseline.trigger).toBe("baseline");
    expect(w.baseline_note).toBeDefined();
    expect(w.changed_count).toBeGreaterThan(0);
    // Story 1 should show up as a regression caused by slips.
    const sin = w.changed_builds.find((b) => b.build_id === "SIN-W3-COMPUTE");
    expect(sin?.direction).toBe("worse");
    expect(w.supplier_commit_slips.some((s) => s.supplier_id === "NXW")).toBe(
      true
    );
  });

  it("prefers a real week-old run over the oldest one", () => {
    // Add a "daily" run 6+ days before the latest, but after the baseline.
    const r = assessReadiness({
      asOf: "2026-11-12",
      ...loadEngineInput(query)
    });
    saveRun(query, r, {
      runAt: "2026-11-12T06:00:00Z",
      asOf: "2026-11-12",
      trigger: "daily"
    });
    const today = assessReadiness({
      asOf: "2026-11-18",
      ...loadEngineInput(query)
    });
    saveRun(query, today, {
      runAt: "2026-11-18T13:00:00Z",
      asOf: "2026-11-18",
      trigger: "manual"
    });
    const w = whatChanged(query);
    if ("error" in w) throw new Error(w.error);
    expect(w.baseline.trigger).toBe("daily");
  });
});

describe("chat tool input tolerance (what Llama tends to send)", () => {
  it("treats null / '' / 'any' as omitted and coerces numeric strings", async () => {
    const tools = createChatTools(query);
    const parsed = tools.listProblemBuilds.inputSchema.parse({
      geo: null,
      region: "",
      fromWeek: "1",
      toWeek: 4,
      severity: "any"
    });
    expect(parsed).toEqual({ fromWeek: 1, toWeek: 4 });
  });

  it("rejects nonsense weeks", () => {
    const tools = createChatTools(query);
    expect(() =>
      tools.listProblemBuilds.inputSchema.parse({ fromWeek: 12 })
    ).toThrow();
  });
});
