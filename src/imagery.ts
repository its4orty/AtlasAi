import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SpatialFact { key: string; value: string; confidence?: number; }
/** The four render views: three exterior (street context, frontal elevation,
 * entrance close-up) plus the interior. Each view has its own camera/angle/
 * lighting vocabulary but shares the evidence block (building-form constraint,
 * no people/text/signage, concept-not-photograph). */
export type RenderView = "exterior_street" | "exterior_elevation" | "exterior_entrance" | "interior";
export interface RenderPrompt { view: RenderView; prompt: string; hash: string; }
export interface ImageResult { bytes: Uint8Array; mime: string; provider: string; model: string; }
export interface DesignContext {
  programmeLabel?: string;
  zoneNames?: string[];
  rooms?: string[];
  allocatedM2?: number;
  buildingForm?: "industrial_unit" | "retail_unit" | "house" | "unknown";
  visualReference?: string;
}
const VERSION = "imagery-prompt-v6";
/** Per-view Pollinations dimensions: street + elevation landscape, entrance portrait. */
export const VIEW_DIMS: Record<RenderView, { width: number; height: number }> = {
  exterior_street: { width: 1024, height: 768 },
  exterior_elevation: { width: 1024, height: 768 },
  exterior_entrance: { width: 768, height: 1024 },
  interior: { width: 1024, height: 768 },
};
/**
 * Cloudflare per-view dimensions (SPARK-verified 2026-08-07: the flux-1-schnell
 * route accepts width/height/guidance/seed — all returned 200). Entrance uses a
 * taller PORTRAIT canvas (832x1216, both multiples of 16) for the close-up.
 */
export const CF_VIEW_DIMS: Record<RenderView, { width: number; height: number }> = {
  exterior_street: { width: 1024, height: 768 },
  exterior_elevation: { width: 1024, height: 768 },
  exterior_entrance: { width: 832, height: 1216 },
  interior: { width: 1024, height: 768 },
};
/**
 * Fixed per-view seed sent to Cloudflare so v6/v7 runs stay comparable when the
 * provider honours seeds. NOTE: flux-1-schnell currently ACCEPTS the param but
 * does not honour it (verified: two identical prompt+seed requests returned
 * different images) — kept for future compatibility; determinism is not achieved.
 */
export const VIEW_SEED: Record<RenderView, number> = {
  exterior_street: 101,
  exterior_elevation: 202,
  exterior_entrance: 303,
  interior: 404,
};
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
function spatialBrief(facts: SpatialFact[]): string {
  const allowed = facts.filter(f => (f.confidence ?? 1) >= 0.8 && /room|dimension|area|floor|ceiling|layout|use_class/i.test(f.key));
  return allowed.map(f => `${f.key.replace(/_/g, " ")}: ${f.value}`).join("; ").slice(0, 170) || "indicative commercial space with an open layout";
}
function designBrief(design?: DesignContext): string {
  if (!design) return "";
  const parts: string[] = [];
  if (design.programmeLabel) parts.push(design.programmeLabel);
  const zones = (design.zoneNames ?? []).filter(Boolean).slice(0, 5);
  if (zones.length) parts.push(`zones: ${zones.join(", ")}`);
  if (design.allocatedM2 && design.allocatedM2 > 0) parts.push(`area about ${design.allocatedM2} m²`);
  const form = design.buildingForm ?? "unknown";
  parts.push(`building form: ${form}`);
  const rooms = (design.rooms ?? []).filter(Boolean).slice(0, 4);
  if (rooms.length) parts.push(`rooms: ${rooms.join(", ")}`);
  return parts.join("; ").slice(0, 210);
}
function exteriorFormText(form: string): string {
  return form === "industrial_unit"
    ? "single-storey industrial unit on a business park, flat roof, blockwork or metal-clad walls, glazed entrance, ground floor only, no upper storey or residential floors"
    : form === "retail_unit"
      ? "single-storey shop unit, no residential above"
      : form === "house"
        ? "the confirmed house form, with only evidence-supported storeys"
        : "commercial premises, ground floor only, no upper storey assumed";
}
function interiorFormText(form: string): string {
  return form === "industrial_unit"
    ? "a single-storey industrial unit shell"
    : form === "retail_unit"
      ? "a single-storey shop unit"
      : "the confirmed ground-floor premises";
}
/**
 * Shared "building sheet" — the SAME building in every exterior view so the
 * four-view set reads as one property (v6). Form-specific, mirroring the
 * exteriorFormText pattern; never invents shopfronts/storeys for forms whose
 * evidence does not support them.
 */
