/**
 * ATLAS AI — nearby opportunities scan (open-data CANDIDATES, never verified
 * vacancies).
 *
 * No free UK source records true vacancy, so this module deliberately returns
 * candidate flags:
 *  - OSM Overpass: development sites (landuse=construction), buildings tagged
 *    disused/abandoned (shop|building|office|commercial) and any building
 *    tagged vacant.
 *  - EPC register (MHCLG Energy Certificate Data API): non-domestic premises
 *    whose certificate floor area falls in a target-compatible size band.
 *    The register says NOTHING about vacancy — every output item carries an
 *    honest note and a low confidence score.
 *
 * Every fetcher has a timeout and degrades to [] on any failure; combine()
 * filters for target-use compatibility (reusing src/compliance.ts), ranks by
 * distance and caps the list.
 */
import {
  currentUseClass,
  normaliseComplianceUse,
  targetUseClass,
} from "./compliance";

export const OSM_OVERPASS_SOURCE = "OSM Overpass (OpenStreetMap contributors, ODbL)";
export const EPC_REGISTER_SOURCE = "EPC register";

const EPC_API_BASE = "https://api.get-energy-performance-data.communities.gov.uk";
const POSTCODES_IO = "https://api.postcodes.io";
const TIMEOUT_MS = 12_000;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const UA = "AtlasAI/1.0 (ATLAS AI property-intelligence demo; contact: team@atlasai.local)";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

