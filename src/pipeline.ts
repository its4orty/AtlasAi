import { sql } from "~/db";
import { ensureSchema, toJson, rowsToJson } from "~/project-schema";

/**
 * ATLAS AI — analysis pipeline runner (Phase 1).
 *
 * runPipeline(address) creates a `projects` row and executes the ordered step
 * list below. Every step writes its artifacts into project memory:
 *   - a `pipeline_runs` row per step (status: running → done | pending | error)
 *   - any `facts` / `sources` the step extracted
 * so a project's memory is a complete, resumable record of the work done.
 *
 * Pipeline order (later phases drop in behind the stubs):
 *   1. normalise     — REAL: address normalisation & validation (local only)
 *   2. discovery     — REAL: find public sources for the address
 *   3. collection    — REAL: comparables evidence from the local Price Paid index
 *   4. intelligence  — STUB: extract structured facts with confidence scores
 *   5. feasibility   — STUB: financial pro-forma (ROI, cashflow, sensitivity)
 *   6. report        — STUB: render the evidence-backed feasibility report
 */

type Db = ReturnType<typeof sql>;

export interface StepContext {
  db: Db;
  projectId: string;
  address: string;
}

export interface FactOut {
  category: string;
  key: string;
  value: string;
  confidence: number;
  sourceId: string | null;
}

export interface SourceOut {
  name: string;
  url: string | null;
  notes: string | null;
}

export interface StepOutput {
  note?: string;
  facts?: FactOut[];
  sources?: SourceOut[];
}

export interface PipelineStepDef {
  name: string;
  title: string;
  implemented: boolean;
  run: (ctx: StepContext, runId: string) => Promise<{ status: "done" | "pending"; output: StepOutput }>;
}

export interface StepRunResult {
  id: string;
  step: string;
  status: string;
  error: string | null;
  output: StepOutput;
}

/* ------------------------------------------------------------------ */
/* Step implementations                                                */
/* ------------------------------------------------------------------ */

/** REAL step — normalise + validate the submitted address, locally, free. */
const normaliseStep: PipelineStepDef = {
  name: "normalise",
  title: "Address normalisation & validation",
  implemented: true,
  run: async (ctx) => {
    const raw = ctx.address.trim().replace(/\s+/g, " ");
    const upper = raw.toUpperCase();
    // UK postcode, e.g. SW1A 1AA / SE19 3AT / W1U 3BW / M1 1AE. Normalise case
    // and spacing. [A-Z0-9]? (not just [A-Z]?) covers two-digit areas like SE19.
    const postcodeMatch = upper.match(/\b[A-Z]{1,2}\d[A-Z0-9]?\s*\d[A-Z]{2}\b/);
    const postcode = postcodeMatch ? postcodeMatch[0].replace(/\s+/g, " ") : null;
    const normalised = postcode && postcodeMatch ? raw.replace(postcodeMatch[0], postcode) : raw;
    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    const valid = wordCount >= 3 && raw.length >= 8;
    // Confidence scoring — the platform never overclaims. A well-formed UK
    // address with a detected postcode is high-confidence; otherwise lower.
    const confidence = postcode ? 0.95 : valid ? 0.7 : 0.4;

    // Record the provenance: the fact came from user input, not an external
    // source (no external fetching in this phase).
    const [source] = await ctx.db`
      INSERT INTO sources (project_id, name, url, notes)
      VALUES (${ctx.projectId}, 'user-provided address', NULL,
        'Address submitted by the user in the /analyse form. Not yet verified against an external address source (discovery step pending).')
      RETURNING id`;
    const sourceId = String(source.id);

    const facts: FactOut[] = [
      { category: "address", key: "raw", value: raw, confidence: 1, sourceId },
      { category: "address", key: "normalised", value: normalised, confidence, sourceId },
    ];
    if (postcode) facts.push({ category: "address", key: "postcode", value: postcode, confidence: 0.99, sourceId });
    facts.push({ category: "address", key: "valid", value: valid ? "yes" : "no", confidence, sourceId });

    for (const f of facts) {
      await ctx.db`
        INSERT INTO facts (project_id, category, key, value, confidence, source_id)
        VALUES (${ctx.projectId}, ${f.category}, ${f.key}, ${f.value}, ${f.confidence}, ${f.sourceId})`;
    }

    return {
      status: "done",
      output: {
        note: "Address normalised and validated locally (no external lookup in this phase).",
        facts,
        sources: [
          {
            name: "user-provided address",
            url: null,
            notes: "Address submitted by the user in the /analyse form.",
          },
        ],
      },
    };
  },
};

