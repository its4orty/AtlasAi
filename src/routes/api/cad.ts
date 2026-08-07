import { createFileRoute } from "@tanstack/react-router";
import { demoDimensionedCadModel, renderCadSvg, renderDxf } from "~/cad";
import { accurateCadLockedResponse, accurateCadUnlocked } from "~/cad-access";

export const Route = createFileRoute("/api/cad")({ server: { handlers: {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") || "17";
    const format = url.searchParams.get("format") === "svg" ? "svg" : "dxf";
    if (!await accurateCadUnlocked(projectId)) return accurateCadLockedResponse();
    const model = demoDimensionedCadModel();
    if (format === "svg") return new Response(renderCadSvg(model), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
    return new Response(renderDxf(model), { headers: { "content-type": "application/dxf", "content-disposition": `attachment; filename="atlas-accurate-cad-${projectId}.dxf"`, "cache-control": "no-store" } });
  },
} } });
