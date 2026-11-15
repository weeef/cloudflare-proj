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
 * CHAT
 * Llama 3.3 answers questions through tools (src/tools/) that query the
 * data. It never computes supply numbers itself.
 *
 * WEEKLY REVIEW (human in the loop)
 * Every Monday (or on demand) the agent starts WeeklyReviewWorkflow
 * (src/workflows/weekly-review.ts). The workflow calls back into this agent
 * over RPC to compute facts and save drafts, then pauses until a human
 * approves or rejects from the UI. Browser-facing actions are @callable;
 * workflow-facing methods are plain public methods, reachable over RPC from
 * our own Worker code but NOT from the browser.
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
import { DATA_VERSION, MOCK_CSVS } from "./db/data";
import { RESULT_SCHEMA, SCHEMA } from "./db/schema";
import { addDays, buildSeedRows, toIsoDate, writeSeed } from "./db/seed";
import { loadEngineInput, type SqlQuery } from "./engine/load";
import {
  buildsForRun,
  latestRun,
  saveRun,
  type RunSummary,
  type RunTrigger
} from "./engine/persist";
import { assessReadiness } from "./engine/readiness";
import { MODEL } from "./llm/model";
import { buildReviewFacts } from "./review/facts";
import {
  attachFacts,
  createReview,
  decide,
  getReview,
  listReviews,
  openReview,
  saveDraft,
  type EmailDraft,
  type ReviewStatus
} from "./review/store";
import { createChatTools } from "./tools/chat-tools";
import { weekCalendar } from "./tools/queries";

/**
 * How many recent messages are sent to the model each turn. All messages are
 * still stored (maxPersistedMessages); this only bounds the prompt size,
 * since Llama 3.3's context window is far smaller than a long chat.
 */
const MODEL_MESSAGE_WINDOW = 20;

/** Daily readiness check: 06:00 UTC, before the EU workday starts. */
const DAILY_CHECK_CRON = "0 6 * * *";

/** Weekly shortage review: Mondays 07:00 UTC, after that day's check. */
const WEEKLY_REVIEW_CRON = "0 7 * * 1";

/** Small summary of a review, pushed to browsers in agent state. */
export type ReviewSummary = {
  review_id: number;
  status: ReviewStatus;
  created_at: string;
  decided_at: string | null;
};

/**
 * Agent state is a small JSON object the SDK keeps in sync with every
 * connected browser: setState() on the server pushes the new value to all
 * clients over WebSocket. We keep only the latest run summary here (big
 * per-build data is fetched on demand) so the dashboard updates live when
 * the daily check runs.
 */
export type AgentState = {
  latestRun: RunSummary | null;
  latestReview: ReviewSummary | null;
};

/**
 * System prompt, rebuilt on every message so "today" and the week calendar
 * are always current. Giving the model the calendar lets it translate
 * "next month" into weeks 1-4 without guessing.
 */
function buildSystemPrompt(
  today: string,
  calendar: { week: number; build_date: string }[]
) {
  const weeks = calendar.map((w) => `W${w.week}=${w.build_date}`).join(", ");
  return `You are the Rack Build Readiness Agent for a hardware supply chain program manager at a global network operator.

You help with material readiness for upcoming L11 rack integration builds, supply allocation and shortages of L10 server/network hardware, supplier performance, and allocation tradeoffs (delay a build, ship servers direct instead of fully integrated racks, or reallocate parts from a lower-priority region).

Today is ${today}. Build weeks and their build dates: ${weeks}.
Regions: FRA Frankfurt, LHR London, AMS Amsterdam (EU); SIN Singapore, NRT Tokyo (APAC); IAD Ashburn, SEA Seattle (NA). Region priority 1 is most critical; SEA is priority 3.
Statuses: ready, at_risk (parts may land late or inside the 7-day buffer), blocked (parts will not be there by the build date).

Rules:
- For any question about builds, parts, suppliers or changes, call a tool first. Never answer data questions from memory.
- Never invent part counts, dates, or supplier names. Only use numbers returned by tools.
- Be concise. Lead with the answer, then the supporting numbers. Use short bullet lists.
- When you suggest options, name the tradeoff (cost, schedule, which region loses).
- For questions about the weekly review report, what was reported to leadership, or what was decided, use getWeeklyReview.`;
}

export class RackOpsAgent extends AIChatAgent<Env, AgentState> {
  initialState: AgentState = { latestRun: null, latestReview: null };

  // Keep the last 100 chat messages in SQLite. Older ones are dropped so the
  // prompt we send to the LLM doesn't grow forever.
  maxPersistedMessages = 100;

  // If the Worker restarts mid-response, resume the stream instead of losing it.
  chatRecovery = true;

