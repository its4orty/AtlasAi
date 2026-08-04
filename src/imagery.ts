import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SpatialFact { key: string; value: string; confidence?: number; }
export interface RenderPrompt { view: "exterior" | "interior"; prompt: string; hash: string; }
export interface ImageResult { bytes: Uint8Array; mime: string; provider: string; model: string; }
/**
 * The designed conversion's own layout, passed from the design step so renders
 * depict the DESIGNED interior (zones/programme), not just the source evidence.
 * Only generic labels travel into the prompt — never an address or personal data.
 */
export interface DesignContext {
  programmeLabel?: string;
  zoneNames?: string[];
  rooms?: string[];
  allocatedM2?: number;
}
const VERSION = "imagery-prompt-v2";
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
function spatialBrief(facts: SpatialFact[]): string {
  const allowed = facts.filter(f => (f.confidence ?? 1) >= 0.8 && /room|dimension|area|floor|ceiling|layout|use_class/i.test(f.key));
  // Image providers have tighter prompt limits than our report. Keep only a
  // compact, high-confidence evidence brief; privacy-safe keys/values are still
  // filtered by the caller's fact selection and the prompt never includes an address.
  return allowed.map(f => `${f.key.replace(/_/g, " ")}: ${f.value}`).join("; ").slice(0, 450) || "an indicative commercial interior with an open layout";
}
function designBrief(design?: DesignContext): string {
  if (!design) return "";
  const parts: string[] = [];
  if (design.programmeLabel) parts.push(design.programmeLabel);
  const zones = (design.zoneNames ?? []).filter(Boolean);
  if (zones.length) parts.push(`zones: ${zones.join(", ")}`);
  if (design.allocatedM2 && design.allocatedM2 > 0) parts.push(`allocated floor area approx ${design.allocatedM2} m²`);
  const rooms = (design.rooms ?? []).filter(Boolean);
  if (rooms.length) parts.push(`rooms: ${rooms.join(", ")}`);
  return parts.join("; ");
}
export function buildRenderPrompts(facts: SpatialFact[], targetUse: string, design?: DesignContext): RenderPrompt[] {
  const brief = spatialBrief(facts);
  const designed = designBrief(design);
  const common = `Target use: ${targetUse}. Spatial brief from evidence: ${brief}.${designed ? ` Designed layout: ${designed}.` : ""} Dimensions not marked high confidence are approximate; do not invent measured facts.`;
  const exterior = `Photorealistic architectural visualization, exterior concept visualisation not a photograph. ${common} Show a plausible street-facing commercial premises adapted for the target use, with a welcoming entrance and restrained contemporary materials. Use a natural eye-level three-quarter viewpoint, realistic daylight, accurate architectural scale, subtle weathering and soft shadows. Include a calm, coherent composition and realistic lens perspective. Keep the frontage generic and do not identify a real property. No people, no text, no logos, no signage lettering, no personal data. Concept visualisation not a photograph.`;
  const interior = `Photorealistic architectural visualization, interior concept visualisation not a photograph. ${common} Show the proposed target-use interior arranged to match this designed layout, with clear accessible circulation between the listed zones, appropriate equipment and fittings for the target use, and only generic finishes such as timber, painted plaster, glass and durable flooring. Use a wide-angle eye-level viewpoint, realistic daylight supplemented by warm practical lighting, natural material texture and believable construction. Include a calm, coherent composition and realistic lens perspective. Do not add measured rooms or dimensions absent from the brief. No people, no text, no logos, no personal data. Concept visualisation not a photograph.`;
  return [{ view: "exterior", prompt: exterior, hash: createHash("sha256").update(`${VERSION}|${JSON.stringify(facts)}|${targetUse}|${JSON.stringify(design ?? null)}|exterior`).digest("hex") }, { view: "interior", prompt: interior, hash: createHash("sha256").update(`${VERSION}|${JSON.stringify(facts)}|${targetUse}|${JSON.stringify(design ?? null)}|interior`).digest("hex") }].filter(p => words(p.prompt) >= 80 && words(p.prompt) <= 180);
}
// Network calls are bounded so a provider outage does not block the design step.
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> { return fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); }
export async function requestImage(prompt: string, view: string): Promise<ImageResult | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim(); const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !account || token.startsWith("your-")) return null;
  const model = process.env.IMAGE_MODEL?.trim() || "@cf/black-forest-labs/flux-1-schnell";
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${encodeURIComponent(model)}`;
  try {
    const res = await fetchWithTimeout(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ prompt }) }, 90000);
    if (!res.ok) throw new Error(`Cloudflare HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    if (!buffer.byteLength) throw new Error("empty image");

    // FLUX 1 Schnell currently wraps its JPEG as { result: { image: base64 } }.
    // Keep the binary path for models/versions that return image bytes directly.
    const body = new TextDecoder().decode(buffer);
    try {
      const parsed = JSON.parse(body) as { result?: { image?: unknown } };
      if (typeof parsed.result?.image === "string" && parsed.result.image.length > 0) {
        const binary = atob(parsed.result.image);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        if (!bytes.length) throw new Error("empty decoded image");
        return { bytes, mime: "image/jpeg", provider: "cloudflare", model };
      }
    } catch {
      // A raw image body is not JSON; use the bytes below.
    }
    const bytes = new Uint8Array(buffer);
    return { bytes, mime: res.headers.get("content-type")?.split(";")[0] || "image/png", provider: "cloudflare", model };
  } catch { /* fall through to the free Pollinations fallback */ }
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=768&model=flux&nologo=true`;
    const res = await fetchWithTimeout(url, {}, 120000); if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer()); if (!bytes.length) return null;
    return { bytes, mime: res.headers.get("content-type")?.split(";")[0] || "image/jpeg", provider: "pollinations", model: "flux" };
  } catch { return null; }
}
export async function saveRender(projectId: string, view: string, result: ImageResult): Promise<string> {
  const ext = result.mime.includes("webp") ? "webp" : result.mime.includes("jpeg") ? "jpg" : "png";
  const dir = path.join(process.cwd(), "public", "project-images", String(projectId)); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${view}.${ext}`), result.bytes); return `/project-images/${projectId}/${view}.${ext}`;
}
export { VERSION as imageryPromptVersion };
