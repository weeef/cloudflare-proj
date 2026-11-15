/**
 * RackOpsAgent: the single "brain" of the Rack Build Readiness Agent.
 *
 * WHAT IT IS
 * A Durable Object (via the Agents SDK). A Durable Object is a tiny stateful
 * server that Cloudflare keeps alive somewhere on its network, with its own
 * private SQLite database. Every browser that connects to the same agent *name*
 * talks to the same instance, so the dashboard, the chat, the daily schedule
 * and the approval queue all share one source of truth.
 *
 * WHY AIChatAgent (not plain Agent)
 * AIChatAgent extends Agent with chat plumbing: it stores every message in the
 * DO's SQLite automatically (that is our conversational memory), streams
 * responses over WebSocket, and resumes a stream if the browser reconnects.
 *
 * DATA
 * On first start the agent seeds the mock CSVs (data/*.csv) into its SQLite
 * database. See src/db/ for the schema and seeding logic.
 *
 * READINESS CHECK
 * A deterministic engine (src/engine/readiness.ts, no LLM) grades every
 * upcoming build ready / at_risk / blocked. It runs right after seeding,
 * then daily on a cron schedule the agent sets for itself. Results are saved
 * per run and pushed to connected browsers via agent state.
 *
 * WHAT GETS ADDED IN LATER STEPS
 *  - step 4: chat tools that query the data
 *  - step 5: kick off / approve the weekly review Workflow
 */
