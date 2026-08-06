import { describe, expect, test } from "bun:test";
import { addressLines, epcAddressScore } from "./pipeline";

describe("EPC address evidence matching", () => {
  const project = "Unit 4 mill lane croydon CR0 4AA";
  const nonDomestic = { addressLine1: "Unit 4", addressLine2: "JAMES BUSINESS PARK", addressLine3: "MILL LANE", postcode: "CR0 4AA" };

  test("matches unit and street across address lines, beating a domestic house", () => {
    expect(addressLines(nonDomestic)).toContain("MILL LANE");
    expect(epcAddressScore(project, nonDomestic, "non-domestic")).toBe(1);
    expect(epcAddressScore(project, { addressLine1: "End-terrace house", addressLine2: "MILL LANE", postcode: "CR0 4AA" }, "domestic")).toBe(0);
  });

  test("rejects a different unit number", () => {
    expect(epcAddressScore(project, { addressLine1: "Unit 7", addressLine2: "MILL LANE" }, "non-domestic")).toBe(0);
  });

  test("does not match a same-street candidate with no identifier", () => {
    expect(epcAddressScore(project, { addressLine1: "MILL LANE", postcode: "CR0 4AA" }, "non-domestic")).toBeLessThan(0.7);
  });

  test("requires agreeing plain house numbers", () => {
    expect(epcAddressScore("244 high street croydon", { addressLine1: "244", addressLine2: "HIGH STREET", addressLine3: "CROYDON" }, "domestic")).toBe(1);
    expect(epcAddressScore("244 high street croydon", { addressLine1: "246", addressLine2: "HIGH STREET", addressLine3: "CROYDON" }, "domestic")).toBe(0);
  });
  test("a house on Mill Lane matches the domestic register (MILL is a street name, not a commercial token)", () => {
    expect(epcAddressScore("24 mill lane croydon", { addressLine1: "24", addressLine2: "MILL LANE", postcode: "CR0 4AA" }, "domestic")).toBe(1);
  });
  test("regression: Unit 4 on Mill Lane still matches the non-domestic register via the UNIT token", () => {
    expect(epcAddressScore("unit 4 mill lane croydon", { addressLine1: "Unit 4", addressLine2: "JAMES BUSINESS PARK", addressLine3: "MILL LANE", postcode: "CR0 4AA" }, "non-domestic")).toBe(1);
  });
});

import { epcAreaFromCertificateOrRegister } from "./pipeline";
describe("EPC floor area fallback", () => {
  test("uses register summary area when certificate has no exact area", () => {
    expect(epcAreaFromCertificateOrRegister({ total_floor_area: null }, { floorArea: 65 })).toEqual({ areaM2: 65, fromRegister: true });
  });
  test("prefers certificate area", () => {
    expect(epcAreaFromCertificateOrRegister({ total_floor_area: 64 }, { floorArea: 65 })).toEqual({ areaM2: 64, fromRegister: false });
  });
});
