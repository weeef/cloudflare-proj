/**
 * Chat with the agent (Llama 3.3 + data tools).
 *
 * useAgentChat streams messages over the same WebSocket as the dashboard.
 * History is stored in the agent's SQLite, so reloading the page (or opening
 * it on another device) shows the same conversation: that's chat memory.
 * Tool calls are shown as small chips so you can see which data the answer
 * came from.
 */
import { useEffect, useRef, useState } from "react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart } from "ai";
import { Streamdown } from "streamdown";
import type { AgentConn } from "./ui";

const SUGGESTIONS = [
  "What's at risk in Europe next month?",
  "Which supplier causes the most delays?",
  "What changed since last week?",
  "Why is SIN-W3-COMPUTE blocked, and what are my options?"
];

export function ChatPanel({ agent }: { agent: AgentConn }) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });
  const streaming = status === "streaming" || status === "submitted";

  // Block body on purpose: newer browsers return a Promise from
  // scrollIntoView(), and React treats an effect's return value as cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = (text: string) => {
    if (!text.trim() || streaming) return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-kumo-line px-4 py-2">
        <h2 className="text-sm font-semibold">Ask the agent</h2>
        <button
          type="button"
          onClick={clearHistory}
          className="text-xs text-kumo-subtle"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-kumo-subtle">Try:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="block w-full rounded-lg border border-kumo-line px-3 py-2 text-left text-xs hover:bg-kumo-control"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "flex justify-end" : ""}
          >
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-2xl bg-kumo-contrast px-3 py-2 text-kumo-inverse"
                  : "space-y-1"
              }
            >
              {m.parts.map((part, i) => {
                if (part.type === "text") {
                  return m.role === "user" ? (
                    <span key={i}>{part.text}</span>
                  ) : (
                    <Streamdown key={i} className="sd-theme" controls={false}>
                      {part.text}
                    </Streamdown>
                  );
                }
                if (isToolUIPart(part)) {
                  const done = part.state === "output-available";
                  return (
                    <span
                      key={i}
                      className="mr-1 inline-block rounded bg-kumo-control px-1.5 py-0.5 font-mono text-[10px] text-kumo-subtle"
                    >
                      {done ? "✓" : "…"} {getToolName(part)}
                    </span>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 border-t border-kumo-line p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about builds, parts, suppliers…"
          aria-label="Message"
          className="min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
        />
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            className="rounded-lg border border-kumo-line px-3 text-sm"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-lg bg-kumo-brand px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
