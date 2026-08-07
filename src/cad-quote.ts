export type CadQuoteInput = { projectId: string; name: string; email: string; docs: string[]; surveyVisit: string; notes: string };
export function validateCadQuote(input: Partial<CadQuoteInput>): string | null {
  if (!/^\d+$/.test(String(input.projectId ?? ""))) return "A numeric project id is required.";
  if (!String(input.name ?? "").trim()) return "Your name is required.";
  const email = String(input.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (!['yes','no','unsure'].includes(String(input.surveyVisit ?? 'unsure'))) return "Choose a survey option.";
  return null;
}
