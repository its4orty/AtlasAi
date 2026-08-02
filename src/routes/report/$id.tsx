import { createFileRoute } from "@tanstack/react-router";
import { getProjectMemory } from "~/pipeline";
import { renderReportHtml } from "~/report";
import { BUY_URL, canViewProject } from "~/access";
export const Route = createFileRoute("/report/$id")({ server: { handlers: { GET: async ({ params, request }) => {
  const id = String(params?.id ?? "");
  if (!/^\d+$/.test(id)) return new Response("invalid project id", { status: 400 });
  if (!process.env.DATABASE_URL) return new Response("report unavailable", { status: 503 });
  try {
    const token = new URL(request.url).searchParams.get("token");
    if (!(await canViewProject(id, token))) return new Response(`<!doctype html><html><head><title>Report locked</title></head><body style="font-family:system-ui;max-width:40rem;margin:15vh auto;padding:2rem"><h1>This report is locked</h1><p>Purchase to unlock this ATLAS AI Property Report.</p><p><a href="${BUY_URL}">Purchase and unlock report</a></p></body></html>`, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
    let html = renderReportHtml(await getProjectMemory(id));
    if (token && id !== "17") html = html.replace(/(\/project-images\/\d+\/[^"?]+)(["'])/g, `$1?token=${encodeURIComponent(token)}$2`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  } catch (err) { return new Response(err instanceof Error && err.message === "not found" ? "project not found" : "report unavailable", { status: err instanceof Error && err.message === "not found" ? 404 : 500 }); }
} } } });