import { createWorkersAI } from "workers-ai-provider";
import { callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { MOCK_CSVS } from "./db/data";
import { buildSeedRows, toIsoDate, writeSeed } from "./db/seed";
import { loadEngineInput, type SqlQuery } from "./engine/load";
import {
  buildsForRun,
  latestRun,
  saveRun,
  type RunSummary,
  type RunTrigger
} from "./engine/persist";
import { assessReadiness } from "./engine/readiness";

/** Daily readiness check: 06:00 UTC, before the EU workday starts. */
const DAILY_CHECK_CRON = "0 6 * * *";

/**
 * Agent state is a small JSON object the SDK keeps in sync with every
 * connected browser: setState() on the server pushes the new value to all
 * clients over WebSocket. We keep only the latest run summary here (big
 * per-build data is fetched on demand) so the dashboard updates live when
 * the daily check runs.
 */
export type AgentState = {
  latestRun: RunSummary | null;
};

/**
 * The model the assignment recommends. "fp8-fast" is an 8-bit quantised build
 * of Llama 3.3 70B tuned for low latency on Workers AI. It supports tool
 * (function) calling, which the chat tools in step 4 rely on.
 */
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are the Rack Build Readiness Agent for a hardware supply chain program manager at a global network operator.

You help with: material readiness for upcoming rack builds (L11 rack integration), supply allocation and shortages of L10 server/network hardware, supplier performance, and allocation tradeoffs (delay a build, ship servers direct instead of fully integrated racks, or reallocate parts from a lower-priority region).

Rules:
- Be concise and specific. Lead with the answer, then the supporting numbers.
- Never invent part counts, dates, or supplier names. If you do not have data for something, say so.`;

export class RackOpsAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = { latestRun: null };

  // Keep the last 100 chat messages in SQLite. Older ones are dropped so the
  // prompt we send to the LLM doesn't grow forever.
  maxPersistedMessages = 100;

  // If the Worker restarts mid-response, resume the stream instead of losing it.
  chatRecovery = true;

  /**
   * Runs whenever the Durable Object wakes up (first request, or after
   * Cloudflare evicted it from memory while idle). The SQLite data persists
   * across wake-ups, so we only seed if the database is empty.
   */
  async onStart() {
    if (!this.isSeeded()) this.seed();

    // Cron schedules are idempotent in the Agents SDK: calling this on every
    // wake-up returns the existing schedule instead of adding duplicates.
    // The SDK stores schedules in SQLite and uses a Durable Object alarm to
    // wake the agent at the right time, so no separate cron Worker is needed.
    await this.schedule(DAILY_CHECK_CRON, "runDailyReadinessCheck");
  }

  /**
   * Thin adapter from the Durable Object SQL API to the SqlQuery shape the
   * engine modules expect (they're written against an injected function so
   * tests can run them on node:sqlite).
   */
  private query: SqlQuery = (q, ...b) =>
    this.ctx.storage.sql.exec(q, ...b).toArray() as never[];

  /** True once the meta table exists and records a seed time. */
  private isSeeded(): boolean {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name = 'meta'`;
    if (rows[0].n === 0) return false;
    return this.sql`SELECT value FROM meta WHERE key = 'seeded_at'`.length > 0;
  }

  /**
   * Load the mock CSVs into SQLite.
   * transactionSync makes the whole seed atomic: if any insert fails,
   * every change is rolled back and we never serve half-loaded data.
   */
  private seed() {
    const rows = buildSeedRows(MOCK_CSVS, new Date());
    this.ctx.storage.transactionSync(() => {
      writeSeed((q, ...b) => this.ctx.storage.sql.exec(q, ...b), rows);
    });
    // Run a first check immediately so the dashboard has data from minute one.
    this.runReadinessCheck("seed");
  }

  /**
   * Load -> assess -> save -> broadcast. Pure engine in the middle; this
   * method is just the plumbing around it.
   */
  private runReadinessCheck(trigger: RunTrigger): RunSummary {
    const asOf = toIsoDate(new Date());
    const results = assessReadiness({ asOf, ...loadEngineInput(this.query) });
    const run = this.ctx.storage.transactionSync(() =>
      saveRun(this.query, results, {
        runAt: new Date().toISOString(),
        asOf,
        trigger
      })
    );
    this.setState({ ...this.state, latestRun: run });
    return run;
  }

  /** Called by the daily cron schedule (name referenced in onStart). */
  async runDailyReadinessCheck() {
    this.runReadinessCheck("daily");
  }

  /** "Run check now" button in the UI. */
  @callable()
  runReadinessCheckNow(): RunSummary {
    return this.runReadinessCheck("manual");
  }

  /** Latest run summary plus every build's status and issues (dashboard grid). */
  @callable()
  getLatestReadiness() {
    const run = latestRun(this.query);
    return run ? { run, builds: buildsForRun(this.query, run.run_id) } : null;
  }

  /**
   * @callable exposes a method to the browser over the agent's WebSocket
   * (the UI calls `agent.stub.getDataSummary()`). Row counts plus the
   * date anchor, which is handy for checking that seeding worked.
   */
  @callable()
  getDataSummary() {
    const count = (table: string) =>
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
        .one().n;
    const meta = Object.fromEntries(
      this.sql<{ key: string; value: string }>`SELECT key, value FROM meta`.map(
        (r) => [r.key, r.value]
      )
    );
    return {
      ...meta,
      counts: {
        regions: count("regions"),
        parts: count("parts"),
        rack_types: count("rack_types"),
        bom: count("bom"),
        forecast: count("forecast"),
        suppliers: count("suppliers"),
        supply: count("supply")
      }
    };
  }

  /**
   * Re-seed from the CSVs with week 1 = the coming Monday. Lets a demo
   * reset to fresh dates if the data has aged since it was first loaded.
   * (Mock data, no auth: the assignment says so. A real version would
   * restrict this.)
   */
  @callable()
  resetDemoData() {
    this.seed();
    return this.getDataSummary();
  }

  /**
   * Called by AIChatAgent every time the user sends a chat message.
   * We hand the full (pruned) history to Llama 3.3 and stream the reply back.
   */
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // workers-ai-provider adapts the Workers AI binding (env.AI) to the
    // Vercel AI SDK interface, so we can use streamText / tools / etc.
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(MODEL),
      system: SYSTEM_PROMPT,
      // this.messages = chat history loaded from SQLite (memory).
      // pruneMessages strips old tool-call payloads to save tokens.
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // Data-querying tools are added in step 4.
      },
      // Cap the tool-call loop so a confused model can't spin forever.
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}
