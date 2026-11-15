/**
 * Weekly review: start a review, read the report, inspect email drafts, and
 * approve / reject. Approve/reject call the agent, which resumes the paused
 * Workflow; the status updates arrive back via agent state.
 *
 * "Compare to previous review" jumps to the What-changed tab with the two
 * reviews' underlying readiness runs selected: week-to-week verification of
 * what leadership was told.
 */
import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { Card, fmtTime, type AgentConn } from "./ui";

type ReviewRow = Awaited<ReturnType<AgentConn["stub"]["getReviews"]>>[number];
type ReviewFull = NonNullable<
  Awaited<ReturnType<AgentConn["stub"]["getReviewDetail"]>>
>;

const STATUS_STYLE: Record<string, string> = {
  drafting: "bg-kumo-control text-kumo-default",
  pending_approval: "bg-amber-400 text-black",
  approved: "bg-emerald-500 text-white",
  rejected: "bg-red-600 text-white",
  expired: "bg-kumo-control text-kumo-subtle",
  failed: "bg-red-600 text-white"
};

function ReviewBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function ReviewPanel({
  agent,
  version,
  onCompareRuns
}: {
  agent: AgentConn;
  /** Changes whenever agent state reports a review update. */
  version: string;
  onCompareRuns: (pair: { from: number; to: number }) => void;
}) {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReviewFull | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    agent.stub.getReviews().then(setReviews).catch(console.error);
  }, [agent, version]);

  const current = selectedId ?? reviews[0]?.review_id ?? null;
  useEffect(() => {
    if (current === null) {
      setDetail(null);
      return;
    }
    agent.stub
      .getReviewDetail(current)
      .then((d) => setDetail(d))
      .catch(console.error);
  }, [agent, current, version]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = (await fn()) as { reason?: string } | undefined;
      if (r?.reason) setMessage(r.reason);
      setNote("");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  // The review before this one (with a run) for the week-to-week comparison.
  const idx = reviews.findIndex((r) => r.review_id === current);
  const previous = reviews.slice(idx + 1).find((r) => r.run_id);

  return (
    <div className="space-y-4">
      <Card
        title="Weekly shortage reviews"
        actions={
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => agent.stub.startWeeklyReview("manual"))}
            className="rounded bg-kumo-brand px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Run weekly review now
          </button>
        }
      >
        <p className="mb-2 text-[11px] text-kumo-subtle">
          Runs automatically Mondays 07:00 UTC. Llama 3.3 drafts the report and
          supplier emails from engine-computed facts; nothing is sent until
          approved.
        </p>
        {message && <p className="mb-2 text-xs text-amber-600">{message}</p>}
        {reviews.length === 0 ? (
          <p className="text-xs text-kumo-subtle">No reviews yet.</p>
        ) : (
          <ul className="space-y-1">
            {reviews.map((r) => (
              <li key={r.review_id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.review_id)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                    r.review_id === current ? "bg-kumo-control" : ""
                  }`}
                >
                  <span className="font-medium">#{r.review_id}</span>
                  <span className="text-kumo-subtle">
                    {fmtTime(r.created_at)}
                  </span>
                  <ReviewBadge status={r.status} />
                  {r.report_source === "fallback" && (
                    <span className="text-[10px] text-kumo-subtle">
                      (no-AI fallback)
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {detail && (
        <Card
          title={`Review #${detail.review_id}${detail.run_id ? ` · based on check #${detail.run_id}` : ""}`}
          actions={
            previous?.run_id && detail.run_id ? (
              <button
                type="button"
                onClick={() =>
                  onCompareRuns({ from: previous.run_id!, to: detail.run_id! })
                }
                className="rounded border border-kumo-line px-2 py-1 text-xs"
              >
                Compare to review #{previous.review_id}
              </button>
            ) : undefined
          }
        >
          {detail.status === "pending_approval" && (
            <div className="mb-3 rounded-lg border-2 border-amber-400 p-3">
              <p className="mb-2 text-xs font-medium">
                Awaiting your approval. Approving releases{" "}
                {detail.emails.length} supplier email
                {detail.emails.length === 1 ? "" : "s"}.
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Decision note (optional)"
                  aria-label="Decision note"
                  className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      agent.stub.approveReview(
                        detail.review_id,
                        note || undefined
                      )
                    )
                  }
                  className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      agent.stub.rejectReview(
                        detail.review_id,
                        note || undefined
                      )
                    )
                  }
                  className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          )}
          {detail.decided_at && (
            <p className="mb-2 text-xs text-kumo-subtle">
              <ReviewBadge status={detail.status} />{" "}
              {fmtTime(detail.decided_at)}
              {detail.decision_note ? `: "${detail.decision_note}"` : ""}
            </p>
          )}

          {detail.report_md ? (
            <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-kumo-line p-3 text-sm">
              <Streamdown className="sd-theme" controls={false}>
                {detail.report_md}
              </Streamdown>
            </div>
          ) : (
            <p className="text-xs text-kumo-subtle">Drafting report…</p>
          )}

          {detail.emails.length > 0 && (
            <div className="mt-3 space-y-2">
              <h3 className="text-xs font-semibold">
                Supplier escalation drafts
              </h3>
              {detail.emails.map((e) => (
                <details
                  key={e.supplier_id}
                  className="rounded-lg border border-kumo-line p-2 text-xs"
                >
                  <summary className="cursor-pointer">
                    <span className="font-medium">{e.supplier_name}</span>:{" "}
                    {e.subject}{" "}
                    <span className="text-kumo-subtle">[{e.status}]</span>
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap font-sans">
                    {e.body}
                  </pre>
                </details>
              ))}
            </div>
          )}

          {detail.facts && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-kumo-subtle">
                Facts given to the LLM (audit)
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-kumo-control p-2 font-mono text-[11px]">
                {JSON.stringify(detail.facts, null, 2)}
              </pre>
            </details>
          )}
        </Card>
      )}
    </div>
  );
}
