import { afterEach, describe, expect, test } from "bun:test";
import { buildRenderPrompts, requestImage, VIEW_DIMS } from "./imagery";

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

const ALL_VIEWS = ["exterior_street", "exterior_elevation", "exterior_entrance", "interior"];

describe("buildRenderPrompts", () => {
  test("emits all four views: three exterior + interior, in stable order", () => {
    const prompts = buildRenderPrompts([
      { key: "address", value: "244 London Road, Croydon CR0 2TA", confidence: 1 },
      { key: "room_dimension_m", value: "6 x 4", confidence: 0.95 },
      { key: "room_label", value: "front office", confidence: 0.95 },
      { key: "total_floor_area_m2", value: "50", confidence: 0.9 },
    ], "barber shop");

    expect(prompts.map((p) => p.view)).toEqual(ALL_VIEWS);
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

  test("each view has a distinct camera/angle vocabulary", () => {
    const prompts = buildRenderPrompts([
      { key: "total_floor_area_m2", value: "50", confidence: 0.9 },
    ], "cafe");
    const byView = Object.fromEntries(prompts.map((p) => [p.view, p.prompt]));
    const street = byView.exterior_street;
    const elevation = byView.exterior_elevation;
    const entrance = byView.exterior_entrance;
    const interior = byView.interior;

    // Street context: 35mm eye level, across the street, neighbours.
    expect(street).toContain("across the street");
    expect(street).toContain("35mm");
    expect(street).toContain("neighbours");
    // Elevation: frontal, squared camera at 50mm, symmetrical one-point perspective.
    expect(elevation).toContain("50mm");
    expect(elevation).toContain("one-point perspective");
    expect(elevation).toContain("symmetrical");
    expect(elevation).not.toContain("35mm");
    // Entrance: close-up, tighter framing, shallow depth of field.
    expect(entrance.toLowerCase()).toContain("close-up");
    expect(entrance).toContain("shallow depth of field");
    expect(entrance).not.toContain("50mm");
    // Interior: designed-layout interior language.
    expect(interior).toContain("interior");
    expect(interior).toContain("designed layout");
    expect(interior).toContain("listed zones");
  });

  test("industrial form is explicit and unknown form stays conservative", () => {
    const industrial = buildRenderPrompts([], "barber shop", { buildingForm: "industrial_unit" }).find((p) => p.view === "exterior_street")!;
    expect(industrial.prompt).toContain("industrial unit");
    expect(industrial.prompt).not.toContain("street-facing commercial premises");
    for (const result of buildRenderPrompts([], "barber shop", { buildingForm: "industrial_unit" })) {
      expect(result.prompt).not.toContain("shopfront");
    }
    const unknown = buildRenderPrompts([], "barber shop", {}).find((p) => p.view === "exterior_street")!;
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
    expect(prompts.map((p) => p.view)).toEqual(ALL_VIEWS);
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
    for (let i = 0; i < ALL_VIEWS.length; i++) {
      expect(different[i].hash).not.toBe(prompts[i].hash);
    }
  });

  test("hashes are stable per view and distinct across views", () => {
    const facts = [{ key: "total_floor_area_m2", value: "50", confidence: 0.9 }];
    const a = buildRenderPrompts(facts, "cafe", { buildingForm: "retail_unit" });
    const b = buildRenderPrompts(facts, "cafe", { buildingForm: "retail_unit" });
    for (let i = 0; i < ALL_VIEWS.length; i++) {
      expect(b[i].hash).toBe(a[i].hash); // deterministic per view
    }
    const hashes = new Set(a.map((p) => p.hash));
    expect(hashes.size).toBe(ALL_VIEWS.length); // each view hashes differently
  });

  test("per-view Pollinations dimensions: entrance is portrait, others landscape", () => {
    expect(VIEW_DIMS.exterior_street).toEqual({ width: 1024, height: 768 });
    expect(VIEW_DIMS.exterior_elevation).toEqual({ width: 1024, height: 768 });
    expect(VIEW_DIMS.exterior_entrance).toEqual({ width: 768, height: 1024 });
    expect(VIEW_DIMS.interior).toEqual({ width: 1024, height: 768 });
  });
});

describe("requestImage", () => {
  test("returns bytes and provider/model on Cloudflare success", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    globalThis.fetch = async () => response(new Uint8Array([7, 8]), "image/webp");

    const result = await requestImage("a safe prompt", "exterior_street");
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

    const result = await requestImage("a safe prompt", "exterior_street");
    expect(result).toMatchObject({ provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/jpeg" });
    expect([...result!.bytes]).toEqual([...jpeg]);
  });

  test("falls back to Pollinations after Cloudflare failure, with per-view dimensions", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) return new Response("failed", { status: 500 });
      return response(new Uint8Array([9]), "image/jpeg");
    };

    // Entrance view falls back to Pollinations with a PORTRAIT canvas.
    const entrance = await requestImage("a safe prompt", "exterior_entrance");
    expect(entrance).toMatchObject({ provider: "pollinations", model: "default", mime: "image/jpeg" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("https://image.pollinations.ai/prompt/");
    expect(calls[1]).toContain("width=768&height=1024");
    expect(calls[1]).toContain("nologo=true");

    // Street view stays landscape.
    calls.length = 0;
    const street = await requestImage("a safe prompt", "exterior_street");
    expect(street).toMatchObject({ provider: "pollinations" });
    expect(calls[1]).toContain("width=1024&height=768");
  });

  test("returns null when both providers fail", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    globalThis.fetch = async () => new Response("failed", { status: 503 });

    expect(await requestImage("a safe prompt", "exterior_street")).toBeNull();
  });
});
