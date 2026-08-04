import { afterEach, describe, expect, test } from "bun:test";
import {
  buildNearbyFacts,
  combine,
  fetchNearbyPremises,
  fetchNearbySites,
  haversineM,
  reverseGeocodePostcode,
  runNearbyScan,
  type NearbyOpportunity,
} from "./nearby";
import { renderReportHtml, serializeNearbyMapData, type ProjectMemoryLike } from "./report";
import { renderPreviewHtml } from "./preview";

const originalFetch = globalThis.fetch;
const originalKey = process.env.EPC_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.EPC_API_KEY;
  else process.env.EPC_API_KEY = originalKey;
});
process.env.EPC_API_KEY = "test-token";

const HDR = { "content-type": "application/json" };

/** Minimal project-memory fixture from (category, key, value) triples. */
function memory(facts: Array<[string, string, string]>): ProjectMemoryLike {
  return {
    project: {
      id: "25",
      address: "78 Godson Road, Croydon",
      status: "complete",
      created_at: null,
      updated_at: null,
    },
    runs: [],
    facts: facts.map(([category, key, value], i) => ({
      id: String(i + 1),
      category,
      key,
      value,
      confidence: 1,
      source_id: null,
      source_name: null,
    })),
    sources: [],
    decisions: [],
  };
}

type Handler = (url: string, init?: RequestInit) => Response;
function router(routes: Array<[RegExp, Handler]>): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = String(input);
    for (const [re, h] of routes) if (re.test(url)) return h(url, init);
    throw new Error(`unexpected fetch in test mock: ${url}`);
  };
}

const OVERPASS_JSON = JSON.stringify({
  elements: [
    { type: "way", id: 1, center: { lat: 51.3727, lon: -0.1158 }, tags: { landuse: "construction", name: "Queens Square Phase 1" } },
    { type: "node", id: 2, lat: 51.371, lon: -0.114, tags: { shop: "bakery", disused: "shop", "addr:street": "Godson Road", "addr:housenumber": "12" } },
  ],
});

describe("haversineM", () => {
  test("0 for identical points, ~111 km per degree of latitude", () => {
    expect(haversineM(51.37, -0.115, 51.37, -0.115)).toBe(0);
    expect(haversineM(51, 0, 52, 0)).toBeGreaterThan(110_000);
    expect(haversineM(51, 0, 52, 0)).toBeLessThan(112_000);
  });
});

describe("fetchNearbySites (OSM Overpass)", () => {
  test("parses elements into site/building items with distances and ODbL source", async () => {
    globalThis.fetch = router([
      [/overpass/, () => new Response(OVERPASS_JSON, { status: 200, headers: HDR })],
    ]);
    const items = await fetchNearbySites(51.3704638, -0.1158263, 1500);
    expect(items.length).toBe(2);
    const site = items[0];
    expect(site.type).toBe("site");
    expect(site.name).toBe("Queens Square Phase 1");
    expect(site.distance_m).toBeGreaterThan(0);
    expect(site.distance_m).toBeLessThan(500);
    expect(site.source).toBe("OSM Overpass (OpenStreetMap contributors, ODbL)");
    const building = items[1];
    expect(building.type).toBe("building");
    expect(building.name).toBeNull();
    expect(building.context).toContain("Godson Road");
    expect(building.distance_m).toBeGreaterThan(0);
  });
  test("returns [] when every Overpass endpoint fails", async () => {
    globalThis.fetch = async () => new Response("boom", { status: 503 });
    expect(await fetchNearbySites(51.37, -0.115, 1500)).toEqual([]);
  });
  test("falls back to a mirror when the primary endpoint fails", async () => {
    globalThis.fetch = router([
      [/overpass-api\.de/, () => new Response("runtime error", { status: 500 })],
      [/overpass\.kumi/, () => new Response(OVERPASS_JSON, { status: 200, headers: HDR })],
    ]);
    const items = await fetchNearbySites(51.3704638, -0.1158263, 1500);
    expect(items.length).toBe(2);
  });
});

