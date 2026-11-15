/**
 * Small shared UI pieces: status colours/labels, card shell, and the type of
 * the agent connection every panel receives.
 */
import type { ReactNode } from "react";
import type { useAgent } from "agents/react";
import type { AgentState, RackOpsAgent } from "../agent";
import type { Status } from "../engine/readiness";

/** The live WebSocket connection to the RackOpsAgent (one per page). */
export type AgentConn = ReturnType<typeof useAgent<RackOpsAgent, AgentState>>;

export const STATUS_LABEL: Record<Status, string> = {
  ready: "Ready",
  at_risk: "At risk",
  blocked: "Blocked"
};

/** Solid colours that read in both light and dark mode. */
export const STATUS_BG: Record<Status, string> = {
  ready: "bg-emerald-500 text-white",
  at_risk: "bg-amber-400 text-black",
  blocked: "bg-red-600 text-white"
};

export function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BG[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Card({
  title,
  actions,
  children
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-base p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-kumo-default">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
