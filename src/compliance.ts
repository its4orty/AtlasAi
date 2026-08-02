/**
 * England planning use-class screening. Rule source: Town and Country
 * Planning (Use Classes) Order 1987, as amended by the 2020 Order.
 * This is a screening aid, not a planning determination; some uses and
 * existing conditions require case-specific advice.
 */
export const TARGET_USE_CLASSES: Record<string, string> = {
  "barber shop": "E", cafe: "E", restaurant: "E", office: "E", retail: "E",
  gym: "E", "studio flat": "C3", workshop: "E(g)(iii)",
};
export const CURRENT_USE_CLASSES: Record<string, string> = {
  accountants: "E", accountant: "E", office: "E", offices: "E", shop: "E",
  retail: "E", cafe: "E", café: "E", restaurant: "E", gym: "E",
  workshop: "E(g)(iii)", dwelling: "C3", house: "C3", flat: "C3",
  residential: "C3", pub: "sui generis", takeaway: "sui generis",
  "betting shop": "sui generis", "hot food takeaway": "sui generis",
};
export function normaliseComplianceUse(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
export function targetUseClass(target: string): string | null {
  return TARGET_USE_CLASSES[normaliseComplianceUse(target)] ?? null;
}
export function currentUseClass(value: string): string | null {
  const v = normaliseComplianceUse(value);
  return CURRENT_USE_CLASSES[v] ?? null;
}
export function complianceVerdict(current: string | null, target: string | null) {
  const caveats = "Planning permission may still be needed for listed-building or conservation-area consent, conditions on the existing permission or other reasons. Building regulations apply to layout, fire safety and means-of-escape changes. Check with the local planning authority.";
  if (!current || !target) return { permission: "unknown", note: `Unknown — cannot determine without the current and proposed use class. ${caveats}`, confidence: 0.25 };
  if (current === target) return { permission: "no", note: `Both the current use (${current}) and proposed use (${target}) fall within the same use class. Changing between uses within the same class does not require planning permission. ${caveats}`, confidence: 0.85 };
  return { permission: "yes", note: `The current use (${current}) and proposed use (${target}) are different use classes, so planning permission is likely required for the change of use. ${caveats}`, confidence: 0.75 };
}