describe("fetchNearbyPremises (EPC register)", () => {
  const NEAREST = {
    result: [
      { postcode: "CR0 4LT", latitude: 51.370295, longitude: -0.11587 },
      { postcode: "CR0 4NW", latitude: 51.3743, longitude: -0.1199 },
    ],
  };
  test("returns non-domestic premises inside the floor-area band with distance + EPC source", async () => {
    globalThis.fetch = router([
      [/api\.postcodes\.io\/postcodes\/(CR04LT|CR04NW)$/, (url) => {
        const pc = url.includes("CR04LT") ? NEAREST.result[0] : NEAREST.result[1];
        return new Response(JSON.stringify({ result: { latitude: pc.latitude, longitude: pc.longitude } }), { status: 200, headers: HDR });
      }],
      [/api\.postcodes\.io\/postcodes\?/, () => new Response(JSON.stringify(NEAREST), { status: 200, headers: HDR })],
      [/non-domestic\/search\?postcode=CR04LT/, () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: HDR })],
      [/non-domestic\/search\?postcode=CR04NW/, () => new Response(
        JSON.stringify({ data: [
          { certificateNumber: "AAAA", addressLine1: "343 Purley Way", postcode: "CR0 4NW" },
          { certificateNumber: "BBBB", addressLine1: "335 Purley Way", postcode: "CR0 4NW" },
        ] }), { status: 200, headers: HDR })],
      [/certificate\?certificate_number=AAAA/, () => new Response(
        JSON.stringify({ data: { address_line_1: "343 Purley Way", postcode: "CR0 4NW", property_type: "Retail/Financial and Professional Services", technical_information: { floor_area: 34 } } }),
        { status: 200, headers: HDR })],
      [/certificate\?certificate_number=BBBB/, () => new Response(
        JSON.stringify({ data: { address_line_1: "335 Purley Way", postcode: "CR0 4NW", property_type: "Retail", technical_information: { floor_area: 900 } } }),
        { status: 200, headers: HDR })],
    ]);
    const items = await fetchNearbyPremises("CR0 4LT", 16, 48, 4);
    expect(items.length).toBe(1);
    expect(items[0].address).toBe("343 Purley Way");
    expect(items[0].floor_area_m2).toBe(34);
    expect(items[0].source).toBe("EPC register");
    expect(items[0].distance_m).toBeGreaterThan(0);
  });
  test("returns [] when the network fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    expect(await fetchNearbyPremises("CR0 9ZZ", 10, 50, 4)).toEqual([]);
  });
  test("returns [] when the EPC key is missing", async () => {
    delete process.env.EPC_API_KEY;
    globalThis.fetch = router([[/./, () => new Response("unused", { status: 200 })]]) as never;
    expect(await fetchNearbyPremises("CR0 4LT", 10, 50, 4)).toEqual([]);
  });
});

describe("combine", () => {
  const SITES_JSON = (count: number, residential = false): string => {
    const extra = residential ? [{ type: "way", id: 99, center: { lat: 51.3709, lon: -0.1155 }, tags: { building: "house", disused: "building" } }] : [];
    const elements = [];
    for (let i = 0; i < count; i++) {
      elements.push({ type: "way", id: 100 + i, center: { lat: 51.3704638 + i * 0.001, lon: -0.1158263 }, tags: { landuse: "construction", name: i === 0 ? "Nearest site" : undefined } });
    }
    return JSON.stringify({ elements: [...elements, ...extra] });
  };
  const NEAREST = {
    result: [
      { postcode: "CR0 4ZZ", latitude: 51.3704638, longitude: -0.1158263 },
      { postcode: "CR0 4NW", latitude: 51.3743, longitude: -0.1199 },
    ],
  };
  const cert = (rrn: string, area: number, type: string, line1: string): [RegExp, Handler] => [
    new RegExp(`certificate\\?certificate_number=${rrn}`),
    () => new Response(JSON.stringify({ data: { address_line_1: line1, postcode: "CR0 4NW", property_type: type, technical_information: { floor_area: area } } }), { status: 200, headers: HDR }),
  ];
  const epcRouter = (siteJson: string): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =>
    router([
      [/overpass/, () => new Response(siteJson, { status: 200, headers: HDR })],
      [/api\.postcodes\.io\/postcodes\/(CR04ZZ|CR04NW)$/, (url) => {
        const pc = url.includes("CR04ZZ") ? NEAREST.result[0] : NEAREST.result[1];
        return new Response(JSON.stringify({ result: { latitude: pc.latitude, longitude: pc.longitude } }), { status: 200, headers: HDR });
      }],
      [/api\.postcodes\.io\/postcodes\?/, () => new Response(JSON.stringify(NEAREST), { status: 200, headers: HDR })],
      [/non-domestic\/search\?postcode=CR04ZZ/, () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: HDR })],
      [/non-domestic\/search\?postcode=CR04NW/, () => new Response(
        JSON.stringify({ data: [
          { certificateNumber: "AAA1", addressLine1: "Unit 1 High Street", postcode: "CR0 4NW" },
          { certificateNumber: "AAA2", addressLine1: "Unit 2 High Street", postcode: "CR0 4NW" },
          { certificateNumber: "AAA3", addressLine1: "Unit 3 High Street", postcode: "CR0 4NW" },
        ] }), { status: 200, headers: HDR })],
      cert("AAA1", 34, "Retail/Financial and Professional Services", "Unit 1 High Street"),
      cert("AAA2", 12, "Retail", "Unit 2 High Street"),
      cert("AAA3", 40, "Residential Institutions: Care Home", "Unit 3 High Street"),
    ]);
  const project = { postcode: "CR0 4ZZ", lat: 51.3704638, lon: -0.1158263, floorAreaM2: 32 }; // band 16–48 m²

  test("keeps compatible sites + in-band commercial premises, drops out-of-band and residential", async () => {
    globalThis.fetch = epcRouter(SITES_JSON(4, true)); // 4 construction sites + 1 disused house
    const opps = await combine(project, "gym");
    const kinds = opps.map((o) => o.kind);
    expect(kinds.filter((k) => k === "site").length).toBe(4); // house excluded (residential)
    const premises = opps.filter((o) => o.kind === "premises");
    expect(premises.length).toBe(1); // only the 34 m² retail unit
    expect(premises[0].name).toBe("Unit 1 High Street");
    expect(premises[0].size_m2).toBe(34);
    expect(premises[0].confidence).toBe(0.7);
    // sorted by distance — the nearest construction site comes first
    expect(opps[0].name).toBe("Nearest site");
    expect(opps[0].confidence).toBe(0.6);
    // honest vacancy note everywhere
    expect(opps[0].note.toLowerCase()).toContain("not verified");
  });
  test("caps the ranked list at ~8", async () => {
    globalThis.fetch = epcRouter(SITES_JSON(12));
    const opps = await combine(project, "gym");
    expect(opps.length).toBe(8);
  });
  test("returns empty when the project has no coordinates and no postcode", async () => {
    globalThis.fetch = epcRouter(SITES_JSON(4));
    const opps = await combine({ postcode: null, lat: null, lon: null, floorAreaM2: 32 }, "gym");
    expect(opps).toEqual([]);
  });
  test("a barbershop (Class E shop) keeps commercial premises but drops a C3 building", async () => {
    globalThis.fetch = epcRouter(SITES_JSON(2, true));
    const opps = await combine(project, "barber shop");
    expect(opps.some((o) => o.kind === "premises")).toBe(true);
    expect(opps.some((o) => o.name === "Nearest site")).toBe(true);
    expect(opps.filter((o) => o.kind === "site").length).toBe(2); // house dropped
  });
});

