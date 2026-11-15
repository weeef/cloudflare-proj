/**
 * SQLite schema for the agent's private database.
 *
 * Every Durable Object declared with `new_sqlite_classes` (see wrangler.jsonc)
 * gets its own embedded SQLite database. It lives with the object, so queries
 * are local function calls, not network round trips.
 *
 * Tables in this file are the *input* data (what a planner would pull from an
 * ERP / supplier portal). Output tables (readiness results, weekly reviews)
 * are added in later steps.
 *
 * Conventions:
 *  - Dates are ISO strings "YYYY-MM-DD" (SQLite has no native date type, and
 *    ISO strings sort correctly as text).
 *  - Booleans are INTEGER 0/1 (SQLite has no boolean type).
 *  - One statement per array entry, so the same list runs on both the
 *    Durable Object SQL API and Node's sqlite module in tests.
 */
export const SCHEMA: string[] = [
  // Key/value facts about the dataset, e.g. when it was seeded and which
  // Monday "week 1" refers to.
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Data center regions that receive rack builds. priority 1 = most critical.
  // Lower-priority regions are candidates to give up parts in a reallocation.
  `CREATE TABLE IF NOT EXISTS regions (
    code     TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    geo      TEXT NOT NULL,          -- EU | APAC | NA
    priority INTEGER NOT NULL
  )`,

  // Part master. direct_ship_ok = can ship straight to the data center as
  // loose L10 hardware instead of waiting for L11 full-rack integration.
  `CREATE TABLE IF NOT EXISTS parts (
    part_number    TEXT PRIMARY KEY,
    description    TEXT NOT NULL,
    category       TEXT NOT NULL,    -- server | switch | pdu | optics | cable | frame
    direct_ship_ok INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS rack_types (
    rack_type   TEXT PRIMARY KEY,
    description TEXT NOT NULL
  )`,

  // Bill of materials: how many of each part one rack of a given type needs.
  `CREATE TABLE IF NOT EXISTS bom (
    rack_type    TEXT NOT NULL REFERENCES rack_types(rack_type),
    part_number  TEXT NOT NULL REFERENCES parts(part_number),
    qty_per_rack INTEGER NOT NULL,
    PRIMARY KEY (rack_type, part_number)
  )`,

  // Demand from Capacity Planning: racks needed per region per week.
  // Each row is one "build" that the readiness engine assesses.
  `CREATE TABLE IF NOT EXISTS forecast (
    build_id   TEXT PRIMARY KEY,     -- e.g. FRA-W3-COMPUTE
    region     TEXT NOT NULL REFERENCES regions(code),
    week       INTEGER NOT NULL,     -- 1..8, relative to meta.week1_start
    rack_type  TEXT NOT NULL REFERENCES rack_types(rack_type),
    racks      INTEGER NOT NULL,
    build_date TEXT NOT NULL         -- date the integrator starts the L11 build
  )`,

  // Supplier master with historical delivery performance.
  `CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id   TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    country       TEXT NOT NULL,
    on_time_pct   INTEGER NOT NULL,  -- % of past deliveries on/before commit date
    avg_slip_days INTEGER NOT NULL   -- average days late when they are late
  )`,

  // Supply "lots": either stock already on hand at the integrator, or a
  // supplier commitment to deliver qty by commit_date. original_commit_date
  // is what they first promised; the gap between the two is slip history.
  `CREATE TABLE IF NOT EXISTS supply (
    lot_id               INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id          TEXT NOT NULL REFERENCES suppliers(supplier_id),
    part_number          TEXT NOT NULL REFERENCES parts(part_number),
    qty                  INTEGER NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('on_hand', 'committed')),
    commit_date          TEXT,       -- NULL when on_hand
    original_commit_date TEXT        -- NULL when on_hand
  )`
];

/** Input tables, in an order that is safe to delete from (children first). */
export const DATA_TABLES = [
  "supply",
  "forecast",
  "bom",
  "suppliers",
  "rack_types",
  "parts",
  "regions",
  "meta"
] as const;

/**
 * Output tables: results of each readiness check.
 *
 * Every run is kept (not overwritten), so the agent can answer
 * "what changed since last week?" by diffing two runs. That history is part
 * of the agent's memory alongside chat messages and past weekly reviews.
 */
export const RESULT_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS readiness_runs (
    run_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at   TEXT NOT NULL,          -- ISO timestamp the check ran
    as_of    TEXT NOT NULL,          -- the "today" date it assessed against
    trigger  TEXT NOT NULL,          -- seed | baseline | daily | manual
    total    INTEGER NOT NULL,
    ready    INTEGER NOT NULL,
    at_risk  INTEGER NOT NULL,
    blocked  INTEGER NOT NULL
  )`,

  // One row per build per run. issues_json holds the engine's Issue[] so the
  // UI and LLM get the exact reasons (part, qty, supplier, days).
  `CREATE TABLE IF NOT EXISTS build_status (
    run_id      INTEGER NOT NULL REFERENCES readiness_runs(run_id),
    build_id    TEXT NOT NULL,
    region      TEXT NOT NULL,
    week        INTEGER NOT NULL,
    rack_type   TEXT NOT NULL,
    racks       INTEGER NOT NULL,
    build_date  TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('ready', 'at_risk', 'blocked')),
    issues_json TEXT NOT NULL,
    PRIMARY KEY (run_id, build_id)
  )`
];

/** Output tables, children first (safe delete order). */
export const RESULT_TABLES = ["build_status", "readiness_runs"] as const;
