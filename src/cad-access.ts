import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";

/** Append-only project facts: the last row for a key is authoritative. */
export async function accurateCadUnlocked(projectId: string): Promise<boolean> {
  await ensureSchema();
  const rows = await sql()`SELECT value FROM facts WHERE project_id = ${projectId} AND key = 'accurate_cad_unlocked' ORDER BY id DESC LIMIT 1`;
  return rows.length > 0 && String(rows[0].value).toLowerCase() === "true";
}

export function paymentLink(): string | null {
  const value = process.env.CAD_PAYMENT_LINK?.trim();
  return value || null;
}

export function accurateCadLockedResponse(): Response {
  return Response.json({ error: "Accurate CAD is a paid add-on", purchase_url: paymentLink(), message: paymentLink() ? `Accurate CAD is a paid add-on; purchase at ${paymentLink()}` : "Accurate CAD is a paid add-on; payment link not configured" }, { status: 423, headers: { "cache-control": "no-store" } });
}

/** Release-token pattern: TEST_TOKEN or ADMIN_TOKEN, or the project's release token. */
export async function canReleaseProject(projectId: string, supplied: string | null): Promise<boolean> {
  if (!supplied) return false;
  const token = supplied.trim();
  if (process.env.TEST_TOKEN?.trim() === token || process.env.ADMIN_TOKEN?.trim() === token) return true;
  await ensureSchema();
  const rows = await sql()`SELECT 1 FROM projects WHERE id = ${projectId} AND release_token = ${token} LIMIT 1`;
  return rows.length > 0;
}