const postcodeCache = new Map<string, Record<string, unknown>>();
const DISCOVERY_TIMEOUT_MS = 12_000;

async function fetchJson(url: string): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), headers: { accept: "application/json" } });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { response, json };
}

/** REAL step — free, evidence-backed screening lookups. Each provider is isolated. */
const discoveryStep: PipelineStepDef = {
  name: "discovery", title: "Property discovery", implemented: true,
  run: async (ctx) => {
    const facts: FactOut[] = [];
    const sources: SourceOut[] = [];
    const add = async (name: string, url: string | null, notes: string, values: Array<[string, string, number]> = []) => {
      const [row] = await ctx.db`INSERT INTO sources (project_id, name, url, notes) VALUES (${ctx.projectId}, ${name}, ${url}, ${notes}) RETURNING id`;
      const sourceId = String(row.id);
      sources.push({ name, url, notes });
      for (const [key, value, confidence] of values) {
        const fact = { category: "discovery", key, value, confidence, sourceId };
        facts.push(fact);
        await ctx.db`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${ctx.projectId}, ${fact.category}, ${key}, ${value}, ${confidence}, ${sourceId})`;
      }
    };
    const [postcodeRow] = await ctx.db`SELECT value FROM facts WHERE project_id = ${ctx.projectId} AND category = 'address' AND key = 'postcode' ORDER BY id DESC LIMIT 1`;
    const postcode = postcodeRow?.value ? String(postcodeRow.value) : null;
    let geo: Record<string, unknown> | null = null;

    // 1. postcodes.io: OGL/free REST, postcode directory geocoding (cached per process).
    try {
      if (!postcode) throw new Error("no postcode extracted by normalise");
      const key = postcode.replace(/\s/g, "").toUpperCase();
      const result = postcodeCache.get(key) ?? (await fetchJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(key)}`)).json;
      postcodeCache.set(key, result);
      geo = (result.result ?? null) as Record<string, unknown> | null;
      if (!geo) throw new Error("postcode response contained no result");
      await add("postcodes.io", `https://api.postcodes.io/postcodes/${key}`, "Free postcode lookup API; postcode data under OGL terms. Geocoding is area-level screening evidence, not exact property identity.", [
        ["postcode_valid", "yes", 0.99], ["latitude", String(geo.latitude), 0.95], ["longitude", String(geo.longitude), 0.95], ["local_authority", String(geo.admin_district ?? geo.admin_county ?? "unknown"), 0.9],
      ]);
    } catch (err) { await add("postcodes.io", postcode ? `https://api.postcodes.io/postcodes/${postcode.replace(/\s/g, "")}` : "https://postcodes.io", `Free API; lookup failed: ${err instanceof Error ? err.message : String(err)}. No postcode evidence returned.`); }

    // 2. Planning Data API. Empty responses are explicitly not a negative finding.
    try {
      if (!geo?.latitude || !geo?.longitude) throw new Error("coordinates unavailable");
      const lat = encodeURIComponent(String(geo.latitude)); const lng = encodeURIComponent(String(geo.longitude));
      const url = `https://www.planning.data.gov.uk/api/1.0/entity.json?longitude=${lng}&latitude=${lat}&limit=100`;
      const { json } = await fetchJson(url);
      const entities = Array.isArray(json.entities) ? json.entities : Array.isArray(json) ? json : [];
      await add("Planning Data API", url, `Planning Data open API; datasets carry their own licence/terms (often OGL). Point query checked ${new Date().toISOString()}; ${entities.length ? `${entities.length} record(s) returned` : "no record found; absence is not proof of no constraint"}.`, [["planning_records_checked", String(entities.length), 0.8]]);
      if (entities.length) await add("Planning Data API records", url, "Open planning dataset records returned for the postcode centroid; inspect dataset-specific entries before relying on them.", [["planning_record_summary", JSON.stringify(entities.slice(0, 20)), 0.75]]);
    } catch (err) { await add("Planning Data API", "https://www.planning.data.gov.uk/api/1.0/entity.json", `Open planning API checked; failed or unavailable: ${err instanceof Error ? err.message : String(err)}. Coverage is not established.`); }

    // 3. Environment Agency flood-monitoring service (free API; incidents are screening only).
    try {
      if (!geo?.latitude || !geo?.longitude) throw new Error("coordinates unavailable");
      const url = `https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${encodeURIComponent(String(geo.latitude))}&long=${encodeURIComponent(String(geo.longitude))}&dist=5`;
      const { json } = await fetchJson(url); const items = Array.isArray(json.items) ? json.items : [];
      await add("Environment Agency flood monitoring", url, `Environment Agency free flood-monitoring API; checked ${new Date().toISOString()}. Nearby alerts are screening evidence only, not a Flood Map for Planning zone determination; ${items.length ? `${items.length} alert(s)` : "no alert record found (not proof of no flood risk)"}.`, [["flood_alerts_checked", String(items.length), 0.65]]);
    } catch (err) { await add("Environment Agency flood monitoring", "https://environment.data.gov.uk/flood-monitoring", `Free Environment Agency service checked; failed: ${err instanceof Error ? err.message : String(err)}. Flood-zone status not checked.`); }

    // 4. NHLE: preserve official list/search URL; no unauthenticated point API is available.
    try {
      const url = geo?.latitude && geo?.longitude ? `https://historicengland.org.uk/listing/the-list/map-search?clearresults=true&searchType=MapSearch&county=&location=${encodeURIComponent(`${geo.latitude},${geo.longitude}`)}` : "https://historicengland.org.uk/listing/the-list/";
      await add("Historic England NHLE", url, "Historic England National Heritage List official map/list search checked as a limited-data source; no unauthenticated point API available. No heritage conclusion is made; buffer/list review required.");
    } catch (err) { await add("Historic England NHLE", "https://historicengland.org.uk/listing/the-list/", `Official NHLE source limited-data check failed: ${err instanceof Error ? err.message : String(err)}.`); }

    // 5. EPC API: never expose the token; skip until owner registers for free access.
    try {
      const token = process.env.EPC_API_KEY?.trim();
      const configured = token && token !== "placeholder" && token !== "your-epc-api-key";
      if (!configured) { await add("EPC Open Data Communities", "https://epc.opendatacommunities.org/docs/api/domestic", "Skipped: EPC API key not configured. Owner must register for a free token; no EPC claim made."); }
      else { await add("EPC Open Data Communities", "https://epc.opendatacommunities.org/docs/api/domestic", "EPC lookup is configured but postcode/address matching adapter is intentionally deferred until token-backed integration is enabled."); }
    } catch (err) { await add("EPC Open Data Communities", "https://epc.opendatacommunities.org/docs/api/domestic", `EPC check failed: ${err instanceof Error ? err.message : String(err)}.`); }
    return { status: "done", output: { note: "Free-source discovery completed; findings are screening evidence and source coverage/absence is recorded explicitly.", facts, sources } };
  },
};

