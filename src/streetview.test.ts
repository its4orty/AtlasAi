import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildStreetViewEmbedUrl, fetchStreetViewFacts, geocodeAddress } from "./streetview";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GOOGLE_MAPS_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalKey;
});

const NOMINATIM_JSON = JSON.stringify([
  { lat: "51.3704638", lon: "-0.1158263", display_name: "Godson Road, Waddon, Croydon" },
]);

describe("buildStreetViewEmbedUrl", () => {
  test("builds a keyless Google Maps Street View embed URL from address + coords", () => {
    const url = buildStreetViewEmbedUrl("78 Godson Road, Croydon", "51.3704638", "-0.1158263");
    expect(url).toContain("https://www.google.com/maps?q=");
    expect(url).toContain("layer=c");
    expect(url).toContain("cbll=51.3704638,-0.1158263");
    expect(url).toContain("cbp=11,0,0,0,0");
    expect(url).toContain("output=svembed");
    expect(decodeURIComponent(url)).toContain("78 Godson Road, Croydon");
  });
});

describe("geocodeAddress", () => {
  test("calls Nominatim with a descriptive User-Agent and returns lat/lon", async () => {
    let ua = "";
    globalThis.fetch = async (input, init) => {
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      ua = headers?.["User-Agent"] ?? "";
      expect(String(input)).toContain("https://nominatim.openstreetmap.org/search?q=");
      expect(String(input)).toContain("78%20Godson%20Road");
      expect(String(input)).toContain("%2C%20UK");
      return new Response(NOMINATIM_JSON, { status: 200, headers: { "content-type": "application/json" } });
    };
    const coords = await geocodeAddress("78 Godson Road, Croydon");
    expect(coords).toEqual({ lat: "51.3704638", lon: "-0.1158263" });
    expect(ua).toContain("AtlasAI");
  });

  test("returns null when Nominatim fails", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    expect(await geocodeAddress("78 Godson Road, Croydon")).toBeNull();
  });

  test("returns null when Nominatim returns no results", async () => {
    globalThis.fetch = async () =>
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    expect(await geocodeAddress("not a real place anywhere")).toBeNull();
  });
});

describe("fetchStreetViewFacts", () => {
  test("records embed URL + coords as confidence-1 imagery facts", async () => {
    globalThis.fetch = async (input) => {
      if (String(input).startsWith("https://nominatim.")) {
        return new Response(NOMINATIM_JSON, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("unexpected", { status: 500 });
    };
    const facts = await fetchStreetViewFacts("78 Godson Road, Croydon", "25", "src-1");
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f.value]));
    expect(byKey.imagery_streetview_status).toBe("embed");
    expect(byKey.imagery_streetview_lat).toBe("51.3704638");
    expect(byKey.imagery_streetview_lon).toBe("-0.1158263");
    expect(byKey.imagery_streetview_embed_url).toContain("output=svembed");
    expect(byKey.imagery_streetview_embed_url).toContain("cbll=51.3704638,-0.1158263");
    expect(facts.every((f) => f.confidence === 1 && f.sourceId === "src-1")).toBe(true);
  });

  test("records a failed status and no embed URL when geocoding fails (graceful skip)", async () => {
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    const facts = await fetchStreetViewFacts("78 Godson Road, Croydon", "25", "src-1");
    expect(facts).toHaveLength(1);
    expect(facts[0].key).toBe("imagery_streetview_status");
    expect(facts[0].value).toBe("failed");
    expect(facts[0].confidence).toBe(1);
  });

  test("saves a static Street View image when GOOGLE_MAPS_API_KEY is set", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://nominatim.")) {
        return new Response(NOMINATIM_JSON, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://maps.googleapis.com/maps/api/streetview")) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    try {
      const facts = await fetchStreetViewFacts("78 Godson Road, Croydon", "sv-test-99", "src-1");
      const byKey = Object.fromEntries(facts.map((f) => [f.key, f.value]));
      expect(byKey.imagery_streetview_status).toBe("image");
      expect(byKey.imagery_streetview_url).toBe("/project-images/sv-test-99/streetview.jpg");
      expect(
        calls.some((u) => u.includes("maps.googleapis.com/maps/api/streetview") && u.includes("key=test-key")),
      ).toBe(true);
    } finally {
      await rm(new URL("../public/project-images/sv-test-99", import.meta.url), { recursive: true, force: true });
    }
  });
});
