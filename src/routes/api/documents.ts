import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/documents — attach an evidence document (floor plan, EPC, planning
 * drawing) to a project. Body: multipart/form-data with `projectId` and `file`.
 * The file is stored on disk; the `documents` row is consumed by the
 * intelligence pipeline step on the next analysis run.
 */
export const Route = createFileRoute("/api/documents")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!process.env.DATABASE_URL) {
          return Response.json({ error: "documents unavailable" }, { status: 503 });
        }
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ error: "invalid upload" }, { status: 400 });
        }
        const projectId = String(form.get("projectId") ?? "").trim();
        const file = form.get("file");
        if (!projectId || !file || typeof file === "string") {
          return Response.json({ error: "projectId and a file are required" }, { status: 400 });
        }
        if (file.size > MAX_BYTES) {
          return Response.json({ error: "file too large (max 25MB)" }, { status: 413 });
        }
        const db = sql();
        await ensureSchema();
        const [proj] = await db`SELECT id FROM projects WHERE id = ${projectId}`;
        if (!proj) return Response.json({ error: "project not found" }, { status: 404 });
        const dir = `/home/team/shared/data/projects/${projectId}`;
        await mkdir(dir, { recursive: true });
        const safeName =
          file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "document.pdf";
        const dest = path.join(dir, `${Date.now()}-${safeName}`);
        await writeFile(dest, Buffer.from(await file.arrayBuffer()));
        const [doc] = await db`
          INSERT INTO documents (project_id, filename, path, mime, size_bytes, status)
          VALUES (${projectId}, ${file.name}, ${dest}, ${file.type}, ${file.size}, 'uploaded')
          RETURNING id`;
        return Response.json({ ok: true, documentId: String(doc.id), filename: file.name });
      },
    },
  },
});