/**
 * REAL step — collect market evidence from the local HM Land Registry Price
 * Paid comparables index (loaded by scripts/import-price-paid.ts). Queries the
 * project's exact postcode and its postcode sector, most recent sales first,
 * and writes honest per-fact confidence (sample-size aware). The step never
 * fails the project: an unloaded/empty index or a query failure is recorded
 * per-source with an explicit note and the step still completes.
 */
const collectionStep: PipelineStepDef = {
  name: "collection",
  title: "Evidence collection (Price Paid comparables)",
  implemented: true,
  run: async (ctx) => {
    const facts: FactOut[] = [];
    const sources: SourceOut[] = [];
    const add = async (name: string, url: string | null, notes: string, values: Array<[string, string, number]> = []) => {
      const [row] = await ctx.db`INSERT INTO sources (project_id, name, url, notes) VALUES (${ctx.projectId}, ${name}, ${url}, ${notes}) RETURNING id`;
      const sourceId = String(row.id);
      sources.push({ name, url, notes });
      for (const [key, value, confidence] of values) {
        const fact = { category: "market", key, value, confidence, sourceId };
        facts.push(fact);
        await ctx.db`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${ctx.projectId}, ${fact.category}, ${key}, ${value}, ${confidence}, ${sourceId})`;
      }
    };
    // The gov.uk collection page is the canonical source URL (the monthly CSV
    // itself lives on the publicdata.landregistry.gov.uk bucket documented there).
    const PRICE_PAID_URL = "https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads";
    const [postcodeRow] = await ctx.db`SELECT value FROM facts WHERE project_id = ${ctx.projectId} AND category = 'address' AND key = 'postcode' ORDER BY id DESC LIMIT 1`;
    const postcode = postcodeRow?.value ? String(postcodeRow.value) : null;

    try {
      if (!postcode) throw new Error("no postcode extracted by normalise");
      const [idx] = await ctx.db`SELECT COUNT(*)::int AS n FROM price_paid`;
      const indexCount = Number(idx?.n ?? 0);

      if (indexCount === 0) {
        // Index not loaded yet — record honest absence, never fail the step.
        await add(
          "HM Land Registry Price Paid",
          PRICE_PAID_URL,
          "Price Paid index not yet loaded — no comparables evidence. Run scripts/import-price-paid.ts to load the free OGL monthly CSV, then resume this project.",
          [["comparables_count", "0", 1]],
        );
      } else {
        // Postcode sector = outward code + first digit of inward (SE19 3AT → SE19 3).
        const compact = postcode.replace(/\s+/g, "").toUpperCase();
        const sectorCompact = compact.slice(0, compact.length - 2);
        const sector = sectorCompact.length > 1 ? `${sectorCompact.slice(0, -1)} ${sectorCompact.slice(-1)}` : sectorCompact;

        // Completed sales at the exact postcode and across the sector, most
        // recent first (bounded so project memory stays small).
        const exact = await ctx.db`
          SELECT price, transfer_date, postcode, property_type, tenure
          FROM price_paid WHERE replace(postcode, ' ', '') = ${compact}
          ORDER BY transfer_date DESC, price DESC LIMIT 10`;
        const sectorRows = await ctx.db`
          SELECT price, transfer_date, postcode, property_type, tenure, town_city
          FROM price_paid WHERE replace(postcode, ' ', '') LIKE ${sectorCompact + "%"}
          ORDER BY transfer_date DESC, price DESC LIMIT 200`;
        const [coverage] = await ctx.db`
          SELECT MIN(transfer_date)::text AS min_d, MAX(transfer_date)::text AS max_d FROM price_paid`;

        const n = sectorRows.length;
        const prices = sectorRows.map((r) => Number(r.price)).sort((a, b) => a - b);
        const median = n ? prices[Math.floor(prices.length / 2)] : null;
        const min = n ? prices[0] : null;
        const max = n ? prices[n - 1] : null;
        // Neon returns DATE columns as JS Dates — normalise to ISO (yyyy-mm-dd).
        const fmtDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
        const mostRecent = sectorRows[0] ? fmtDate(sectorRows[0].transfer_date) : null;
        // Confidence is sample-size aware: the official register is authoritative
        // for what it contains, but a small sample is weak evidence of an area.
        const conf = (base: number) => (n >= 10 ? base : n >= 3 ? base - 0.15 : n >= 1 ? base - 0.3 : 0);

        const values: Array<[string, string, number]> = [
          ["comparables_sector", sector, 0.99],
          ["comparables_count", String(n), 0.98],
          ["comparables_postcode_count", String(exact.length), 0.98],
          ["most_recent_sale_date", mostRecent ?? "", n ? 0.9 : 0],
          ["comparables_coverage_window", `${coverage?.min_d ?? "?"} to ${coverage?.max_d ?? "?"}`, 0.98],
        ];
        if (median !== null) {
          values.push(["comparables_median_price", String(median), conf(0.9)]);
          values.push(["comparables_min_max", `${min},${max}`, conf(0.85)]);
        }
        await add(
          "HM Land Registry Price Paid",
          PRICE_PAID_URL,
          `HM Land Registry Price Paid Data (free, Open Government Licence v3). Completed registered sale prices only — never asking prices or marketing valuations. Local index loaded from the monthly CSV (pp-monthly-update-new-version.csv); coverage window ${coverage?.min_d ?? "?"} to ${coverage?.max_d ?? "?"}. Sector ${sector}: ${n} completed sale(s), ${exact.length} at the exact postcode. Median/min/max confidence reflects sample size.`,
          values,
        );
      }
    } catch (err) {
      await add(
        "HM Land Registry Price Paid",
        PRICE_PAID_URL,
        `Price Paid comparables check failed: ${err instanceof Error ? err.message : String(err)}. No comparables evidence recorded for this project.`,
        [["comparables_count", "0", 1]],
      );
    }

    // Evidence-assembly summary. PLACEHOLDER: document intake (user-uploaded
    // PDFs, planning/EPC records fetched by later adapters) is NOT in scope yet
    // — the count below covers only the evidence items this step assembles,
    // which today is the comparables evidence recorded above.
    await ctx.db`
      INSERT INTO facts (project_id, category, key, value, confidence, source_id)
      VALUES (${ctx.projectId}, 'collection', 'evidence_items_collected', '0', 1, NULL)`;
    facts.push({ category: "collection", key: "evidence_items_collected", value: "0", confidence: 1, sourceId: null });

    return {
      status: "done",
      output: {
        note: "Comparables evidence collected from the local HM Land Registry Price Paid index (completed sales only; see source notes for coverage).",
        facts,
        sources,
      },
    };
  },
};

