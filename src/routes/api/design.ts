import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { runDesignStep } from "~/design";

/**
 * POST /api/design — generate a concept design ("convert to X") for an existing
 * project. Body: { projectId: string, targetUse: string }.
 * Reads the space facts already in project memory (intelligence step), plans a
 * zoning concept for the target use and writes design facts + a user decision
 * into project memory. The CAD-style SVG concept is rendered in the report.
 */
export const Route = createFileRoute("/api/design")({
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
          projectId?: unknown;
          targetUse?: unknown;
        };
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "design unavailable" }, { status: 503 });
        }
        const projectId = typeof obj.projectId === "string" ? obj.projectId.trim() : "";
        const targetUse = typeof obj.targetUse === "string" ? obj.targetUse.trim().replace(/\s+/g, " ") : "";
        if (!/^\d+$/.test(projectId)) {
          return Response.json({ error: "invalid project id" }, { status: 400 });
        }
        if (targetUse.length < 2 || targetUse.length > 80) {
          return Response.json({ error: "please enter a target use (e.g. barber shop)" }, { status: 400 });
        }
        try {
          const db = sql();
          const result = await runDesignStep(db, projectId, targetUse);
          return Response.json({
            ok: true,
            projectId,
            targetUse,
            programLabel: result.design.programLabel,
            status: "done",
            rooms: result.design.rooms.length,
            allocatedM2: result.design.allocatedM2,
            circulationPct: result.design.circulationPct,
            note: result.note,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (message === "project not found") {
            return Response.json({ error: "project not found" }, { status: 404 });
          }
          return Response.json({ error: "design generation failed" }, { status: 500 });
        }
      },
    },
  },
});