describe("reverseGeocodePostcode", () => {
  test("returns the nearest postcode from postcodes.io", async () => {
    globalThis.fetch = router([
      [/api\.postcodes\.io\/postcodes\?/, () => new Response(JSON.stringify({ result: [{ postcode: "M1 1AE", latitude: 53.479, longitude: -2.238 }] }), { status: 200, headers: HDR })],
    ]);
    expect(await reverseGeocodePostcode(53.48, -2.24)).toBe("M1 1AE");
  });
  test("returns null on failure", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    expect(await reverseGeocodePostcode(51.37, -0.115)).toBeNull();
  });
});

describe("runNearbyScan / buildNearbyFacts", () => {
  test("records honest failed status when coords and postcode are both missing", async () => {
    globalThis.fetch = async () => {
      throw new Error("must not be called");
    };
    const facts = await runNearbyScan({ postcode: null, lat: null, lon: null, floorAreaM2: 32, targetUse: "gym", sourceId: "s1", generatedAt: "2026-08-03T00:00:00Z" });
    expect(facts.find((f) => f.key === "nearby_status")?.value).toBe("failed");
    expect(facts.find((f) => f.key === "nearby_count")?.value).toBe("0");
    for (const f of facts) expect(f.category).toBe("nearby");
  });
  test("buildNearbyFacts writes per-item facts with the item's own confidence", () => {
    const opps: NearbyOpportunity[] = [
      { kind: "site", name: "Queens Square Phase 1", size_m2: null, distance_m: 248, source: "OSM Overpass (OpenStreetMap contributors, ODbL)", confidence: 0.6, note: "not verified" },
      { kind: "premises", name: "343 Purley Way", size_m2: 34, distance_m: 540, source: "EPC register", confidence: 0.7, note: "not verified" },
    ];
    const facts = buildNearbyFacts(opps, { generatedAt: "2026-08-03T00:00:00Z", sourceId: "src-9", status: "ok" });
    expect(facts.find((f) => f.key === "nearby_count")?.value).toBe("2");
    expect(facts.find((f) => f.key === "nearby_0_kind")?.value).toBe("site");
    expect(facts.find((f) => f.key === "nearby_0_confidence")?.value).toBe("0.6");
    expect(facts.find((f) => f.key === "nearby_0_distance_m")?.value).toBe("248");
    expect(facts.find((f) => f.key === "nearby_1_kind")?.value).toBe("premises");
    expect(facts.find((f) => f.key === "nearby_1_confidence")?.value).toBe("0.7");
    expect(facts.find((f) => f.key === "nearby_1_size_m2")?.value).toBe("34");
    for (const f of facts) expect(f.category).toBe("nearby");
    expect(facts.every((f) => f.sourceId === "src-9")).toBe(true);
  });
});