function buildingSheetText(form: string): string {
  return form === "retail_unit"
    ? "the same building in every view: a single-storey, ground-floor-only shop unit — roofline directly above the shopfront, no upper floor, no residential; warm red-brick plinth, pale render above, dark grey metal shopfront frame, clear glazing, a recessed oak door, one display window; glazed shopfront with no branding or lettering on the glass; overcast diffuse daylight, soft consistent shadows"
    : form === "industrial_unit"
      ? "the same building in every view: a single-storey industrial unit on a business park, flat roof, blockwork or metal-clad walls, a glazed entrance, ground floor only, no upper storey or residential floors; overcast diffuse daylight, soft consistent shadows"
      : form === "house"
        ? "the same building in every view: the confirmed house form, with only evidence-supported storeys, no invented upper storeys or residential flats; overcast diffuse daylight, soft consistent shadows"
        : "the same building in every view: commercial premises, ground floor only, no upper storey assumed, no residential floors; overcast diffuse daylight, soft consistent shadows";
}
/** Storey guard repeated inside the street + elevation prompts to block upper-storey bleed. */
function storeyGuard(form: string): string {
  return form === "retail_unit"
    ? "Single storey only, roofline above the shopfront."
    : form === "industrial_unit"
      ? "Single storey only, roofline directly above the entrance, no upper storey."
      : form === "house"
        ? "Only evidence-supported storeys; no upper storey added."
        : "Single storey only, no upper storey assumed.";
}
/** Street-context neighbours: form-aware so industrial/house prompts never claim shopfronts. */
function streetViewText(form: string): string {
  const neighbours =
    form === "retail_unit"
      ? "neighbouring shopfronts visible either side"
      : form === "industrial_unit"
        ? "neighbouring units visible either side"
        : form === "house"
          ? "neighbouring houses visible either side"
          : "neighbouring premises visible either side";
  return `Street view: three-quarter oblique view, two-point perspective, ${neighbours}, wide pavement and kerb in the foreground, sky visible above the roofline, subject centred.`;
}
/** Use-specific interior fittings: barber uses the designer-approved programme. */
function interiorFittings(targetUse: string): string {
  return /barber/i.test(targetUse)
    ? "mirrors and barber chairs and a reception desk"
    : "suitable generic equipment and fittings";
}
// Shared evidence/constraint block for every exterior view. Never invent
// storeys, residential uses, shopfronts or typologies beyond the evidence.
const EXTERIOR_CONSTRAINT =
  "No storeys or residential use beyond the evidence. No people, text, logos, signage, address or personal data. Generic property only. Concept visualisation, not a photograph.";
const INTERIOR_CONSTRAINT =
  "Do not add absent rooms or dimensions. No people, text, logos, signage, address or personal data. Generic property only. Concept visualisation, not a photograph.";
