import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try { body = await request.json(); } catch { return Response.json({ error: "invalid email" }, { status: 400 }); }
        const email = typeof body === "object" && body !== null && "email" in body ? String((body as { email?: unknown }).email).trim().toLowerCase() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "invalid email" }, { status: 400 });
        if (!process.env.DATABASE_URL) return Response.json({ error: "waitlist unavailable" }, { status: 503 });
        try { const db = sql(); await db`CREATE TABLE IF NOT EXISTS waitlist (id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`; await db`INSERT INTO waitlist (email) VALUES (${email}) ON CONFLICT (email) DO NOTHING`; return Response.json({ ok: true }); }
        catch { return Response.json({ error: "waitlist unavailable" }, { status: 503 }); }
      },
    },
  },
});
