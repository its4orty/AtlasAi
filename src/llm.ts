import { createHash } from "node:crypto";

export interface LlmRoom { id: string; label: string; widthM: number; depthM: number; areaM2: number; sourceRoomIndex: number; isNewPartition: boolean; zones: Array<{ label: string; xM: number; yM: number; widthM: number; depthM: number; notes: string }>; }
export interface LlmDesign { targetUse: string; rooms: LlmRoom[]; circulationM2: number; notes: string[]; }
export interface SpaceInput { rooms: Array<{ label: string; widthM: number; depthM: number; areaM2: number; confidence?: number; source?: string }>; totalFloorAreaM2: number; currentUse?: string; targetUse: string; }

export function designInputHash(input: SpaceInput): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }

const schema = { type: "OBJECT", properties: {
  targetUse: { type: "STRING" }, rooms: { type: "ARRAY", items: { type: "OBJECT", properties: {
    id: { type: "STRING" }, label: { type: "STRING" }, widthM: { type: "NUMBER" }, depthM: { type: "NUMBER" }, areaM2: { type: "NUMBER" }, sourceRoomIndex: { type: "INTEGER" }, isNewPartition: { type: "BOOLEAN" }, zones: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, xM: { type: "NUMBER" }, yM: { type: "NUMBER" }, widthM: { type: "NUMBER" }, depthM: { type: "NUMBER" }, notes: { type: "STRING" } }, required: ["label","xM","yM","widthM","depthM","notes"] } }
  }, required: ["id","label","widthM","depthM","areaM2","sourceRoomIndex","isNewPartition","zones"] } }, circulationM2: { type: "NUMBER" }, notes: { type: "ARRAY", items: { type: "STRING" } }
}, required: ["targetUse","rooms","circulationM2","notes"] };

function positive(n: unknown): n is number { return typeof n === "number" && Number.isFinite(n) && n > 0; }
export function validateLlmDesign(value: unknown, input: SpaceInput): value is LlmDesign {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<LlmDesign>;
  if (typeof d.targetUse !== "string" || !Array.isArray(d.rooms) || d.rooms.length > 12 || !positive(input.totalFloorAreaM2) || !positive(d.circulationM2) && d.circulationM2 !== 0 || !Array.isArray(d.notes) || d.notes.some((n) => typeof n !== "string")) return false;
  let allocated = 0;
  for (const r of d.rooms) {
    if (!r || typeof r.id !== "string" || typeof r.label !== "string" || !positive(r.widthM) || !positive(r.depthM) || !positive(r.areaM2) || !Number.isInteger(r.sourceRoomIndex) || r.sourceRoomIndex < 0 || r.sourceRoomIndex >= input.rooms.length || typeof r.isNewPartition !== "boolean" || !Array.isArray(r.zones) || r.zones.length > 40) return false;
    if (Math.abs(r.areaM2 - r.widthM * r.depthM) > Math.max(0.5, r.areaM2 * 0.05)) return false;
    const envelope = input.rooms[r.sourceRoomIndex];
    if (!envelope || r.widthM > envelope.widthM * 1.05 || r.depthM > envelope.depthM * 1.05) return false;
    allocated += r.areaM2;
    for (const z of r.zones) if (!z || typeof z.label !== "string" || !positive(z.widthM) || !positive(z.depthM) || !Number.isFinite(z.xM) || !Number.isFinite(z.yM) || typeof z.notes !== "string" || z.xM < 0 || z.yM < 0 || z.xM + z.widthM > r.widthM * 1.05 || z.yM + z.depthM > r.depthM * 1.05) return false;
  }
  return allocated + d.circulationM2 <= input.totalFloorAreaM2 * 1.05;
}

export async function requestGemini(input: SpaceInput): Promise<LlmDesign | null> {
  const key = process.env.GEMINI_API_KEY?.trim(); if (!key || key === "placeholder" || key.startsWith("your-")) return null;
  const model = process.env.LLM_MODEL?.trim() || "gemini-2.5-flash";
  const prompt = `You are a space-planning assistant. Use only these structured space facts and target use: ${JSON.stringify(input)}. Treat dimensions as indicative; never invent measured facts; preserve the supplied external envelope; leave explicit circulation; this is a concept design, not construction information. Output only valid JSON matching the supplied schema.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", signal: AbortSignal.timeout(20000), headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: "You are a space-planning assistant; output only valid JSON matching the schema; treat dimensions as indicative; never invent measured facts; preserve the supplied external envelope; leave explicit circulation; concept design not construction info." }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: "application/json", responseSchema: schema } }) });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const body = await res.json() as any; const candidate = body?.candidates?.[0];
      if (!candidate || candidate.finishReason === "SAFETY" || !candidate.content?.parts?.[0]?.text) throw new Error("Gemini returned no usable candidate");
      const parsed = JSON.parse(candidate.content.parts[0].text);
      if (!validateLlmDesign(parsed, input)) throw new Error("Gemini design failed validation");
      return parsed;
    } catch { if (attempt === 1) return null; }
  }
  return null;
}