export function buildRenderPrompts(facts: SpatialFact[], targetUse: string, design?: DesignContext): RenderPrompt[] {
  const brief = spatialBrief(facts);
  const designed = designBrief(design);
  const common = `Target use: ${targetUse}. Evidence: ${brief}.${designed ? ` Designed layout: ${designed}.` : ""} Approximate only; do not invent measurements.`;
  const form = design?.buildingForm ?? "unknown";
  const open = "Show a welcoming entrance.";
  const sheet = `The ${buildingSheetText(form)}.`;
  const guard = storeyGuard(form);
  const views: Array<{ view: RenderView; prompt: string }> = [
    {
      view: "exterior_street",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} ${sheet} ${open} ${streetViewText(form)} ${guard} ${EXTERIOR_CONSTRAINT}`,
    },
    {
      view: "exterior_elevation",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} ${sheet} ${open} Frontal elevation: dead-on frontal view, camera axis perpendicular to the facade, vertical edges parallel to the picture frame, no keystone, the full single storey including roofline and cornice fills the frame, doorway centred on the vertical midline with a balanced window either side. ${guard} ${EXTERIOR_CONSTRAINT}`,
    },
    {
      view: "exterior_entrance",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} ${sheet} ${open} Entrance close-up: camera two to three metres from the door at eye level; the doorway, its surround and one full display window fill the frame edge to edge; only lintel and cornice above — no whole building in frame; glass reflects soft sky only; tactile material detail on the door surround and glazing, soft daylight, shallow depth of field. ${EXTERIOR_CONSTRAINT}`,
    },
    {
      view: "interior",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} Show the proposed ${targetUse} interior in ${interiorFormText(form)}, matching the designed layout with listed zones, clear circulation, one-point perspective from the entrance looking to the rear wall, ceiling visible, no mezzanine or second floor, ${interiorFittings(targetUse)}, muted palette of timber and matte black metal, daylight from the front glazing with warm practical light, realistic construction. ${INTERIOR_CONSTRAINT}`,
    },
  ];
  return views
    .map((v) => ({
      ...v,
      hash: createHash("sha256").update(`${VERSION}|${JSON.stringify(facts)}|${targetUse}|${JSON.stringify(design ?? null)}|${v.view}`).digest("hex"),
    }))
    // v6 adds the verbatim building sheet + storey guard + honesty markers, so
    // prompts run longer than v5: cap raised 180 -> 220 words (1600 chars).
    .filter((p) => words(p.prompt) >= 80 && words(p.prompt) <= 220 && p.prompt.length <= 1600);
}
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> { return fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); }
export async function requestImage(prompt: string, view: string): Promise<ImageResult | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim(); const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !account || token.startsWith("your-")) return null;
  const model = process.env.IMAGE_MODEL?.trim() || "@cf/black-forest-labs/flux-1-schnell";
  // CF's model route uses literal slash-separated model segments; encoding the whole
  // @cf/... identifier as one segment yields API error 7000 (No route).
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`;
  try {
    // SPARK-verified 2026-08-07: flux-1-schnell accepts optional width, height,
    // guidance and seed (all returned 200). Per-view dims: street + elevation
    // landscape, entrance PORTRAIT, interior landscape; fixed seed per view
    // (accepted but not honoured by the model — see VIEW_SEED note).
    const dims = CF_VIEW_DIMS[view as RenderView] ?? { width: 1024, height: 768 };
    const body: Record<string, unknown> = {
      prompt,
      width: dims.width,
      height: dims.height,
      guidance: 3,
      seed: VIEW_SEED[view as RenderView],
    };
    const res = await fetchWithTimeout(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }, 12000);
    if (!res.ok) throw new Error(`Cloudflare HTTP ${res.status}`);
    const buffer = await res.arrayBuffer(); if (!buffer.byteLength) throw new Error("empty image");
    const text = new TextDecoder().decode(buffer);
    try {
      const parsed = JSON.parse(text) as { result?: { image?: unknown } };
      if (typeof parsed.result?.image === "string" && parsed.result.image.length > 0) {
        const binary = atob(parsed.result.image); const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        if (!bytes.length) throw new Error("empty decoded image");
        return { bytes, mime: "image/jpeg", provider: "cloudflare", model };
      }
    } catch { /* raw image response */ }
    return { bytes: new Uint8Array(buffer), mime: res.headers.get("content-type")?.split(";")[0] || "image/png", provider: "cloudflare", model };
  } catch { /* fall through to free fallback */ }
  try {
    // Current Pollinations endpoint works without the retired model=flux parameter.
    // Per-view dimensions: street + elevation landscape, entrance portrait.
    const dims = VIEW_DIMS[view as RenderView] ?? { width: 1024, height: 768 };
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${dims.width}&height=${dims.height}&nologo=true`;
    const res = await fetchWithTimeout(url, {}, 8000); if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer()); if (!bytes.length) return null;
    return { bytes, mime: res.headers.get("content-type")?.split(";")[0] || "image/jpeg", provider: "pollinations", model: "default" };
  } catch { return null; }
}
export async function saveRender(projectId: string, view: string, result: ImageResult): Promise<string> {
  const ext = result.mime.includes("webp") ? "webp" : result.mime.includes("jpeg") ? "jpg" : "png";
  const dir = path.join(process.cwd(), "public", "project-images", String(projectId)); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${view}.${ext}`), result.bytes); return `/project-images/${projectId}/${view}.${ext}`;
}
export { VERSION as imageryPromptVersion };
