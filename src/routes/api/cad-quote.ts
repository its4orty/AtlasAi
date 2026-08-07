import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { validateCadQuote } from "~/cad-quote";

export const Route = createFileRoute("/api/cad-quote")({ server: { handlers: {
  GET: async ({ request }) => {
    const id = new URL(request.url).searchParams.get("projectId") || "";
    if (!/^\d+$/.test(id)) return Response.json({ error: "projectId must be numeric" }, { status: 400 });
    await ensureSchema();
    const rows = await sql()`SELECT key,value FROM facts WHERE project_id=${id} AND category='cad' ORDER BY id DESC`;
    const latest = new Map<string,string>(); for (const r of rows) if (!latest.has(String(r.key))) latest.set(String(r.key), String(r.value));
    return Response.json({ requested: latest.get("cad_quote_requested") === "true", unlocked: latest.get("accurate_cad_unlocked") === "true" });
  },
  POST: async ({ request }) => {
    const body = await request.json().catch(() => ({})) as Partial<CadQuoteInput>;
    const input = { projectId: String(body.projectId ?? ""), name: String(body.name ?? "").trim(), email: String(body.email ?? "").trim(), docs: Array.isArray(body.docs) ? body.docs.map(String).slice(0, 10) : [], surveyVisit: String(body.surveyVisit ?? "unsure"), notes: String(body.notes ?? "").trim().slice(0, 2000) };
    const error = validateCadQuote(input); if (error) return Response.json({ error }, { status: 400 });
    await ensureSchema();
    const source = await sql()`INSERT INTO sources (project_id,name,notes) VALUES (${input.projectId},'Client quote request','Source: client-quote-request; submitted ${new Date().toISOString()}') RETURNING id`;
    const sid = source[0].id;
    const add = async (key:string,value:string) => sql()`INSERT INTO facts (project_id,category,key,value,confidence,source_id) VALUES (${input.projectId},'cad',${key},${value},1.0,${sid})`;
    await add('cad_quote_requested','true'); await add('cad_quote_contact', JSON.stringify({ name: input.name, email: input.email })); await add('cad_quote_docs', JSON.stringify(input.docs)); await add('cad_quote_survey_visit', input.surveyVisit); await add('cad_quote_notes', input.notes);
    return Response.json({ ok: true, requested: true, provenance: { source: 'client-quote-request', confidence: 1.0, timestamp: new Date().toISOString() } });
  }
} } });
