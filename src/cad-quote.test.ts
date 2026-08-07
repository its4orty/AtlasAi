import { describe, expect, test } from "bun:test";
import { cadQuoteStateHtml, validateCadQuote } from "./cad-quote";
import { renderReportHtml, type ProjectMemoryLike } from "./report";

function memory(facts: Array<[string, string, string, number]>, id = "17"): ProjectMemoryLike {
  return {
    project: { id, address: "244 London Road, Croydon CR0 2XZ", status: "complete", created_at: null, updated_at: null },
    runs: [],
    facts: facts.map(([category, key, value, confidence], i) => ({
      id: String(i + 1), category, key, value, confidence, source_id: null, source_name: null,
    })),
    sources: [],
    decisions: [],
  };
}

describe("validateCadQuote", () => {
  test("valid input passes", () => {
    expect(validateCadQuote({ projectId: "17", name: "Ann Owner", email: "ann@example.com", docs: ["lease"], surveyVisit: "yes", notes: "" })).toBeNull();
  });
  test("missing name is rejected with the right message", () => {
    expect(validateCadQuote({ projectId: "17", name: "  ", email: "ann@example.com", surveyVisit: "yes" })).toBe("Your name is required.");
  });
  test("bad email is rejected with the right message", () => {
    expect(validateCadQuote({ projectId: "17", name: "Ann", email: "not-an-email", surveyVisit: "yes" })).toBe("Enter a valid email address.");
  });
  test("non-numeric project id is rejected with the right message", () => {
    expect(validateCadQuote({ projectId: "abc", name: "Ann", email: "ann@example.com", surveyVisit: "yes" })).toBe("A numeric project id is required.");
  });
  test("bad survey option is rejected with the right message", () => {
    expect(validateCadQuote({ projectId: "17", name: "Ann", email: "ann@example.com", surveyVisit: "maybe" })).toBe("Choose a survey option.");
  });
});

describe("cad quote state machine (in isolation — route handlers need no DB for the transition logic)", () => {
  test("locked state shows the quote form with the projectId pre-filled", () => {
    const html = cadQuoteStateHtml({ projectId: "17", unlocked: false, requested: false });
    expect(html).toContain("Locked — Accurate CAD is a quoted add-on");
    expect(html).toContain('<form id="quote"');
    expect(html).toContain('name="projectId" value="17"');
    expect(html).toContain("Request a quote for Accurate CAD");
    expect(html).not.toContain("Accurate CAD unlocked");
  });
  test("requested state says quote requested and hides the form", () => {
    const html = cadQuoteStateHtml({ projectId: "17", unlocked: false, requested: true });
    expect(html).toContain("Quote requested");
    expect(html).not.toContain("<form");
  });
  test("unlocked state shows download links and hides the form", () => {
    const html = cadQuoteStateHtml({ projectId: "17", unlocked: true, requested: false });
    expect(html).toContain("Accurate CAD unlocked");
    expect(html).toContain('href="/api/cad?projectId=17&format=svg"');
    expect(html).toContain('download href="/api/cad?projectId=17"');
    expect(html).not.toContain("<form");
  });
});

describe("report page Accurate CAD section", () => {
  test("project 17 shows the quoted add-on section (locked, form pre-filled) even with no cad facts yet", () => {
    const html = renderReportHtml(memory([]));
    expect(html).toContain("Accurate CAD — quoted add-on");
    expect(html).toContain('<form id="quote"');
    expect(html).toContain('name="projectId" value="17"');
    expect(html).toContain("Request a quote for Accurate CAD");
  });
  test("requested state renders 'quote requested' and no form", () => {
    const html = renderReportHtml(memory([["cad", "cad_quote_requested", "true", 1]]));
    expect(html).toContain("Quote requested");
    expect(html).not.toContain('<form id="quote"');
  });
  test("unlocked state renders download links", () => {
    const html = renderReportHtml(memory([["cad", "accurate_cad_unlocked", "true", 1]]));
    expect(html).toContain("Accurate CAD unlocked");
    expect(html).toContain("Download Accurate CAD DXF");
    expect(html).not.toContain('<form id="quote"');
  });
  test("latest-wins: a stale requested=false row never overrides a later requested=true row", () => {
    const html = renderReportHtml(memory([
      ["cad", "cad_quote_requested", "false", 1],
      ["cad", "cad_quote_requested", "true", 1],
    ]));
    expect(html).toContain("Quote requested");
    expect(html).not.toContain('<form id="quote"');
  });
  test("never renders the quote section content into the free schematic tier", () => {
    const html = renderReportHtml(memory([["design", "design_status", "generated", 1]]));
    expect(html).toContain("Accurate CAD — quoted add-on"); // add-on section present…
    expect(html).toContain("Request a quote for Accurate CAD"); // …with the form, not a fake unlock
    expect(html).not.toContain("Accurate CAD unlocked");
  });
});
