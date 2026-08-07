import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { canReleaseProject } from "~/cad-access";

export const Route = createFileRoute("/api/cad-unlock")({ server: { handlers: {
  POST: async ({ request }) => {
    const body = await request.json().catch(() => ({})) as { projectId?: string };
    const projectId = String(body.projectId ?? "");
    if (!/^\d+$/.test(projectId)) return Response.json({ error: "projectId must be numeric" }, { status: 400 });
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || new URL(request.url).searchParams.get("token");
    if (!await canReleaseProject(projectId, supplied)) return Response.json({ error: "unauthorised" }, { status: 401 });
    await ensureSchema();
    await sql()`INSERT INTO facts (project_id, category, key, value, confidence, source_id) VALUES (${projectId}, 'cad', 'accurate_cad_unlocked', 'true', 1.0, NULL)`;
    return Response.json({ projectId, accurate_cad_unlocked: true, provenance: { source: "admin-release", confidence: 1.0 } });
  },
} } });
