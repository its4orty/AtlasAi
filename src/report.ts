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
      `<tr><td class="strong">EPC floor area</td><td>${esc(epcArea.value)} m²</td><td>${confPct(epcArea.confidence)}</td><td class="src">${esc(epcArea.source_name ?? "EPC Open Data Communities")}</td></tr>`,
    );
  } else {
    const epcNote = epcSrc?.notes ? esc(epcSrc.notes) : "EPC data not available for this project.";
    flags.push(
      `<tr><td class="strong">EPC floor area</td><td><span class="badge-warn">Not available</span><p class="note">${epcNote} Without floor area, per-m² value/cost figures cannot be derived — the financial model uses flat assumption bands instead.</p></td><td>—</td><td class="src">EPC Open Data Communities</td></tr>`,
    );
  }

  // Other discovery facts (postcode validity, local authority…).
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

function confidenceSection(facts: MemoryFact[]): string {
  const low = facts
    .filter((f) => f.confidence < 0.8)
    .sort((a, b) => a.confidence - b.confidence);
  if (low.length === 0) {
    return `<section>
      <h2><span class="num">5</span>Confidence summary</h2>
      <p class="lede">No extracted fact carries confidence below 80% — good evidence coverage for this project.</p>
    </section>`;
  }
  const rows = low.map(
    (f) =>
      `<tr><td class="strong">${esc(f.key)}</td><td>${esc(f.category)}</td><td>${esc(f.value.slice(0, 80))}${f.value.length > 80 ? "…" : ""}</td><td>${confPct(f.confidence)}</td><td class="src">${esc(f.source_name ?? "inferred")}</td></tr>`,
  );
  return `<section>
    <h2><span class="num">5</span>Confidence summary — needs review</h2>
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
    <h2><span class="num">6</span>Items requiring professional review</h2>
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
tr.flag-row td{background:#fdfaf4}
ul.review{padding:0;margin:12px 0 0;list-style:none}
ul.review li{padding:11px 14px 11px 40px;background:#fff;border:1px solid var(--line);border-top:0;font-size:13.5px;position:relative}
ul.review li:first-child{border-top:1px solid var(--line)}
ul.review li:before{content:"!";position:absolute;left:14px;top:9px;color:var(--copper);font:700 15px Manrope}
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
    sourcesSection(memory),
    marketSection(facts),
    constraintsSection(facts, sources),
    financialSection(facts),
    confidenceSection(facts),
    reviewSection(facts),
    disclaimer,
  ].join("\n");

  return documentShell(project.address, inner);
}
