import { describe, expect, test } from "bun:test";
import { modelFromSurveyDimensions, validateSurveyDimensions, SURVEYOR_ACCURACY, selectCadTier } from "./surveyor";
describe("surveyor CAD channel", () => {
  test("validates positive millimetres and sensible bounds", () => {
    expect(validateSurveyDimensions({ widthMm: 0, depthMm: 5000 })).toContain("widthMm");
    expect(validateSurveyDimensions({ widthMm: 100001, depthMm: 5000 })).toContain("widthMm");
    expect(validateSurveyDimensions({ widthMm: 8000, depthMm: 5000 })).toBeNull();
  });
  test("builds professional provenance without inventing dimensions", () => {
    const m = modelFromSurveyDimensions({ widthMm: 8123, depthMm: 4567, notes: "field sheet" }, "2026-01-01T00:00:00.000Z");
    expect(m.provenance.sourceType).toBe("surveyor");
    expect(m.provenance.declaredAccuracy).toBe(SURVEYOR_ACCURACY);
    expect(m.provenance.confidence).toBe(1);
    expect(m.dimensions.map(d => d.valueMm)).toEqual([8123, 4567]);
    expect(m.titleBlock.revision).toBe("SURVEYOR-ENTRY");
  });
  test("surveyor takes precedence over document and demo", () => {
    expect(selectCadTier(true, true)).toBe("surveyor");
    expect(selectCadTier(false, true)).toBe("client_document");
    expect(selectCadTier(false, false)).toBe("demo");
  });
});
