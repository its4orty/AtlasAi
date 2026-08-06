import { afterEach, describe, expect, test } from "bun:test";
import { buildRenderPrompts, requestImage } from "./imagery";

const originalFetch = globalThis.fetch;
const originalToken = process.env.CLOUDFLARE_API_TOKEN;
const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;

function response(bytes = new Uint8Array([1, 2, 3]), contentType = "image/png") {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
});

describe("buildRenderPrompts", () => {
  test("returns suitably detailed, privacy-safe exterior and interior prompts", () => {
    const prompts = buildRenderPrompts([
      { key: "address", value: "244 London Road, Croydon CR0 2TA", confidence: 1 },
      { key: "room_dimension_m", value: "6 x 4", confidence: 0.95 },
      { key: "room_label", value: "front office", confidence: 0.95 },
      { key: "total_floor_area_m2", value: "50", confidence: 0.9 },
    ], "barber shop");

    expect(prompts.map((p) => p.view)).toEqual(["exterior", "interior"]);
    for (const result of prompts) {
      const count = result.prompt.trim().split(/\s+/).length;
      expect(count).toBeGreaterThanOrEqual(80);
      expect(count).toBeLessThanOrEqual(180);
      expect(result.prompt).not.toContain("London Road");
      expect(result.prompt).not.toContain("CR0");
      expect(result.prompt.length).toBeLessThan(1000);
      expect(result.prompt.toLowerCase()).toContain("barber");
      expect(result.prompt.startsWith("Photorealistic architectural visualization")).toBe(true);
    }
  });

  test("industrial form is explicit and unknown form stays conservative", () => {
    const industrial = buildRenderPrompts([], "barber shop", { buildingForm: "industrial_unit" }).find((p) => p.view === "exterior")!;
    expect(industrial.prompt).toContain("industrial unit");
    expect(industrial.prompt).not.toContain("street-facing commercial premises");
    const unknown = buildRenderPrompts([], "barber shop", {}).find((p) => p.view === "exterior")!;
    expect(unknown.prompt).toContain("ground floor only");
    expect(unknown.prompt).not.toContain("shopfront");
  });

  test("design-aware prompts describe the DESIGNED layout and stay privacy-safe", () => {
    // Project with NO source documents: only an address fact exists, so the
    // spatial evidence brief is empty — the designed conversion context must
    // carry the render brief instead of falling back to generic imagery.
    const prompts = buildRenderPrompts(
      [{ key: "address", value: "78 Godson Road, Croydon CR0 2TA", confidence: 1 }],
      "gym",
      { programmeLabel: "Gym / studio", zoneNames: ["Studio floor", "Changing", "Office", "Store"], rooms: ["OPEN PLAN"], allocatedM2: 32 },
    );
    expect(prompts.map((p) => p.view)).toEqual(["exterior", "interior"]);
    for (const result of prompts) {
      const count = result.prompt.trim().split(/\s+/).length;
      expect(count).toBeGreaterThanOrEqual(80);
      expect(count).toBeLessThanOrEqual(180);
      // No personal/property identity anywhere in the prompts.
      expect(result.prompt).not.toContain("Godson");
      expect(result.prompt).not.toContain("Croydon");
      expect(result.prompt).not.toContain("CR0");
      expect(result.prompt).not.toContain("78");
      // The designed programme + zones drive the brief.
      expect(result.prompt).toContain("Gym / studio");
      expect(result.prompt).toContain("Studio floor");
      expect(result.prompt).toContain("Changing");
    }
    const interior = prompts.find((p) => p.view === "interior")!;
    expect(interior.prompt).toContain("designed layout");
    expect(interior.prompt).toContain("listed zones");
    expect(interior.prompt.length).toBeLessThan(1000);
    // Changing the designed layout must change the cache hash so renders regenerate.
    const different = buildRenderPrompts(
      [{ key: "address", value: "78 Godson Road, Croydon CR0 2TA", confidence: 1 }],
      "gym",
      { programmeLabel: "Gym / studio", zoneNames: ["Cardio zone", "Free-weights area"], rooms: ["OPEN PLAN"], allocatedM2: 40 },
    );
    expect(different[0].hash).not.toBe(prompts[0].hash);
    expect(different[1].hash).not.toBe(prompts[1].hash);
  });
});

describe("requestImage", () => {
  test("returns bytes and provider/model on Cloudflare success", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    globalThis.fetch = async () => response(new Uint8Array([7, 8]), "image/webp");

    const result = await requestImage("a safe prompt", "exterior");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/webp" });
    expect([...result!.bytes]).toEqual([7, 8]);
  });

  test("decodes Cloudflare base64 JSON image responses", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const encoded = btoa(String.fromCharCode(...jpeg));
    globalThis.fetch = async () => new Response(JSON.stringify({ result: { image: encoded } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await requestImage("a safe prompt", "exterior");
    expect(result).toMatchObject({ provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/jpeg" });
    expect([...result!.bytes]).toEqual([...jpeg]);
  });

  test("falls back to Pollinations after Cloudflare failure", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) return new Response("failed", { status: 500 });
      return response(new Uint8Array([9]), "image/jpeg");
    };

    const result = await requestImage("a safe prompt", "interior");
    expect(result).toMatchObject({ provider: "pollinations", model: "default", mime: "image/jpeg" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("https://image.pollinations.ai/prompt/");
  });

  test("returns null when both providers fail", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    globalThis.fetch = async () => new Response("failed", { status: 503 });

    expect(await requestImage("a safe prompt", "exterior")).toBeNull();
  });
});
