import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { ensureSchema } from "~/project-schema";

/**
 * Import the HM Land Registry Price Paid monthly CSV into the local
 * `price_paid` comparables index.
 *
 * Usage:  bun scripts/import-price-paid.ts [path/to/pp-monthly.csv]
 *         (defaults to /home/team/shared/data/pp-monthly.csv; DATABASE_URL
 *         comes from .env — bun loads it automatically from the repo root)
 *
 * Source: https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads
 * Licence: Open Government Licence v3 (free for commercial use with attribution).
 *
 * Policy (documented in the project schema header):
 *  - Only rows with PPD category "A" (standard open-market price paid) and
 *    record status "A" (added) are imported. Category "B" rows (right-to-buy,
 *    part-exchange, portfolio transfers etc.) are not open-market comparables;
 *    record status "C" (changed) and "D" (deleted) rows do not represent
 *    distinct completed sales. Skipped rows are counted and reported.
 *  - Idempotent: batches use ON CONFLICT DO NOTHING keyed on transaction_id,
 *    so re-running (e.g. with a newer monthly file) only adds new rows.
 *
 * Memory-conscious: rows are read line-by-line (no full-file parse in memory)
 * and inserted in small batches over the Neon HTTP driver.
 */

const CSV_PATH = process.argv[2] ?? "/home/team/shared/data/pp-monthly.csv";
const BATCH_SIZE = 500;
const COLUMNS =
  "transaction_id, price, transfer_date, postcode, property_type, new_build, tenure, locality, town_city, district, county";

/** Minimal RFC4180 parser — HMLR CSVs quote every field, commas included. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

/** Normalise "2021-04-22 00:00" or "22/04/2021 00:00" to "2021-04-22". */
function normaliseDate(raw: string): string {
  const token = raw.trim().split(/\s+/)[0] ?? "";
  if (token.includes("-")) return token; // already yyyy-mm-dd
  const [d, m, y] = token.split("/");
  return `${y}-${m}-${d}`;
}

/** Uppercase, collapse whitespace, keep the standard single space: SE19 3AT. */
function normalisePostcode(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

interface Row {
  transaction_id: string;
  price: number;
  transfer_date: string;
  postcode: string;
  property_type: string;
  new_build: boolean;
  tenure: string;
  locality: string;
  town_city: string;
  district: string;
  county: string;
}

async function main() {
  const raw = readFileSync(CSV_PATH, "utf8");
  const lines = raw.split("\n");
  console.log(`Reading ${CSV_PATH}: ${lines.length} lines (${(raw.length / 1e6).toFixed(1)} MB)`);

  const db = neon(process.env.DATABASE_URL ?? "");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  await ensureSchema();

  const rows: Row[] = [];
  let skipped = 0;
  let malformed = 0;
  let inserted = 0;
  let batches = 0;

  const flush = async () => {
    if (rows.length === 0) return;
    const placeholders = rows
      .map((_, i) => `($${i * 11 + 1}, $${i * 11 + 2}, $${i * 11 + 3}, $${i * 11 + 4}, $${i * 11 + 5}, $${i * 11 + 6}, $${i * 11 + 7}, $${i * 11 + 8}, $${i * 11 + 9}, $${i * 11 + 10}, $${i * 11 + 11})`)
      .join(", ");
    const params = rows.flatMap((r) => [
      r.transaction_id, r.price, r.transfer_date, r.postcode, r.property_type,
      r.new_build, r.tenure, r.locality, r.town_city, r.district, r.county,
    ]);
    const created = await db.query(
      `INSERT INTO price_paid (${COLUMNS}) VALUES ${placeholders} ON CONFLICT DO NOTHING RETURNING transaction_id`,
      params,
    );
    inserted += created.length;
    batches++;
    if (batches % 10 === 0) console.log(`  ${batches} batches — ${inserted} rows inserted so far`);
    rows.length = 0;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 16) {
      malformed++;
      continue;
    }
    // f[14] = PPD category (A standard / B additional), f[15] = record status
    // (A added / C changed / D deleted). Only standard, added rows are kept.
    if (f[14] !== "A" || f[15] !== "A") {
      skipped++;
      continue;
    }
    rows.push({
      transaction_id: f[0],
      price: Number.parseInt(f[1], 10),
      transfer_date: normaliseDate(f[2]),
      postcode: normalisePostcode(f[3]),
      property_type: f[4],
      new_build: f[5] === "Y",
      tenure: f[6],
      locality: f[10],
      town_city: f[11],
      district: f[12],
      county: f[13],
    });
    if (rows.length >= BATCH_SIZE) await flush();
  }
  await flush(); // trailing partial batch

  const [totals] = await db.query("SELECT COUNT(*)::int AS n FROM price_paid");
  const [coverage] = await db.query(
    "SELECT MIN(transfer_date)::text AS min_d, MAX(transfer_date)::text AS max_d FROM price_paid",
  );
  console.log("── Import complete ──────────────────────────────");
  console.log(`  rows parsed:        ${lines.length - 1}`);
  console.log(`  inserted (new):     ${inserted}`);
  console.log(`  skipped (B/C/D):    ${skipped}`);
  console.log(`  malformed:          ${malformed}`);
  console.log(`  total in table:     ${totals?.n ?? 0}`);
  console.log(`  coverage:           ${coverage?.min_d ?? "?"} → ${coverage?.max_d ?? "?"}`);
}

main().catch((err) => {
  console.error("Import failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
