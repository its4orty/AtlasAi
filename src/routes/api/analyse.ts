import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { runPipeline } from "~/pipeline";
/**
 * POST /api/analyse — start (or re-run) an analysis.
 * Body: { address: string } — creates a project and runs the full pipeline.
 * Body: { projectId: string } — re-runs the pipeline for an existing project
 * (e.g. after uploading documents) so the intelligence step can consume the
 * new evidence.
 */
export const Route = createFileRoute("/api/analyse")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid request" }, { status: 400 });
        }
        const obj = (typeof body === "object" && body !== null ? body : {}) as {
          address?: unknown;
          projectId?: unknown;
        };
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "analysis unavailable" }, { status: 503 });
        }
        try {
          const projectId = typeof obj.projectId === "string" ? obj.projectId.trim() : "";
          if (projectId) {
            const db = sql();
            const [proj] = await db`SELECT address FROM projects WHERE id = ${projectId}`;
            if (!proj) return Response.json({ error: "project not found" }, { status: 404 });
            const result = await runPipeline(String(proj.address), projectId);
            return Response.json({ ok: true, ...result });
          }
          const address =
            typeof obj.address === "string"
              ? obj.address.trim().replace(/\s+/g, " ")
              : "";
          if (address.length < 8) {
            return Response.json({ error: "please enter a full property address" }, { status: 400 });
          }
          const result = await runPipeline(address);
          return Response.json({ ok: true, ...result });
        } catch {
          return Response.json({ error: "analysis failed" }, { status: 500 });
        }
      },
    },
  },
});
