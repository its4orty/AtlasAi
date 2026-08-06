import { createHash } from "node:crypto";

export interface LlmRoom {
  id: string;
  label: string;
  widthM: number;
  depthM: number;
  areaM2: number;
  sourceRoomIndex: number;
  isNewPartition: boolean;
  zones: Array<{
    label: string;
    xM: number;
    yM: number;
    widthM: number;
    depthM: number;
    notes: string;
  }>;
}
export interface LlmDesign {
  targetUse: string;
  rooms: LlmRoom[];
  circulationM2: number;
  notes: string[];
}
export interface SpaceInput {
  rooms: Array<{
    label: string;
    widthM: number;
    depthM: number;
    areaM2: number;
    confidence?: number;
    source?: string;
  }>;
  totalFloorAreaM2: number;
  currentUse?: string;
  targetUse: string;
  buildingForm?: string;
}
export function designInputHash(input: SpaceInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

const schema = {
  type: "OBJECT",
  properties: {
    targetUse: { type: "STRING" },
    rooms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          label: { type: "STRING" },
          widthM: { type: "NUMBER" },
          depthM: { type: "NUMBER" },
          areaM2: { type: "NUMBER" },
          sourceRoomIndex: { type: "INTEGER" },
          isNewPartition: { type: "BOOLEAN" },
          zones: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                label: { type: "STRING" },
                xM: { type: "NUMBER" },
                yM: { type: "NUMBER" },
                widthM: { type: "NUMBER" },
                depthM: { type: "NUMBER" },
                notes: { type: "STRING" },
              },
              required: ["label", "xM", "yM", "widthM", "depthM", "notes"],
            },
          },
        },
        required: [
          "id",
          "label",
          "widthM",
          "depthM",
          "areaM2",
          "sourceRoomIndex",
          "isNewPartition",
          "zones",
        ],
      },
    },
    circulationM2: { type: "NUMBER" },
    notes: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["targetUse", "rooms", "circulationM2", "notes"],
};
function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value))
    out[key] =
      key === "type" && typeof child === "string"
        ? child.toLowerCase()
        : jsonSchema(child);
  return out;
}
const openAiSchema = jsonSchema(schema);
function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}
export function validateLlmDesign(
  value: unknown,
  input: SpaceInput,
): value is LlmDesign {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<LlmDesign>;
  if (
    typeof d.targetUse !== "string" ||
    !Array.isArray(d.rooms) ||
    d.rooms.length > 12 ||
    !positive(input.totalFloorAreaM2) ||
    (!positive(d.circulationM2) && d.circulationM2 !== 0) ||
    !Array.isArray(d.notes) ||
    d.notes.some((n) => typeof n !== "string")
  )
    return false;
  let allocated = 0;
  for (const r of d.rooms) {
    if (
      !r ||
      typeof r.id !== "string" ||
      typeof r.label !== "string" ||
      !positive(r.widthM) ||
      !positive(r.depthM) ||
      !positive(r.areaM2) ||
      !Number.isInteger(r.sourceRoomIndex) ||
      r.sourceRoomIndex < 0 ||
      r.sourceRoomIndex >= input.rooms.length ||
      typeof r.isNewPartition !== "boolean" ||
      !Array.isArray(r.zones) ||
      r.zones.length > 40
    )
      return false;
    if (
      Math.abs(r.areaM2 - r.widthM * r.depthM) > Math.max(0.5, r.areaM2 * 0.05)
    )
      return false;
    const envelope = input.rooms[r.sourceRoomIndex];
    if (
      !envelope ||
      r.widthM > envelope.widthM * 1.05 ||
      r.depthM > envelope.depthM * 1.05
    )
      return false;
    allocated += r.areaM2;
    for (const z of r.zones)
      if (
        !z ||
        typeof z.label !== "string" ||
        !positive(z.widthM) ||
        !positive(z.depthM) ||
        !Number.isFinite(z.xM) ||
        !Number.isFinite(z.yM) ||
        typeof z.notes !== "string" ||
        z.xM < 0 ||
        z.yM < 0 ||
        z.xM + z.widthM > r.widthM * 1.05 ||
        z.yM + z.depthM > r.depthM * 1.05
      )
        return false;
  }
  return allocated + d.circulationM2 <= input.totalFloorAreaM2 * 1.05;
}

