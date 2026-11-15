/**
 * Seed tests: run the real schema + seed against an in-memory SQLite
 * database (Node's built-in node:sqlite). This catches SQL syntax errors,
 * broken foreign keys and bad CSV rows without deploying anything.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MOCK_CSVS } from "./data";
import { buildSeedRows, nextMonday, writeSeed } from "./seed";

// A fixed "today" so dates in assertions are stable: Wed 2026-11-18.
const NOW = new Date("2026-11-18T12:00:00Z");

function seededDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); // enforce REFERENCES clauses
  writeSeed(
    (q, ...b) => {
      db.prepare(q).run(...b);
    },
    buildSeedRows(MOCK_CSVS, NOW)
  );
  return db;
}

describe("nextMonday", () => {
  it("returns the coming Monday mid-week", () => {
    expect(nextMonday(new Date("2026-11-18T12:00:00Z"))).toBe("2026-11-23");
  });
  it("returns today when today is Monday", () => {
    expect(nextMonday(new Date("2026-11-23T08:00:00Z"))).toBe("2026-11-23");
  });
  it("handles Sunday", () => {
    expect(nextMonday(new Date("2026-11-22T08:00:00Z"))).toBe("2026-11-23");
  });
});

describe("seed", () => {
  it("loads every table with the expected row counts", () => {
    const db = seededDb();
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("regions")).toBe(7);
    expect(count("parts")).toBe(8);
    expect(count("rack_types")).toBe(3);
    expect(count("bom")).toBe(21);
    expect(count("forecast")).toBe(40);
    expect(count("suppliers")).toBe(7);
    expect(count("supply")).toBe(33);
  });

  it("anchors week 1 to the coming Monday and builds on Thursdays", () => {
    const db = seededDb();
    const w1 = db
      .prepare(`SELECT value FROM meta WHERE key = 'week1_start'`)
      .get() as { value: string };
    expect(w1.value).toBe("2026-11-23");

    const fraW3 = db
      .prepare(
        `SELECT build_date FROM forecast WHERE build_id = 'FRA-W3-COMPUTE'`
      )
      .get() as { build_date: string };
    expect(fraW3.build_date).toBe("2026-12-10"); // Mon 11-23 + 14 + 3
  });

  it("is re-runnable (reset) without duplicating rows", () => {
    const db = seededDb();
    writeSeed(
      (q, ...b) => {
        db.prepare(q).run(...b);
      },
      buildSeedRows(MOCK_CSVS, NOW)
    );
    const n = db.prepare(`SELECT COUNT(*) AS n FROM forecast`).get() as {
      n: number;
    };
    expect(n.n).toBe(40);
  });

  it("contains the designed problem: Nexwave switch commits have all slipped", () => {
    const db = seededDb();
    const slips = db
      .prepare(
        `SELECT julianday(commit_date) - julianday(original_commit_date) AS slip
         FROM supply WHERE supplier_id = 'NXW' AND status = 'committed'`
      )
      .all() as { slip: number }[];
    expect(slips.length).toBeGreaterThan(0);
    expect(slips.every((s) => s.slip > 0)).toBe(true);
  });

  it("every BOM part has at least one supply lot", () => {
    const db = seededDb();
    const orphans = db
      .prepare(
        `SELECT DISTINCT b.part_number FROM bom b
         LEFT JOIN supply s ON s.part_number = b.part_number
         WHERE s.lot_id IS NULL`
      )
      .all();
    expect(orphans).toEqual([]);
  });
});
