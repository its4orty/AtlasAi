import { describe, expect, test } from "bun:test";
import { renderReportHtml } from "./report";
import type { ProjectMemoryLike } from "./report";
import { hasPreviewImagery, previewImages, renderPreviewHtml } from "./preview";
import { BUY_URL } from "./access";

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

const WITH_IMAGERY: Array<[string, string, string]> = [
  ["address", "postcode", "CR0 4HL"],
  ["discovery", "local_authority", "Croydon"],
  ["design", "design_status", "generated"],
  ["design", "design_program_label", "Gym / studio"],
  ["design", "design_target_use", "gym"],
  ["design", "design_total_floor_area_m2", "120"],
  ["design", "design_rooms_count", "3"],
  ["imagery", "imagery_exterior_status", "generated"],
  ["imagery", "imagery_exterior_url", "/project-images/25/exterior.jpg"],
  ["imagery", "imagery_interior_status", "generated"],
  ["imagery", "imagery_interior_url", "/project-images/25/interior.jpg"],
  ["imagery", "imagery_streetview_status", "embed"],
  ["imagery", "imagery_streetview_embed_url", "https://www.google.com/maps?q=78%20Godson%20Road&output=svembed"],
  // Full-report-only facts that must NOT leak into the preview:
  ["feasibility", "refurbishment_cost_range_low", "35000"],
  ["compliance", "verdict_note", "Change of use permission required"],
  ["report", "report_generated", "yes"],
];

describe("hasPreviewImagery / previewImages", () => {
  test("true when generated exterior/interior renders exist", () => {
    expect(hasPreviewImagery(memory(WITH_IMAGERY))).toBe(true);
    expect(previewImages(memory(WITH_IMAGERY))).toEqual([
      { view: "exterior", previewUrl: "/project-images/25/exterior.preview.jpg" },
      { view: "interior", previewUrl: "/project-images/25/interior.preview.jpg" },
    ]);
  });
  test("false when renders exist but were not generated", () => {
    const m = memory([
      ["imagery", "imagery_exterior_status", "skipped"],
      ["imagery", "imagery_exterior_url", "/project-images/25/exterior.jpg"],
    ]);
    expect(hasPreviewImagery(m)).toBe(false);
    expect(previewImages(m)).toEqual([]);
  });
  test("false when no imagery facts at all", () => {
    expect(hasPreviewImagery(memory([["design", "design_status", "generated"]]))).toBe(false);
  });
  test("never rewrites a URL that does not match the project-images pattern", () => {
    const m = memory([
      ["imagery", "imagery_exterior_status", "generated"],
      ["imagery", "imagery_exterior_url", "https://example.com/clean.jpg"],
    ]);
    expect(previewImages(m)).toEqual([]);
  });
});

describe("renderPreviewHtml — the preview page", () => {
  const html = renderPreviewHtml(memory(WITH_IMAGERY))!;

  test("returns a page (not null) when generated imagery exists", () => {
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(1000);
  });

  test("contains the CSS watermark overlay class and text", () => {
    expect(html).toContain('class="watermark"');
    expect(html).toContain("ATLAS AI — PREVIEW");
    // Watermark sits inside a position:relative figure so screenshots capture it.
    expect(html).toContain("position:relative");
    expect(html).toContain("position:absolute");
  });

  test("links to BUY_URL with an explicit unlock CTA", () => {
    expect(html).toContain(BUY_URL);
    expect(html).toContain("Unlock full report");
  });

  test("embeds the inline payment-gate script (click/contextmenu/drag/select)", () => {
    expect(html).toContain("window.location.href");
    expect(html).toContain('addEventListener("click", go)');
    expect(html).toContain('addEventListener("contextmenu", go)');
    expect(html).toContain('addEventListener("dragstart", go)');
    expect(html).toContain('addEventListener("selectstart", go)');
    expect(html).toContain("figure.preview-media");
    expect(html).toContain("draggable=\"false\"");
  });

  test("shows the watermarked preview image URLs — never the clean full-res files", () => {
    expect(html).toContain("/project-images/25/exterior.preview.jpg");
    expect(html).toContain("/project-images/25/interior.preview.jpg");
    expect(html).not.toContain("/project-images/25/exterior.jpg");
    expect(html).not.toContain("/project-images/25/interior.jpg");
  });

  test("shows the public Google Street View embed when recorded", () => {
    expect(html).toContain("www.google.com/maps?q=78%20Godson%20Road");
    expect(html).toContain("output=svembed");
    expect(html).toContain("Street View");
  });

  test("keeps the teaser honest and brief — no financials, compliance verdict or analysis", () => {
    expect(html).toContain("78 Godson Road, Croydon");
    expect(html).toContain("Gym / studio");
    expect(html).toContain("CR0 4HL");
    expect(html).toContain("Croydon");
    expect(html).not.toContain("refurbishment_cost_range_low");
    expect(html).not.toContain("verdict_note");
    expect(html).not.toContain("Disclaimer");
    expect(html).not.toContain("Feasibility");
  });

  test("returns null when there is no generated output to preview", () => {
    expect(renderPreviewHtml(memory([]))).toBeNull();
    expect(renderPreviewHtml(memory([["design", "design_status", "generated"]]))).toBeNull();
    expect(renderPreviewHtml(memory([["imagery", "imagery_exterior_status", "skipped"]]))).toBeNull();
  });
});

describe("full report (token path) is unchanged", () => {
  test("renders the complete report without watermark, gate script or BUY_URL", () => {
    const html = renderReportHtml(memory(WITH_IMAGERY));
    // Full analysis content present:
    expect(html).toContain("78 Godson Road, Croydon");
    expect(html).toContain("Feasibility");
    // Clean full-res image paths (the route appends ?token= at serve time):
    expect(html).toContain("/project-images/25/exterior.jpg");
    expect(html).toContain("/project-images/25/interior.jpg");
    // No preview machinery leaks into the paid report:
    expect(html).not.toContain("watermark");
    expect(html).not.toContain("preview-media");
    expect(html).not.toContain("ATLAS AI — PREVIEW");
    expect(html).not.toContain(BUY_URL);
    expect(html).not.toContain("window.location.href");
    expect(html).not.toContain("contextmenu");
  });
});
