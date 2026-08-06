import { sql } from "~/db";
import { ensureSchema, toJson, rowsToJson } from "~/project-schema";
import { renderReportHtml } from "~/report";
import { runDesignStep } from "~/design";
import { runTwinStep } from "~/twin";
// pdf-parse v1 (CJS, no exports map — vite interop gives a default export).
// Import the lib entry directly: index.js has an `isDebugMode = !module.parent`
// block that reads ./test/data/... and crashes the server at startup under
// Vite's CJS bundling. lib/pdf-parse.js has no such block.
// eslint-disable-next-line import/default
import pdfParse from "pdf-parse/lib/pdf-parse.js";

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
 *   4. intelligence  — REAL: extract structured space facts from uploaded
 *                      documents (floor plans, EPCs) with per-fact confidence
 *   5. feasibility   — REAL: assumption-led financial feasibility model
 *   6. compliance    — REAL: change-of-use screening + constraint data gaps
 *   7. twin          — REAL: as-built "digital twin" of the existing layout
 *   8. report        — REAL: evidence-backed feasibility report (server-rendered)
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

/* ------------------------------------------------------------------ */
/* EPC register (MHCLG Energy Certificate Data API) helpers            */
/* Base URL + bearer-token auth per the official docs:                 */
/* https://get-energy-performance-data.communities.gov.uk/guidance/    */
/*   energy-certificate-data-apis                                      */
/* ------------------------------------------------------------------ */
const EPC_API_BASE = "https://api.get-energy-performance-data.communities.gov.uk";
const EPC_API_DOCS = "https://get-energy-performance-data.communities.gov.uk/guidance/energy-certificate-data-apis";

