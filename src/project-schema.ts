import { sql } from "~/db";

/**
 * ATLAS AI — shared project-memory schema (Phase 1).
 *
 * Every analysis starts with a `projects` row; everything else hangs off it.
 * The design goal is full traceability: each fact carries a confidence score
 * and an optional source, each pipeline step has a row in `pipeline_runs`,
 * and user decisions are recorded so a project can be resumed where it left
 * off and nothing is a black box.
 *
 * ── projects ────────────────────────────────────────────────────────────
 * One row per analysis. `status` lifecycle:
 *   created   → row created, pipeline not started
 *   running   → pipeline executing
 *   complete  → all steps finished (some may be `pending` — see
 *               pipeline_runs — meaning they are stubs awaiting later phases)
 *   failed    → at least one step errored
 * `updated_at` is refreshed on every status change (set in code; no trigger).
 *
 * ── sources ─────────────────────────────────────────────────────────────
 * Every source consulted for a project (a website, an API, a document, or
 * user-supplied input). `url` is nullable for non-URL sources (e.g. a
 * physical document or the user-entered address). `fetched_at` records when
 * the source was retrieved; `notes` is free text (licence terms, access
 * method, reason for inclusion…).
 *
 * ── facts ───────────────────────────────────────────────────────────────
 * Every extracted fact about the property, stored as a string `value`.
 * `category` groups facts (address, planning, epc, market, …), `key` names
 * the fact (normalised, postcode, use_class, …). `confidence` is 0..1 — the
 * platform never overclaims (e.g. planning 1.0, geometry 0.93). `source_id`
 * links the fact to the source it came from (nullable: some facts are
 * inferred, not read from a source).
 *
 * ── decisions ───────────────────────────────────────────────────────────
 * User decisions taken during a project ("which concept to develop further"),
 * recorded with the step that triggered them and the rationale, so sessions
 * can be replayed/resumed and every choice is traceable.
 *
 * ── pipeline_runs ───────────────────────────────────────────────────────
 * One row per step per pipeline execution. `status`:
 *   running  → step is executing right now
 *   done     → step completed and wrote its artifacts
 *   pending  → step not implemented yet (stub) — recorded so the loop is
 *              provably complete end-to-end and later steps are drop-in
 *   error    → step threw; `error` holds the message
 * `started_at`/`finished_at` bracket the step.
 *
 * ── price_paid ──────────────────────────────────────────────────────────
 * GLOBAL (cross-project) local index of HM Land Registry Price Paid data —
 * completed, registered sale prices only (never asking prices), OGL licence.
 * Imported from the free monthly CSV by scripts/import-price-paid.ts
 * (idempotent batch inserts, ON CONFLICT DO NOTHING). Not keyed to projects:
 * the collection pipeline step queries it for the project's postcode/sector.
 *
 * Tables are created with CREATE TABLE IF NOT EXISTS (the same pattern as the
 * waitlist table) and enforced lazily via ensureSchema() before first use —
 * no migration tooling.
 */

let schemaReady = false;

/** Create the project-memory tables if they don't exist yet. Idempotent. */
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const db = sql();
  await db`
    CREATE TABLE IF NOT EXISTS projects (
      id BIGSERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS sources (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS facts (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_id BIGINT REFERENCES sources(id) ON DELETE SET NULL
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS decisions (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      choice TEXT NOT NULL,
      rationale TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      error TEXT
    )`;
  await db`
    CREATE INDEX IF NOT EXISTS idx_sources_project ON sources (project_id)`;
  await db`
    CREATE INDEX IF NOT EXISTS idx_facts_project ON facts (project_id)`;
  await db`
    CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions (project_id)`;
  await db`
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project ON pipeline_runs (project_id)`;

  // Global Price Paid comparables index (see header comment). CREATE TABLE IF
  // NOT EXISTS + ON CONFLICT DO NOTHING imports make this safe to run anywhere,
  // any number of times.
  await db`
    CREATE TABLE IF NOT EXISTS price_paid (
      transaction_id TEXT PRIMARY KEY,
      price INTEGER NOT NULL,
      transfer_date DATE NOT NULL,
      postcode TEXT NOT NULL,
      property_type TEXT,
      new_build BOOLEAN,
      tenure TEXT,
      locality TEXT,
      town_city TEXT,
      district TEXT,
      county TEXT
    )`;
  await db`
    CREATE INDEX IF NOT EXISTS idx_price_paid_postcode ON price_paid (postcode)`;
  await db`
    CREATE INDEX IF NOT EXISTS idx_price_paid_transfer_date ON price_paid (transfer_date)`;

  schemaReady = true;
}

/**
 * Coerce a database value to a JSON-safe string, or null when the value is
 * NULL. Timestamps come back from Neon as JS Dates, which React will not
 * render — always pass rows through this before returning them to a client
 * component (SITE.md / db.ts guidance).
 */
export function toJson(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Map query rows, coercing the named date columns (and id bigints) to strings. */
export function rowsToJson(rows: Record<string, unknown>[], dateCols: string[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = dateCols.includes(k) ? toJson(v) : v;
    }
    return out;
  });
}
