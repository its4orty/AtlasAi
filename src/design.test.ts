import { describe, expect, test } from "bun:test";
import { deriveBuildingForm } from "./design";

const fact = (category: string, key: string, value: string) => ({ category, key, value });

describe("deriveBuildingForm", () => {
  test("identifies a unit from non-domestic B8 evidence", () => {
    expect(deriveBuildingForm("Unit 4 Mill Lane", [fact("epc", "epc_register_type", "non-domestic"), fact("epc", "epc_property_type", "Non-domestic"), fact("epc", "epc_use_class", "B8 Storage or Distribution"), fact("nearby", "nearby_use_class", "B8")]).form).toBe("industrial_unit");
  });
  test("returns unknown when unit and domestic house evidence conflict", () => {
    const form = deriveBuildingForm("Unit 4 Mill Lane", [fact("epc", "epc_register_type", "domestic"), fact("epc", "epc_property_type", "End-terrace house")]).form;
    expect(form).toBe("unknown");
    expect(form).not.toBe("industrial_unit");
    expect(form).not.toBe("house");
  });
  test("identifies a plain domestic house", () => {
    expect(deriveBuildingForm("244 High Street", [fact("epc", "epc_register_type", "domestic"), fact("epc", "epc_property_type", "End-terrace house")]).form).toBe("house");
  });
  test("is unknown without evidence", () => {
    expect(deriveBuildingForm("Some address", []).form).toBe("unknown");
  });
});

describe("latest-wins project facts", () => {
  test("latestFacts keeps the last row for each key", async () => {
    const { latestFacts } = await import("./design");
    expect(latestFacts([{ key: "epc_register_type", value: "domestic" }, { key: "x", value: "1" }, { key: "epc_register_type", value: "non-domestic" }])).toEqual([{ key: "epc_register_type", value: "non-domestic" }, { key: "x", value: "1" }]);
  });
  test("newer non-domestic evidence beats an old domestic register fact", () => {
    expect(deriveBuildingForm("Unit 4 Mill Lane", [fact("epc", "epc_register_type", "domestic"), fact("epc", "epc_property_type", "End-terrace house"), fact("epc", "epc_register_type", "non-domestic"), fact("epc", "epc_property_type", "B8 Storage or Distribution")]).form).toBe("industrial_unit");
  });
});
