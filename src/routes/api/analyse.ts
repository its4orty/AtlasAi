import { createFileRoute } from "@tanstack/react-router";
import { runPipeline } from "~/pipeline";

/**
 * POST /api/analyse — start an analysis.
 * Body: { address: string }. Creates a project row and runs the full pipeline
 * (normalise, discovery and collection are real; intelligence/feasibility/
 * report are stubs that record themselves as `pending`). Returns the project
 * id and the ordered step statuses.
 */
export const Route = createFileRoute("/api/analyse")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid address" }, { status: 400 });
        }
        const address =
          typeof body === "object" && body !== null && "address" in body
            ? String((body as { address?: unknown }).address).trim().replace(/\s+/g, " ")
            : "";
        if (address.length < 8) {
          return Response.json({ error: "please enter a full property address" }, { status: 400 });
        }
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "analysis unavailable" }, { status: 503 });
        }
        try {
          const result = await runPipeline(address);
          return Response.json({ ok: true, ...result });
        } catch {
          return Response.json({ error: "analysis failed" }, { status: 500 });
        }
      },
    },
  },
});
