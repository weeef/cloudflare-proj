/**
 * Seeding: turn the mock CSVs into database rows.
 *
 * Split in two on purpose:
 *  1. buildSeedRows(): pure function, CSV text + a date -> typed rows.
 *     No database, so it is trivially unit-testable.
 *  2. writeSeed(): takes those rows and an `exec` function and inserts them.
 *     `exec` is injected so the same code runs against the Durable Object's
 *     SQL API in production and Node's built-in sqlite in tests.
 *
 * WHY RELATIVE DATES
 * The CSVs store dates as "days after the week-1 Monday" instead of fixed
 * calendar dates. At seed time we pick week 1 = the coming Monday and convert.
 * That way the demo always shows "the next 8 weeks" no matter when someone
 * opens it, instead of a dataset that silently goes stale.
 */
import { parseCsv } from "./csv";
import { DATA_TABLES, RESULT_SCHEMA, RESULT_TABLES, SCHEMA } from "./schema";

/** Raw CSV text for each input file. */
export type SeedCsvs = {
  regions: string;
  parts: string;
  rackTypes: string;
  bom: string;
  forecast: string;
  suppliers: string;
  supply: string;
};

/** Executes one SQL statement with positional (?) bindings. */
export type SqlExec = (
  query: string,
  ...bindings: (string | number | null)[]
) => void;

/** Build day within a week: Monday + 3 = Thursday. */
const BUILD_DAY_OFFSET = 3;

// ── date helpers (all UTC so results don't depend on server timezone) ──

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** The Monday on or after `now` (today, if today is Monday). */
export function nextMonday(now: Date): string {
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const daysUntilMonday = (8 - day) % 7;
  return addDays(toIsoDate(now), daysUntilMonday);
}

/** Parse an integer column, failing loudly on bad data. */
function int(row: Record<string, string>, col: string): number {
  const n = Number(row[col]);
  if (!Number.isInteger(n)) {
    throw new Error(`Expected integer in column "${col}", got "${row[col]}"`);
  }
  return n;
}

export function buildSeedRows(csv: SeedCsvs, now: Date, dataVersion = "dev") {
  const week1Start = nextMonday(now);

  const regions = parseCsv(csv.regions).map((r) => ({
    code: r.code,
    name: r.name,
    geo: r.geo,
    priority: int(r, "priority")
  }));

  const parts = parseCsv(csv.parts).map((r) => ({
    part_number: r.part_number,
    description: r.description,
    category: r.category,
    direct_ship_ok: int(r, "direct_ship_ok")
  }));

  const rackTypes = parseCsv(csv.rackTypes).map((r) => ({
    rack_type: r.rack_type,
    description: r.description
  }));

  const bom = parseCsv(csv.bom).map((r) => ({
    rack_type: r.rack_type,
    part_number: r.part_number,
    qty_per_rack: int(r, "qty_per_rack")
  }));

  const forecast = parseCsv(csv.forecast).map((r) => {
    const week = int(r, "week");
    return {
      build_id: `${r.region}-W${week}-${r.rack_type}`,
      region: r.region,
      week,
      rack_type: r.rack_type,
      racks: int(r, "racks"),
      build_date: addDays(week1Start, (week - 1) * 7 + BUILD_DAY_OFFSET)
    };
  });

  const suppliers = parseCsv(csv.suppliers).map((r) => ({
    supplier_id: r.supplier_id,
    name: r.name,
    country: r.country,
    on_time_pct: int(r, "on_time_pct"),
    avg_slip_days: int(r, "avg_slip_days")
  }));

  const supply = parseCsv(csv.supply).map((r) => {
    const onHand = r.status === "on_hand";
    return {
      supplier_id: r.supplier_id,
      part_number: r.part_number,
      qty: int(r, "qty"),
      status: r.status,
      commit_date: onHand ? null : addDays(week1Start, int(r, "commit_day")),
      original_commit_date: onHand
        ? null
        : addDays(week1Start, int(r, "original_commit_day"))
    };
  });

  return {
    meta: {
      seeded_at: now.toISOString(),
      week1_start: week1Start,
      data_version: dataVersion
    },
    regions,
    parts,
    rackTypes,
    bom,
    forecast,
    suppliers,
    supply
  };
}

export type SeedRows = ReturnType<typeof buildSeedRows>;

/**
 * Create tables (if missing), wipe input data and old results, insert
 * fresh rows.
 * The caller should wrap this in a transaction so a failure halfway
 * through never leaves a half-seeded database.
 */
export function writeSeed(exec: SqlExec, rows: SeedRows) {
  for (const stmt of [...SCHEMA, ...RESULT_SCHEMA]) exec(stmt);
  // Old readiness results refer to the old dates, so a re-seed clears them too.
  for (const table of [...RESULT_TABLES, ...DATA_TABLES]) {
    exec(`DELETE FROM ${table}`);
  }

  for (const [key, value] of Object.entries(rows.meta)) {
    exec(`INSERT INTO meta (key, value) VALUES (?, ?)`, key, value);
  }
  for (const r of rows.regions) {
    exec(
      `INSERT INTO regions (code, name, geo, priority) VALUES (?, ?, ?, ?)`,
      r.code,
      r.name,
      r.geo,
      r.priority
    );
  }
  for (const r of rows.parts) {
    exec(
      `INSERT INTO parts (part_number, description, category, direct_ship_ok) VALUES (?, ?, ?, ?)`,
      r.part_number,
      r.description,
      r.category,
      r.direct_ship_ok
    );
  }
  for (const r of rows.rackTypes) {
    exec(
      `INSERT INTO rack_types (rack_type, description) VALUES (?, ?)`,
      r.rack_type,
      r.description
    );
  }
  for (const r of rows.bom) {
    exec(
      `INSERT INTO bom (rack_type, part_number, qty_per_rack) VALUES (?, ?, ?)`,
      r.rack_type,
      r.part_number,
      r.qty_per_rack
    );
  }
  for (const r of rows.forecast) {
    exec(
      `INSERT INTO forecast (build_id, region, week, rack_type, racks, build_date) VALUES (?, ?, ?, ?, ?, ?)`,
      r.build_id,
      r.region,
      r.week,
      r.rack_type,
      r.racks,
      r.build_date
    );
  }
  for (const r of rows.suppliers) {
    exec(
      `INSERT INTO suppliers (supplier_id, name, country, on_time_pct, avg_slip_days) VALUES (?, ?, ?, ?, ?)`,
      r.supplier_id,
      r.name,
      r.country,
      r.on_time_pct,
      r.avg_slip_days
    );
  }
  for (const r of rows.supply) {
    exec(
      `INSERT INTO supply (supplier_id, part_number, qty, status, commit_date, original_commit_date) VALUES (?, ?, ?, ?, ?, ?)`,
      r.supplier_id,
      r.part_number,
      r.qty,
      r.status,
      r.commit_date,
      r.original_commit_date
    );
  }
}
