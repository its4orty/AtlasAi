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
const VERSION = "imagery-prompt-v5";
/** Per-view Pollinations dimensions: street + elevation landscape, entrance portrait. */
export const VIEW_DIMS: Record<RenderView, { width: number; height: number }> = {
  exterior_street: { width: 1024, height: 768 },
  exterior_elevation: { width: 1024, height: 768 },
  exterior_entrance: { width: 768, height: 1024 },
  interior: { width: 1024, height: 768 },
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
// Shared evidence/constraint block for every exterior view. Never invent
// storeys, residential uses, shopfronts or typologies beyond the evidence.
const EXTERIOR_CONSTRAINT =
  "No storeys or residential use beyond the evidence. No people, text, logos, signage, address or personal data. Generic property only. Calm composition, realistic details, soft shadows. Concept visualisation, not a photograph.";
const INTERIOR_CONSTRAINT =
  "Do not add absent rooms or dimensions. No people, text, logos, signage or personal data. Concept visualisation, not a photograph.";
export function buildRenderPrompts(facts: SpatialFact[], targetUse: string, design?: DesignContext): RenderPrompt[] {
  const brief = spatialBrief(facts);
  const designed = designBrief(design);
  const common = `Target use: ${targetUse}. Evidence: ${brief}.${designed ? ` Designed layout: ${designed}.` : ""} Approximate only; do not invent measurements.`;
  const form = design?.buildingForm ?? "unknown";
  const extForm = exteriorFormText(form);
  const open = `Show ${extForm}, with a welcoming entrance, restrained contemporary materials and soft daylight.`;
  const views: Array<{ view: RenderView; prompt: string }> = [
    {
      view: "exterior_street",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} ${open} Framed from across the street at 35mm eye level, the building in situ among its neighbours with realistic pavement, kerb and street context, natural perspective and depth of field, realistic scale. ${EXTERIOR_CONSTRAINT}`,
    },
    {
      view: "exterior_elevation",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} ${open} Direct frontal elevation: camera squared to the facade at 50mm, one-point perspective, facade plane parallel to the frame, symmetrical composition, even diffuse daylight, crisp clean architectural presentation. ${EXTERIOR_CONSTRAINT}`,
    },
    {
      view: "exterior_entrance",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} ${open} Close-up of the entrance zone at eye level: tighter framing filling the frame with the doorway, window and entrance, soft daylight, shallow depth of field, tactile material detail on the door surround and glazing. ${EXTERIOR_CONSTRAINT}`,
    },
    {
      view: "interior",
      prompt: `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} Show the proposed ${targetUse} interior in ${interiorFormText(form)}, matching the designed layout with listed zones, clear circulation, suitable generic equipment and fittings, timber, plaster, glass and durable flooring, daylight with warm practical light, wide eye-level view, realistic construction. ${INTERIOR_CONSTRAINT}`,
    },
  ];
  return views
    .map((v) => ({
      ...v,
      hash: createHash("sha256").update(`${VERSION}|${JSON.stringify(facts)}|${targetUse}|${JSON.stringify(design ?? null)}|${v.view}`).digest("hex"),
    }))
    .filter((p) => words(p.prompt) >= 80 && words(p.prompt) <= 180);
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
    // flux-1-schnell takes prompt-only (no steps/guidance); defaults left as-is.
    const res = await fetchWithTimeout(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ prompt }) }, 12000);
    if (!res.ok) throw new Error(`Cloudflare HTTP ${res.status}`);
    const buffer = await res.arrayBuffer(); if (!buffer.byteLength) throw new Error("empty image");
    const body = new TextDecoder().decode(buffer);
    try {
      const parsed = JSON.parse(body) as { result?: { image?: unknown } };
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
