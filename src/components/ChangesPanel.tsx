/**
 * Week-to-week verification.
 *
 * Every readiness check is stored as an immutable snapshot (readiness_runs +
 * build_status). This panel diffs any two of them: count deltas, every build
 * whose status moved, and the exact issues that appeared or cleared. It also
 * shows the run history as a trend table. Because both sides are stored
 * snapshots (not recomputed), the diff is an audit trail anyone can re-check.
 */
import { Card, StatusPill, fmtTime, signed, type AgentConn } from "./ui";

export type Comparison = Awaited<
  ReturnType<AgentConn["stub"]["compareReadiness"]>
>;
export type RunRow = Awaited<
  ReturnType<AgentConn["stub"]["getRunHistory"]>
>[number];

const triggerLabel = (t: string) =>
  t === "baseline" ? "baseline (original commits)" : t;

/** Display-only: App fetches the comparison (the grid uses it too). */
export function ChangesPanel({
  cmp,
  runs,
  onSelect
}: {
  cmp: Comparison | null;
  runs: RunRow[];
  onSelect: (pair: { from: number; to: number }) => void;
}) {
  const select = (which: "from" | "to", id: number) => {
    if (!cmp || "error" in cmp) return;
    onSelect({
      from: which === "from" ? id : cmp.baseline.run_id,
      to: which === "to" ? id : cmp.latest.run_id
    });
  };

  const RunSelect = ({
    which,
    value
  }: {
    which: "from" | "to";
    value: number;
  }) => (
    <select
      aria-label={`Compare ${which}`}
      value={value}
      onChange={(e) => select(which, Number(e.target.value))}
      className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default"
    >
      {runs.map((r) => (
        <option key={r.run_id} value={r.run_id}>
          #{r.run_id} · {fmtTime(r.run_at)} · {triggerLabel(r.trigger)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-4">
      <Card title="Compare readiness checks">
        {!cmp ? (
          <p className="text-xs text-kumo-subtle">Loading…</p>
        ) : "error" in cmp ? (
          <p className="text-xs text-kumo-subtle">{cmp.error}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-kumo-subtle">From</span>
              <RunSelect which="from" value={cmp.baseline.run_id} />
              <span className="text-kumo-subtle">to</span>
              <RunSelect which="to" value={cmp.latest.run_id} />
            </div>
            {cmp.baseline_note && (
              <p className="mt-2 text-[11px] text-kumo-subtle">
                {cmp.baseline_note}
              </p>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {(["ready", "at_risk", "blocked"] as const).map((s) => (
                <div key={s} className="rounded-lg border border-kumo-line p-2">
                  <StatusPill status={s} />
                  <div className="mt-1 text-lg font-semibold text-kumo-default">
                    {cmp.latest[s]}
                  </div>
                  <div className="text-xs text-kumo-subtle">
                    was {cmp.baseline[s]} ({signed(cmp.delta[s])})
                  </div>
                </div>
              ))}
            </div>

            <h3 className="mt-4 mb-1 text-xs font-semibold text-kumo-default">
              {cmp.changed_count} builds changed status
            </h3>
            {cmp.changed_count === 0 ? (
              <p className="text-xs text-kumo-subtle">
                No status changes between these checks.
              </p>
            ) : (
              <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
                {cmp.changed_builds.map((b) => (
                  <div
                    key={b.build_id}
                    className="rounded-lg border border-kumo-line p-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={
                          b.direction === "worse"
                            ? "text-red-600"
                            : "text-emerald-600"
                        }
                      >
                        {b.direction === "worse" ? "▲ worse" : "▼ better"}
                      </span>
                      <span className="font-mono font-medium">
                        {b.build_id}
                      </span>
                      <StatusPill status={b.previous_status} />
                      <span>→</span>
                      <StatusPill status={b.status} />
                    </div>
                    {b.issues_added.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 text-kumo-default">
                        {b.issues_added.map((m) => (
                          <li key={m}>
                            <span className="text-red-600">new:</span> {m}
                          </li>
                        ))}
                      </ul>
                    )}
                    {b.issues_resolved.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 text-kumo-subtle">
                        {b.issues_resolved.map((m) => (
                          <li key={m}>
                            <span className="text-emerald-600">cleared:</span>{" "}
                            {m}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Check history">
        <table className="w-full text-xs">
          <thead className="text-kumo-subtle">
            <tr className="text-left">
              <th className="font-normal">Run</th>
              <th className="font-normal">When</th>
              <th className="font-normal">Trigger</th>
              <th className="font-normal text-right">Ready</th>
              <th className="font-normal text-right">At risk</th>
              <th className="font-normal text-right">Blocked</th>
            </tr>
          </thead>
          <tbody className="text-kumo-default">
            {runs.map((r) => (
              <tr key={r.run_id} className="border-t border-kumo-line">
                <td className="py-1">#{r.run_id}</td>
                <td>{fmtTime(r.run_at)}</td>
                <td>{triggerLabel(r.trigger)}</td>
                <td className="text-right">{r.ready}</td>
                <td className="text-right">{r.at_risk}</td>
                <td className="text-right">{r.blocked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
