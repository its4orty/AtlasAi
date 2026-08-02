import { afterEach, describe, expect, test } from "bun:test";
import { designInputHash, requestGemini, validateLlmDesign, type SpaceInput } from "./llm";

/**
 * Unit tests for src/llm.ts — Gemini-backed concept design generation.
 * Global fetch is mocked: no network, no real key. requestGemini returns
 * `LlmDesign | null` (null on any failure after 2 attempts).
 */

const input: SpaceInput = {
  rooms: [
    { label: "OFFICE 1", widthM: 6, depthM: 4, areaM2: 24 },
    { label: "OFFICE 2", widthM: 5, depthM: 4, areaM2: 20 },
  ],
  totalFloorAreaM2: 50,
  currentUse: "office",
  targetUse: "barber shop",
};

const validDesign = {
  targetUse: "barber shop",
  rooms: [
    {
      id: "r1",
      label: "CUTTING AREA",
      widthM: 6,
      depthM: 4,
      areaM2: 24,
      sourceRoomIndex: 0,
      isNewPartition: false,
      zones: [
        { label: "Cutting station", xM: 0, yM: 0, widthM: 3, depthM: 2, notes: "two chairs" },
        { label: "Backwash", xM: 0, yM: 2, widthM: 2, depthM: 2, notes: "" },
      ],
    },
    {
      id: "r2",
      label: "FRONT",
      widthM: 5,
      depthM: 4,
      areaM2: 20,
      sourceRoomIndex: 1,
      isNewPartition: true,
      zones: [{ label: "Reception", xM: 0, yM: 0, widthM: 5, depthM: 3, notes: "till" }],
    },
  ],
  circulationM2: 4,
  notes: ["concept only, not for construction"],
};

function geminiResponse(text: string): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text }] } }],
  });
}

function mockFetchResolving(text: string): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url) => {
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    return geminiResponse(text);
  };
}

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_MODEL;
});

describe("requestGemini", () => {
  test("happy path: parses + validates a Gemini-shaped body into an LlmDesign", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchResolving(JSON.stringify(validDesign));
    try {
      const result = await requestGemini(input);
      expect(result).not.toBeNull();
      expect(result).toEqual(validDesign);
      expect(result!.rooms).toHaveLength(2);
      expect(result!.circulationM2).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects malformed JSON → returns null", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchResolving("this is not json {");
    try {
      const result = await requestGemini(input);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a design that fails validation (negative circulation) → returns null", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const bad = structuredClone(validDesign);
    bad.circulationM2 = -5;
    expect(validateLlmDesign(bad, input)).toBe(false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchResolving(JSON.stringify(bad));
    try {
      const result = await requestGemini(input);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a design whose rooms exceed the total floor area → returns null", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const bad = structuredClone(validDesign);
    bad.rooms[0].areaM2 = 60; // 60 + 20 + 4 = 84 > 50 * 1.05
    bad.rooms[0].widthM = 12;
    bad.rooms[0].depthM = 5;
    expect(validateLlmDesign(bad, input)).toBe(false);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchResolving(JSON.stringify(bad));
    try {
      const result = await requestGemini(input);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("designInputHash", () => {
  test("same input → identical hash", () => {
    expect(designInputHash(input)).toBe(designInputHash({ ...input }));
  });

  test("different input → different hash", () => {
    const other: SpaceInput = { ...input, targetUse: "cafe" };
    expect(designInputHash(other)).not.toBe(designInputHash(input));
  });
});

describe("OpenAI-compatible provider", () => {
  const openAiResponse = (content: string, status = 200) => Response.json(status === 200 ? { choices: [{ message: { content } }] } : { error: { message: "unsupported response format" } }, { status });
  afterEach(() => { delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY; delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL; });

  test("happy path parses choices message content", async () => {
    process.env.LLM_PROVIDER = "openai"; process.env.LLM_API_KEY = "test-key"; process.env.LLM_BASE_URL = "https://api.groq.com/openai/v1"; process.env.LLM_MODEL = "llama-test";
    const original = globalThis.fetch; const calls: unknown[] = [];
    globalThis.fetch = (async (url, init) => { calls.push(JSON.parse(String(init?.body))); expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions"); return openAiResponse(JSON.stringify(validDesign)); }) as typeof fetch;
    try { expect(await requestGemini(input)).toEqual(validDesign); expect(calls).toHaveLength(1); } finally { globalThis.fetch = original; }
  });

  test("strict schema 400 retries with json_object", async () => {
    process.env.LLM_PROVIDER = "openai"; process.env.LLM_API_KEY = "test-key"; process.env.LLM_BASE_URL = "https://models.github.ai/inference";
    const original = globalThis.fetch; const formats: string[] = [];
    globalThis.fetch = (async (_url, init) => { const body = JSON.parse(String(init?.body)); formats.push(body.response_format.type); return formats.length === 1 ? openAiResponse("", 400) : openAiResponse(JSON.stringify(validDesign)); }) as typeof fetch;
    try { expect(await requestGemini(input)).toEqual(validDesign); expect(formats).toEqual(["json_schema", "json_object"]); } finally { globalThis.fetch = original; }
  });

  test("both response formats failing returns null", async () => {
    process.env.LLM_PROVIDER = "openai"; process.env.LLM_API_KEY = "test-key"; process.env.LLM_BASE_URL = "https://api.groq.com/openai/v1";
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = (async () => { calls++; return openAiResponse("", 400); }) as typeof fetch;
    try { expect(await requestGemini(input)).toBeNull(); expect(calls).toBe(4); } finally { globalThis.fetch = original; }
  });
});
