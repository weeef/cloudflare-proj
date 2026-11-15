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
 * WHAT GETS ADDED IN LATER STEPS
 *  - step 2: seed mock CSV data into SQLite on first start
 *  - step 3: deterministic readiness engine + daily schedule
 *  - step 4: chat tools that query the data
 *  - step 5: kick off / approve the weekly review Workflow
 */
import { createWorkersAI } from "workers-ai-provider";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";

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

export class RackOpsAgent extends AIChatAgent<Env> {
  // Keep the last 100 chat messages in SQLite. Older ones are dropped so the
  // prompt we send to the LLM doesn't grow forever.
  maxPersistedMessages = 100;

  // If the Worker restarts mid-response, resume the stream instead of losing it.
  chatRecovery = true;

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
