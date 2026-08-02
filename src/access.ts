import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
export const DEMO_PROJECT_ID = "17";
export const BUY_URL = "https://buy.stripe.com/aFa00j3gC94j9fkbAt9Ve01";
export async function canViewProject(projectId: string, token?: string | null): Promise<boolean> {
  if (projectId === DEMO_PROJECT_ID) return true;
  if (!token) return false;
  await ensureSchema();
  const rows = await sql()`SELECT 1 FROM projects WHERE id = ${projectId} AND release_token = ${token} LIMIT 1`;
  return rows.length > 0;
}
export function lockedResponse(): Response { return Response.json({ error: "This report is locked — purchase to unlock", purchase_url: BUY_URL }, { status: 403 }); }
