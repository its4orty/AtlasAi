import { createFileRoute } from "@tanstack/react-router";
import { getProjectMemory } from "~/pipeline";

/**
 * GET /api/project?id=<id> — load a project's full memory (project row,
 * pipeline runs, facts with source names, sources, decisions). All timestamps
 * are coerced to ISO strings server-side before returning.
 */
export const Route = createFileRoute("/api/project")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!/^\d+$/.test(id)) {
          return Response.json({ error: "invalid project id" }, { status: 400 });
        }
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "project memory unavailable" }, { status: 503 });
        }
        try {
          return Response.json(await getProjectMemory(id));
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (message === "not found") {
            return Response.json({ error: "project not found" }, { status: 404 });
          }
          return Response.json({ error: "project memory unavailable" }, { status: 500 });
        }
      },
    },
  },
});
