/**
 * Prompts for the weekly review, plus a deterministic fallback.
 *
 * Kept in one file so the exact wording the LLM receives is easy to review,
 * tweak, and explain. Each prompt embeds the facts pack as JSON and tells
 * the model to use ONLY those numbers.
 */
import type { ReviewFacts, SupplierEscalation } from "../review/facts";

export type ChatMessage = { role: "system" | "user"; content: string };

// ── leadership report ───────────────────────────────────────────────────

export function reportPrompt(facts: ReviewFacts): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You write the weekly supply allocation and shortage review for infrastructure leadership and Capacity Planning at a global network operator. Readers are busy executives: plain English, no jargon they would not know, specific numbers, clear recommendations.

Hard rules:
- Use ONLY facts and numbers present in the JSON you are given. Never invent quantities, dates, suppliers or options.
- Only present options that appear in the JSON. If a delay option is "feasible": false, say delay cannot fix it and why.
- Output GitHub-flavoured Markdown only. No preamble, no sign-off.`
    },
    {
      role: "user",
      content: `Write this week's review with exactly these sections:

# Weekly Rack Build Readiness Review: ${facts.as_of}

## Summary
3 to 4 bullets: overall ready / at risk / blocked counts, the change versus last week (if baseline_is_reconstructed is true, say "versus suppliers' original commit dates" instead of "last week"), and the single biggest risk.

## Blocked builds and options
One ### subsection per blocked build (build id, region, build date). For each:
- One sentence: what is short, how many, and why (supplier, days late).
- **Option A: Delay**: days and new date, plus side effects; or why delay cannot fix it.
- **Option B: Reallocate**: each reallocate entry: which lower-priority build to defer and its side effects. If the list is empty, say no single lower-priority build frees enough parts.
- **Option C: Ship direct**: if short_parts_can_ship_direct is false, explain that the short part has to be integrated into the rack, so shipping the servers direct to site only helps if the site can do the network integration itself, at the cost of on-site labour and no factory rack test.
- **Recommendation:** one line choosing an option and saying why, weighing region priority (1 = most critical) and side effects.

## Supplier escalations
One bullet per supplier in supplier_escalations: what they slipped (parts, quantities, days) and which builds it is hurting.

## Watch list
2 to 3 bullets on the most constrained parts and any geo with many at-risk builds.

Facts (JSON):
${JSON.stringify(facts)}`
    }
  ];
}

// ── supplier escalation email ───────────────────────────────────────────

export function emailPrompt(
  supplier: SupplierEscalation,
  asOf: string
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are a senior supply chain program manager writing to a hardware supplier's account manager. Tone: firm, professional, specific, collaborative. Under 200 words.

Hard rules:
- Use ONLY the facts in the JSON. Never invent quantities, dates, part numbers, people's names or prices.
- The first line must be "Subject: <subject>". Then a blank line, then the email body.
- Sign off as "Rack Integration Supply Planning". No placeholders like [Name].`
    },
    {
      role: "user",
      content: `Today is ${asOf}. Draft an escalation email to ${supplier.name}. Cover:
1. The specific commits that slipped (part, quantity, original date, current date, days slipped).
2. The business impact: number of rack builds blocked or at risk.
3. Clear asks: confirm firm ship dates for the open commits within 2 business days, a recovery plan to pull dates back in, and whether partial early shipments are possible.

Facts (JSON):
${JSON.stringify(supplier)}`
    }
  ];
}

/** Split "Subject: ...\n\nbody" into parts; tolerant of small format slips. */
export function parseEmail(text: string, fallbackSubject: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\**subject:?\**\s*(.+)\n+([\s\S]*)$/i);
  return match
    ? { subject: match[1].trim(), body: match[2].trim() }
    : { subject: fallbackSubject, body: trimmed };
}

// ── deterministic fallback (no LLM) ─────────────────────────────────────

/**
 * Plain report built straight from the facts. Used if Workers AI is
 * unavailable after retries, so the approval workflow never dead-ends.
 * Clearly labelled so nobody mistakes it for the LLM-written version.
 */
export function fallbackReport(facts: ReviewFacts): string {
  const t = facts.totals;
  const lines = [
    `# Weekly Rack Build Readiness Review: ${facts.as_of}`,
    "",
    "> Auto-generated summary: the AI report writer was unavailable, so this was produced directly from the readiness data.",
    "",
    "## Summary",
    `- ${t.total} upcoming builds: ${t.ready} ready, ${t.at_risk} at risk, ${t.blocked} blocked.`
  ];
  if (facts.change_vs_last_week) {
    const d = facts.change_vs_last_week.delta;
    lines.push(
      `- Change vs ${facts.change_vs_last_week.baseline_date}: ready ${signed(d.ready)}, at risk ${signed(d.at_risk)}, blocked ${signed(d.blocked)}.`
    );
  }
  lines.push("", "## Blocked builds and options");
  for (const b of facts.blocked_builds) {
    lines.push(
      "",
      `### ${b.build_id} (${b.region}, ${b.build_date})`,
      ...b.short_parts.map(
        (s) =>
          `- Short ${s.qty} ${s.part_number}${s.supplier_id ? ` (${s.supplier_id}${s.days_late ? `, ${s.days_late} days late` : ""})` : ""}`
      ),
      b.delay.feasible
        ? `- Option A: Delay ${b.delay.days} days to ${b.delay.new_build_date} (${b.delay.side_effects.length} side effects).`
        : `- Option A: Delay not possible: ${b.delay.reason}`,
      b.reallocate.length
        ? `- Option B: Defer ${b.reallocate.map((r) => `${r.defer_build_id} (priority ${r.defer_region_priority}, ${r.side_effects.length} side effects)`).join(" or ")}.`
        : "- Option B: No single lower-priority build frees enough parts.",
      `- Option C: Short part ${b.ship_direct.short_parts_can_ship_direct ? "can" : "cannot"} ship direct.`
    );
  }
  lines.push("", "## Supplier escalations");
  for (const s of facts.supplier_escalations) {
    lines.push(
      `- ${s.name} (${s.on_time_pct}% on-time): ${s.slipped_commits.length} slipped commits; ${s.builds_blocked} builds blocked, ${s.builds_at_risk} at risk.`
    );
  }
  return lines.join("\n");
}

export function fallbackEmail(s: SupplierEscalation) {
  const slips = s.slipped_commits
    .map(
      (c) =>
        `- ${c.qty} x ${c.part_number}: committed ${c.original_commit_date}, now ${c.commit_date} (${c.slip_days} days late)`
    )
    .join("\n");
  return {
    subject: `Escalation: slipped commits on ${s.parts.join(", ")}`,
    body: `Hello ${s.name} team,\n\nThe following commits have slipped:\n${slips}\n\nThis currently blocks ${s.builds_blocked} and puts ${s.builds_at_risk} rack builds at risk. Please confirm firm ship dates within 2 business days, share a recovery plan, and let us know if partial early shipments are possible.\n\nRack Integration Supply Planning`
  };
}

const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
