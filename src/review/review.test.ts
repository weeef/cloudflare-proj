/**
 * Weekly review tests: what-if options, facts pack, approval lifecycle,
 * prompt helpers. (The Workflow orchestration itself is exercised end to
 * end against a local Durable Object; see PROMPTS.md step 5.)
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MOCK_CSVS } from "../db/data";
import { buildSeedRows, writeSeed } from "../db/seed";
import { loadEngineInput, type SqlQuery } from "../engine/load";
import { allocationOptions, type PartInfo } from "../engine/options";
import { saveRun } from "../engine/persist";
import { assessReadiness } from "../engine/readiness";
import {
  emailPrompt,
  fallbackEmail,
  fallbackReport,
  parseEmail,
  reportPrompt
} from "../llm/prompts";
import { weeklyReview } from "../tools/queries";
import { buildReviewFacts } from "./facts";
import {
  attachFacts,
  createReview,
  decide,
  listReviews,
  openReview,
  saveDraft
} from "./store";

const AS_OF = "2026-11-18";
let query: SqlQuery;

beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  writeSeed(
    (q, ...b) => {
      db.prepare(q).run(...b);
    },
    buildSeedRows(MOCK_CSVS, new Date("2026-11-18T12:00:00Z"))
  );
  query = (q, ...b) => db.prepare(q).all(...b) as never[];
  saveRun(
    query,
    assessReadiness({
      asOf: "2026-11-11",
      ...loadEngineInput(query, { asOriginallyPromised: true })
    }),
    { runAt: "2026-11-11T12:00:00Z", asOf: "2026-11-11", trigger: "baseline" }
  );
  saveRun(query, assessReadiness({ asOf: AS_OF, ...loadEngineInput(query) }), {
    runAt: "2026-11-18T12:00:00Z",
    asOf: AS_OF,
    trigger: "seed"
  });
});

const options = () =>
  allocationOptions(
    { asOf: AS_OF, ...loadEngineInput(query) },
    query<PartInfo>(`SELECT part_number, category, direct_ship_ok FROM parts`)
  );

describe("allocation options (what-if engine)", () => {
  it("covers every blocked build", () => {
    expect(options()).toHaveLength(8);
  });

  it("finds the minimal delay, and verifies it unblocks the build", () => {
    const sin = options().find((o) => o.build_id === "SIN-W3-COMPUTE")!;
    expect(sin.delay).toMatchObject({ feasible: true, days: 3 });
    // One day less must still be blocked (i.e. 3 really is the minimum).
    const input = loadEngineInput(query);
    const twoDays = assessReadiness({
      asOf: AS_OF,
      ...input,
      builds: input.builds.map((b) =>
        b.build_id === "SIN-W3-COMPUTE" ? { ...b, build_date: "2026-12-12" } : b
      )
    }).find((r) => r.build_id === "SIN-W3-COMPUTE")!;
    expect(twoDays.status).toBe("blocked");
  });

  it("says delay cannot fix a build with no supply committed", () => {
    const sin8 = options().find((o) => o.build_id === "SIN-W8-EDGE")!;
    expect(sin8.delay.feasible).toBe(false);
  });

  it("only proposes lower-priority donors that actually unblock the build", () => {
    for (const o of options()) {
      for (const r of o.reallocate) {
        expect(r.defer_region_priority).toBeGreaterThan(o.region_priority);
        expect(r.status_after).not.toBe("blocked");
      }
    }
    const ams6 = options().find((o) => o.build_id === "AMS-W6-STORAGE")!;
    expect(ams6.reallocate.map((r) => r.defer_build_id)).toContain(
      "SEA-W3-COMPUTE"
    );
  });

  it("knows switches and optics cannot ship direct, servers can", () => {
    const sin = options().find((o) => o.build_id === "SIN-W3-COMPUTE")!;
    expect(sin.ship_direct.short_parts_can_ship_direct).toBe(false);
    expect(sin.ship_direct.direct_ship_parts).toEqual(["SRV-C1"]);
  });
});

describe("review facts", () => {
  it("escalates the slipping suppliers, not the reliable one next in queue", () => {
    const facts = buildReviewFacts(query, AS_OF);
    const ids = facts.supplier_escalations.map((s) => s.supplier_id).sort();
    expect(ids).toEqual(["LUM", "NXW"]);
    const nxw = facts.supplier_escalations.find(
      (s) => s.supplier_id === "NXW"
    )!;
    expect(nxw.slipped_commits).toHaveLength(3);
    expect(nxw.blocked_builds_on_their_parts).toContain("SIN-W3-COMPUTE");
  });

  it("includes the change vs the (reconstructed) baseline", () => {
    const facts = buildReviewFacts(query, AS_OF);
    expect(facts.change_vs_last_week?.baseline_is_reconstructed).toBe(true);
    expect(facts.change_vs_last_week?.builds_worse.length).toBeGreaterThan(0);
  });

  it("stays small enough for the model's context", () => {
    const prompt = reportPrompt(buildReviewFacts(query, AS_OF));
    const chars = prompt.reduce((n, m) => n + m.content.length, 0);
    // ~4 chars/token: keep the report prompt well under ~8k tokens.
    expect(chars).toBeLessThan(32_000);
  });
});

describe("approval lifecycle", () => {
  const facts = () => buildReviewFacts(query, AS_OF);
  const draft = {
    reportMd: "# report",
    reportSource: "llm" as const,
    emails: [
      {
        supplier_id: "NXW",
        supplier_name: "Nexwave",
        subject: "s",
        body: "b",
        status: "draft" as const
      }
    ]
  };

  it("drafting -> pending_approval -> approved releases emails", () => {
    createReview(query, { workflowId: "wf1", trigger: "manual" });
    expect(openReview(query)?.status).toBe("drafting");
    attachFacts(query, "wf1", 2, facts());
    expect(saveDraft(query, "wf1", draft)?.status).toBe("pending_approval");
    const done = decide(query, "wf1", "approved", "ok to send");
    expect(done?.status).toBe("approved");
    expect(done?.emails[0].status).toBe("approved");
    expect(done?.decision_note).toBe("ok to send");
    expect(openReview(query)).toBeNull();
  });

  it("rejected discards the drafts", () => {
    createReview(query, { workflowId: "wf2", trigger: "manual" });
    saveDraft(query, "wf2", draft);
    expect(decide(query, "wf2", "rejected")?.emails[0].status).toBe(
      "discarded"
    );
  });

  it("can't decide before the draft exists, or decide twice", () => {
    createReview(query, { workflowId: "wf3", trigger: "manual" });
    expect(decide(query, "wf3", "approved")?.status).toBe("drafting");
    saveDraft(query, "wf3", draft);
    decide(query, "wf3", "rejected");
    expect(decide(query, "wf3", "approved")?.status).toBe("rejected");
  });

  it("createReview is idempotent per workflow id", () => {
    createReview(query, { workflowId: "wf4", trigger: "manual" });
    createReview(query, { workflowId: "wf4", trigger: "manual" });
    expect(listReviews(query)).toHaveLength(1);
  });

  it("chat tool returns the latest report and decision", () => {
    createReview(query, { workflowId: "wf5", trigger: "weekly" });
    saveDraft(query, "wf5", draft);
    decide(query, "wf5", "approved", "go");
    const r = weeklyReview(query, "latest");
    expect(r).toMatchObject({
      status: "approved",
      decision_note: "go",
      report_markdown: "# report"
    });
    expect(weeklyReview(query, "previous")).toHaveProperty("error");
  });
});

describe("prompt helpers", () => {
  it("parses the email subject line, tolerating bold/markdown", () => {
    expect(parseEmail("Subject: Late switches\n\nHello", "x")).toEqual({
      subject: "Late switches",
      body: "Hello"
    });
    expect(parseEmail("**Subject:** Late switches\n\nHello", "x").subject).toBe(
      "Late switches"
    );
    expect(parseEmail("Hello there", "fallback")).toEqual({
      subject: "fallback",
      body: "Hello there"
    });
  });

  it("embeds the facts in the prompts", () => {
    const facts = buildReviewFacts(query, AS_OF);
    expect(reportPrompt(facts)[1].content).toContain("SIN-W3-COMPUTE");
    const nxw = facts.supplier_escalations.find(
      (s) => s.supplier_id === "NXW"
    )!;
    expect(emailPrompt(nxw, AS_OF)[1].content).toContain("Nexwave Networks");
  });

  it("fallback report and email are built purely from facts", () => {
    const facts = buildReviewFacts(query, AS_OF);
    const md = fallbackReport(facts);
    expect(md).toContain("AI report writer was unavailable");
    expect(md).toContain("### SIN-W3-COMPUTE");
    const email = fallbackEmail(facts.supplier_escalations[0]);
    expect(email.body).toContain("days late");
  });
});
