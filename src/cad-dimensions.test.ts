import { describe, expect, test } from "bun:test";
import { modelFromDimensions, parseDimensions } from "./cad-dimensions";
describe("client document dimension parser", () => {
  test("parses metric formats and ignores garbage", () => {
    const d = parseDimensions("Plan: 5.2m x 5200mm, height 3.45m. Ref 12345", "lease.pdf", 2);
    expect(d.map(x => x.valueMm)).toEqual([5200, 5200, 3450]);
    expect(parseDimensions("price 5200 and postcode CR0")).toHaveLength(0);
  });
  test("parses feet and inches", () => expect(parseDimensions("frontage 4' 2\"", "plan.pdf")[0].valueMm).toBe(1270));
  test("preserves page/source confidence", () => { const d = parseDimensions("width: 4m", "floor-plan.pdf", 3)[0]; expect(d.sourceRef).toBe("floor-plan.pdf"); expect(d.page).toBe(3); expect(d.confidence).toBeGreaterThan(0); });
  test("populates accurate model only from parsed dimensions", () => { const m = modelFromDimensions(parseDimensions("overall width 5.2m, depth 3.45m", "client-plan.pdf")); expect(m.dimensions.map(d => d.valueMm)).toEqual([5200,3450]); expect(m.rooms[0].areaM2).toBe(17.94); expect(m.provenance.sourceType).toBe("client_document"); expect(m.titleBlock.revision).toBe("DOCUMENT-EXTRACTED"); });
  test("missing dimensions remain absent", () => expect(modelFromDimensions([]).dimensions).toHaveLength(0));
});