describe("report + preview integration", () => {
  test("serializes privacy-safe map pins with coordinates and caveat", () => {
    const data = serializeNearbyMapData(memory([
      ["discovery", "latitude", "51.372"], ["discovery", "longitude", "-0.115"],
      ["nearby", "nearby_count", "1"], ["nearby", "nearby_0_kind", "site"], ["nearby", "nearby_0_name", "Open Site"],
      ["nearby", "nearby_0_size_m2", "120"], ["nearby", "nearby_0_distance_m", "250"], ["nearby", "nearby_0_source", "OSM"],
      ["nearby", "nearby_0_lat", "51.373"], ["nearby", "nearby_0_lon", "-0.116"],
    ]).facts);
    expect(data.pins).toEqual([{ name: "Open Site", kind: "site", size: "120 m²", distance: "250 m", source: "OSM", lat: 51.373, lon: -0.116 }]);
    expect(data.center).toEqual({ lat: 51.372, lon: -0.115 });
    expect(data.caveat).toContain("open-data candidate — vacancy not verified");
  });
  test("report contains map enhancement and serialized pins for a synthetic candidate", () => {
    const html = renderReportHtml(memory([
      ["nearby", "nearby_count", "1"], ["nearby", "nearby_0_kind", "site"], ["nearby", "nearby_0_name", "Synthetic Site"],
      ["nearby", "nearby_0_lat", "51.373"], ["nearby", "nearby_0_lon", "-0.116"], ["nearby", "nearby_0_source", "OSM"],
    ]));
    expect(html).toContain('id="nearby-map"'); expect(html).toContain('"lat":51.373'); expect(html).toContain("open-data candidate — vacancy not verified");
  });
  test("report renders the Nearby opportunities section with the honest caveat", () => {
    const html = renderReportHtml(memory([
      ["design", "design_target_use", "gym"],
      ["nearby", "nearby_count", "2"],
      ["nearby", "nearby_0_kind", "site"],
      ["nearby", "nearby_0_name", "Queens Square Phase 1"],
      ["nearby", "nearby_0_size_m2", ""],
      ["nearby", "nearby_0_distance_m", "248"],
      ["nearby", "nearby_0_source", "OSM Overpass (OpenStreetMap contributors, ODbL)"],
      ["nearby", "nearby_0_confidence", "0.6"],
      ["nearby", "nearby_1_kind", "premises"],
      ["nearby", "nearby_1_name", "343 Purley Way"],
      ["nearby", "nearby_1_size_m2", "34"],
      ["nearby", "nearby_1_distance_m", "540"],
      ["nearby", "nearby_1_source", "EPC register"],
      ["nearby", "nearby_1_confidence", "0.7"],
    ]));
    expect(html).toContain("Nearby opportunities");
    expect(html).toContain(">SITE<");
    expect(html).toContain(">PREMISES<");
    expect(html).toContain("Queens Square Phase 1");
    expect(html).toContain("343 Purley Way");
    expect(html).toContain("248 m");
    expect(html).toContain("540 m");
    expect(html).toContain("34 m²");
    expect(html).toContain("Candidates flagged from open data (OSM/EPC). Availability and vacancy are NOT verified — confirm with the local authority, agents and the landowner.");
  });
  test("report omits the section when nearby_count is absent or zero", () => {
    const html = renderReportHtml(memory([["design", "design_target_use", "gym"], ["nearby", "nearby_count", "0"]]));
    expect(html).not.toContain("Nearby opportunities");
  });
  test("preview teaser shows the nearby line when nearby_count > 0", () => {
    const html = renderPreviewHtml(memory([
      ["imagery", "imagery_exterior_status", "generated"],
      ["imagery", "imagery_exterior_url", "/project-images/25/exterior.jpg"],
      ["imagery", "imagery_interior_status", "generated"],
      ["imagery", "imagery_interior_url", "/project-images/25/interior.jpg"],
      ["nearby", "nearby_count", "4"],
    ]));
    expect(html).not.toBeNull();
    expect(html).toContain("Nearby opportunities: 4 sites/premises within 1.5 km flagged — unlock the full report to see them.");
  });
  test("preview teaser omits the nearby line when nearby_count is zero", () => {
    const html = renderPreviewHtml(memory([
      ["imagery", "imagery_exterior_status", "generated"],
      ["imagery", "imagery_exterior_url", "/project-images/25/exterior.jpg"],
      ["imagery", "imagery_interior_status", "generated"],
      ["imagery", "imagery_interior_url", "/project-images/25/interior.jpg"],
      ["nearby", "nearby_count", "0"],
    ]));
    expect(html).not.toContain("Nearby opportunities:");
  });
});
