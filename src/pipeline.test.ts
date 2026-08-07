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
  test("CEPC: reads floor area from technical_information.floor_area when top level has none", () => {
    // 202 London Rd Croydon style: non-domestic cert with area only inside
    // technical_information, and a register summary row with NO floor_area.
    const cert = { technical_information: { floor_area: 74, building_level: "Level 3" } };
    expect(epcAreaFromCertificateOrRegister(cert, { address_line_1: "202 London Road", postcode: "CR0 2TE" })).toEqual({ areaM2: 74, fromRegister: false });
  });
  test("CEPC: technical_information.total_floor_area variant is read", () => {
    expect(epcAreaFromCertificateOrRegister({ technical_information: { total_floor_area: 120 } }, { floorArea: 90 })).toEqual({ areaM2: 120, fromRegister: false });
  });
  test("CEPC: technical_information.gross_internal_area variant is read", () => {
    expect(epcAreaFromCertificateOrRegister({ technical_information: { gross_internal_area: "95.5" } }, { floorArea: 90 })).toEqual({ areaM2: 95.5, fromRegister: false });
  });
  test("CEPC: SBEM building_level alone is not an area — falls back to the register row", () => {
    // building_level / building_complexity is the SBEM assessment complexity,
    // NOT a storey count or an area; it must never be read as either.
    const cert = { technical_information: { building_level: "Level 3" }, building_complexity: "Level 3" };
    expect(epcAreaFromCertificateOrRegister(cert, { floorArea: 65 })).toEqual({ areaM2: 65, fromRegister: true });
  });
  test("CEPC: fallback to register row still works when certificate has technical_information but no area", () => {
    const cert = { technical_information: { hec_rating: 22 }, current_energy_efficiency_band: "C" };
    expect(epcAreaFromCertificateOrRegister(cert, { total_floor_area: 74 })).toEqual({ areaM2: 74, fromRegister: true });
  });
});
