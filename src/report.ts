/**
 * ATLAS AI — server-side feasibility report renderer (Phase 1).
 *
 * renderReportHtml(memory) turns a project's stored memory (facts + sources)
 * into a complete, standalone, printable HTML report. It invents nothing:
 * every figure and caveat comes from project memory — the feasibility facts,
 * the discovery/market facts, and the source rows with their notes. The
 * output is a full HTML document with its own print stylesheet so it can be
 * saved/printed as-is (served by /report/$id).
 *
 * Facts are grouped into a "map" of category → key → { value, confidence,
 * sourceName } for easy lookups; absence is handled explicitly and honestly
 * (e.g. "coverage not established" for a failed provider).
 */

export interface MemoryFact {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  source_id: string | null;
  source_name: string | null;
}

export interface MemorySource {
  id: string;
  name: string;
  url: string | null;
  fetched_at: unknown;
  notes: string | null;
}

export interface ProjectMemoryLike {
  project: {
    id: string;
    address: string;
    status: string;
    created_at: string | null;
    updated_at: string | null;
  };
  runs: Array<{ id: string; step: string; status: string }>;
  facts: MemoryFact[];
  sources: MemorySource[];
  decisions: Array<unknown>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const money = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const fmtMoney = (v: string | number): string => {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? `£${money.format(Math.round(n))}` : "—";
};
const fmtPct = (v: string | number): string => {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? `${n}%` : "—";
};
const confPct = (c: number): string => `${Math.round(c * 100)}%`;
const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

/** Build category → key → fact lookup from the facts array. */
function factMap(facts: MemoryFact[]): Map<string, Map<string, MemoryFact>> {
  const map = new Map<string, Map<string, MemoryFact>>();
  for (const f of facts) {
    let byKey = map.get(f.category);
    if (!byKey) {
      byKey = new Map();
      map.set(f.category, byKey);
    }
    if (!byKey.has(f.key)) byKey.set(f.key, f); // first (earliest) occurrence wins
  }
  return map;
}

function findFact(facts: MemoryFact[], category: string, keyRe: RegExp): MemoryFact | null {
  return facts.find((f) => f.category === category && keyRe.test(f.key)) ?? null;
}

/** Render a generic evidence table: rows of [label, value, confidence, source]. */
function evidenceTable(rows: Array<[string, string, string, string]>): string {
  return `<table class="ev">
    <thead><tr><th>Item</th><th>Value</th><th>Confidence</th><th>Source</th></tr></thead>
    <tbody>${rows
      .map(
        ([label, value, confidence, source]) =>
          `<tr><td>${esc(label)}</td><td>${value}</td><td>${confidence}</td><td class="src">${esc(source)}</td></tr>`,
      )
      .join("")}
    </tbody></table>`;
}

/* ------------------------------------------------------------------ */
/* Section builders                                                    */
/* ------------------------------------------------------------------ */

function confirmationSection(memory: ProjectMemoryLike): string {
  const c = factMap(memory.facts).get("confirmation");
  const decision = (memory.decisions as any[]).find((d) => d?.step === "confirm");
  if (!decision && !c) return "";
  const coords = [c?.get("coords_lat")?.value, c?.get("coords_lon")?.value].filter(Boolean).join(", ");
  return `<section><h2><span class="num">0</span>Property confirmation</h2><p class="lede">Client decision: <strong>${esc(decision?.choice ?? "confirmed")}</strong>. Coordinates source: ${esc(c?.get("coords_source")?.value ?? "client-confirmed")}${coords ? ` (${esc(coords)})` : ""}.</p><p class="note">The client confirmed this property reference before design generation. Street View is a live Google preview, not an image owned by ATLAS AI.</p></section>`;
}

function sourcesSection(memory: ProjectMemoryLike): string {
  const sources = memory.sources;
  const rows = sources.map((s) => {
    const url = s.url ? `<a href="${esc(s.url)}" rel="noopener">${esc(s.url)}</a>` : "—";
    const notes = s.notes ? `<p class="note">${esc(s.notes)}</p>` : "";
    const fetched = s.fetched_at ? fmtDate(String(s.fetched_at)) : "—";
    return `<tr><td class="strong">${esc(s.name)}</td><td>${url}</td><td>${fetched}</td><td>${notes}</td></tr>`;
  });
  return `<section>
    <h2><span class="num">1</span>Evidence sources consulted</h2>
    <p class="lede">Every source consulted for this project, with the caveats recorded at the time. An entry with no records returned is not evidence of absence — it is recorded as coverage not established.</p>
    <table class="ev">
      <thead><tr><th>Source</th><th>URL</th><th>Fetched</th><th>Notes / caveats</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </section>`;
}

function marketSection(facts: MemoryFact[]): string {
  const m = factMap(facts);
  const get = (key: string) => m.get("market")?.get(key) ?? null;
  const count = get("comparables_count");
  const median = get("comparables_median_price");
  const minmax = get("comparables_min_max");
  const hasEvidence = count && Number.parseInt(count.value, 10) > 0;

  if (!hasEvidence) {
    return `<section>
      <h2><span class="num">2</span>Market evidence</h2>
      <div class="flag warn">No comparables evidence was recorded for this project (Price Paid index empty or unavailable at collection time). A market value could not be estimated from evidence — the financial summary below is assumption-only.</div>
    </section>`;
  }

  const rows: Array<[string, string, string, string]> = [];
  const add = (label: string, f: MemoryFact | null, fmt: (v: string) => string) => {
    if (f) rows.push([label, fmt(f.value), confPct(f.confidence), f.source_name ?? "inferred"]);
  };
  add("Comparables sector", get("comparables_sector"), (v) => esc(v));
  add("Completed sales in sector", count, (v) => esc(v));
  add("Sales at exact postcode", get("comparables_postcode_count"), (v) => esc(v));
  add("Median sale price", median, fmtMoney);
  add("Price range (min – max)", minmax, (v) => {
    const [lo, hi] = v.split(",").map((x) => Number.parseFloat(x));
    return Number.isFinite(lo) && Number.isFinite(hi) ? `${fmtMoney(lo)} – ${fmtMoney(hi)}` : esc(v);
  });
  add("Most recent sale", get("most_recent_sale_date"), (v) => esc(v));
  add("Index coverage window", get("comparables_coverage_window"), (v) => esc(v));

  const caveat =
    count && Number.parseInt(count.value, 10) < 10
      ? `<p class="note caveat">Small sample (${esc(count.value)} sales): sector evidence is weak — treat any value derived from it as indicative only.</p>`
      : "";

  return `<section>
    <h2><span class="num">2</span>Market evidence</h2>
    <p class="lede">Completed, registered sale prices from HM Land Registry Price Paid (free, OGL v3) for the project's postcode sector. These are completed sales only — never asking prices or marketing valuations.</p>
    ${evidenceTable(rows)}
    ${caveat}
  </section>`;
}

function constraintsSection(facts: MemoryFact[], sources: MemorySource[]): string {
  const m = factMap(facts);
  const discovery = m.get("discovery") ?? new Map();
  const flood = discovery.get("flood_alerts_checked") ?? null;
  const planning = discovery.get("planning_records_checked") ?? null;
  const epcArea = findFact(facts, "epc", /floor.?area/i);
  const src = (nameRe: RegExp) => sources.find((s) => nameRe.test(s.name)) ?? null;
  const nhle = src(/Historic England/i);
  const planningSrc = src(/Planning Data/i);
  const epcSrc = src(/EPC/i);
  const eaSrc = src(/flood/i);

  const flags: string[] = [];

  // Flood — screening flag, always needs professional determination.
  if (flood) {
    flags.push(
      `<tr><td class="strong">Flood alerts checked</td><td>${esc(flood.value)} alert(s) near postcode centroid (screening only)</td><td>${confPct(flood.confidence)}</td><td class="src">Environment Agency flood monitoring</td></tr>`,
    );
  }
  flags.push(
    `<tr><td class="strong">Flood risk determination</td><td>Not established by this screening — flood alerts are <em>not</em> a Flood Map for Planning zone determination${eaSrc && eaSrc.notes ? `. ${esc(eaSrc.notes)}` : ""}</td><td>—</td><td class="src">Professional review required</td></tr>`,
  );

  // Planning — fact may be missing when the open API failed; say so honestly.
  if (planning) {
    flags.push(
      `<tr><td class="strong">Planning records checked</td><td>${esc(planning.value)} record(s) returned by open planning API</td><td>${confPct(planning.confidence)}</td><td class="src">Planning Data API</td></tr>`,
    );
  } else {
    const note = planningSrc?.notes ? esc(planningSrc.notes) : "Planning Data API coverage was not established for this project.";
    flags.push(
      `<tr class="flag-row"><td class="strong">Planning records checked</td><td><span class="badge-warn">Coverage not established</span><p class="note">${note}</p></td><td>—</td><td class="src">Professional review required</td></tr>`,
    );
  }

  // Heritage — limited-data check only, per the NHLE source note.
  const heritageNote = nhle?.notes
    ? esc(nhle.notes)
    : "Historic England National Heritage List check performed as a limited-data source; no conclusion was made.";
  flags.push(
    `<tr class="flag-row"><td class="strong">Heritage / listed status</td><td><span class="badge-warn">Check performed — no conclusion made</span><p class="note">${heritageNote}</p></td><td>—</td><td class="src">Professional review required</td></tr>`,
  );

  // EPC — floor area drives the per-m² model; absent here (token not configured).
  if (epcArea) {
    flags.push(
      `<tr><td class="strong">EPC floor area</td><td>${esc(epcArea.value)} m²</td><td>${confPct(epcArea.confidence)}</td><td class="src">${esc(epcArea.source_name ?? "EPC register")}</td></tr>`,
    );
  } else {
    const epcNote = epcSrc?.notes ? esc(epcSrc.notes) : "EPC data not available for this project.";
    flags.push(
      `<tr><td class="strong">EPC floor area</td><td><span class="badge-warn">Not available</span><p class="note">${epcNote} Without floor area, per-m² value/cost figures cannot be derived — the financial model uses flat assumption bands instead.</p></td><td>—</td><td class="src">EPC register</td></tr>`,
    );
  }

  // Other discovery facts (postcode validity, local authority…).
  const complianceGap = m.get("compliance")?.get("constraint_data");
  if (complianceGap) flags.push(`<tr class="flag-row"><td class="strong">Constraint data coverage</td><td><span class="badge-warn">Data gaps recorded</span><p class="note">${esc(complianceGap.value)}</p></td><td>${confPct(complianceGap.confidence)}</td><td class="src">ATLAS AI screening</td></tr>`);
  const extras: Array<[string, string, string, string]> = [];
  for (const key of ["postcode_valid", "local_authority"]) {
    const f = discovery.get(key);
    if (f) extras.push([key, esc(f.value), confPct(f.confidence), f.source_name ?? "inferred"]);
  }

  return `<section>
    <h2><span class="num">3</span>Constraints &amp; flags</h2>
    <p class="lede">Screening flags from the discovery step. These are honest, evidence-limited checks — absence of a record is never treated as proof of no constraint, and each item below requires professional determination.</p>
    <table class="ev">
      <thead><tr><th>Item</th><th>Finding</th><th>Confidence</th><th>Source</th></tr></thead>
      <tbody>${flags.join("")}</tbody>
    </table>
    ${extras.length ? `<h3 class="sub">Other discovery facts</h3>${evidenceTable(extras)}` : ""}
  </section>`;
}

const MONEY_KEYS = new Set([
  "current_value_estimate",
  "current_value_per_sqm",
  "gdv_estimate_low",
  "gdv_estimate_high",
  "refurbishment_cost_range_low",
  "refurbishment_cost_range_high",
  "professional_fees_amount",
]);
const PCT_KEYS = new Set(["professional_fees_percent", "indicative_roi", "roi_upside", "roi_downside"]);
const FINANCIAL_ORDER = [
  "comparables_available",
  "current_value_basis",
  "current_value_estimate",
  "current_value_per_sqm",
  "gdv_estimate_low",
  "gdv_estimate_high",
  "refurbishment_cost_range_low",
  "refurbishment_cost_range_high",
  "professional_fees_percent",
  "professional_fees_amount",
  "indicative_roi",
  "roi_upside",
  "roi_downside",
  "model_note",
];

function financialSection(facts: MemoryFact[]): string {
  const feats = facts
    .filter((f) => f.category === "feasibility" && !f.key.startsWith("assumption_"))
    .sort((a, b) => {
      const ia = FINANCIAL_ORDER.indexOf(a.key);
      const ib = FINANCIAL_ORDER.indexOf(b.key);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  const assumptions = facts
    .filter((f) => f.category === "feasibility" && f.key.startsWith("assumption_"))
    .sort((a, b) => a.key.localeCompare(b.key));

  if (feats.length === 0) {
    return `<section>
      <h2><span class="num">4</span>Financial summary</h2>
      <div class="flag warn">The feasibility step has not produced financial facts for this project yet — re-run the pipeline after the feasibility step is enabled.</div>
    </section>`;
  }

  const fmt = (f: MemoryFact): string => {
    if (MONEY_KEYS.has(f.key)) return fmtMoney(f.value);
    if (PCT_KEYS.has(f.key)) return fmtPct(f.value);
    return esc(f.value);
  };
  const rows = feats.map(
    (f) =>
      `<tr><td class="strong">${esc(f.key.replace(/_/g, " "))}</td><td>${fmt(f)}</td><td>${confPct(f.confidence)}</td><td class="src">${esc(f.source_name ?? "inferred")}</td></tr>`,
  );
  const assumptionRows = assumptions.map(
    (a) => `<tr><td class="strong">${esc(a.key.replace(/^assumption_/, "").replace(/_/g, " "))}</td><td>${esc(a.value)}</td></tr>`,
  );

  return `<section>
    <h2><span class="num">4</span>Financial summary</h2>
    <p class="lede">An <strong>assumption-led screening model</strong> built only from the evidence in project memory. All money is rounded to whole pounds. Every figure is advisory — see the disclaimer below. Assumption-led outputs carry low confidence by design.</p>
    <table class="ev">
      <thead><tr><th>Item</th><th>Value</th><th>Confidence</th><th>Basis</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <h3 class="sub">Key assumptions used</h3>
    <table class="ev">
      <thead><tr><th>Assumption</th><th>Value</th></tr></thead>
      <tbody>${assumptionRows.join("")}</tbody>
    </table>
  </section>`;
}

/**
 * Section 5 — existing layout (digital twin). Rendered only when the twin step
 * has run for this project (category "twin" facts exist in memory). Latest
 * wins: facts accumulate across re-runs, so iterate in id order and overwrite —
 * the newest as-built model is the one shown. The SVG is inserted as-is: it is
 * generated server-side by src/twin.ts, not user input.
 */
function twinSection(facts: MemoryFact[]): string {
  const t = new Map<string, MemoryFact>();
  for (const f of facts) {
    if (f.category !== "twin") continue;
    t.set(f.key, f);
  }
  if (!t.has("twin_status")) return "";
  const status = t.get("twin_status")?.value ?? "";
  const svg = t.get("twin_floor_plan_svg")?.value ?? null;
  const axoSvg = t.get("twin_floor_plan_axo_svg")?.value ?? null;
  const description = t.get("twin_layout_description")?.value ?? null;
  const coverage = t.get("twin_data_coverage")?.value ?? null;
  const roomsRaw = t.get("twin_rooms")?.value ?? null;
  const totalArea = t.get("twin_total_area_m2")?.value ?? null;

  if (status === "no-space-evidence") {
    return `<section>
      <h2><span class="num">6</span>Existing layout (digital twin)</h2>
      <div class="flag warn">No space evidence in project memory — the as-built model could not be generated. Upload a floor plan or EPC (or enable the EPC register lookup), then re-run the analysis.</div>
      ${coverage ? `<p class="note">${esc(coverage)}</p>` : ""}
    </section>`;
  }

  let roomsHtml = "";
  if (roomsRaw) {
    try {
      const rooms = JSON.parse(roomsRaw) as Array<{ label: string; width_m: number; height_m: number; area_m2: number }>;
      roomsHtml = evidenceTable(
        rooms.map((r) => [
          r.label,
          `${r.width_m} × ${r.height_m} m · ${r.area_m2} m²`,
          "—",
          "document intelligence (labels paired with dimensions in document order)",
        ]),
      );
    } catch {
      roomsHtml = "";
    }
  }

  return `<section>
    <h2><span class="num">6</span>Existing layout (digital twin)</h2>
    <p class="lede">The current ("as-built") layout of the property, generated from the confidence-scored space facts in project memory. This is the "before" to the concept design's "after" — it is <strong>indicative, not a surveyed plan</strong>, and it never invents rooms or dimensions that are not in the evidence.</p>
    ${totalArea ? `<p class="note">Total floor area: ${esc(totalArea)} m².</p>` : ""}
    ${svg ? `<div class="twin-svg"><p class="note"><strong>Existing layout — 2D plan</strong></p>${svg}</div>` : ""}
    ${axoSvg ? `<div class="twin-svg"><p class="note"><strong>3D-style view (indicative, not photorealistic)</strong></p>${axoSvg}<p class="note caveat">Schematic extrusion from the same project-memory evidence, not a surveyed or photorealistic render. ${status === "generated" && roomsRaw ? "Room geometry is limited to recorded dimensions; verify with a measured survey." : "Footprint-only extrusion: only total area was evidenced; shape and rooms are not known."}</p></div>` : ""}
    ${description ? `<p class="note">${esc(description)}</p>` : ""}
    ${roomsHtml ? `<h3 class="sub">Rooms recorded</h3>${roomsHtml}` : ""}
    ${coverage ? `<div class="flag"><h3 class="sub">Data coverage</h3><p class="note">${esc(coverage)}</p></div>` : ""}
  </section>`;
}

/**
 * Section 5 — current property, real Google Street View imagery. Rendered only
 * when the design step recorded street-view facts. This is REAL photography
 * (Google), never labelled as AI; the pin is approximate and the caption says so.
 */
function streetViewSection(facts: MemoryFact[]): string {
  const m = factMap(facts);
  const imagery = m.get("imagery") ?? new Map();
  const embedUrl = imagery.get("imagery_streetview_embed_url")?.value ?? null;
  const imgUrl = imagery.get("imagery_streetview_url")?.value ?? null;
  if (!embedUrl && !imgUrl) return "";
  const lat = imagery.get("imagery_streetview_lat")?.value ?? null;
  const lon = imagery.get("imagery_streetview_lon")?.value ?? null;
  const view = imgUrl
    ? `<figure class="sv"><img src="${esc(imgUrl)}" alt="Google Street View of the current property (real photograph)"/><figcaption>Google Street View (static image) — <strong>real photograph from Google, not AI-generated</strong>. Approximate location${lat && lon ? ` (${esc(lat)}, ${esc(lon)})` : ""}; verify at the property.</figcaption></figure>`
    : `<figure class="sv"><iframe src="${esc(embedUrl)}" width="100%" height="420" style="border:0" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" title="Google Street View of the current property"></iframe><figcaption>Google Street View — <strong>real imagery from Google, not AI-generated</strong>. Approximate location${lat && lon ? ` (${esc(lat)}, ${esc(lon)})` : ""}; verify at the property.</figcaption></figure>`;
  return `<section>
    <h2><span class="num">5</span>Current property — Google Street View</h2>
    <p class="lede">A real street-level view of the property's current frontage, embedded from Google Street View. This is a photograph — the AI concept visualisations of the conversion appear later in this report.</p>
    ${view}
    <p class="note caveat">Approximate location; verify at the property. Street View imagery may be out of date, and the property may not be visible if it has no street-facing frontage.</p>
  </section>`;
}
/**
 * Section 6 — concept design ("convert to X"). Rendered only when the design
 * step has run for this project (design facts exist in memory). The SVG is
 * inserted as-is: it is generated server-side by src/design.ts, not user input.
 */
function designSection(facts: MemoryFact[]): string {
  // Latest design wins: facts accumulate across re-runs, so iterate in id order
  // and overwrite — the newest concept is the one shown.
  const d = new Map<string, MemoryFact>();
  for (const f of facts) {
    // Imagery facts are stored under category "imagery" but belong to the
    // design section (the renders of this concept) — include both.
    if (f.category !== "design" && f.category !== "imagery") continue;
    d.set(f.key, f);
  }
  // Same latest-wins rule for compliance facts: the change-of-use verdict must
  // match the design being displayed, not the first design ever generated.
  const compliance = new Map<string, MemoryFact>();
  for (const f of facts) {
    if (f.category !== "compliance") continue;
    compliance.set(f.key, f);
  }
  if (!d.has("design_status")) return "";
  const svg = d.get("design_concept_svg")?.value ?? null;
  const axoSvg = d.get("design_concept_axo_svg")?.value ?? null;
  const programLabel = d.get("design_program_label")?.value ?? d.get("design_target_use")?.value ?? "—";
  const generatedAt = d.get("design_generated_at")?.value ?? null;
  const totalArea = d.get("design_total_floor_area_m2")?.value;
  const allocated = d.get("design_allocated_m2")?.value;
  const circulation = d.get("design_circulation_pct")?.value;
  const assumptions = d.get("design_assumptions")?.value;
  const imagery = ["exterior", "interior"].map(view => ({ view, url: d.get(`imagery_${view}_url`)?.value, status: d.get(`imagery_${view}_status`)?.value, provider: d.get(`imagery_${view}_provider`)?.value, model: d.get(`imagery_${view}_model`)?.value })).filter(x => x.url && x.status === "generated");

  let zonesHtml = "";
  const zonesRaw = d.get("design_zones")?.value;
  if (zonesRaw) {
    try {
      const zones = JSON.parse(zonesRaw) as Array<{
        zone: string;
        room: string;
        area_m2: number;
        retained: boolean;
        tight: boolean;
      }>;
      zonesHtml = evidenceTable(
        zones.map((zRow) => [
          zRow.zone,
          `${esc(zRow.room)} · ${zRow.area_m2} m²${zRow.retained ? " (retained)" : " (new)"}${zRow.tight ? " ⚠ tight fit" : ""}`,
          "—",
          zRow.retained ? "existing room reused" : "new sub-division",
        ]),
      );
    } catch {
      zonesHtml = "";
    }
  }

  return `<section>
    <h2><span class="num">7</span>Concept design — convert to ${esc(programLabel)}</h2>
    <p class="lede">An indicative zoning concept generated from the space facts in project memory (room dimensions, labels, floor area). It is a screening sketch — <strong>not a professional design, not for construction</strong>, and no planning or statutory compliance has been checked.</p>
    ${totalArea ? `<p class="note">Floor area used: ${esc(totalArea)} m² · allocated to zones: ${esc(allocated ?? "—")} m² · circulation: ${esc(circulation ?? "—")}%${generatedAt ? ` · generated ${fmtDate(generatedAt.slice(0, 10))}` : ""}.</p>` : ""}
    ${svg ? `<div class="design-svg"><p class="note"><strong>Concept design — 2D plan</strong></p>${svg}</div>` : ""}
    ${axoSvg ? `<div class="design-svg"><p class="note"><strong>3D-style view (indicative, not photorealistic)</strong></p>${axoSvg}<p class="note caveat">Schematic extrusion from the same project-memory room evidence, not a surveyed or photorealistic render. This concept remains indicative and not for construction.</p></div>` : ""}
    ${zonesHtml ? `<h3 class="sub">Proposed zones</h3>${zonesHtml}` : ""}
    ${assumptions ? `<p class="note caveat">${esc(assumptions)}</p>` : ""}
    ${imagery.length ? `<div class="imagery"><h3 class="sub">Photorealistic concept visualisations</h3>${imagery.map(i => `<figure><img src="${esc(i.url)}" alt="AI-generated ${i.view} concept visualisation"/><figcaption>AI-generated concept visualisation — not a photograph of the property. ${esc(i.view)} view; provider ${esc(i.provider ?? "unknown")}, model ${esc(i.model ?? "unknown")}.</figcaption></figure>`).join("")}<p class="note caveat">Images are generated from the project's confidence-scored spatial brief and target use; they are illustrative concepts, not surveyed or verified photography.</p></div>` : ""}
    ${complianceBlock(compliance)}
  </section>`;
}

function complianceBlock(c: Map<string, MemoryFact>): string {
  const note = c.get("verdict_note");
  if (!note) return "";
  const permission = c.get("change_of_use_permission_required")?.value ?? "unknown";
  const title = permission === "no" ? "No change-of-use permission required (screening)" : permission === "yes" ? "Change-of-use permission likely required (screening)" : "Change-of-use verdict unknown";
  return `<div class="flag ${permission === "no" ? "" : "warn"}"><h3 class="sub">Change of use</h3><p><strong>${esc(title)}</strong></p><p>${esc(note.value)}</p><p class="note">Confidence: ${confPct(note.confidence)}. This is an England Use Classes Order screening, not a planning determination.</p></div>`;
}
const fmtDist = (d: number): string => (d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`);

export const NEARBY_CAVEAT = "open-data candidate — vacancy not verified";
export interface NearbyMapPin {
  name: string;
  kind: string;
  size: string | null;
  distance: string | null;
  source: string;
  lat: number;
  lon: number;
}

/** Serialize only non-sensitive nearby facts for the progressive map enhancement. */
export function serializeNearbyMapData(facts: MemoryFact[]): { pins: NearbyMapPin[]; center: { lat: number; lon: number } | null; caveat: string } {
  const byKey = factMap(facts).get("nearby");
  const count = Number.parseInt(byKey?.get("nearby_count")?.value ?? "0", 10);
  const pins: NearbyMapPin[] = [];
  for (let i = 0; i < (Number.isFinite(count) ? count : 0); i++) {
    const lat = Number.parseFloat(byKey?.get(`nearby_${i}_lat`)?.value ?? "");
    const lon = Number.parseFloat(byKey?.get(`nearby_${i}_lon`)?.value ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const size = Number.parseFloat(byKey?.get(`nearby_${i}_size_m2`)?.value ?? "");
    const distance = Number.parseFloat(byKey?.get(`nearby_${i}_distance_m`)?.value ?? "");
    pins.push({
      name: byKey?.get(`nearby_${i}_name`)?.value ?? "—",
      kind: byKey?.get(`nearby_${i}_kind`)?.value ?? "candidate",
      size: Number.isFinite(size) && size > 0 ? `${size} m²` : null,
      distance: Number.isFinite(distance) && distance >= 0 ? fmtDist(distance) : null,
      source: byKey?.get(`nearby_${i}_source`)?.value ?? "",
      lat, lon,
    });
  }
  const address = factMap(facts).get("address");
  const discovery = factMap(facts).get("discovery");
  const lat = Number.parseFloat(discovery?.get("latitude")?.value ?? address?.get("latitude")?.value ?? address?.get("lat")?.value ?? "");
  const lon = Number.parseFloat(discovery?.get("longitude")?.value ?? address?.get("longitude")?.value ?? address?.get("lon")?.value ?? "");
  return { pins, center: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null, caveat: NEARBY_CAVEAT };
}

function nearbySection(facts: MemoryFact[]): string {
  const byKey = factMap(facts).get("nearby");
  if (!byKey) return "";
  const n = Number.parseInt(byKey.get("nearby_count")?.value ?? "0", 10);
  if (!Number.isFinite(n) || n <= 0) return "";
  const targetUse = factMap(facts).get("design")?.get("design_target_use")?.value;
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const kind = byKey.get(`nearby_${i}_kind`)?.value;
    if (!kind) continue;
    const name = byKey.get(`nearby_${i}_name`)?.value ?? "—";
    const sizeRaw = Number.parseFloat(byKey.get(`nearby_${i}_size_m2`)?.value ?? "");
    const distRaw = Number.parseFloat(byKey.get(`nearby_${i}_distance_m`)?.value ?? "");
    const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? `${esc(String(sizeRaw))} m²` : "—";
    const dist = Number.isFinite(distRaw) && distRaw >= 0 ? fmtDist(distRaw) : "—";
    const source = byKey.get(`nearby_${i}_source`)?.value ?? "";
    const confRaw = Number.parseFloat(byKey.get(`nearby_${i}_confidence`)?.value ?? "");
    const conf = Number.isFinite(confRaw) ? confPct(confRaw) : "—";
    const badge = kind === "site" ? `<span class="badge-nearby site">SITE</span>` : `<span class="badge-nearby prem">PREMISES</span>`;
    rows.push(`<tr><td>${badge}<span class="strong"> ${esc(name)}</span></td><td>${size}</td><td>${dist}</td><td class="src">${esc(source)}</td><td>${conf}</td></tr>`);
  }
  if (rows.length === 0) return "";
  const mapData = serializeNearbyMapData(facts);
  const json = JSON.stringify(mapData).replace(/<\//g, "<\\/");
  const center = mapData.center ? `map.setView([${mapData.center.lat}, ${mapData.center.lon}], 14);` : "";
  return `<section>
    <h2><span class="num">8</span>Nearby opportunities — ${NEARBY_CAVEAT}</h2>
    <p class="lede">Candidate buildings and development sites near this project that could plausibly accommodate the same target use${targetUse ? ` (convert to ${esc(targetUse)})` : ""}. <strong>${NEARBY_CAVEAT}</strong>; availability is not established.</p>
    <div class="nearby-map-wrap"><div id="nearby-map" class="nearby-map" role="img" aria-label="Map of nearby open-data candidates"></div><p id="nearby-map-fallback" class="note">Map enhancement unavailable; the candidate list below remains the source of record.</p></div>
    <script type="application/json" id="nearby-map-data">${json}</script>
    <table class="ev"><thead><tr><th>Candidate</th><th>Size</th><th>Distance</th><th>Source</th><th>Confidence</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    <p class="note caveat">${NEARBY_CAVEAT}. Candidates flagged from open data (OSM/EPC). Availability and vacancy are NOT verified — confirm with the local authority, agents and the landowner.</p>
    <script>(function(){var el=document.getElementById('nearby-map'),data=document.getElementById('nearby-map-data'),fallback=document.getElementById('nearby-map-fallback');if(!el||!data)return;function init(){if(!window.L)return;try{var d=JSON.parse(data.textContent||'{}'),m=L.map(el),bounds=[];L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap contributors',maxZoom:19}).addTo(m);d.pins.forEach(function(p){var marker=L.marker([p.lat,p.lon]).addTo(m);bounds.push([p.lat,p.lon]);marker.bindPopup('<strong>'+p.name.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})+'</strong><br>'+p.kind+(p.size?'<br>'+p.size:'')+(p.distance?'<br>'+p.distance:'')+'<br>'+p.source+'<br><em>'+d.caveat+'</em>')});if(d.center)bounds.push([d.center.lat,d.center.lon]);if(bounds.length)m.fitBounds(bounds,{padding:[24,24],maxZoom:15});else ${center}fallback.style.display='none'}catch(e){}}var t=setInterval(function(){if(window.L){clearInterval(t);init()}},50);setTimeout(function(){clearInterval(t);if(!window.L)fallback.style.display='block'},4000)})();</script>
  </section>`;
}
function confidenceSection(facts: MemoryFact[]): string {
  const low = facts
    .filter((f) => f.confidence < 0.8)
    .sort((a, b) => a.confidence - b.confidence);
  if (low.length === 0) {
    return `<section>
      <h2><span class="num">9</span>Confidence summary</h2>
      <p class="lede">No extracted fact carries confidence below 80% — good evidence coverage for this project.</p>
    </section>`;
  }
  const rows = low.map(
    (f) =>
      `<tr><td class="strong">${esc(f.key)}</td><td>${esc(f.category)}</td><td>${esc(f.value.slice(0, 80))}${f.value.length > 80 ? "…" : ""}</td><td>${confPct(f.confidence)}</td><td class="src">${esc(f.source_name ?? "inferred")}</td></tr>`,
  );
  return `<section>
    <h2><span class="num">9</span>Confidence summary — needs review</h2>
    <p class="lede">Every fact below carries confidence below 80% and should be treated as needing review before reliance. This includes all assumption-led financial outputs by design.</p>
    <table class="ev">
      <thead><tr><th>Fact</th><th>Category</th><th>Value</th><th>Confidence</th><th>Source</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </section>`;
}

function reviewSection(facts: MemoryFact[]): string {
  const items: string[] = [];
  const m = factMap(facts);
  const discovery = m.get("discovery") ?? new Map();

  if (!discovery.get("planning_records_checked")) {
    items.push("Planning record coverage was <strong>not established</strong> (open planning API unavailable or returned nothing). Obtain a planning history and constraint search before any commitment.");
  }
  items.push("Flood screening is <strong>not</strong> a Flood Map for Planning zone determination — obtain an official flood-risk assessment for the exact property.");
  items.push("Heritage check was limited-data only — commission a listed-building / conservation-area buffer review before design work.");
  if (!findFact(facts, "epc", /floor.?area/i)) {
    items.push("EPC floor area is unavailable, so per-m² value and cost figures could not be derived — the flat assumption bands should be replaced with measured areas.");
  }
  const count = m.get("market")?.get("comparables_count");
  if (count && Number.parseInt(count.value, 10) > 0 && Number.parseInt(count.value, 10) < 10) {
    items.push(`Comparables sample is small (${esc(count.value)} sales) — commission a professional valuation rather than relying on the sector median.`);
  }
  const financial = facts.filter((f) => f.category === "feasibility" && !f.key.startsWith("assumption_"));
  if (financial.length > 0) {
    items.push("Every financial figure is an <strong>assumption-based screening estimate (confidence below 50% by design)</strong> — obtain a professional development appraisal and valuation before relying on any of them.");
  }

  return `<section>
    <h2><span class="num">10</span>Items requiring professional review</h2>
    <ul class="review">
      ${items.map((i) => `<li>${i}</li>`).join("")}
      ${items.length === 0 ? "<li>No outstanding professional-review items were identified from the evidence recorded.</li>" : ""}
    </ul>
  </section>`;
}

/* ------------------------------------------------------------------ */
/* Document shell                                                      */
/* ------------------------------------------------------------------ */

const REPORT_CSS = `
:root{--ink:#101820;--graphite:#27323a;--limestone:#f4f0e8;--copper:#c98a4a;--copper-light:#e5b77c;--slate:#71808a;--line:#ddd6c8;--warn-bg:#f7efe3;--warn-line:#c98a4a}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--limestone);color:var(--ink);font-family:'Manrope',ui-sans-serif,sans-serif;line-height:1.6}
h1,h2,h3{font-family:'DM Sans',ui-sans-serif,sans-serif;letter-spacing:-.02em;margin:0}
.report{max-width:900px;margin:0 auto;padding:0 28px 60px}
a{color:var(--ink)}
/* Masthead */
.masthead{background:var(--ink);color:var(--limestone);padding:38px 40px 30px;margin:28px 0 34px}
.masthead .brand{display:flex;align-items:center;justify-content:space-between}
.masthead .brand img{width:110px;display:block}
.doctype{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--copper-light);margin:26px 0 12px}
.masthead h1{font-size:clamp(26px,4vw,38px);line-height:1.08;max-width:760px}
.meta{width:100%;border-collapse:collapse;margin-top:24px;font-size:12px}
.meta td{padding:7px 0;border-top:1px solid #3a4850;color:#d7d5ce;vertical-align:top}
.meta td:first-child{color:var(--copper-light);font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.1em;width:150px}
.meta td:last-child{color:var(--limestone)}
.back{display:inline-block;margin-top:20px;color:var(--copper-light);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;text-decoration:none}
/* Sections */
section{margin:0 0 40px}
h2{font-size:24px;display:flex;align-items:baseline;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:10px}
h2 .num{color:var(--copper);font-size:13px;letter-spacing:0}
.nearby-map-wrap{margin:14px 0;background:#fff;border:1px solid var(--line);padding:10px}.nearby-map{height:380px;background:#e8e4da}.nearby-map-wrap .note{margin:8px 2px}.leaflet-container{font:12px Manrope,sans-serif}
h3.sub{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:var(--slate);margin:26px 0 10px}
.lede{color:var(--slate);font-size:13.5px;max-width:760px;margin:12px 0 18px}
.note{font-size:12px;color:var(--slate);margin:6px 0 0;max-width:520px}
.caveat{color:#8a5a1e;font-weight:600}
/* Tables */
table.ev{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid var(--line)}
table.ev th{font:700 10px Manrope;text-transform:uppercase;letter-spacing:.1em;color:var(--slate);text-align:left;padding:10px 12px;border-bottom:1px solid #c8c1b5;background:#faf8f2}
table.ev td{padding:10px 12px;border-bottom:1px solid #eee8dc;vertical-align:top}
table.ev tr:last-child td{border-bottom:0}
table.ev td.strong{font-weight:700;white-space:nowrap}
table.ev td.src{font-size:11px;color:var(--slate)}
/* Flags */
.flag{border:1px solid;padding:14px 16px;font-size:13px;margin:6px 0 18px}
.flag.warn{background:var(--warn-bg);border-color:var(--warn-line);color:#7a4e14}
.badge-warn{display:inline-block;background:var(--warn-bg);border:1px solid var(--warn-line);color:#8a5a1e;font:700 10px Manrope;text-transform:uppercase;letter-spacing:.1em;padding:3px 8px;white-space:nowrap}
.badge-nearby{display:inline-block;font:700 9px Manrope;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;white-space:nowrap;vertical-align:middle;border-radius:3px}
.badge-nearby.site{background:#e8efec;border:1px solid #9db8ab;color:#2e5c46}
.badge-nearby.prem{background:#efe8f4;border:1px solid #bda3cc;color:#5b3a73}
tr.flag-row td{background:#fdfaf4}
ul.review{padding:0;margin:12px 0 0;list-style:none}
ul.review li{padding:11px 14px 11px 40px;background:#fff;border:1px solid var(--line);border-top:0;font-size:13.5px;position:relative}
ul.review li:first-child{border-top:1px solid var(--line)}
ul.review li:before{content:"!";position:absolute;left:14px;top:9px;color:var(--copper);font:700 15px Manrope}
/* Concept design */
.design-svg{margin:14px 0;padding:12px;background:#fff;border:1px solid var(--line)}
.design-svg svg, .imagery img{width:100%;height:auto;display:block}
/* Imagery figures (AI concept renders + real Street View) */
.imagery figure, figure.sv{margin:14px 0;background:#fff;border:1px solid var(--line);padding:10px}
.imagery figcaption, figure.sv figcaption{font-size:11.5px;color:var(--slate);margin:8px 2px 2px}
figure.sv iframe{display:block}
/* Digital twin (as-built) */
.twin-svg{margin:14px 0;padding:12px;background:#fff;border:1px solid var(--line)}
.twin-svg svg{width:100%;height:auto;display:block}
/* Footer */
.disclaimer{background:var(--ink);color:#d7d5ce;padding:26px 40px;font-size:12px}
.disclaimer h3{color:var(--copper-light);font-size:12px;text-transform:uppercase;letter-spacing:.14em;margin:0 0 10px}
.disclaimer p{margin:0 0 8px}
.disclaimer p:last-child{margin:0}
@media(max-width:640px){.report{padding:0 14px 40px}.masthead{padding:26px 22px 22px}.disclaimer{padding:22px}}
@media print{
  body{background:#fff}
  .masthead{background:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact;break-after:avoid}
  .report{max-width:100%;padding:0}
  section{break-inside:auto}
  table.ev tr,table.meta tr{break-inside:avoid}
  h2{break-after:avoid}
  .back{display:none}
  @page{margin:16mm 14mm}
  .disclaimer{break-before:auto}
}
`;

function documentShell(address: string, inner: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ATLAS AI — Feasibility screening · ${esc(address)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@600;700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="report">
${inner}
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Public renderer                                                     */
/* ------------------------------------------------------------------ */

export function renderReportHtml(memory: ProjectMemoryLike): string {
  const { project, facts, sources } = memory;

  const generatedAt =
    findFact(facts, "report", /generated_at/i)?.value ?? project.updated_at ?? project.created_at ?? null;
  const postcode = factMap(facts).get("address")?.get("postcode")?.value ?? null;
  const localAuthority = factMap(facts).get("discovery")?.get("local_authority")?.value ?? null;

  const masthead = `<header class="masthead">
    <div class="brand">
      <img src="/brand/atlas-logo.svg" alt="ATLAS AI"/>
      <span class="doctype" style="margin:0">Feasibility screening report</span>
    </div>
    <p class="doctype">ATLAS AI · ADVISORY FEASIBILITY SCREENING</p>
    <h1>${esc(project.address)}</h1>
    <table class="meta">
      <tr><td>Project</td><td>#${esc(project.id)} · status ${esc(project.status)}</td></tr>
      <tr><td>Report generated</td><td>${fmtDate(generatedAt)}</td></tr>
      ${postcode ? `<tr><td>Postcode</td><td>${esc(postcode)}</td></tr>` : ""}
      ${localAuthority ? `<tr><td>Local authority</td><td>${esc(localAuthority)}</td></tr>` : ""}
    </table>
    <a class="back" href="/project/${esc(project.id)}">← Back to project memory</a>
  </header>`;

  const disclaimer = `<footer class="disclaimer">
    <h3>Disclaimer</h3>
    <p>This document is an <strong>advisory feasibility screening</strong> produced automatically from free public data and stated assumptions. It is <strong>not professional advice</strong> (not a valuation, development appraisal, or legal/planning opinion).</p>
    <p>There is <strong>no guarantee of planning approval or of any returns</strong>. Assumption-led figures carry low confidence by design, and sensitivity is shown to illustrate the range of outcomes. Obtain professional advice before relying on anything in this report.</p>
  </footer>`;

  const inner = [
    masthead,
    confirmationSection(memory),
    sourcesSection(memory),
    marketSection(facts),
    constraintsSection(facts, sources),
    financialSection(facts),
    streetViewSection(facts),
    twinSection(facts),
    designSection(facts),
    nearbySection(facts),
    confidenceSection(facts),
    reviewSection(facts),
    disclaimer,
  ].join("\n");

  return documentShell(project.address, inner);
}
