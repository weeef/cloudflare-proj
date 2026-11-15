/**
 * Tools the chat model (Llama 3.3) can call.
 *
 * HOW TOOL CALLING WORKS
 * Each tool has a description + a JSON-schema of parameters (generated from
 * the zod schema). The model sees these, decides a tool would help, and
 * replies with a structured "call getSupplierScorecard({})" instead of text.
 * The AI SDK runs our `execute` function, feeds the JSON result back to the
 * model, and the model writes the final answer from it. `stopWhen` in
 * agent.ts caps how many of these round trips one message can take.
 *
 * WHY THE TOLERANT PARAMETERS
 * Smaller open models often pass null, "" or "3" (string) for optional
 * fields. Strict validation would reject the call and the user would see an
 * error, so `opt()` / `optNum()` normalise those before validating.
 */
import { tool } from "ai";
import { z } from "zod";
import type { SqlQuery } from "../engine/load";
import {
  buildDetail,
  listProblemBuilds,
  readinessOverview,
  supplierScorecard,
  whatChanged
} from "./queries";

/** Optional param: null / "" / "any" are treated as "not provided". */
const opt = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (v === null || v === "" || v === "any" ? undefined : v),
    schema.optional()
  );

/** Optional number that also accepts numeric strings like "3". */
const optNum = (description: string) =>
  opt(z.coerce.number().int().min(1).max(8)).describe(description);

export function createChatTools(query: SqlQuery) {
  return {
    getReadinessOverview: tool({
      description:
        "High-level readiness picture from the latest daily check: counts of ready / at_risk / blocked builds by geo and by week, the most constrained parts, and the week-number calendar. Use for general 'how are we looking' questions.",
      inputSchema: z.object({}),
      execute: async () => readinessOverview(query)
    }),

    listProblemBuilds: tool({
      description:
        "List rack builds that are blocked and/or at risk, with the reason for each. Filter by geo (EU = Europe, APAC = Asia-Pacific, NA = North America), a single region, and a week range. 'Next month' means weeks 1-4.",
      inputSchema: z.object({
        geo: opt(z.enum(["EU", "APAC", "NA"])).describe(
          "EU, APAC or NA. Omit for all."
        ),
        region: opt(z.string()).describe(
          "Region code or city, e.g. FRA or Frankfurt. Omit for all."
        ),
        fromWeek: optNum("First week to include (1-8)."),
        toWeek: optNum("Last week to include (1-8)."),
        severity: opt(z.enum(["blocked", "at_risk", "both"])).describe(
          "Default both."
        )
      }),
      execute: async (filter) => listProblemBuilds(query, filter)
    }),

    getBuildDetail: tool({
      description:
        "Full detail for one build: bill of materials with required quantities, which parts can ship direct (skip L11 integration), region priority, and every issue. Build IDs look like FRA-W3-COMPUTE.",
      inputSchema: z.object({
        buildId: z.string().describe("e.g. SIN-W3-COMPUTE")
      }),
      execute: async ({ buildId }) => buildDetail(query, buildId)
    }),

    getSupplierScorecard: tool({
      description:
        "Supplier performance: on-time %, average slip, slipped commits and total slip days, and how many builds each supplier is blocking or putting at risk right now. Use for 'which supplier causes the most delays' or supplier business review questions.",
      inputSchema: z.object({}),
      execute: async () => supplierScorecard(query)
    }),

    whatChanged: tool({
      description:
        "Compare the latest readiness check against the one from about a week earlier: builds that got better or worse, count deltas, and the supplier commit slips behind them. Use for 'what changed since last week'.",
      inputSchema: z.object({}),
      execute: async () => whatChanged(query)
    })
  };
}
