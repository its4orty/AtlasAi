import { createFileRoute } from "@tanstack/react-router";
import { demoDimensionedCadModel, renderCadSvg, renderDxf } from "~/cad";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { extractPdfDimensions, modelFromDimensions } from "~/cad-dimensions";
import { accurateCadLockedResponse, accurateCadUnlocked } from "~/cad-access";
import { modelFromSurveyDimensions, validateSurveyDimensions, selectCadTier } from "~/surveyor";

export const Route = createFileRoute("/api/cad")({ server: { handlers: {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") || "17";
    const format = url.searchParams.get("format") === "svg" ? "svg" : "dxf";
    if (!await accurateCadUnlocked(projectId)) return accurateCadLockedResponse();
    let model = demoDimensionedCadModel();
    if (process.env.DATABASE_URL) {
      await ensureSchema();
      const surveyRows = await sql()`SELECT value FROM facts WHERE project_id=${projectId} AND category='cad' AND key='surveyor_dimensions' ORDER BY id DESC LIMIT 1`;
      let hasSurveyor = false;
      if (surveyRows.length) {
        try { const input = JSON.parse(String(surveyRows[0].value)); const error = validateSurveyDimensions(input); if (!error) { model = modelFromSurveyDimensions(input); hasSurveyor = true; } } catch { /* malformed append-only fact is ignored */ }
      }
      const docs = await sql()`SELECT filename,path FROM documents WHERE project_id=${projectId} ORDER BY id DESC`;
      let hasClientDocument = false;
      if (!hasSurveyor) for (const doc of docs) {
        if (!String(doc.mime ?? "application/pdf").includes("pdf") && !String(doc.filename).toLowerCase().endsWith(".pdf")) continue;
        try {
          const dimensions = await extractPdfDimensions(String(doc.path), String(doc.filename));
          if (dimensions.length) { model = modelFromDimensions(dimensions); hasClientDocument = true; break; }
        } catch { /* unavailable/unreadable source remains the honest demo model */ }
      }
      // Keep tier determination explicit for auditing and future callers.
      selectCadTier(hasSurveyor, hasClientDocument);
    }
    if (format === "svg") return new Response(renderCadSvg(model), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
    return new Response(renderDxf(model), { headers: { "content-type": "application/dxf", "content-disposition": `attachment; filename="atlas-accurate-cad-${projectId}.dxf"`, "cache-control": "no-store" } });
  },
} } });