/** Conservative repair: it only coerces representation and clips geometry to evidence envelopes. */
export function normalizeLlmDesign(
  value: unknown,
  input: SpaceInput,
): { design: LlmDesign | null; repaired: boolean } {
  if (!value || typeof value !== "object")
    return { design: null, repaired: false };
  const raw = value as any;
  let repaired = false;
  const num = (v: unknown, fallback = 0) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && Number.isFinite(Number(v))) {
      repaired = true;
      return Number(v);
    }
    return fallback;
  };
  const rooms: LlmRoom[] = [];
  for (const rr of Array.isArray(raw.rooms) ? raw.rooms : []) {
    const idx = Math.trunc(num(rr?.sourceRoomIndex, -1));
    const env = input.rooms[idx];
    if (!env) {
      repaired = true;
      continue;
    }
    const width = num(rr.widthM),
      depth = num(rr.depthM);
    if (
      !(width > 0 && depth > 0) ||
      width > env.widthM * 1.05 ||
      depth > env.depthM * 1.05
    ) {
      repaired = true;
      return { design: null, repaired };
    }
    const room: LlmRoom = {
      id: String(rr.id ?? "room"),
      label: String(rr.label ?? "Unlabelled space"),
      widthM: width,
      depthM: depth,
      areaM2: Math.round(width * depth * 100) / 100,
      sourceRoomIndex: idx,
      isNewPartition: Boolean(rr.isNewPartition),
      zones: [],
    };
    if (rr.areaM2 !== room.areaM2) repaired = true;
    for (const zz of Array.isArray(rr.zones) ? rr.zones : []) {
      const zw = num(zz.widthM),
        zd = num(zz.depthM);
      if (!(zw > 0 && zd > 0)) {
        repaired = true;
        continue;
      }
      const x = Math.max(0, Math.min(num(zz.xM), Math.max(0, width - zw)));
      const y = Math.max(0, Math.min(num(zz.yM), Math.max(0, depth - zd)));
      if (x !== num(zz.xM) || y !== num(zz.yM)) repaired = true;
      room.zones.push({
        label: String(zz.label ?? "Zone"),
        xM: x,
        yM: y,
        widthM: Math.min(zw, width),
        depthM: Math.min(zd, depth),
        notes: typeof zz.notes === "string" ? zz.notes : "",
      });
      if (typeof zz.notes !== "string") repaired = true;
    }
    rooms.push(room);
  }
  const design: LlmDesign = {
    targetUse: String(raw.targetUse ?? input.targetUse),
    rooms,
    circulationM2: num(raw.circulationM2),
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
  };
  if (!Array.isArray(raw.notes)) repaired = true;
  if (!validateLlmDesign(design, input)) return { design: null, repaired };
  if (repaired) repairedDesigns.add(design);
  return { design, repaired };
}
const repairedDesigns = new WeakSet<object>();
export function llmDesignWasRepaired(design: LlmDesign): boolean {
  return repairedDesigns.has(design);
}
export type LlmProvider = "gemini" | "openai";
export function llmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER?.trim().toLowerCase() === "openai"
    ? "openai"
    : "gemini";
}
export function llmProviderLabel(): string {
  const provider = llmProvider();
  return `${provider === "openai" ? "OpenAI-compatible provider" : "Gemini"} (${process.env.LLM_MODEL?.trim() || (provider === "openai" ? "llama-3.3-70b-versatile" : "gemini-2.5-flash")})`;
}
const promptFor = (input: SpaceInput, error?: string) =>
  `You are a space-planning assistant. Use only these structured space facts and target use: ${JSON.stringify(input)}. Treat dimensions as indicative; never invent measured facts; preserve the supplied external envelope; leave explicit circulation; this is a concept design, not construction information. HARD PROPERTY CONSTRAINT: use the supplied buildingForm as evidence. Do not invent storeys, residential uses, shopfronts, or typologies unsupported by evidence. Output only valid JSON matching the supplied schema.${error ? ` Previous output failed this exact validation: ${error}. Correct only that issue.` : ""}`;

async function requestOpenAi(input: SpaceInput): Promise<LlmDesign | null> {
  const key = process.env.LLM_API_KEY?.trim(),
    base = process.env.LLM_BASE_URL?.trim().replace(/\/$/, "");
  if (
    !key ||
    !base ||
    key === "placeholder" ||
    key.startsWith("your-") ||
    base.startsWith("your-")
  )
    return null;
  const model = process.env.LLM_MODEL?.trim() || "llama-3.3-70b-versatile";
  let lastError = "validation failed";
  for (let cycle = 0; cycle < 3; cycle++) {
    const messages = [
      {
        role: "system",
        content:
          "Output only valid JSON matching the schema. Never invent space.",
      },
      {
        role: "user",
        content: promptFor(input, cycle ? lastError : undefined),
      },
    ];
    try {
      const request = (format: unknown) =>
        fetch(`${base}/chat/completions`, {
          method: "POST",
          signal: AbortSignal.timeout(20000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            max_tokens: 4096,
            response_format: format,
          }),
        });
      let res =
        cycle === 0
          ? await request({
              type: "json_schema",
              json_schema: {
                name: "concept_design",
                strict: true,
                schema: openAiSchema,
              },
            })
          : await request({ type: "json_object" });
      if (cycle === 0 && !res.ok && res.status >= 400 && res.status < 500)
        res = await request({ type: "json_object" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as any;
      const parsed = JSON.parse(body?.choices?.[0]?.message?.content);
      const normalized = normalizeLlmDesign(parsed, input);
      if (normalized.design) {
        if (normalized.repaired) repairedDesigns.add(normalized.design);
        return normalized.design;
      }
      lastError = "normalized candidate failed validateLlmDesign";
    } catch (e) {
      lastError = e instanceof Error ? e.message : "invalid JSON";
    }
  }
  return null;
}
export async function requestGemini(
  input: SpaceInput,
): Promise<LlmDesign | null> {
  if (llmProvider() === "openai") return requestOpenAi(input);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === "placeholder" || key.startsWith("your-")) return null;
  const model = process.env.LLM_MODEL?.trim() || "gemini-2.5-flash";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          signal: AbortSignal.timeout(20000),
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptFor(input) }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 4096,
              responseMimeType: "application/json",
              responseSchema: schema,
            },
          }),
        },
      );
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const body = (await res.json()) as any;
      const parsed = JSON.parse(
        body?.candidates?.[0]?.content?.parts?.[0]?.text,
      );
      const n = normalizeLlmDesign(parsed, input);
      if (n.design) {
        if (n.repaired) repairedDesigns.add(n.design);
        return n.design;
      }
    } catch {
      /* deterministic fallback */
    }
  }
  return null;
}
