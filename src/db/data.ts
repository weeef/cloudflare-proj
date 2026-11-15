/**
 * Bundles the mock CSV files into the Worker at build time.
 *
 * Vite's `?raw` suffix imports a file's contents as a plain string, so the
 * CSVs ship inside the deployed Worker. No file system or R2 bucket is needed
 * at runtime. To change the demo data, edit /data/*.csv and redeploy.
 */
import regions from "../../data/regions.csv?raw";
import parts from "../../data/parts.csv?raw";
import rackTypes from "../../data/rack_types.csv?raw";
import bom from "../../data/bom.csv?raw";
import forecast from "../../data/forecast.csv?raw";
import suppliers from "../../data/suppliers.csv?raw";
import supply from "../../data/supply.csv?raw";
import type { SeedCsvs } from "./seed";

/**
 * Bump this whenever any CSV (or what seeding produces) changes. On start-up, an agent seeded with an
 * older version re-seeds itself, so a deploy with new data takes effect
 * without a manual reset. (Chat history lives in separate tables and is kept.)
 */
export const DATA_VERSION = "3"; // 3: seed also records a baseline run

export const MOCK_CSVS: SeedCsvs = {
  regions,
  parts,
  rackTypes,
  bom,
  forecast,
  suppliers,
  supply
};
