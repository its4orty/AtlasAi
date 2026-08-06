import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SpatialFact { key: string; value: string; confidence?: number; }
export interface RenderPrompt { view: "exterior" | "interior"; prompt: string; hash: string; }
export interface ImageResult { bytes: Uint8Array; mime: string; provider: string; model: string; }
export interface DesignContext {
  programmeLabel?: string;
  zoneNames?: string[];
  rooms?: string[];
  allocatedM2?: number;
  buildingForm?: "industrial_unit" | "retail_unit" | "house" | "unknown";
  visualReference?: string;
}
const VERSION = "imagery-prompt-v4";
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
function spatialBrief(facts: SpatialFact[]): string {
  const allowed = facts.filter(f => (f.confidence ?? 1) >= 0.8 && /room|dimension|area|floor|ceiling|layout|use_class/i.test(f.key));
  return allowed.map(f => `${f.key.replace(/_/g, " ")}: ${f.value}`).join("; ").slice(0, 220) || "indicative commercial space with an open layout";
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
  return parts.join("; ").slice(0, 260);
}
export function buildRenderPrompts(facts: SpatialFact[], targetUse: string, design?: DesignContext): RenderPrompt[] {
  const brief = spatialBrief(facts);
  const designed = designBrief(design);
  const common = `Target use: ${targetUse}. Evidence: ${brief}.${designed ? ` Designed layout: ${designed}.` : ""} Approximate only; do not invent measurements.`;
  const form = design?.buildingForm ?? "unknown";
  const exteriorForm = form === "industrial_unit" ? "single-storey industrial unit on a business park, flat roof, blockwork or metal-clad walls, wide roller-shutter or glazed entrance adapted for the new use, ground floor only, no upper storey, no residential floors" : form === "retail_unit" ? "single-storey shop unit, no residential above" : form === "house" ? "the confirmed house form, with only evidence-supported storeys" : "commercial premises, ground floor only, no upper storey assumed";
  const interiorForm = form === "industrial_unit" ? "inside a single-storey industrial unit shell" : form === "retail_unit" ? "inside a single-storey shop unit" : "inside the confirmed ground-floor premises";
  const exterior = `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} Show ${exteriorForm} adapted for this use, welcoming entrance, restrained contemporary materials, daylight, eye-level three-quarter view, realistic scale and lens perspective. No storeys or residential use beyond the evidence. No people, text, logos, signage lettering, address or personal data. Generic property only. Calm coherent composition, realistic details, subtle weathering and soft shadows. Concept visualisation not a photograph.`;
  const interior = `Photorealistic architectural visualization, concept visualisation not a photograph. ${common} Show the proposed ${targetUse} interior in ${interiorForm}, matching the designed layout with listed zones, clear circulation, suitable generic equipment and fittings, timber, plaster, glass and durable flooring, daylight with warm practical light, wide eye-level view, realistic construction. Do not add absent rooms or dimensions. No people, text, logos, signage or personal data. Concept visualisation not a photograph.`;
  return [{ view: "exterior", prompt: exterior, hash: createHash("sha256").update(`${VERSION}|${JSON.stringify(facts)}|${targetUse}|${JSON.stringify(design ?? null)}|exterior`).digest("hex") }, { view: "interior", prompt: interior, hash: createHash("sha256").update(`${VERSION}|${JSON.stringify(facts)}|${targetUse}|${JSON.stringify(design ?? null)}|interior`).digest("hex") }].filter(p => words(p.prompt) >= 80 && words(p.prompt) <= 180);
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
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=768&nologo=true`;
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
