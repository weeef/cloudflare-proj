/**
 * Region × week grid, coloured by the worst status of the builds in each
 * cell. Click a cell to see its builds and the engine's reasons.
 *
 * When a comparison is active (`changes`), cells whose status changed get a
 * ring and an arrow (▲ worse / ▼ better) so week-to-week movement is visible
 * at a glance.
 */
import { useState } from "react";
import type { StoredBuildStatus } from "../engine/persist";
import type { Status } from "../engine/readiness";
import { STATUS_BG, StatusPill } from "./ui";

const REGIONS = [
  { code: "FRA", geo: "EU" },
  { code: "LHR", geo: "EU" },
  { code: "AMS", geo: "EU" },
  { code: "SIN", geo: "APAC" },
  { code: "NRT", geo: "APAC" },
  { code: "IAD", geo: "NA" },
  { code: "SEA", geo: "NA" }
];
const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8];
const RANK: Record<Status, number> = { ready: 0, at_risk: 1, blocked: 2 };

export type ChangeMark = { build_id: string; direction: string };

export function ReadinessGrid({
  builds,
  changes
}: {
  builds: StoredBuildStatus[];
  changes?: ChangeMark[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const changeById = new Map((changes ?? []).map((c) => [c.build_id, c]));
  const cell = (region: string, week: number) =>
    builds.filter((b) => b.region === region && b.week === week);
  const dateOf = (week: number) =>
    builds.find((b) => b.week === week)?.build_date;
  const selectedBuilds = selected
    ? builds.filter((b) => `${b.region}-${b.week}` === selected)
    : [];

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="text-left text-kumo-subtle font-normal">Region</th>
              {WEEKS.map((w) => (
                <th key={w} className="font-normal text-kumo-subtle">
                  W{w}
                  <div className="text-[10px]">{dateOf(w)?.slice(5)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {REGIONS.map((r) => (
              <tr key={r.code}>
                <td className="pr-2 font-medium text-kumo-default">
                  {r.code} <span className="text-kumo-subtle">{r.geo}</span>
                </td>
                {WEEKS.map((w) => {
                  const bs = cell(r.code, w);
                  if (bs.length === 0) {
                    return (
                      <td
                        key={w}
                        aria-label={`${r.code} week ${w}: no build`}
                        className="h-10 rounded bg-kumo-control"
                      />
                    );
                  }
                  const worst = bs.reduce<Status>(
                    (acc, b) => (RANK[b.status] > RANK[acc] ? b.status : acc),
                    "ready"
                  );
                  const changed = bs
                    .map((b) => changeById.get(b.build_id))
                    .filter(Boolean);
                  const worse = changed.some((c) => c!.direction === "worse");
                  const key = `${r.code}-${w}`;
                  return (
                    <td key={w} className="p-0">
                      <button
                        type="button"
                        onClick={() =>
                          setSelected(selected === key ? null : key)
                        }
                        title={bs
                          .map((b) => `${b.build_id}: ${b.status}`)
                          .join("\n")}
                        className={`h-10 w-full rounded font-medium ${STATUS_BG[worst]} ${
                          changed.length
                            ? "ring-2 ring-offset-1 ring-kumo-contrast"
                            : ""
                        } ${selected === key ? "outline outline-2 outline-kumo-brand" : ""}`}
                      >
                        {bs.reduce((n, b) => n + b.racks, 0)}
                        {changed.length > 0 && (
                          <span className="ml-0.5">{worse ? "▲" : "▼"}</span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-kumo-subtle">
        Number = racks to build.{" "}
        {changes ? "Ringed cells changed (▲ worse, ▼ better)." : ""} Click a
        cell for details.
      </p>

      {selectedBuilds.length > 0 && (
        <div className="mt-3 space-y-2">
          {selectedBuilds.map((b) => (
            <div
              key={b.build_id}
              className="rounded-lg border border-kumo-line p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-medium">{b.build_id}</span>
                <StatusPill status={b.status} />
                <span className="text-kumo-subtle">
                  {b.racks} racks · build {b.build_date}
                </span>
              </div>
              {b.issues.length === 0 ? (
                <p className="mt-1 text-xs text-kumo-subtle">
                  All parts covered with buffer.
                </p>
              ) : (
                <ul className="mt-1 list-disc pl-5 text-xs text-kumo-default">
                  {b.issues.map((i, n) => (
                    <li key={n}>
                      <span
                        className={
                          i.severity === "blocked" ? "text-red-600" : ""
                        }
                      >
                        {i.message.replace(`${b.build_id}: `, "")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
