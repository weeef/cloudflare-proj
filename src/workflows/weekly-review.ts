/**
 * Weekly shortage review: a Cloudflare Workflow.
 *
 * WHY A WORKFLOW (and not just a method on the agent)
 * This process spans days: it drafts a report, then waits for a human to
 * approve it, possibly until next week. A Workflow is a durable, multi-step
 * program: each `step.do()` result is persisted, failed steps retry on their
 * own, and `waitForApproval` can sleep for days without holding any compute.
 * If Cloudflare restarts the machine mid-run, the workflow resumes at the
 * next unfinished step instead of starting over (so no duplicate LLM calls
 * or duplicate review rows).
 *
 * THE STEPS
 *   1. compute       fresh readiness check + facts pack (deterministic)
 *   2. report        Llama 3.3 writes the leadership report from the facts
 *   3. emails        Llama 3.3 drafts one escalation email per supplier
 *   4. save draft    review goes into the approval queue
 *   5. WAIT          pause until a human approves/rejects (max 7 days)
 *   6. finalize      mark approved (emails released) or rejected (discarded)
 *
 * Nothing is "sent" without step 5. In this demo, approved emails are marked
 * ready to send; a real version would hand them to an email service here.
 *
 * AgentWorkflow (from the Agents SDK) gives us `this.agent`, a typed RPC
 * stub back to the RackOpsAgent that started us, plus waitForApproval().
 */
import {
  AgentWorkflow,
  WorkflowRejectedError,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { RackOpsAgent } from "../agent";
import { MODEL } from "../llm/model";
import {
  emailPrompt,
  fallbackEmail,
  fallbackReport,
  parseEmail,
  reportPrompt,
  type ChatMessage
} from "../llm/prompts";
import type { ReviewFacts } from "../review/facts";
import type { EmailDraft } from "../review/store";

export type WeeklyReviewParams = { trigger: "weekly" | "manual" };

/** How long a review may wait for a decision before it expires. */
const APPROVAL_TIMEOUT = "7 days";

/** LLM steps retry on transient Workers AI errors before falling back. */
const LLM_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "3 minutes"
} as const;

export class WeeklyReviewWorkflow extends AgentWorkflow<
  RackOpsAgent,
  WeeklyReviewParams
> {
  async run(
    _event: AgentWorkflowEvent<WeeklyReviewParams>,
    step: AgentWorkflowStep
  ) {
    const workflowId = this.workflowId;

    // 1. Deterministic: fresh readiness check, options, escalations.
    //    Runs inside the agent (it owns the data), called over RPC.
    // Returned as a JSON string: step results must be serializable, and a
    // plain string sidesteps the RPC wrapper types on the agent's response.
    const facts: ReviewFacts = JSON.parse(
      await step.do("compute readiness and options", () =>
        this.agent.prepareWeeklyReview(workflowId)
      )
    );

    // 2. LLM writes the report. If Workers AI is still failing after the
    //    step's retries, fall back to a plain report so the human approval
    //    step is never blocked by an AI outage.
    let report: { markdown: string; source: "llm" | "fallback" };
    try {
      report = await step.do("write leadership report", LLM_STEP, async () => ({
        markdown: await this.llm(reportPrompt(facts), 2500),
        source: "llm" as const
      }));
    } catch (err) {
      console.error("Report LLM failed, using fallback:", err);
      report = await step.do("write fallback report", async () => ({
        markdown: fallbackReport(facts),
        source: "fallback" as const
      }));
    }

    // 3. One email per supplier, each its own durable step (a failure on
    //    supplier B doesn't redo supplier A's email).
    const emails: EmailDraft[] = [];
    for (const supplier of facts.supplier_escalations) {
      const draft = await step
        .do(`draft email ${supplier.supplier_id}`, LLM_STEP, async () =>
          parseEmail(
            await this.llm(emailPrompt(supplier, facts.as_of), 600),
            `Escalation: ${supplier.parts.join(", ")} commits`
          )
        )
        .catch(() => fallbackEmail(supplier));
      emails.push({
        supplier_id: supplier.supplier_id,
        supplier_name: supplier.name,
        ...draft,
        status: "draft"
      });
    }

    // 4. Into the approval queue (agent broadcasts it to the dashboard).
    await step.do("save draft for approval", () =>
      this.agent.saveWeeklyReviewDraft(workflowId, {
        reportMd: report.markdown,
        reportSource: report.source,
        emails
      })
    );

    // 5. PAUSE. The workflow sleeps here (no compute) until the agent calls
    //    approveWorkflow() / rejectWorkflow() from the UI, or 7 days pass.
    //    Only the wait is inside try/catch, so a failure in a LATER step is
    //    reported as an error, never mistaken for a rejection or timeout.
    let approval: { note?: string } | undefined;
    try {
      // Resolves with the `metadata` the agent passed to approveWorkflow().
      approval = await this.waitForApproval<{ note?: string }>(step, {
        timeout: APPROVAL_TIMEOUT
      });
    } catch (err) {
      if (err instanceof WorkflowRejectedError) {
        // 6b. Rejected: the agent already recorded it (see rejectReview);
        //     this step is a no-op safety net.
        await step.do("mark rejected", () =>
          this.agent.finalizeWeeklyReview(workflowId, "rejected", err.reason)
        );
        return { status: "rejected" };
      }
      // Otherwise waitForEvent timed out: nobody decided within 7 days.
      await step.do("mark expired", () =>
        this.agent.finalizeWeeklyReview(
          workflowId,
          "expired",
          `No decision within ${APPROVAL_TIMEOUT}`
        )
      );
      return { status: "expired" };
    }

    // 6a. Approved: release the emails (mock send).
    await step.do("mark approved", () =>
      this.agent.finalizeWeeklyReview(workflowId, "approved", approval?.note)
    );
    return { status: "approved" };
  }

  /** One non-streaming Llama 3.3 call via the Workers AI binding. */
  private async llm(messages: ChatMessage[], maxTokens: number) {
    // A missing binding is permanent: skip the retries and go straight to
    // the fallback. (Transient Workers AI errors below DO get retried.)
    if (!this.env.AI) {
      throw new NonRetryableError("Workers AI binding not configured");
    }
    const res = await this.env.AI.run(MODEL, {
      messages,
      max_tokens: maxTokens,
      // Low temperature: we want faithful, consistent summaries, not creativity.
      temperature: 0.2
    });
    const text =
      typeof res === "object" && res && "response" in res ? res.response : "";
    if (!text?.trim()) throw new Error("Empty response from Workers AI");
    return text.trim();
  }
}
