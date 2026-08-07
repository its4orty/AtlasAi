import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { validateSurveyDimensions, modelFromSurveyDimensions } from "~/surveyor";

export const Route = createFileRoute("/api/surveyor")({ server: { handlers: {
  POST: async ({ request }) => {
    const supplied = (request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || new URL(request.url).searchParams.get("token") || "").trim();
    if (!supplied || (process.env.TEST_TOKEN?.trim() !== supplied && process.env.ADMIN_TOKEN?.trim() !== supplied)) return Response.json({ error: "unauthorised" }, { status: 401 });
    let body: Record<string, unknown> = {};
    try {
      if ((request.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) body = Object.fromEntries((await request.formData()).entries());
      else body = await request.json();
    } catch { return Response.json({ error: "invalid request body" }, { status: 400 }); }
    const projectId = String(body.projectId ?? "").trim();
    if (!/^\d+$/.test(projectId)) return Response.json({ error: "projectId must be numeric" }, { status: 400 });
    let rooms: unknown = body.rooms;
    if (typeof rooms === "string") { try { rooms = JSON.parse(rooms || "[]"); } catch { return Response.json({ error: "rooms must be valid JSON" }, { status: 400 }); } }
    const input = { widthMm: Number(body.widthMm), depthMm: Number(body.depthMm), rooms, notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : undefined } as Parameters<typeof validateSurveyDimensions>[0];
    const error = validateSurveyDimensions(input); if (error) return Response.json({ error }, { status: 400 });
    await ensureSchema();
    const [project] = await sql()`SELECT id FROM projects WHERE id=${projectId}`;
    if (!project) return Response.json({ error: "Project not found" }, { status: 400 });
    const timestamp = new Date().toISOString();
    const source = await sql()`INSERT INTO sources (project_id,name,notes) VALUES (${projectId},'Professional measured survey',${`Source: surveyor-entry; recorded ${timestamp}`}) RETURNING id`;
    const value = JSON.stringify({ ...input, provenance: { sourceType: "surveyor", declaredAccuracy: "professional measured survey figures", confidence: 1.0, label: "surveyor-entry", timestamp } });
    await sql()`INSERT INTO facts (project_id,category,key,value,confidence,source_id) VALUES (${projectId},'cad','surveyor_dimensions',${value},1.0,${source[0].id})`;
    return Response.json({ ok: true, projectId, sourceType: "surveyor", declaredAccuracy: "professional measured survey figures", confidence: 1.0, timestamp });
  }
} } });

