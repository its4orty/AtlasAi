/**
 * ATLAS AI — real "current property" street imagery (keyless by default).
 *
 * Pipeline: geocode the project address with the free Nominatim (OpenStreetMap)
 * API, then build a Google Maps Street View embed URL from the returned
 * coordinates. The embed is rendered as an iframe in the report and the URL +
 * coordinates are recorded as confidence-1 facts (category "imagery") so the
 * provenance is traceable like every other fact.
 *
 * Optional (gated on GOOGLE_MAPS_API_KEY — never required): when a key is
 * present, fetch the official Street View Static API image instead, save it
 * under public/project-images/<id>/streetview.jpg (served behind the release
 * token like the other renders) and record imagery_streetview_url.
 *
 * Honesty rules:
 *  - Street View is REAL imagery (Google), never labelled as AI.
 *  - The geocoded pin is approximate — the report says "verify at the property".
 *  - Any failure (network, non-OK, empty result) degrades to zero facts and the
 *    report section is skipped — the design step never blocks on street view.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type StreetViewFact = {
  category: string;
  key: string;
  value: string;
  confidence: number;
  sourceId: string | null;
};

export interface StreetViewResult {
  status: "embed" | "image" | "failed";
  embedUrl: string | null;
  imageUrl: string | null; // local /project-images/... path when static image saved
  lat: string | null;
  lon: string | null;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const UA = "AtlasAI/1.0 (ATLAS AI property-intelligence demo; contact: team@atlasai.local)";

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Build the keyless Google Maps Street View embed URL for an address + coords. */
export function buildStreetViewEmbedUrl(address: string, lat: string, lon: string): string {
  return (
    `https://www.google.com/maps?q=${encodeURIComponent(address)}` +
    `&layer=c&cbll=${encodeURIComponent(lat)},${encodeURIComponent(lon)}` +
    `&cbp=11,0,0,0,0&output=svembed`
  );
}

/**
 * Server-side geocode via Nominatim (no key needed). Returns the first result's
 * lat/lon as strings, or null when the request fails / returns nothing.
 */
export async function reverseGeocodeAddress(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}&format=json`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA, accept: "application/json" } }, 8000);
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name?.trim() || null;
  } catch { return null; }
}

export async function geocodeAddress(address: string): Promise<{ lat: string; lon: string } | null> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(`${address}, UK`)}&format=json&limit=1`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA, accept: "application/json" } }, 12000);
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
  const first = data[0];
  if (!first) return null;
  const lat = Number.parseFloat(String(first.lat ?? ""));
  const lon = Number.parseFloat(String(first.lon ?? ""));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat: String(lat), lon: String(lon) };
}

/**
 * Fetch everything needed for the report's "Current property — Google Street
 * View" section. Always returns an array of facts (never throws); on failure it
 * records a single imagery_streetview_status=failed fact so the design step and
 * report both keep working and the gap is honest.
 */
export async function fetchStreetViewFacts(
  address: string,
  projectId: string,
  sourceId: string,
): Promise<StreetViewFact[]> {
  try {
    const coords = await geocodeAddress(address);
    if (!coords) {
      return [{ category: "imagery", key: "imagery_streetview_status", value: "failed", confidence: 1, sourceId }];
    }
    const facts: StreetViewFact[] = [
      { category: "imagery", key: "imagery_streetview_status", value: "embed", confidence: 1, sourceId },
      { category: "imagery", key: "imagery_streetview_embed_url", value: buildStreetViewEmbedUrl(address, coords.lat, coords.lon), confidence: 1, sourceId },
      { category: "imagery", key: "imagery_streetview_lat", value: coords.lat, confidence: 1, sourceId },
      { category: "imagery", key: "imagery_streetview_lon", value: coords.lon, confidence: 1, sourceId },
    ];
    // Optional upgrade: official Street View Static API image when a key exists.
    const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (key && !key.startsWith("your-")) {
      try {
        const staticUrl = `https://maps.googleapis.com/maps/api/streetview?size=800x500&location=${encodeURIComponent(address)}&key=${encodeURIComponent(key)}`;
        const res = await fetchWithTimeout(staticUrl, {}, 30000);
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length > 0) {
            const dir = path.join(process.cwd(), "public", "project-images", String(projectId));
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, "streetview.jpg"), bytes);
            facts[0] = { ...facts[0], value: "image" };
            facts.push({ category: "imagery", key: "imagery_streetview_url", value: `/project-images/${projectId}/streetview.jpg`, confidence: 1, sourceId });
          }
        }
      } catch {
        // Keep the embed fallback — the section still renders.
      }
    }
    return facts;
  } catch {
    return [{ category: "imagery", key: "imagery_streetview_status", value: "failed", confidence: 1, sourceId }];
  }
}