/** Search one register (domestic / non-domestic) by postcode; returns summary rows or []. */
async function epcSearchRows(path: string, token: string): Promise<Record<string, unknown>[]> {
  try {
    const response = await fetch(`${EPC_API_BASE}${path}`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const json = (await response.json().catch(() => null)) as { data?: unknown } | null;
    return Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** Fetch the full certificate for an RRN; returns the record object or null. */
async function epcFetchCertificate(rrn: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${EPC_API_BASE}/api/certificate?certificate_number=${encodeURIComponent(rrn)}`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const json = (await response.json().catch(() => null)) as { data?: unknown } | null;
    return json?.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Address evidence matching: identifier-level only; street/postcode alone is insufficient. */
export function addressLines(value: Record<string, unknown> | string): string {
  if (typeof value === "string") return value;
  return ["addressLine1", "addressLine2", "addressLine3", "addressLine4", "addressLine5", "postcode"].map(k => String(value[k] ?? "")).filter(Boolean).join(" ");
}
function normAddr(s: string): string { return s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
function houseNumber(s: string): string { const m = normAddr(s).match(/(?:^| )(#?\d+[A-Z]?(?:-\d+[A-Z]?)?)(?: |$)/); return m ? m[1].replace(/^#/, "") : ""; }
function unitId(s: string): string { const m = normAddr(s).match(/\b(?:UNIT|SUITE|WORKSHOP|PLOT|UNITED)\s*([A-Z]?\d+[A-Z]?)\b/); return m ? m[1] : ""; }
function buildingName(s: string): string { const m = normAddr(s).match(/\b([A-Z0-9]+\s+(?:BUSINESS|INDUSTRIAL)\s+PARK|[A-Z0-9]+\s+MILL)\b/); return m ? m[1] : ""; }
function streetTokens(s: string): string[] { return normAddr(s).split(/\s+/).filter(x => x.length > 2 && !/^\d/.test(x) && !/^(UNIT|SUITE|WORKSHOP|PLOT|BUSINESS|INDUSTRIAL|PARK|ESTATE)$/.test(x)); }
function hasCommercialToken(s: string): boolean { return /\b(UNIT|SUITE|WORKSHOP|BUSINESS PARK|INDUSTRIAL ESTATE|WAREHOUSE|STUDIO|MILL|PLOT)\b/i.test(s); }
/** Scores only genuine identifier agreement at/above the 0.7 threshold. */
export function epcAddressScore(projectAddr: string, row: Record<string, unknown>, register?: "domestic"|"non-domestic"): number {
  const proj=normAddr(projectAddr), cand=normAddr(addressLines(row)); if (!cand) return 0;
  const pUnit=unitId(proj), cUnit=unitId(cand);
  if ((pUnit || cUnit) && pUnit !== cUnit) return 0;
  const pStreet=streetTokens(proj), cStreet=streetTokens(cand);
  const streetMatch=pStreet.some(t=>cStreet.includes(t)); if (!streetMatch) return 0;
  if (!pUnit && !cUnit) { const pn=houseNumber(proj), cn=houseNumber(cand); if (pn && cn && !numbersOverlap(pn,cn)) return 0; if (!pn || !cn) return 0.55; return hasCommercialToken(proj) && register === "domestic" ? 0.4 : 1; }
  if (pUnit && cUnit && pUnit===cUnit) return hasCommercialToken(proj) && register === "non-domestic" ? 1 : 0.9;
  return 0;
}
function numbersOverlap(a: string,b: string): boolean { const parse=(x:string)=>x.split("-").map(n=>parseInt(n,10)); const [a1,a2]=parse(a),[b1,b2]=parse(b); return Math.min(a1,a2||a1)<=Math.max(b1,b2||b1)&&Math.min(b1,b2||b1)<=Math.max(a1,a2||a1); }

/** REAL step — free, evidence-backed screening lookups. Each provider is isolated. */
const discoveryStep: PipelineStepDef = {
  name: "discovery", title: "Property discovery", implemented: true,
  run: async (ctx) => {
    const facts: FactOut[] = [];
    const sources: SourceOut[] = [];
    const add = async (name: string, url: string | null, notes: string, values: Array<[string, string, number]> = []): Promise<string> => {
      const [row] = await ctx.db`INSERT INTO sources (project_id, name, url, notes) VALUES (${ctx.projectId}, ${name}, ${url}, ${notes}) RETURNING id`;
      const sourceId = String(row.id);
      sources.push({ name, url, notes });
      for (const [key, value, confidence] of values) {
        const fact = { category: "discovery", key, value, confidence, sourceId };
        facts.push(fact);
        await ctx.db`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${ctx.projectId}, ${fact.category}, ${key}, ${value}, ${confidence}, ${sourceId})`;
      }
      return sourceId;
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

    // 5. EPC register (MHCLG Energy Certificate Data API — free developer token, OGL v3).
    //    Searches domestic + non-domestic registers by postcode, matches to the
    //    project address, fetches the winning certificate and writes EPC facts.
    //    The token is never exposed in outputs; absence is recorded honestly.
    try {
      const token = process.env.EPC_API_KEY?.trim();
      const configured = token && token !== "placeholder" && token !== "your-epc-api-key";
      if (!configured) {
        await add("EPC register (MHCLG API)", EPC_API_DOCS, "Skipped: EPC API key not configured. Owner must register for a free developer token (GOV.UK One Login); no EPC claim made.");
      } else if (!postcode) {
        await add("EPC register (MHCLG API)", EPC_API_DOCS, "EPC lookup skipped: no postcode extracted from the address, so the register cannot be searched.");
      } else {
        const pc = postcode.replace(/\s/g, "").toUpperCase();
        const searchUrl = `${EPC_API_BASE}/api/domestic/search?postcode=${encodeURIComponent(pc)}`;
        const [normRow] = await ctx.db`SELECT value FROM facts WHERE project_id = ${ctx.projectId} AND category = 'address' AND key = 'normalised' ORDER BY id DESC LIMIT 1`;
        const projectAddr = normRow?.value ? String(normRow.value) : ctx.address;
        const domestic = await epcSearchRows(`/api/domestic/search?postcode=${encodeURIComponent(pc)}`, token);
        const nonDomestic = await epcSearchRows(`/api/non-domestic/search?postcode=${encodeURIComponent(pc)}`, token);
        // Score every row against the project address; best score wins.
        let best: { row: Record<string, unknown>; score: number; register: "domestic" | "non-domestic" } | null = null;
        for (const row of domestic) {
          const score = epcAddressScore(projectAddr, row, "domestic");
          if (score > (best?.score ?? 0)) best = { row, score, register: "domestic" };
        }
        for (const row of nonDomestic) {
          const score = epcAddressScore(projectAddr, row, "non-domestic");
          if (score > (best?.score ?? 0)) best = { row, score, register: "non-domestic" };
        }
        const matched = best && best.score >= 0.7 ? best : null;
        const matchedAddr = matched ? addressLines(matched.row) : "";
        const note = matched
          ? `EPC register searched by postcode ${postcode}: ${domestic.length} domestic and ${nonDomestic.length} non-domestic certificate(s) returned; matched "${matchedAddr}" (${matched.register} register, ${String(matched.row.registrationDate ?? "date unknown")}).`
          : `EPC register searched by postcode ${postcode}: ${domestic.length} domestic and ${nonDomestic.length} non-domestic certificate(s) returned, none matching "${projectAddr}". No EPC evidence from the register — absence is recorded honestly, not as a finding.`;
        const sourceId = await add("EPC register (MHCLG API)", searchUrl, note, [
          ["epc_register_checked", "yes", 0.95],
          ["epc_domestic_count", String(domestic.length), 0.8],
          ["epc_non_domestic_count", String(nonDomestic.length), 0.8],
          ["epc_found", matched ? "yes" : "no", 0.9],
          ["epc_address_matched", matched ? "yes" : "no", matched ? 0.9 : 1],
        ]);
        if (matched) {
          const rrn = String(matched.row.certificateNumber ?? "");
          const cert = rrn ? await epcFetchCertificate(rrn, token) : null;
          const band = String(cert?.current_energy_efficiency_band ?? cert?.asset_rating_band ?? matched.row.currentEnergyEfficiencyBand ?? matched.row.assetRatingBand ?? "").trim();
          const area = cert?.total_floor_area ?? cert?.total_floor_area_m2;
          const areaM2 = typeof area === "number" && area > 0 ? String(area) : null;
          const epcFacts: Array<[string, string, number]> = [];
          if (areaM2) epcFacts.push(["total_floor_area_m2", areaM2, 0.95]);
          if (band) epcFacts.push(["epc_rating", band.toUpperCase(), 0.95]);
          if (rrn) epcFacts.push(["epc_rrn", rrn, 0.95]);
          if (cert?.registration_date) epcFacts.push(["epc_registration_date", String(cert.registration_date), 0.9]);
          if (cert?.inspection_date) epcFacts.push(["epc_inspection_date", String(cert.inspection_date), 0.9]);
          const propType = String(cert?.dwelling_type ?? cert?.property_type ?? matched.row.propertyType ?? "").trim();
          if (propType && propType !== "0") epcFacts.push(["epc_property_type", propType, 0.85]);
          if (cert?.uprn !== undefined && cert?.uprn !== null) epcFacts.push(["epc_uprn", String(cert.uprn), 0.9]);
          const ratingNum = cert?.energy_rating_current ?? cert?.asset_rating_current;
          if (typeof ratingNum === "number") epcFacts.push(["epc_energy_rating_current", String(ratingNum), 0.9]);
          epcFacts.push(["epc_register_type", matched.register, 1]);

          // EPC facts land in category 'epc' under the same source row so the
          // report's space-evidence row and the feasibility per-m² model can
          // consume them, exactly like an uploaded EPC would.
          for (const [key, value, confidence] of epcFacts) {
            const fact = { category: "epc", key, value, confidence, sourceId };
            facts.push(fact);
            await ctx.db`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${ctx.projectId}, ${fact.category}, ${key}, ${value}, ${confidence}, ${sourceId})`;
          }
        }
      }
    } catch (err) { await add("EPC register (MHCLG API)", EPC_API_DOCS, `EPC register check failed: ${err instanceof Error ? err.message : String(err)}. No EPC claim made.`); }
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

    // Evidence-assembly summary: comparables evidence recorded above plus any
    // user-uploaded documents available to the intelligence step.
    const docRows = await ctx.db`
      SELECT count(*)::int AS n FROM documents WHERE project_id = ${ctx.projectId}`;
    const evidenceCount = Number(docRows[0]?.n ?? 0);
    await ctx.db`
      INSERT INTO facts (project_id, category, key, value, confidence, source_id)
      VALUES (${ctx.projectId}, 'collection', 'evidence_items_collected', ${String(evidenceCount)}, 1, NULL)`;
    facts.push({ category: "collection", key: "evidence_items_collected", value: String(evidenceCount), confidence: 1, sourceId: null });

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

/**
 * REAL step — assumption-led financial feasibility model built EXCLUSIVELY from
 * evidence already in project memory (Price Paid comparables, constraint flags,
 * EPC floor area when present). Never re-fetches external data. Writes
 * feasibility facts with honest, sample-aware confidence, stores the key
 * assumptions as explicit `assumption_*` facts (so the report can show them),
 * and records the model as a source with the advisory disclaimer. Completes
 * even with no comparables, producing clearly-labelled assumption-only outputs
 * at lower confidence.
 */
const feasibilityStep: PipelineStepDef = {
  name: "feasibility",
  title: "Financial feasibility",
  implemented: true,
  run: async (ctx) => {
    const facts: FactOut[] = [];
    const sources: SourceOut[] = [];
    const add = async (name: string, url: string | null, notes: string, values: Array<[string, string, number]> = []) => {
      const [row] = await ctx.db`INSERT INTO sources (project_id, name, url, notes) VALUES (${ctx.projectId}, ${name}, ${url}, ${notes}) RETURNING id`;
      const sourceId = String(row.id);
      sources.push({ name, url, notes });
      for (const [key, value, confidence] of values) {
        const fact = { category: "feasibility", key, value, confidence, sourceId };
        facts.push(fact);
        await ctx.db`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${ctx.projectId}, ${fact.category}, ${key}, ${value}, ${confidence}, ${sourceId})`;
      }
    };

    // ---- read evidence from project memory only ----
    const rows = await ctx.db`SELECT category, key, value FROM facts WHERE project_id = ${ctx.projectId}`;
    const fact = (cat: string, key: string): string | null => {
      const r = rows.find((x) => String(x.category) === cat && String(x.key) === key);
      return r ? String(r.value) : null;
    };
    const [heritage] = await ctx.db`
      SELECT notes FROM sources WHERE project_id = ${ctx.projectId} AND name ILIKE '%Historic England%' LIMIT 1`;
    const heritageNote = heritage?.notes ? String(heritage.notes) : null;

    const floorAreaRow = rows.find((r) => String(r.category) === "epc" && /floor.?area/i.test(String(r.key)));
    const floorArea = floorAreaRow ? Number.parseFloat(String(floorAreaRow.value)) : NaN;
    const floorAreaKnown = Number.isFinite(floorArea) && floorArea > 0;

    const medianRaw = fact("market", "comparables_median_price");
    const countRaw = fact("market", "comparables_count");
    const median = medianRaw ? Number.parseInt(medianRaw, 10) : NaN;
    const count = countRaw ? Number.parseInt(countRaw, 10) : 0;
    const hasComparables = Number.isFinite(median) && count > 0;
    // Sample-aware confidence, mirroring the collection step's honesty.
    const conf = (base: number) => (count >= 10 ? base : count >= 3 ? base - 0.15 : count >= 1 ? base - 0.3 : 0);

    const floodAlerts = fact("discovery", "flood_alerts_checked");
    const planningChecked = fact("discovery", "planning_records_checked");

    // ---- model constants (each stored as an explicit assumption fact) ----
    const GDV_UPLIFT_LOW = 1.1; // +10% uplift band (light refurb/development)
    const GDV_UPLIFT_HIGH = 1.25; // +25% uplift band (more ambitious redevelopment)
    const REFURB_PER_SQM_LOW = 600; // £/m² light-to-mid refurb (screening band)
    const REFURB_PER_SQM_HIGH = 1200; // £/m² mid-to-full refurb (screening band)
    const REFURB_FLAT_LOW = 35000; // flat band when floor area unknown
    const REFURB_FLAT_HIGH = 85000;
    const FEES_PERCENT = 12; // professional fees as % of refurbishment cost
    const SENSITIVITY = 0.1; // ±10% on GDV and total costs

    const round = (n: number) => Math.round(n);
    const pct1 = (n: number) => (Math.round(n * 10) / 10).toString();

    const assumptions: Array<[string, string]> = [
      ["assumption_gdv_uplift_low_percent", String(Math.round((GDV_UPLIFT_LOW - 1) * 100))],
      ["assumption_gdv_uplift_high_percent", String(Math.round((GDV_UPLIFT_HIGH - 1) * 100))],
      ["assumption_professional_fees_percent", String(FEES_PERCENT)],
      ["assumption_sensitivity_band", `±${Math.round(SENSITIVITY * 100)}% applied to GDV and total costs`],
      ["assumption_acquisition_price", "acquisition assumed at estimated current value — no purchase price provided"],
    ];
    if (floorAreaKnown) {
      assumptions.push(["assumption_refurb_cost_per_sqm_low", String(REFURB_PER_SQM_LOW)]);
      assumptions.push(["assumption_refurb_cost_per_sqm_high", String(REFURB_PER_SQM_HIGH)]);
    } else {
      assumptions.push(["assumption_refurb_flat_low", String(REFURB_FLAT_LOW)]);
      assumptions.push(["assumption_refurb_flat_high", String(REFURB_FLAT_HIGH)]);
    }

    // ---- model outputs (all money rounded to whole pounds) ----
    const values: Array<[string, string, number]> = [
      ["comparables_available", hasComparables ? "yes" : "no", 0.98],
    ];

    if (hasComparables) {
      const currentValue = round(median);
      values.push([
        "current_value_basis",
        floorAreaKnown
          ? "per-sqm anchored to sector median (EPC floor area)"
          : "price-based (sector median; no EPC floor area)",
        0.9,
      ]);
      values.push(["current_value_estimate", String(currentValue), conf(0.8)]);
      if (floorAreaKnown) values.push(["current_value_per_sqm", String(round(currentValue / floorArea)), 0.5]);

      const gdvLow = round(currentValue * GDV_UPLIFT_LOW);
      const gdvHigh = round(currentValue * GDV_UPLIFT_HIGH);
      values.push(["gdv_estimate_low", String(gdvLow), 0.45]);
      values.push(["gdv_estimate_high", String(gdvHigh), 0.45]);

      const refurbLow = floorAreaKnown ? round(floorArea * REFURB_PER_SQM_LOW) : REFURB_FLAT_LOW;
      const refurbHigh = floorAreaKnown ? round(floorArea * REFURB_PER_SQM_HIGH) : REFURB_FLAT_HIGH;
      values.push(["refurbishment_cost_range_low", String(refurbLow), floorAreaKnown ? 0.5 : 0.35]);
      values.push(["refurbishment_cost_range_high", String(refurbHigh), floorAreaKnown ? 0.5 : 0.35]);

      const feesAmount = round(((refurbLow + refurbHigh) / 2) * (FEES_PERCENT / 100));
      values.push(["professional_fees_percent", String(FEES_PERCENT), 0.5]);
      values.push(["professional_fees_amount", String(feesAmount), 0.4]);

      // Indicative ROI at mid-GDV vs acquisition (at estimated value) + refurb + fees.
      const gdvMid = (gdvLow + gdvHigh) / 2;
      const totalCost = currentValue + (refurbLow + refurbHigh) / 2 + feesAmount;
      const roi = ((gdvMid - totalCost) / totalCost) * 100;
      values.push(["indicative_roi", pct1(roi), 0.4]);

      // Sensitivity: ±10% on GDV and total costs.
      const upside =
        ((gdvMid * (1 + SENSITIVITY) - totalCost * (1 - SENSITIVITY)) / (totalCost * (1 - SENSITIVITY))) * 100;
      const downside =
        ((gdvMid * (1 - SENSITIVITY) - totalCost * (1 + SENSITIVITY)) / (totalCost * (1 + SENSITIVITY))) * 100;
      values.push(["roi_upside", pct1(upside), 0.35]);
      values.push(["roi_downside", pct1(downside), 0.35]);
    } else {
      // No comparables — assumption-only outputs, clearly labelled, low confidence.
      values.push(["current_value_basis", "assumption-only — no comparables evidence recorded", 0.9]);
      values.push(["refurbishment_cost_range_low", String(REFURB_FLAT_LOW), 0.3]);
      values.push(["refurbishment_cost_range_high", String(REFURB_FLAT_HIGH), 0.3]);
      values.push(["professional_fees_percent", String(FEES_PERCENT), 0.4]);
      values.push([
        "professional_fees_amount",
        String(round(((REFURB_FLAT_LOW + REFURB_FLAT_HIGH) / 2) * (FEES_PERCENT / 100))),
        0.3,
      ]);
    }

    // Model note — inputs used and honest limitations, folded from the flags.
    const modelNote = [
      "Inputs from project memory only:",
      hasComparables ? `sector median ${medianRaw} (${count} completed sale(s))` : "no comparables evidence",
      floorAreaKnown ? `EPC floor area ${round(floorArea)} m²` : "no EPC floor area (flat assumption bands used)",
      `flood alerts: ${floodAlerts ?? "not established"}`,
      `planning records: ${planningChecked ?? "not established"}`,
      heritageNote ? "heritage: limited-data check only, no conclusion" : "heritage: not checked",
    ].join("; ");
    values.push(["model_note", modelNote, 0.95]);

    for (const [key, value] of assumptions) values.push([key, value, 0.9]);

    await add(
      "Financial feasibility model",
      null,
      "Assumption-driven screening model built from evidence in project memory (Price Paid comparables + constraint flags + EPC floor area when available). Advisory screening only — NOT professional advice; no guarantee of planning approval or returns. All money rounded to whole pounds; ROI sensitivity ±10% on GDV and total costs. Key assumptions stored as fact keys assumption_*.",
      values,
    );

    return {
      status: "done",
      output: {
        note: "Financial feasibility model completed from project memory (assumption-led, advisory; sensitivity shown).",
        facts,
        sources,
      },
    };
  },
};

/**
 * REAL step — generate the evidence-backed feasibility report. Renders the
 * report HTML server-side from project memory only (facts + sources, via
 * src/report.ts), records the artifact in memory, and marks the step done.
 * The printable HTML itself is served by /report/$id.
 */
const complianceStep: PipelineStepDef = {
  name: "compliance",
  title: "Planning and change-of-use screening",
  implemented: true,
  run: async (ctx) => {
    const [source] = await ctx.db`INSERT INTO sources (project_id, name, url, notes) VALUES (${ctx.projectId}, 'ATLAS AI compliance data-gap register', NULL, 'No new external data queried; missing constraint layers are recorded honestly.') RETURNING id`;
    const sourceId = String(source.id);
    const value = 'Listed building status: not available (no free national API); conservation area: not available; flood risk: not available. These are data gaps, not findings that no constraints exist.';
    const fact = { category: 'compliance', key: 'constraint_data', value, confidence: 0.2, sourceId };
    await ctx.db`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${ctx.projectId}, ${fact.category}, ${fact.key}, ${fact.value}, ${fact.confidence}, ${fact.sourceId})`;
    return { status: 'done', output: { note: 'recorded known constraint data gaps', facts: [fact], sources: [{ name: 'ATLAS AI compliance data-gap register', url: null, notes: 'No new external data queried.' }] } };
  },
};

/**
 * REAL step — Phase 1 "digital twin": an as-built spatial model of the EXISTING
 * property rendered from confidence-scored space facts already in memory
 * (src/twin.ts). Generates an as-built floor-plan SVG in the same CAD-style
 * visual language as the concept design, a plain-English layout description and
 * an honest data-coverage note; writes category "twin" facts. Never invents
 * rooms or dimensions; footprint-only when only a total floor area exists.
 */
const twinStep: PipelineStepDef = {
  name: "twin",
  title: "Existing layout (digital twin)",
  implemented: true,
  run: async (ctx) => runTwinStep(ctx.db, ctx.projectId),
};
const reportStep: PipelineStepDef = {
  name: "report",
  title: "Report generation",
  implemented: true,
  run: async (ctx) => {
    const memory = await getProjectMemory(ctx.projectId);
    const html = renderReportHtml(memory);
    if (!html || html.length < 600) throw new Error("report generation produced no output");

    const generatedAt = new Date().toISOString();
    const reportPath = `/report/${ctx.projectId}`;
    const [source] = await ctx.db`
      INSERT INTO sources (project_id, name, url, notes)
      VALUES (${ctx.projectId}, 'ATLAS AI feasibility report', NULL,
        'Rendered server-side from project memory (facts + sources) via src/report.ts. No content invented beyond the assumptions recorded as feasibility facts. Printable HTML served at ' || ${reportPath} || '.')
      RETURNING id`;
    const sourceId = String(source.id);
    const facts: FactOut[] = [
      { category: "report", key: "report_generated", value: "yes", confidence: 1, sourceId },
      { category: "report", key: "report_generated_at", value: generatedAt, confidence: 1, sourceId },
      { category: "report", key: "report_html_bytes", value: String(html.length), confidence: 1, sourceId },
    ];
    for (const f of facts) {
      await ctx.db`
        INSERT INTO facts (project_id, category, key, value, confidence, source_id)
        VALUES (${ctx.projectId}, ${f.category}, ${f.key}, ${f.value}, ${f.confidence}, ${f.sourceId})`;
    }

    return {
      status: "done",
      output: {
        note: `Evidence-backed feasibility report generated (advisory screening; served at ${reportPath}).`,
        facts,
        sources: [
          {
            name: "ATLAS AI feasibility report",
            url: null,
            notes: "Rendered server-side from project memory (facts + sources) via src/report.ts.",
          },
        ],
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Document intelligence (step 4)                                      */
/* ------------------------------------------------------------------ */
/** Extract plain-text from a PDF on disk. Returns "" for scanned pages (no text layer). */
async function extractPdfText(filePath: string): Promise<string> {
  try {
    const bytes = await Bun.file(filePath).arrayBuffer();
    const data = await pdfParse(Buffer.from(bytes));
    return typeof data.text === "string" ? data.text : "";
  } catch {
    return "";
  }
}

interface SpaceFact {
  key: string;
  value: string;
  confidence: number;
}

const ROOM_LABELS = [
  "reception", "office", "kitchen", "kitchenette", "wc", "toilet", "bathroom",
  "shower", "storage", "meeting", "waiting", "lounge", "bedroom", "salon",
  "shop", "retail", "corridor", "stair", "hall", "lobby", "cafe", "restaurant", "bar",
];

const OCCUPANCY_HINTS: Array<[RegExp, string]> = [
  [/accountant/i, "accountants"], [/solicitor/i, "solicitors"],
  [/estate agent/i, "estate agent"], [/dentist/i, "dental practice"],
  [/hairdresser|barber/i, "hairdresser/barber"], [/restaurant|bistro|cafe\b/i, "cafe/restaurant"],
  [/retail|shop\b|store\b/i, "retail"], [/office/i, "office"],
  [/residential|flat|apartment|dwelling/i, "residential"],
];

/**
 * Rule-based extraction of space facts from a document's text layer.
 * Every fact carries a confidence score; nothing here ever overclaims.
 * OCR of scanned plans is a later phase (flagged when no text layer).
 */
function extractSpaceFacts(text: string, filename: string): SpaceFact[] {
  const facts: SpaceFact[] = [];
  const t = text.replace(/\s+/g, " ");

  // Document type (filename first, then content signals).
  const name = filename.toLowerCase();
  let docType = "other";
  if (/(epc|energy performance)/i.test(name) || /energy performance/i.test(t)) docType = "epc";
  else if (/(floor\s*plan|floorplan|layout|drawing)/i.test(name)) docType = "floor plan";
  else if (/planning/i.test(name)) docType = "planning document";
  else if (/(title|register)/i.test(name)) docType = "title document";
  facts.push({ key: "document_type", value: docType, confidence: 0.75 });

  // Floor areas (m² patterns, then sq ft converted to m²).
  const areaPatterns: Array<[RegExp, string]> = [
    [/total\s+floor\s+area[:\s]*([\d,]+(?:\.\d+)?)\s*(?:m2|m²|sq\s*m|sqm)/i, "total_floor_area_m2"],
    [/gross\s+internal\s+area[:\s]*([\d,]+(?:\.\d+)?)\s*(?:m2|m²|sq\s*m|sqm)/i, "gia_m2"],
    [/gross\s+external\s+area[:\s]*([\d,]+(?:\.\d+)?)\s*(?:m2|m²|sq\s*m|sqm)/i, "gea_m2"],
  ];
  for (const [re, key] of areaPatterns) {
    const m = t.match(re);
    if (m) facts.push({ key, value: String(parseFloat(m[1].replace(/,/g, ""))), confidence: 0.8 });
  }
  const sqft = t.match(/([\d,]+(?:\.\d+)?)\s*(?:sq\s*ft|ft2|square\s*feet)/i);
  if (sqft) {
    const m2 = Math.round(parseFloat(sqft[1].replace(/,/g, "")) * 0.092903 * 10) / 10;
    facts.push({ key: "total_floor_area_m2", value: String(m2), confidence: 0.7 });
  }

  // Room dimensions: "4.5m x 3.2m" and "12' x 10'" styles.
  const mRe = /([\d.]+)\s*m\s*[x×]\s*([\d.]+)\s*m/gi;
  let mm: RegExpExecArray | null;
  while ((mm = mRe.exec(t)) !== null) {
    facts.push({ key: "room_dimension_m", value: `${mm[1]} x ${mm[2]}`, confidence: 0.8 });
  }
  const ftRe = /(\d+(?:\.\d+)?)'\s*[x×]\s*(\d+(?:\.\d+)?)'(?!\s*m)/gi;
  let fm: RegExpExecArray | null;
  while ((fm = ftRe.exec(t)) !== null) {
    facts.push({ key: "room_dimension_ft", value: `${fm[1]}' x ${fm[2]}'`, confidence: 0.7 });
  }

  // Room labels by keyword.
  for (const label of ROOM_LABELS) {
    if (new RegExp(`\\b${label}\\b`, "i").test(t)) {
      facts.push({ key: "room_label", value: label, confidence: 0.55 });
    }
  }

  // Use class, ceiling height, EPC rating/RRN, dates, stated amounts.
  const uc = t.match(/use\s+class[:\s]*([A-Za-z]\d?)/i);
  if (uc) facts.push({ key: "use_class", value: uc[1].toUpperCase(), confidence: 0.85 });
  const ch = t.match(/ceiling\s+height[:\s]*([\d.]+)\s*m/i);
  if (ch) facts.push({ key: "ceiling_height_m", value: ch[1], confidence: 0.8 });
  const rating = t.match(/(?:current|energy)\s+rating[:\s]*([A-G])\b/i);
  if (rating) facts.push({ key: "epc_rating", value: rating[1].toUpperCase(), confidence: 0.85 });
  const rrn = t.match(/\b(\d{4}-\d{4}-\d{4}-\d{4}-\d{4})\b/);
  if (rrn) facts.push({ key: "epc_rrn", value: rrn[1], confidence: 0.9 });
  const dt = t.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  if (dt) facts.push({ key: "document_date", value: dt[1], confidence: 0.8 });
  const amt = t.match(/£\s*([\d,]+(?:\.\d+)?)/);
  if (amt) facts.push({ key: "stated_amount_gbp", value: amt[1].replace(/,/g, ""), confidence: 0.8 });

  // Current use / occupancy (first strong hint wins).
  for (const [re, label] of OCCUPANCY_HINTS) {
    if (re.test(t)) {
      facts.push({ key: "current_use", value: label, confidence: 0.6 });
      break;
    }
  }

  return facts;
}

const intelligenceStep: PipelineStepDef = {
  name: "intelligence",
  title: "Document intelligence",
  implemented: true,
  run: async (ctx) => {
    const { db, projectId } = ctx;
    const sources: SourceOut[] = [];
    const facts: FactOut[] = [];
    const docs = await db`
      SELECT id, filename, path FROM documents WHERE project_id = ${projectId} ORDER BY id`;
    if (docs.length === 0) {
      const [src] = await db`
        INSERT INTO sources (project_id, name, url, notes)
        VALUES (${projectId}, 'document intake', NULL,
          'No documents uploaded. Upload a floor plan or EPC via POST /api/documents, then re-run the analysis to extract space facts.')
        RETURNING id`;
      await db`
        INSERT INTO facts (project_id, category, key, value, confidence, source_id)
        VALUES (${projectId}, 'intelligence', 'documents_processed', '0', 1, ${src.id})`;
      return {
        status: "done",
        output: { note: "no documents uploaded — nothing to extract", facts, sources },
      };
    }
    let processed = 0;
    for (const doc of docs) {
      const path = String(doc.path);
      const filename = String(doc.filename);
      const text = await extractPdfText(path);
      if (text.trim().length < 10) {
        await db`
          UPDATE documents SET status = 'no-text-layer' WHERE id = ${doc.id}`;
        await db`
          INSERT INTO sources (project_id, name, url, notes)
          VALUES (${projectId}, ${filename}, NULL,
            'Uploaded but has no extractable text layer (scanned image?). OCR is a later phase.')
          RETURNING id`;
        continue;
      }
      const extracted = extractSpaceFacts(text, filename);
      const [src] = await db`
        INSERT INTO sources (project_id, name, url, notes)
        VALUES (${projectId}, ${filename}, NULL,
          'Uploaded document; rule-based text extraction with per-fact confidence scores (OCR of scanned plans is a later phase).')
        RETURNING id`;
      const sourceId = String(src.id);
      sources.push({ name: filename, url: null, notes: "uploaded document" });
      for (const f of extracted) {
        await db`
          INSERT INTO facts (project_id, category, key, value, confidence, source_id)
          VALUES (${projectId}, 'intelligence', ${f.key}, ${f.value}, ${f.confidence}, ${sourceId})`;
        facts.push({
          category: "intelligence",
          key: f.key,
          value: f.value,
          confidence: f.confidence,
          sourceId,
        });
      }
      await db`UPDATE documents SET status = 'extracted' WHERE id = ${doc.id}`;
      processed += 1;
    }
    await db`
      INSERT INTO facts (project_id, category, key, value, confidence, source_id)
      VALUES (${projectId}, 'intelligence', 'documents_processed', ${String(processed)}, 1, NULL)`;
    facts.push({
      category: "intelligence",
      key: "documents_processed",
      value: String(processed),
      confidence: 1,
      sourceId: null,
    });
    return {
      status: "done",
      output: { note: `extracted space facts from ${processed} uploaded document(s)`, facts, sources },
    };
  },
};

export const PIPELINE_STEPS: PipelineStepDef[] = [
  normaliseStep,
  discoveryStep,
  collectionStep,
  intelligenceStep,
  feasibilityStep,
  complianceStep,
  twinStep,
  reportStep,
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
export async function runPipeline(address: string, existingProjectId?: string) {
  const db = sql();
  await ensureSchema();

  let projectId: string;
  if (existingProjectId) {
    // Re-run on an existing project (e.g. after uploading documents) so the
    // intelligence step can consume the new evidence. Steps append new
    // pipeline_runs rows; facts/sources accumulate in project memory.
    projectId = existingProjectId;
    await db`UPDATE projects SET status = 'running', updated_at = NOW() WHERE id = ${projectId}`;
  } else {
    const [project] = await db`
      INSERT INTO projects (address, status) VALUES (${address}, 'running')
      RETURNING id, address, status`;
    projectId = String(project.id);
  }

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