  /**
   * Runs whenever the Durable Object wakes up (first request, or after
   * Cloudflare evicted it from memory while idle). The SQLite data persists
   * across wake-ups, so we only seed if the database is empty or was seeded
   * from an older version of the CSVs.
   */
  async onStart() {
    if (!this.isSeeded()) {
      this.seed();
    } else {
      // Schema upgrades: CREATE TABLE IF NOT EXISTS is a no-op for tables
      // that exist, so this safely adds tables introduced in newer versions
      // to an agent that was seeded by an older deploy.
      for (const stmt of [...SCHEMA, ...RESULT_SCHEMA]) {
        this.ctx.storage.sql.exec(stmt);
      }
      if (!latestRun(this.query)) this.runReadinessCheck("seed");
    }

    // Cron schedules are idempotent in the Agents SDK: calling this on every
    // wake-up returns the existing schedule instead of adding duplicates.
    // The SDK stores schedules in SQLite and uses a Durable Object alarm to
    // wake the agent at the right time, so no separate cron Worker is needed.
    await this.schedule(DAILY_CHECK_CRON, "runDailyReadinessCheck");
    await this.schedule(WEEKLY_REVIEW_CRON, "runScheduledWeeklyReview");
  }

  /**
   * Thin adapter from the Durable Object SQL API to the SqlQuery shape the
   * engine modules expect (they're written against an injected function so
   * tests can run them on node:sqlite).
   */
  private query: SqlQuery = (q, ...b) =>
    this.ctx.storage.sql.exec(q, ...b).toArray() as never[];

