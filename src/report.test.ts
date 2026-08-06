import { describe, expect, test } from "bun:test";
import { renderReportHtml, type ProjectMemoryLike } from "./report";
/**
 * Facts are append-only history: every re-run appends rows, so the same key
 * (e.g. design_zones) can hold stale values from earlier runs. The evidence
 * table must render ONLY the latest value per key — the state that actually
 * drives the report — never the historical rows.
 */
function memory(facts: Array<[string, string, string, number]>): ProjectMemoryLike {
  return {
    project: {
      id: "39",
      address: "Unit 4, Mill Lane, Croydon",
      status: "complete",
      created_at: null,
      updated_at: null,
    },
    runs: [],
    facts: facts.map(([category, key, value, confidence], i) => ({
      id: String(i + 1),
      category,
      key,
      value,
      confidence,
      source_id: null,
      source_name: null,
    })),
    sources: [],
    decisions: [],
  };
}
const OLD_ZONES = '[{"zone":"Shopfront / till","room":"OPEN PLAN","area_m2":6.2,"retained":false}]';
const NEW_ZONES = '[{"zone":"Reception / till point","room":"OPEN PLAN","area_m2":6.2,"retained":false}]';
const WITH_STALE_HISTORY: Array<[string, string, string, number]> = [
  // First (wrong) design run — must never appear in the report's evidence table.
  ["design", "design_status", "generated", 0.5],
  ["design", "design_zones", OLD_ZONES, 0.55],
  ["design", "design_allocated_m2", "46.9", 0.55],
  ["design", "building_form", "unknown", 0.5],
  ["design", "design_total_floor_area_m2", "65", 0.7],
  ["epc", "epc_register_type", "non-domestic", 1],
  ["epc", "epc_property_type", "Non-domestic", 1],
  ["epc", "epc_use_class", "B8 Storage or Distribution", 1],
  ["epc", "total_floor_area_m2", "65", 1],
  // Corrected re-run — the latest per key, the only state that should show.
  ["design", "design_zones", NEW_ZONES, 0.55],
  ["design", "building_form", "industrial_unit", 0.7],
];
describe("report evidence table shows current evidence only", () => {
  const html = renderReportHtml(memory(WITH_STALE_HISTORY));
  test("never renders the stale 'Shopfront / till' design from the earlier run", () => {
    expect(html.split("Shopfront / till").length - 1).toBe(0);
  });
  test("renders the corrected latest design and building form", () => {
    expect(html).toContain("Reception / till point");
    expect(html).toContain("Building form (evidence):</strong> industrial_unit");
    expect(html).toContain("Floor area used: 65");
  });
  test("keeps the latest fact even when both the old and new rows are low-confidence", () => {
    const rows = html.match(/<tr><td class="strong">design_zones<\/td>/g) ?? [];
    expect(rows.length).toBe(1);
    expect(html).not.toContain("Shopfront / till");
  });
});