/** STUB factory — records a `pending` run and returns a marker output. */
function stub(name: string, title: string, note: string): PipelineStepDef {
  return {
    name,
    title,
    implemented: false,
    run: async (ctx, runId) => {
      // Mark this step pending in project memory: not implemented yet, but the
      // row exists so the loop is complete and later phases are drop-in.
      await ctx.db`
        UPDATE pipeline_runs SET status = 'pending', finished_at = NOW() WHERE id = ${runId}`;
      return { status: "pending", output: { note } };
    },
  };
}

export const PIPELINE_STEPS: PipelineStepDef[] = [
  normaliseStep,
  discoveryStep,
  collectionStep,
  stub(
    "intelligence",
    "Document intelligence",
    "Stub: extract structured facts from collected documents (use class, dimensions, occupancy, services) with per-fact confidence.",
  ),
  stub(
    "feasibility",
    "Financial feasibility",
    "Stub: build the financial model — purchase, refurbishment, fees, revenue, ROI, cashflow, sensitivity (advisory).",
  ),
  stub(
    "report",
    "Report generation",
    "Stub: render the evidence-backed feasibility report with a professional-review flag list.",
  ),
];

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function runStep(db: Db, projectId: string, step: PipelineStepDef, address: string): Promise<StepRunResult> {
  const [run] = await db`
    INSERT INTO pipeline_runs (project_id, step, status, started_at)
    VALUES (${projectId}, ${step.name}, 'running', NOW())
    RETURNING id`;
  const runId = String(run.id);
  try {
    const { status, output } = await step.run({ db, projectId, address }, runId);
    // The step may have marked itself (stubs set 'pending'); write the final
    // status regardless so the row is always consistent.
    await db`
      UPDATE pipeline_runs SET status = ${status}, finished_at = NOW(), error = NULL WHERE id = ${runId}`;
    return { id: runId, step: step.name, status, error: null, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db`
      UPDATE pipeline_runs SET status = 'error', finished_at = NOW(), error = ${message} WHERE id = ${runId}`;
    return { id: runId, step: step.name, status: "error", error: message, output: { note: message } };
  }
}

/**
 * Create a project row for `address` and run the whole pipeline, writing every
 * step's status into project memory. Returns the project id, its final status
 * and the ordered step statuses — enough for the /analyse page to render.
 */
export async function runPipeline(address: string) {
  const db = sql();
  await ensureSchema();

  const [project] = await db`
    INSERT INTO projects (address, status) VALUES (${address}, 'running')
    RETURNING id, address, status`;
  const projectId = String(project.id);

  let projectStatus = "complete";
  try {
    for (const step of PIPELINE_STEPS) {
      const result = await runStep(db, projectId, step, address);
      if (result.status === "error") projectStatus = "failed";
    }
  } catch (err) {
    // Belt-and-braces: runStep already captures step errors, but if the loop
    // itself breaks (DB outage mid-run), fail the project rather than leave it
    // looking stuck in 'running'.
    projectStatus = "failed";
    await db`UPDATE projects SET status = ${projectStatus}, updated_at = NOW() WHERE id = ${projectId}`;
    throw err;
  }
  await db`UPDATE projects SET status = ${projectStatus}, updated_at = NOW() WHERE id = ${projectId}`;

  const runs = await db`
    SELECT id, step, status, started_at, finished_at, error
    FROM pipeline_runs WHERE project_id = ${projectId} ORDER BY id`;
  const steps = (rowsToJson(runs, ["started_at", "finished_at"]) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    step: String(r.step),
    status: String(r.status),
    started_at: r.started_at,
    finished_at: r.finished_at,
    error: r.error,
  }));

  return { projectId, address, status: projectStatus, steps };
}

