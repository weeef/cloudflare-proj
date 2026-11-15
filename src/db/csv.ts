/**
 * Minimal CSV parser for our mock data files.
 *
 * Deliberately tiny: our CSVs have a header row, comma separators and no
 * quoted fields or embedded commas. Pulling in a CSV library for that would
 * add bundle weight to the Worker for no benefit. If the data ever came from
 * a real ERP export, swap this for a proper parser (e.g. papaparse).
 *
 * Returns one object per row, keyed by the header names. All values are
 * strings; callers convert numbers explicitly so bad data fails loudly.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const headers = lines[0].split(",");
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== headers.length) {
      throw new Error(
        `CSV row ${i + 2} has ${cells.length} cells, expected ${headers.length}: "${line}"`
      );
    }
    return Object.fromEntries(headers.map((h, j) => [h, cells[j]]));
  });
}
