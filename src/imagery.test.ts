import { afterEach, describe, expect, test } from "bun:test";
import { buildRenderPrompts, CF_VIEW_DIMS, requestImage, VIEW_DIMS, VIEW_SEED } from "./imagery";

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
      expect(count).toBeLessThanOrEqual(220);
      expect(result.prompt).not.toContain("London Road");
      expect(result.prompt).not.toContain("CR0");
      expect(result.prompt.length).toBeLessThan(1600);
      expect(result.prompt.toLowerCase()).toContain("barber");
      expect(result.prompt.startsWith("Photorealistic architectural visualization")).toBe(true);
    }
  });

  test("each view has a distinct camera/angle vocabulary", () => {
    const prompts = buildRenderPrompts([
      { key: "total_floor_area_m2", value: "50", confidence: 0.9 },
    ], "cafe", { buildingForm: "retail_unit" });
    const byView = Object.fromEntries(prompts.map((p) => [p.view, p.prompt]));
    const street = byView.exterior_street;
    const elevation = byView.exterior_elevation;
    const entrance = byView.exterior_entrance;
    const interior = byView.interior;

    // Street: three-quarter oblique, two-point perspective, subject centred.
    expect(street).toContain("three-quarter oblique view");
    expect(street).toContain("two-point perspective");
    expect(street).toContain("neighbouring shopfronts visible either side");
    expect(street).toContain("sky visible above the roofline");
    expect(street).toContain("subject centred");
    // Elevation: dead-on frontal, camera axis perpendicular, no keystone.
    expect(elevation).toContain("dead-on frontal view");
    expect(elevation).toContain("camera axis perpendicular to the facade");
    expect(elevation).toContain("no keystone");
    expect(elevation).toContain("doorway centred on the vertical midline");
    expect(elevation).not.toContain("35mm");
    // Entrance: hard scale anchor — 2-3 m from the door, frame edge to edge.
    expect(entrance.toLowerCase()).toContain("close-up");
    expect(entrance).toContain("shallow depth of field");
    expect(entrance).toContain("camera two to three metres from the door");
    expect(entrance).toContain("no whole building in frame");
    expect(entrance).not.toContain("50mm");
    // Interior: designed-layout interior language + v6 camera/space wording.
    expect(interior).toContain("interior");
    expect(interior).toContain("designed layout");
    expect(interior).toContain("listed zones");
    expect(interior).toContain("one-point perspective from the entrance");
    expect(interior).toContain("no mezzanine or second floor");
  });
  test("v6 building sheet is shared VERBATIM across all three exterior views (retail)", () => {
    const prompts = buildRenderPrompts([], "barber shop", { buildingForm: "retail_unit" });
    const exterior = prompts.filter((p) => p.view !== "interior");
    expect(exterior.length).toBe(3);
    const sheet = "the same building in every view: a single-storey, ground-floor-only shop unit — roofline directly above the shopfront, no upper floor, no residential; warm red-brick plinth, pale render above, dark grey metal shopfront frame, clear glazing, a recessed oak door, one display window; glazed shopfront with no branding or lettering on the glass; overcast diffuse daylight, soft consistent shadows";
    for (const p of exterior) {
      expect(p.prompt).toContain(sheet); // identical string in every exterior view
    }
    // The storey guard is repeated inside street + elevation only (upper-storey bleed block).
    const guard = "Single storey only, roofline above the shopfront.";
    expect(prompts.find((p) => p.view === "exterior_street")!.prompt).toContain(guard);
    expect(prompts.find((p) => p.view === "exterior_elevation")!.prompt).toContain(guard);
    expect(prompts.find((p) => p.view === "exterior_entrance")!.prompt).not.toContain(guard);
  });
  test("v6 honesty markers survive in every prompt; barber-only interior fittings", () => {
    const barber = buildRenderPrompts([], "barber shop", { buildingForm: "retail_unit" });
    const gym = buildRenderPrompts([], "gym", { buildingForm: "unknown" });
    for (const result of [...barber, ...gym]) {
      expect(result.prompt.toLowerCase()).toContain("concept visualisation, not a photograph");
      expect(result.prompt.toLowerCase()).toContain("no people, text, logos, signage, address or personal data");
    }
    // Barber interior carries the designer-approved fittings; gym stays generic.
    expect(barber.find((p) => p.view === "interior")!.prompt).toContain("barber chairs");
    const gymInterior = gym.find((p) => p.view === "interior")!.prompt;
    expect(gymInterior).not.toContain("barber chairs");
    expect(gymInterior).toContain("suitable generic equipment and fittings");
  });
  test("Cloudflare per-view dims: entrance portrait 832x1216, one fixed seed per view", () => {
    expect(CF_VIEW_DIMS.exterior_street).toEqual({ width: 1024, height: 768 });
    expect(CF_VIEW_DIMS.exterior_elevation).toEqual({ width: 1024, height: 768 });
    expect(CF_VIEW_DIMS.exterior_entrance).toEqual({ width: 832, height: 1216 });
    expect(CF_VIEW_DIMS.interior).toEqual({ width: 1024, height: 768 });
    expect(new Set(Object.values(VIEW_SEED)).size).toBe(4);
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
      expect(count).toBeLessThanOrEqual(220);
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
    expect(interior.prompt.length).toBeLessThan(1600);
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

  test("sends the SPARK-verified Cloudflare params: per-view dims + guidance + fixed seed", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response(new Uint8Array([1]), "image/jpeg");
    };
    await requestImage("street prompt", "exterior_street");
    expect(bodies[0]).toMatchObject({ width: 1024, height: 768, guidance: 3, seed: VIEW_SEED.exterior_street });
    bodies.length = 0;
    await requestImage("entrance prompt", "exterior_entrance");
    // Entrance is PORTRAIT on the Cloudflare path (832x1216).
    expect(bodies[0]).toMatchObject({ width: 832, height: 1216, guidance: 3, seed: VIEW_SEED.exterior_entrance });
    bodies.length = 0;
    await requestImage("interior prompt", "interior");
    expect(bodies[0]).toMatchObject({ width: 1024, height: 768, seed: VIEW_SEED.interior });
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