/* ------------------------------------------------------------------ */
/* Project memory read (used by /project/[id] and /api/project)        */
/* ------------------------------------------------------------------ */

/**
 * Load the full project memory: project row, pipeline runs, facts (with their
 * source names), sources and decisions. All timestamps coerced to strings so
 * the result is safe to hand to a client component / JSON response.
 */
export async function getProjectMemory(projectId: string) {
  const db = sql();
  await ensureSchema();

  const [project] = await db`
    SELECT id, address, status, created_at, updated_at FROM projects WHERE id = ${projectId}`;
  if (!project) throw new Error("not found");

  const runs = await db`
    SELECT id, step, status, started_at, finished_at, error
    FROM pipeline_runs WHERE project_id = ${projectId} ORDER BY id`;
  const facts = await db`
    SELECT f.id, f.category, f.key, f.value, f.confidence, f.source_id, s.name AS source_name
    FROM facts f LEFT JOIN sources s ON s.id = f.source_id
    WHERE f.project_id = ${projectId} ORDER BY f.id`;
  const sources = await db`
    SELECT id, name, url, fetched_at, notes FROM sources WHERE project_id = ${projectId} ORDER BY id`;
  const decisions = await db`
    SELECT id, step, choice, rationale, created_at FROM decisions WHERE project_id = ${projectId} ORDER BY id`;

  return {
    project: {
      id: String(project.id),
      address: String(project.address),
      status: String(project.status),
      created_at: toJson(project.created_at),
      updated_at: toJson(project.updated_at),
    },
    runs: (rowsToJson(runs, ["started_at", "finished_at"]) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      step: String(r.step),
      status: String(r.status),
      started_at: r.started_at,
      finished_at: r.finished_at,
      error: r.error,
    })),
    facts: (rowsToJson(facts, []) as Record<string, unknown>[]).map((f) => ({
      id: String(f.id),
      category: String(f.category),
      key: String(f.key),
      value: String(f.value),
      confidence: Number(f.confidence),
      source_id: f.source_id === null || f.source_id === undefined ? null : String(f.source_id),
      source_name: f.source_name === null || f.source_name === undefined ? null : String(f.source_name),
    })),
    sources: (rowsToJson(sources, ["fetched_at"]) as Record<string, unknown>[]).map((s) => ({
      id: String(s.id),
      name: String(s.name),
      url: s.url === null || s.url === undefined ? null : String(s.url),
      fetched_at: s.fetched_at,
      notes: s.notes === null || s.notes === undefined ? null : String(s.notes),
    })),
    decisions: (rowsToJson(decisions, ["created_at"]) as Record<string, unknown>[]).map((d) => ({
      id: String(d.id),
      step: String(d.step),
      choice: String(d.choice),
      rationale: d.rationale === null || d.rationale === undefined ? null : String(d.rationale),
      created_at: d.created_at,
    })),
  };
}