async function fetchJson(url: string, init: RequestInit, ms = TIMEOUT_MS): Promise<unknown> {
  const res = await fetchWithTimeout(url, init, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Module-level postcodes.io cache so repeated scans don't re-hit the API. */
const postcodeCache = new Map<string, { lat: number; lon: number } | null>();
const nearbyPostcodeCache = new Map<string, Array<{ postcode: string; lat: number; lon: number }>>();

async function postcodeCentroid(postcode: string): Promise<{ lat: number; lon: number } | null> {
  const key = postcode.replace(/\s+/g, "").toUpperCase();
  if (postcodeCache.has(key)) return postcodeCache.get(key) ?? null;
  try {
    const json = (await fetchJson(
      `${POSTCODES_IO}/postcodes/${encodeURIComponent(key)}`,
      { headers: { accept: "application/json", "User-Agent": UA } },
    )) as { result?: { latitude?: number; longitude?: number } | null };
    const r = json.result;
    const out = r && typeof r.latitude === "number" && typeof r.longitude === "number"
      ? { lat: r.latitude, lon: r.longitude }
      : null;
    postcodeCache.set(key, out);
    return out;
  } catch {
    postcodeCache.set(key, null);
    return null;
  }
}

/** Nearest postcodes to a point (postcodes.io, sorted by distance) — used to
 * enumerate the postcodes the EPC register is searched over. */
async function nearestPostcodes(lat: number, lon: number, limit = 10): Promise<Array<{ postcode: string; lat: number; lon: number }>> {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = nearbyPostcodeCache.get(key);
  if (cached) return cached;
  try {
    const json = (await fetchJson(
      `${POSTCODES_IO}/postcodes?lon=${encodeURIComponent(String(lon))}&lat=${encodeURIComponent(String(lat))}&limit=${limit}`,
      { headers: { accept: "application/json", "User-Agent": UA } },
    )) as { result?: Array<{ postcode?: string; latitude?: number; longitude?: number }> };
    const out = (json.result ?? [])
      .filter((r) => r.postcode && typeof r.latitude === "number" && typeof r.longitude === "number")
      .map((r) => ({ postcode: String(r.postcode), lat: r.latitude as number, lon: r.longitude as number }));
    nearbyPostcodeCache.set(key, out);
    return out;
  } catch {
    return [];
  }
}

/** Reverse-geocode a point to its nearest postcode (postcodes.io). */
export async function reverseGeocodePostcode(lat: number, lon: number): Promise<string | null> {
  const list = await nearestPostcodes(lat, lon, 1);
  return list[0]?.postcode ?? null;
}

/* ------------------------------------------------------------------ */
/* 1a) OSM Overpass — development sites + disused/abandoned/vacant     */
/* ------------------------------------------------------------------ */
export interface NearbySiteItem {
  type: "site" | "building";
  name: string | null;
  context: string;
  lat: number;
  lon: number;
  distance_m: number;
  size_m2: number | null;
  source: string;
  tags: Record<string, string>;
}

function overpassQuery(lat: number, lon: number, radiusM: number): string {
  return (
    `[out:json][timeout:20];(` +
    `nwr["disused"~"shop|building|office|commercial"](around:${radiusM},${lat},${lon});` +
    `nwr["abandoned"~"shop|building|office|commercial"](around:${radiusM},${lat},${lon});` +
    `nwr["landuse"="construction"](around:${radiusM},${lat},${lon});` +
    `nwr["vacant"="yes"](around:${radiusM},${lat},${lon});` +
    `);out center tags 30;`
  );
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function elementCenter(e: OverpassElement): { lat: number; lon: number } | null {
  if (typeof e.center?.lat === "number" && typeof e.center?.lon === "number") {
    return { lat: e.center.lat, lon: e.center.lon };
  }
  if (typeof e.lat === "number" && typeof e.lon === "number") return { lat: e.lat, lon: e.lon };
  return null;
}

/** "Address-ish" context from whatever OSM tags exist (no reverse geocoding). */
function siteContext(tags: Record<string, string>): string {
  const addr = [tags["addr:housenumber"], tags["addr:housename"], tags["addr:street"], tags["addr:city"]]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (addr) return addr;
  if (tags.landuse === "construction") return "Construction site";
  const kind = tags.building ?? tags.shop ?? tags.office ?? tags.commercial ?? "building";
  const flag = tags.vacant === "yes" ? "vacant" : tags.disused ? "disused" : tags.abandoned ? "abandoned" : "";
  return [flag, kind].filter(Boolean).join(" ").trim() || "Building";
}

function parseSite(tags: Record<string, string>): { kind: "site" | "building"; name: string | null; size: number | null } {
  const kind = tags.landuse === "construction" ? "site" : "building";
  const name = tags.name ?? tags["addr:housename"] ?? null;
  const sizeRaw = Number.parseFloat(tags.area ?? "");
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.round(sizeRaw) : null;
  return { kind, name, size };
}

/** Query Overpass (with mirror fallback). Never throws — returns [] on failure. */
export async function fetchNearbySites(lat: number, lon: number, radiusM = 1500): Promise<NearbySiteItem[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const data = overpassQuery(lat, lon, radiusM);
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const json = (await fetchJson(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": UA },
          body: new URLSearchParams({ data }),
        },
        TIMEOUT_MS + 5000,
      )) as { elements?: OverpassElement[] };
      const elements = json.elements;
      if (!Array.isArray(elements)) throw new Error("unexpected overpass payload");
      const items: NearbySiteItem[] = [];
      for (const e of elements) {
        const center = elementCenter(e);
        const tags = e.tags ?? {};
        if (!center) continue;
        const parsed = parseSite(tags);
        items.push({
          type: parsed.kind,
          name: parsed.name,
          context: siteContext(tags),
          lat: center.lat,
          lon: center.lon,
          distance_m: haversineM(lat, lon, center.lat, center.lon),
          size_m2: parsed.size,
          source: OSM_OVERPASS_SOURCE,
          tags,
        });
      }
      return items;
    } catch {
      // try the next mirror; all fail → []
    }
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 1b) EPC register — non-domestic premises by floor-area band          */
/* ------------------------------------------------------------------ */
export interface NearbyPremisesItem {
  address: string;
  floor_area_m2: number;
  type: string | null;
  distance_m: number | null;
  source: string;
}

interface EpcSummaryRow {
  certificateNumber: string;
  registrationDate: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  addressLine4: string | null;
  postcode: string | null;
}

async function epcSearchRows(path: string, token: string): Promise<EpcSummaryRow[]> {
  try {
    const json = (await fetchJson(`${EPC_API_BASE}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    })) as { data?: unknown };
    if (!Array.isArray(json.data)) return [];
    return (json.data as Array<Record<string, unknown>>)
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        certificateNumber: String(r.certificateNumber ?? ""),
        registrationDate: r.registrationDate ? String(r.registrationDate) : null,
        addressLine1: r.addressLine1 ? String(r.addressLine1) : null,
        addressLine2: r.addressLine2 ? String(r.addressLine2) : null,
        addressLine3: r.addressLine3 ? String(r.addressLine3) : null,
        addressLine4: r.addressLine4 ? String(r.addressLine4) : null,
        postcode: r.postcode ? String(r.postcode) : null,
      }))
      .filter((r) => r.certificateNumber);
  } catch {
    return [];
  }
}

interface EpcCertificateDetail {
  address: string;
  floorArea: number | null;
  propertyType: string | null;
  postcode: string | null;
}

async function epcCertificate(rrn: string, token: string): Promise<EpcCertificateDetail | null> {
  try {
    const json = (await fetchJson(
      `${EPC_API_BASE}/api/certificate?certificate_number=${encodeURIComponent(rrn)}`,
      { headers: { accept: "application/json", authorization: `Bearer ${token}` } },
    )) as { data?: Record<string, unknown> | null };
    const d = json.data;
    if (!d || typeof d !== "object") return null;
    const ti = (d.technical_information ?? {}) as Record<string, unknown>;
    const rawArea = Number.parseFloat(String(ti.floor_area ?? ""));
    const floorArea = Number.isFinite(rawArea) && rawArea > 0 ? Math.round(rawArea) : null;
    const address = [d.address_line_1, d.address_line_2, d.address_line_3, d.address_line_4]
      .filter((v) => v && String(v).trim())
      .map((v) => String(v).trim())
      .join(", ");
    return {
      address: address || "Address not disclosed",
      floorArea,
      propertyType: d.property_type ? String(d.property_type) : null,
      postcode: d.postcode ? String(d.postcode) : null,
    };
  } catch {
    return null;
  }
}

/**
 * EPC register search over the input postcode, then its nearest neighbours
 * (postcodes.io), for NON-DOMESTIC premises whose certificate total floor area
 * is within [minM2, maxM2]. Vacancy is NOT in this data — that's the caller's
 * honest note. Never throws; returns [] on failure or missing key.
 */
export async function fetchNearbyPremises(
  postcode: string,
  minM2: number,
  maxM2: number,
  limit = 6,
): Promise<NearbyPremisesItem[]> {
  const token = process.env.EPC_API_KEY?.trim();
  if (!token || token.startsWith("your-") || !postcode) return [];
  if (!Number.isFinite(minM2) || !Number.isFinite(maxM2) || minM2 <= 0 || maxM2 < minM2) return [];

  const origin = await postcodeCentroid(postcode);
  if (!origin) return [];

  const neighbours = await nearestPostcodes(origin.lat, origin.lon, 10);
  if (neighbours.length === 0) return [];

  // Collect candidate certificates across nearby postcodes (bounded, deduped).
  const seen = new Set<string>();
  const rows: EpcSummaryRow[] = [];
  for (let i = 0; i < neighbours.length && rows.length < 40; i++) {
    const pc = neighbours[i].postcode.replace(/\s+/g, "").toUpperCase();
    const list = await epcSearchRows(`/api/non-domestic/search?postcode=${encodeURIComponent(pc)}`, token);
    for (const r of list) {
      if (!r.certificateNumber || seen.has(r.certificateNumber)) continue;
      seen.add(r.certificateNumber);
      rows.push({ ...r, postcode: r.postcode ?? pc });
    }
    // Early exit: enough candidates from at least 3 postcodes.
    if (rows.length >= Math.max(6, limit * 2) && i >= 2) break;
  }
  if (rows.length === 0) return [];

  // Fetch full certificates in parallel batches (bounded); stop once we have
  // `limit` qualifying premises.
  const items: NearbyPremisesItem[] = [];
  const pool = rows.slice(0, 24);
  for (let i = 0; i < pool.length && items.length < limit; i += 4) {
    const batch = pool.slice(i, i + 4);
    const certs = await Promise.all(batch.map((r) => epcCertificate(r.certificateNumber, token)));
    for (let j = 0; j < certs.length && items.length < limit; j++) {
      const c = certs[j];
      if (!c || c.floorArea === null) continue;
      if (c.floorArea < minM2 || c.floorArea > maxM2) continue;
      const certPostcode = c.postcode ?? pool[i + j].postcode ?? postcode;
      let distance_m: number | null = null;
      if (certPostcode) {
        const point = certPostcode.replace(/\s+/g, "").toUpperCase() === postcode.replace(/\s+/g, "").toUpperCase()
          ? origin
          : await postcodeCentroid(certPostcode);
        if (point) distance_m = haversineM(origin.lat, origin.lon, point.lat, point.lon);
      }
      items.push({
        address: c.address,
        floor_area_m2: c.floorArea,
        type: c.propertyType,
        distance_m,
        source: EPC_REGISTER_SOURCE,
      });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* 1c) combine — filter, rank, cap                                     */
/* ------------------------------------------------------------------ */
export interface NearbyProjectInput {
  postcode: string | null;
  lat: number | null;
  lon: number | null;
  /** Project floor area in m²; drives the 0.5x–1.5x band for premises. */
  floorAreaM2: number | null;
}

export interface NearbyOpportunity {
  kind: "site" | "premises";
  name: string;
  size_m2: number | null;
  distance_m: number | null;
  source: string;
  confidence: number;
  note: string;
}

/** Best-effort use class derived from a free-text description / OSM tags. */
function derivedUseClass(text: string): string | null {
  const v = normaliseComplianceUse(text);
  const mapped = currentUseClass(v);
  if (mapped) return mapped;
  for (const w of v.split(/\s+/)) {
    const m = currentUseClass(w);
    if (m) return m;
  }
  if (/(shop|retail|office|caf|restaurant|gym|leisure|assembly|financial|professional|studio|workshop|school|nursery)/.test(v)) return "E";
  if (/(industrial|factory|manufactur|warehouse|storage|depot)/.test(v)) return "B2";
  if (/(residential|dwelling|flat|apartment|care home|hospital|student|boarding|prison|hotel|hostel|house)/.test(v)) return "C3";
  return null;
}

const COMMERCIAL_CLASSES = new Set(["E", "E(g)(iii)", "B2", "B8", "sui generis"]);

/** Include when the candidate's use is the same class as target (lawful as-is)
 * or another commercial class (changeable with permission). Residential↔
 * commercial jumps are filtered out of this commercial-opportunity scan. */
export function compatibleWithTarget(derived: string | null, target: string | null): boolean {
  if (!target) return true; // target class unknown — keep, flagged in note
  if (!derived) return true; // cannot derive — keep, flagged in note
  if (derived === target) return true;
  if (COMMERCIAL_CLASSES.has(derived) && COMMERCIAL_CLASSES.has(target)) return true;
  return false;
}

function useClassSentence(derived: string | null, target: string | null): string {
  if (!derived || !target) return "";
  if (derived === target) return `Current use falls in the same use class as the target (${target}) — no change-of-use permission required (screening). `;
  if (COMMERCIAL_CLASSES.has(derived) && COMMERCIAL_CLASSES.has(target)) {
    return `Current use (${derived}) differs from the target class (${target}) — change-of-use permission likely required. `;
  }
  return "";
}

function siteNote(item: NearbySiteItem, target: string | null): string {
  const desc = Object.entries(item.tags)
    .filter(([k]) => !k.startsWith("addr:") && !["name", "website", "note", "check_date", "type"].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const flag = item.tags.landuse === "construction"
    ? "development site flagged as under construction in OSM"
    : `building flagged ${item.tags.vacant === "yes" ? "vacant" : item.tags.disused ? "disused" : "abandoned"} in OSM`;
  const use = useClassSentence(derivedUseClass(`${item.tags.shop ?? ""} ${item.tags.building ?? ""} ${item.tags.office ?? ""}`), target);
  return `${flag} (community-maintained tag${desc ? `: ${desc}` : ""}). ${use}Vacancy, ownership and availability NOT verified — confirm with the local authority, agents and the landowner.`;
}

function premisesNote(item: NearbyPremisesItem, target: string | null): string {
  const derived = item.type ? derivedUseClass(item.type) : null;
  const use = useClassSentence(derived, target);
  return `${item.type ?? "Non-domestic premises"}. EPC-registered floor area only — the register does NOT record vacancy; confirm with agents and the landowner. ${use}`;
}

export interface CombineOptions {
  radiusM?: number;
  cap?: number;
}

/**
 * Run both fetchers, filter to target-use compatibility, rank by distance and
 * cap at ~8. The project supplies the postcode + coordinates (analyse step)
 * and its floor area (design step) — whichever is missing simply contributes
 * no candidates; this never throws.
 */
export async function combine(
  project: NearbyProjectInput,
  targetUse: string,
  opts: CombineOptions = {},
): Promise<NearbyOpportunity[]> {
  const radiusM = opts.radiusM ?? 1500;
  const cap = opts.cap ?? 8;
  const targetClass = targetUseClass(targetUse);
  const hasCoords = project.lat != null && project.lon != null && Number.isFinite(project.lat) && Number.isFinite(project.lon);
  const hasArea = project.floorAreaM2 != null && project.floorAreaM2 > 0;

  const [sites, premises] = await Promise.all([
    hasCoords ? fetchNearbySites(project.lat as number, project.lon as number, radiusM) : Promise.resolve([]),
    project.postcode && hasArea
      ? fetchNearbyPremises(project.postcode, project.floorAreaM2 * 0.5, project.floorAreaM2 * 1.5, Math.max(4, Math.ceil(cap / 2)))
      : Promise.resolve([]),
  ]);

  const opportunities: NearbyOpportunity[] = [];
  for (const s of sites) {
    const derived = derivedUseClass(`${s.tags.shop ?? ""} ${s.tags.building ?? ""} ${s.tags.office ?? ""}`);
    if (!compatibleWithTarget(derived, targetClass)) continue;
    opportunities.push({
      kind: "site",
      name: s.name ?? s.context,
      size_m2: s.size_m2,
      distance_m: s.distance_m,
      source: s.source,
      confidence: 0.6, // community-maintained OSM tags; vacancy unverified
      note: siteNote(s, targetClass),
    });
  }
  for (const p of premises) {
    const derived = p.type ? derivedUseClass(p.type) : null;
    if (!compatibleWithTarget(derived, targetClass)) continue;
    opportunities.push({
      kind: "premises",
      name: p.address,
      size_m2: p.floor_area_m2,
      distance_m: p.distance_m,
      source: p.source,
      confidence: 0.7, // register floor area is solid, but vacancy unverified
      note: premisesNote(p, targetClass),
    });
  }

  opportunities.sort((a, b) => (a.distance_m ?? Number.MAX_SAFE_INTEGER) - (b.distance_m ?? Number.MAX_SAFE_INTEGER));
  return opportunities.slice(0, cap);
}

/* ------------------------------------------------------------------ */
/* Fact builder — used by the design step (category "nearby")          */
/* ------------------------------------------------------------------ */
export interface NearbyFact {
  category: "nearby";
  key: string;
  value: string;
  confidence: number;
  sourceId: string | null;
}

export interface NearbyScanContext {
  generatedAt: string;
  sourceId: string | null;
  status: "ok" | "failed";
  note?: string;
}

export function buildNearbyFacts(opportunities: NearbyOpportunity[], ctx: NearbyScanContext): NearbyFact[] {
  const facts: NearbyFact[] = [
    { category: "nearby", key: "nearby_status", value: ctx.status, confidence: 1, sourceId: ctx.sourceId },
    { category: "nearby", key: "nearby_count", value: String(opportunities.length), confidence: 1, sourceId: ctx.sourceId },
    { category: "nearby", key: "nearby_generated_at", value: ctx.generatedAt, confidence: 1, sourceId: ctx.sourceId },
  ];
  if (ctx.note) facts.push({ category: "nearby", key: "nearby_note", value: ctx.note, confidence: 1, sourceId: ctx.sourceId });
  opportunities.forEach((o, i) => {
    facts.push(
      { category: "nearby", key: `nearby_${i}_kind`, value: o.kind, confidence: o.confidence, sourceId: ctx.sourceId },
      { category: "nearby", key: `nearby_${i}_name`, value: o.name, confidence: o.confidence, sourceId: ctx.sourceId },
      { category: "nearby", key: `nearby_${i}_size_m2`, value: o.size_m2 != null ? String(o.size_m2) : "", confidence: o.confidence, sourceId: ctx.sourceId },
      { category: "nearby", key: `nearby_${i}_distance_m`, value: o.distance_m != null ? String(o.distance_m) : "", confidence: o.confidence, sourceId: ctx.sourceId },
      { category: "nearby", key: `nearby_${i}_source`, value: o.source, confidence: o.confidence, sourceId: ctx.sourceId },
      { category: "nearby", key: `nearby_${i}_confidence`, value: String(o.confidence), confidence: 1, sourceId: ctx.sourceId },
      { category: "nearby", key: `nearby_${i}_note`, value: o.note, confidence: o.confidence, sourceId: ctx.sourceId },
    );
  });
  return facts;
}

export interface NearbyScanInput {
  postcode: string | null;
  lat: number | null;
  lon: number | null;
  floorAreaM2: number | null;
  targetUse: string;
  sourceId: string | null;
  generatedAt: string;
}

/**
 * End-to-end scan wrapper for the design step. Never throws: if the project
 * lacks coords AND postcode, or any provider fails, it records honest
 * nearby_status=failed facts and returns them.
 */
export async function runNearbyScan(input: NearbyScanInput): Promise<NearbyFact[]> {
  const { targetUse, sourceId, generatedAt } = input;
  const hasCoords = input.lat != null && input.lon != null && Number.isFinite(input.lat) && Number.isFinite(input.lon);
  if (!hasCoords && !input.postcode) {
    return buildNearbyFacts([], {
      generatedAt,
      sourceId,
      status: "failed",
      note: "No stored coordinates or postcode for this project — nearby scan skipped.",
    });
  }
  try {
    const opportunities = await combine(
      { postcode: input.postcode, lat: input.lat, lon: input.lon, floorAreaM2: input.floorAreaM2 },
      targetUse,
    );
    return buildNearbyFacts(opportunities, { generatedAt, sourceId, status: "ok" });
  } catch (err) {
    return buildNearbyFacts([], {
      generatedAt,
      sourceId,
      status: "failed",
      note: `Nearby scan failed: ${err instanceof Error ? err.message : String(err)}. No candidates flagged.`,
    });
  }
}
