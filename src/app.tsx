/**
 * Dashboard + chat UI.
 *
 * ONE WebSocket connection (useAgent) to the RackOpsAgent is shared by every
 * panel. Two kinds of traffic flow over it:
 *  - agent STATE (latest run + latest review summary), pushed by the server
 *    whenever it changes, e.g. when the daily cron runs or a review is
 *    approved. Panels use it as a "something changed, refetch" signal.
 *  - RPC calls to @callable methods (agent.stub.*) to fetch data or act.
 *
 * Layout: tabs (Readiness / What changed / Weekly review) + chat panel.
 */
import { useCallback, useEffect, useState } from "react";
import { useAgent } from "agents/react";
import type { AgentState, RackOpsAgent } from "./agent";
import type { StoredBuildStatus } from "./engine/persist";
import { ChatPanel } from "./components/ChatPanel";
import {
  ChangesPanel,
  type Comparison,
  type RunRow
} from "./components/ChangesPanel";
import { ReadinessGrid } from "./components/ReadinessGrid";
import { ReviewPanel } from "./components/ReviewPanel";
import { Card, StatusPill, fmtTime, signed } from "./components/ui";

type Tab = "readiness" | "changes" | "review";

export default function App() {
  const [state, setState] = useState<AgentState | null>(null);
  const [connected, setConnected] = useState(false);
  const agent = useAgent<RackOpsAgent, AgentState>({
    agent: "RackOpsAgent", // must match the Durable Object binding name
    onStateUpdate: useCallback((s: AgentState) => setState(s), []),
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), [])
  });

  const [tab, setTab] = useState<Tab>("readiness");
  const [builds, setBuilds] = useState<StoredBuildStatus[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [pair, setPair] = useState<{ from: number; to: number } | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [busy, setBusy] = useState(false);

  const runId = state?.latestRun?.run_id;
  const reviewVersion = `${state?.latestReview?.review_id}:${state?.latestReview?.status}`;

  // New readiness run -> refetch grid + history, and reset to the default
  // comparison (latest vs ~a week earlier).
  useEffect(() => {
    if (!connected) return;
    agent.stub.getLatestReadiness().then((r) => setBuilds(r?.builds ?? []));
    agent.stub.getRunHistory().then(setRuns);
    setPair(null);
  }, [agent, connected, runId]);

  // Fetch the comparison whenever the selected pair (or latest run) changes.
  useEffect(() => {
    if (!connected) return;
    agent.stub
      .compareReadiness(pair?.from, pair?.to)
      .then(setCmp)
      .catch(console.error);
  }, [agent, connected, pair?.from, pair?.to, runId]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const latest = state?.latestRun;
  const changes = cmp && !("error" in cmp) ? cmp : null;
  // Only highlight on the grid when comparing INTO the latest run (the grid
  // shows the latest run).
  const gridChanges =
    highlight && changes && changes.latest.run_id === latest?.run_id
      ? changes.changed_builds
      : undefined;

  return (
    <div className="flex h-screen flex-col bg-kumo-elevated text-kumo-default">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-line bg-kumo-base px-5 py-3">
        <div>
          <h1 className="text-base font-semibold">
            Rack Build Readiness Agent
          </h1>
          <p className="text-xs text-kumo-subtle">
            L10 supply vs L11 rack builds · 7 regions × 8 weeks · Workers AI
            (Llama 3.3) + Durable Objects + Workflows
          </p>
        </div>
        <span
          className={`text-xs ${connected ? "text-emerald-600" : "text-red-600"}`}
        >
          ● {connected ? "Connected" : "Connecting…"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          <nav className="mb-4 flex gap-1">
            {(
              [
                ["readiness", "Readiness"],
                ["changes", "What changed"],
                ["review", "Weekly review"]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  tab === id
                    ? "bg-kumo-contrast text-kumo-inverse"
                    : "hover:bg-kumo-control"
                }`}
              >
                {label}
                {id === "review" &&
                  state?.latestReview?.status === "pending_approval" && (
                    <span className="ml-1.5 rounded bg-amber-400 px-1 text-[10px] text-black">
                      needs approval
                    </span>
                  )}
              </button>
            ))}
          </nav>

          {tab === "readiness" && (
            <div className="space-y-4">
              <Card
                title={
                  latest
                    ? `Latest check #${latest.run_id} · ${fmtTime(latest.run_at)} (${latest.trigger})`
                    : "Latest check"
                }
                actions={
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act(() => agent.stub.runReadinessCheckNow())
                      }
                      className="rounded bg-kumo-brand px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Run check now
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            "Reset demo data? This clears runs and reviews (chat is kept)."
                          )
                        )
                          act(() => agent.stub.resetDemoData());
                      }}
                      className="rounded border border-kumo-line px-3 py-1 text-xs disabled:opacity-50"
                    >
                      Reset demo data
                    </button>
                  </>
                }
              >
                {latest && (
                  <div className="mb-3 flex flex-wrap gap-4 text-sm">
                    {(["ready", "at_risk", "blocked"] as const).map((s) => (
                      <div key={s} className="flex items-center gap-1.5">
                        <StatusPill status={s} />
                        <span className="font-semibold">{latest[s]}</span>
                        {changes && changes.latest.run_id === latest.run_id && (
                          <span className="text-xs text-kumo-subtle">
                            ({signed(changes.delta[s])} vs #
                            {changes.baseline.run_id})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {changes && (
                  <label className="mb-2 flex items-center gap-2 text-xs text-kumo-subtle">
                    <input
                      type="checkbox"
                      checked={highlight}
                      onChange={(e) => setHighlight(e.target.checked)}
                    />
                    Highlight changes vs check #{changes.baseline.run_id} (
                    {changes.changed_count} builds changed)
                  </label>
                )}
                <ReadinessGrid builds={builds} changes={gridChanges} />
              </Card>
            </div>
          )}

          {tab === "changes" && (
            <ChangesPanel cmp={cmp} runs={runs} onSelect={setPair} />
          )}

          {tab === "review" && (
            <ReviewPanel
              agent={agent}
              version={reviewVersion}
              onCompareRuns={(p) => {
                setPair(p);
                setTab("changes");
              }}
            />
          )}
        </main>

        <aside className="h-[28rem] border-t border-kumo-line bg-kumo-base lg:h-auto lg:w-[26rem] lg:border-l lg:border-t-0">
          <ChatPanel agent={agent} />
        </aside>
      </div>
    </div>
  );
}
