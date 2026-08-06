import { describe, expect, test } from "bun:test";
import { facadeToSvg, lookupFacadeImage } from "./facade";

/** Synthetic building image: mid-grey facade mass with two white window openings. */
async function syntheticFacadePng(): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const src = `<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg">
    <rect width="300" height="200" fill="#a0a0a0"/>
    <rect x="40" y="50" width="50" height="70" fill="#ffffff"/>
    <rect x="200" y="60" width="45" height="60" fill="#ffffff"/>
  </svg>`;
  const buf = await sharp(Buffer.from(src)).png().toBuffer();
  return new Uint8Array(buf);
}

describe("facadeToSvg", () => {
  test("extracts a deterministic schematic with the mandated title block from a synthetic facade", async () => {
    const img = await syntheticFacadePng();
    const a = await facadeToSvg(img);
    const b = await facadeToSvg(img);
    expect(a.status).toBe("generated");
    if (a.status !== "generated") return;
    // Deterministic: same input → byte-identical SVG.
    expect(a.svg).toBe(b.status === "generated" ? b.svg : "");
    // Mandated honest title block.
    expect(a.svg).toContain("Schematic facade elevation — inferred from a single image; not a measured survey.");
    // Both windows detected as inferred openings.
    expect(a.svg.match(/class="opening inferred"/g)?.length ?? 0).toBe(2);
    // Every opening is explicitly labelled inferred with a confidence flag.
    expect(a.svg).toContain('data-inferred="true"');
    expect(a.svg).toContain("data-confidence=");
    // Ground line and facade boundary present.
    expect(a.svg).toContain("GROUND LINE · inferred");
    expect(a.svg).toContain("class=\"boundary\"");
  });

  test("refuses a plain image with no facade features (never fabricates)", async () => {
    const sharp = (await import("sharp")).default;
    const blank = new Uint8Array(await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer());
    const r = await facadeToSvg(blank);
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toBe("no features");
  });

  test("returns unavailable on a degenerate input", async () => {
    const r = await facadeToSvg(new Uint8Array(8));
    expect(r.status).toBe("unavailable");
  });
});

describe("lookupFacadeImage", () => {
  test("returns 'no token' when MAPILLARY_TOKEN is absent (env-gated)", async () => {
    const had = process.env.MAPILLARY_TOKEN;
    delete process.env.MAPILLARY_TOKEN;
    try {
      const r = await lookupFacadeImage({ lat: 51.372, lon: -0.098 });
      expect(r).toEqual({ status: "unavailable", reason: "no token" });
    } finally {
      if (had !== undefined) process.env.MAPILLARY_TOKEN = had;
    }
  });

  test("returns 'invalid coordinates' for non-finite coords even with a token", async () => {
    const had = process.env.MAPILLARY_TOKEN;
    process.env.MAPILLARY_TOKEN = "test-token";
    try {
      const r = await lookupFacadeImage({ lat: Number.NaN, lon: 0 });
      expect(r).toEqual({ status: "unavailable", reason: "invalid coordinates" });
    } finally {
      if (had !== undefined) process.env.MAPILLARY_TOKEN = had;
      else delete process.env.MAPILLARY_TOKEN;
    }
  });
});
