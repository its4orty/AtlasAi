import { createFileRoute } from "@tanstack/react-router";
import { getProjectMemory } from "~/pipeline";
import { renderReportHtml } from "~/report";

/**
 * GET /report/:id — server-rendered, printable feasibility report.
 * Renders the full HTML document from stored project memory (facts + sources)
 * via src/report.ts — no content is invented at request time; the report step
 * of the pipeline already recorded the artifact metadata in project memory.
 */
export const Route = createFileRoute("/report/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = String(params?.id ?? "");
        if (!/^\d+$/.test(id)) {
          return new Response("invalid project id", {
            status: 400,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        if (!process.env.DATABASE_URL) {
          return new Response("report unavailable", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        try {
          const memory = await getProjectMemory(id);
          const html = renderReportHtml(memory);
          return new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (message === "not found") {
            return new Response("project not found", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return new Response("report unavailable", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      },
    },
  },
});
