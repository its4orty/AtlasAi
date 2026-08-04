import { describe, expect, test } from "bun:test";
import { isConfirmedByLatestDecision } from "./confirm";

describe("confirmation hard gate", () => {
  test("no decision ever -> not confirmed", () => {
    expect(isConfirmedByLatestDecision(null)).toBe(false);
    expect(isConfirmedByLatestDecision(undefined)).toBe(false);
  });
  test("a yes decision -> confirmed", () => {
    expect(isConfirmedByLatestDecision("yes")).toBe(true);
  });
  test("a pin correction after a yes -> NOT confirmed (gate closes again)", () => {
    expect(isConfirmedByLatestDecision("pin:51.353,-0.0995")).toBe(false);
  });
  test("a no decision -> not confirmed", () => {
    expect(isConfirmedByLatestDecision("no")).toBe(false);
  });
  test("a fresh yes after a pin -> confirmed again", () => {
    expect(isConfirmedByLatestDecision("yes")).toBe(true);
  });
});
