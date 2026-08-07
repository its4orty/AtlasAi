import { describe, expect, test } from "bun:test";
import { addressLines, epcAddressScore, selectBestEpcMatch, epcPropertyTypeText } from "./pipeline";

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

describe("EPC register selection (best match across both registers)", () => {
  const project = "202 London Road, Croydon CR0 2TE";
  const domesticRow = { addressLine1: "202", addressLine2: "LONDON ROAD", postcode: "CR0 2TE", certificateNumber: "8971-7229-6650-4215-8992" };
  const cepcRow = { addressLine1: "202 London Road", postcode: "CR0 2TE", certificateNumber: "9295-5271-3377-8023-9270" };
  test("202 London Rd: equal-scoring CEPC beats the domestic house cert (demo regression)", () => {
    // Both registers have a certificate at 202 London Rd (house EPC + restaurant
    // CEPC). The CEPC must win so the design is evidence-constrained to the
    // commercial unit, not the flat/house.
    const best = selectBestEpcMatch(project, [domesticRow], [cepcRow]);
    expect(best?.register).toBe("non-domestic");
    expect(String(best?.row.certificateNumber)).toBe("9295-5271-3377-8023-9270");
  });
  test("a plain house with no non-domestic cert stays domestic", () => {
    const best = selectBestEpcMatch("24 Mill Lane, Croydon CR0 4AA", [domesticRow], []);
    expect(best?.register).toBe("domestic");
  });
  test("a lower-scoring non-domestic row does not steal a domestic match", () => {
    // Non-domestic 204 is a different house number -> score 0; domestic 202 wins.
    const best = selectBestEpcMatch(project, [domesticRow], [{ addressLine1: "204", addressLine2: "LONDON ROAD", postcode: "CR0 2TE" }]);
    expect(best?.register).toBe("domestic");
  });
  test("no match at all returns null", () => {
    expect(selectBestEpcMatch("99 Nowhere Road, ZZ9 9ZZ", [], [])).toBeNull();
  });
});

describe("EPC property-type text", () => {
  test("CEPC property_type string passes through", () => {
    expect(epcPropertyTypeText("Restaurants and Cafes/Drinking Establishments/Takeaways")).toBe("Restaurants and Cafes/Drinking Establishments/Takeaways");
  });
  test("domestic dwelling_type {value, language} object is unwrapped", () => {
    expect(epcPropertyTypeText({ value: "Mid-floor flat", language: "1" })).toBe("Mid-floor flat");
  });
  test("numeric codes and absent values yield no text (honest absence)", () => {
    expect(epcPropertyTypeText(2)).toBe("");
    expect(epcPropertyTypeText(null)).toBe("");
    expect(epcPropertyTypeText(undefined)).toBe("");
  });
});