  /** True once seeded with the CSV version this code ships with. */
  private isSeeded(): boolean {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name = 'meta'`;
    if (rows[0].n === 0) return false;
    const [row] = this.sql<{
      value: string;
    }>`SELECT value FROM meta WHERE key = 'data_version'`;
    return row?.value === DATA_VERSION;
  }

  /**
   * Load the mock CSVs into SQLite.
   * transactionSync makes the whole seed atomic: if any insert fails,
   * every change is rolled back and we never serve half-loaded data.
   */
  private seed() {
    const rows = buildSeedRows(MOCK_CSVS, new Date(), DATA_VERSION);
    this.ctx.storage.transactionSync(() => {
      writeSeed((q, ...b) => this.ctx.storage.sql.exec(q, ...b), rows);
    });
    // Reconstructed "last week" snapshot: the same data, but with every lot
    // at its ORIGINAL commit date (before suppliers slipped), dated 7 days
    // ago. It gives "what changed since last week?" a real answer on a fresh
    // demo. Labelled trigger = "baseline" so it is never mistaken for a real
    // check; once real daily runs exist, whatChanged prefers those.
    const now = new Date();
    this.runReadinessCheck("baseline", {
      asOf: addDays(toIsoDate(now), -7),
      runAt: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      asOriginallyPromised: true
    });
    // Then today's real check, so the dashboard has data from minute one.
    this.runReadinessCheck("seed");
  }

  /**
   * Load -> assess -> save -> broadcast. Pure engine in the middle; this
   * method is just the plumbing around it.
   */
  private runReadinessCheck(
    trigger: RunTrigger,
    opts: { asOf?: string; runAt?: string; asOriginallyPromised?: boolean } = {}
  ): RunSummary {
    const asOf = opts.asOf ?? toIsoDate(new Date());
    const results = assessReadiness({
      asOf,
      ...loadEngineInput(this.query, {
        asOriginallyPromised: opts.asOriginallyPromised
      })
    });
    const run = this.ctx.storage.transactionSync(() =>
      saveRun(this.query, results, {
        runAt: opts.runAt ?? new Date().toISOString(),
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

  // ── weekly review: browser-facing (@callable) ─────────────────────────

  /**
   * Start a weekly review workflow. Refuses if one is already open, so the
   * approval queue never holds two competing drafts.
   *
   * The review row is inserted synchronously BEFORE starting the workflow:
   * a Durable Object processes one event at a time, so a double-click's
   * second call sees this row and is refused.
   */
  @callable()
  async startWeeklyReview(trigger: "weekly" | "manual" = "manual") {
    const open = openReview(this.query);
    if (open) {
      return {
        started: false,
        reason: `Review #${open.review_id} is still ${open.status}. Approve or reject it first.`,
        review_id: open.review_id
      };
    }
    const workflowId = crypto.randomUUID();
    const review = createReview(this.query, { workflowId, trigger });
    this.publishReview(review);
    try {
      await this.runWorkflow("WEEKLY_REVIEW", { trigger }, { id: workflowId });
    } catch (err) {
      this.publishReview(decide(this.query, workflowId, "failed", String(err)));
      throw err;
    }
    return { started: true, review_id: review.review_id };
  }

  /** Called by the weekly cron schedule. */
  async runScheduledWeeklyReview() {
    await this.startWeeklyReview("weekly");
  }

  /**
   * Human decision from the approval queue. For approval we don't update
   * the row here: we send the decision to the paused workflow, and ITS next
   * step records it and releases the emails.
   */
  @callable()
  async approveReview(reviewId: number, note?: string) {
    const review = this.requirePending(reviewId);
    // waitForApproval() hands the workflow the `metadata` object, so the
    // note travels there.
    await this.approveWorkflow(review.workflow_id, {
      reason: note,
      metadata: { note }
    });
    return { ok: true };
  }

  /**
   * Rejection is recorded HERE, before signalling the workflow. The SDK's
   * waitForApproval() reports a rejection as a workflow error (which fires
   * onWorkflowError), so recording it first makes the outcome "rejected",
   * and the later workflow step / error hook are harmless no-ops.
   */
  @callable()
  async rejectReview(reviewId: number, note?: string) {
    const review = this.requirePending(reviewId);
    this.publishReview(
      decide(this.query, review.workflow_id, "rejected", note)
    );
    await this.rejectWorkflow(review.workflow_id, { reason: note });
    return { ok: true };
  }

  /** Approval queue / history (newest first, without the bulky facts). */
  @callable()
  getReviews() {
    return listReviews(this.query);
  }

  /** One review in full: report, email drafts, and the facts the LLM saw. */
  @callable()
  getReviewDetail(reviewId: number) {
    return getReview(this.query, reviewId);
  }

  private requirePending(reviewId: number) {
    const review = getReview(this.query, reviewId);
    if (!review) throw new Error(`Review ${reviewId} not found`);
    if (review.status !== "pending_approval") {
      throw new Error(
        `Review ${reviewId} is ${review.status}, not pending approval`
      );
    }
    return review;
  }

  // ── weekly review: workflow-facing (RPC from WeeklyReviewWorkflow) ────

  /** Workflow step 1: fresh readiness check + facts pack (as JSON) for the LLM. */
  async prepareWeeklyReview(workflowId: string) {
    const run = this.runReadinessCheck("weekly");
    const facts = buildReviewFacts(this.query, run.as_of);
    attachFacts(this.query, workflowId, run.run_id, facts);
    return JSON.stringify(facts);
  }

  /** Workflow step 4: draft is ready, put it in the approval queue. */
  async saveWeeklyReviewDraft(
    workflowId: string,
    draft: {
      reportMd: string;
      reportSource: "llm" | "fallback";
      emails: EmailDraft[];
    }
  ) {
    this.publishReview(saveDraft(this.query, workflowId, draft));
  }

  /** Workflow step 6: record the outcome. */
  async finalizeWeeklyReview(
    workflowId: string,
    status: "approved" | "rejected" | "expired",
    note?: string
  ) {
    this.publishReview(decide(this.query, workflowId, status, note));
  }

  /** SDK hook: a workflow this agent started threw an unhandled error. */
  async onWorkflowError(_name: string, workflowId: string, error: string) {
    const review = decide(this.query, workflowId, "failed", error);
    // A rejection also arrives here (the SDK reports it as an error), but the
    // review is already "rejected" so decide() was a no-op. Only log real failures.
    if (review?.status === "failed") {
      console.error(`Workflow ${workflowId} failed:`, error);
    }
    this.publishReview(review);
  }

  /** Push the review's new status to every connected browser. */
  private publishReview(review: ReturnType<typeof getReview>) {
    if (!review) return;
    this.setState({
      ...this.state,
      latestReview: {
        review_id: review.review_id,
        status: review.status,
        created_at: review.created_at,
        decided_at: review.decided_at
      }
    });
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
   * We hand recent (pruned) history + the data tools to Llama 3.3 and
   * stream the reply back over the WebSocket.
   */
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // workers-ai-provider adapts the Workers AI binding (env.AI) to the
    // Vercel AI SDK interface, so we can use streamText / tools / etc.
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(MODEL),
      system: buildSystemPrompt(
        toIsoDate(new Date()),
        weekCalendar(this.query)
      ),
      // this.messages = chat history loaded from SQLite (memory). We send the
      // most recent window; pruneMessages also strips old tool-call payloads
      // (big JSON results) from earlier turns to save tokens.
      messages: pruneMessages({
        messages: await convertToModelMessages(
          this.messages.slice(-MODEL_MESSAGE_WINDOW)
        ),
        toolCalls: "before-last-2-messages"
      }),
      tools: createChatTools(this.query),
      // Cap the tool-call loop so a confused model can't spin forever.
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}
