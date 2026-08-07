import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";

/**
 * Owner quote-review page — lists every project with an active Accurate CAD
 * quote request (latest-wins on cad_quote_requested), the contact details,
 * documents held, survey-visit answer, notes, request timestamp (from the
 * source row), and the current accurate_cad_unlocked state. Token-gated with
 * the same env-token pattern the report route uses (TEST_TOKEN / ADMIN_TOKEN).
 * Unauthenticated requests get the honest locked stub and NEVER see the list.
 */
export const Route = createFileRoute("/admin/cad-quotes")({ server: { handlers: { GET: async ({ request }) => {
  const url = new URL(request.url);
  const supplied = (request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "").trim();
  const adminOk = supplied !== "" && (process.env.TEST_TOKEN?.trim() === supplied || process.env.ADMIN_TOKEN?.trim() === supplied);
  const esc = (v: unknown): string => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const locked = (): Response =>
    new Response(`<!doctype html><html><head><title>Locked</title></head><body style="font-family:system-ui;max-width:40rem;margin:15vh auto;padding:2rem"><h1>This page is locked</h1><p>Owner token required to review Accurate CAD quote requests.</p></body></html>`, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (!adminOk) return locked();
  if (!process.env.DATABASE_URL) return new Response("admin page unavailable", { status: 503 });
  await ensureSchema();
  const rows = await sql()`SELECT f.id, f.project_id, f.value, f.source_id FROM facts f WHERE f.category='cad' AND f.key='cad_quote_requested' ORDER BY f.id`;
  const latest = new Map<string, { value: string; source_id: string | null }>();
  for (const r of rows) latest.set(String(r.project_id), { value: String(r.value), source_id: r.source_id === null || r.source_id === undefined ? null : String(r.source_id) });
  const ids = [...latest.keys()].filter((pid) => (latest.get(pid)?.value ?? "").toLowerCase() === "true");
  if (ids.length === 0) {
    const html = `<!doctype html><html><head><title>Accurate CAD quote requests</title></head><body style="font-family:system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem"><h1>Accurate CAD — quote requests</h1><p>No quote requests yet. Requests submitted via /api/cad-quote appear here for the owner to review and price.</p></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const detail = await sql()`SELECT f.project_id, p.address AS addr, f.key, f.value, f.source_id, s.fetched_at AS src_fetched FROM facts f JOIN projects p ON p.id = f.project_id LEFT JOIN sources s ON s.id = f.source_id WHERE f.category='cad' AND f.project_id = ANY(${ids}) ORDER BY f.id`;
  type Proj = { address: string; facts: Map<string, { value: string; srcFetched: string | null }>; requestedFetched: string | null };
  const per = new Map<string, Proj>();
  for (const r of detail) {
    const pid = String(r.project_id);
    let p = per.get(pid);
    if (!p) { p = { address: String(r.addr ?? ""), facts: new Map(), requestedFetched: null }; per.set(pid, p); }
    const srcFetched = r.src_fetched === null || r.src_fetched === undefined ? null : String(r.src_fetched);
    p.facts.set(String(r.key), { value: String(r.value), srcFetched });
    if (String(r.key) === "cad_quote_requested" && srcFetched) p.requestedFetched = srcFetched;
  }
  const fmtDate = (iso: string | null): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const contactOf = (raw: string | undefined): string => {
    if (!raw) return "—";
    try { const c = JSON.parse(raw) as { name?: string; email?: string }; return `${esc(c.name ?? "—")} · ${esc(c.email ?? "—")}`; } catch { return esc(raw); }
  };
  const docsOf = (raw: string | undefined): string => {
    if (!raw) return "—";
    try { const a = JSON.parse(raw) as string[]; return a.length ? esc(a.join(", ")) : "—"; } catch { return esc(raw); }
  };
  const body = [...per.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([pid, p]) => {
      const f = p.facts;
      const unlocked = (f.get("accurate_cad_unlocked")?.value ?? "").toLowerCase() === "true";
      return `<tr><td class="strong">#${esc(pid)}</td><td>${esc(p.address)}</td><td>${contactOf(f.get("cad_quote_contact")?.value)}</td><td>${docsOf(f.get("cad_quote_docs")?.value)}</td><td>${esc(f.get("cad_quote_survey_visit")?.value ?? "—")}</td><td>${esc(f.get("cad_quote_notes")?.value ?? "—")}</td><td>${fmtDate(p.requestedFetched)}</td><td>${unlocked ? '<span style="background:#e8efec;border:1px solid #9db8ab;color:#2e5c46;padding:2px 8px;border-radius:3px;font-weight:700">UNLOCKED</span>' : '<span style="background:#f7efe3;border:1px solid #c98a4a;color:#8a5a1e;padding:2px 8px;border-radius:3px;font-weight:700">locked — not released</span>'}</td></tr>`;
    })
    .join("");
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Accurate CAD — quote requests (owner)</title></head><body style="font-family:system-ui;max-width:72rem;margin:2rem auto;padding:0 1rem;color:#172033"><h1>Accurate CAD — quote requests</h1><p>Projects with an active quote request (<code>cad_quote_requested=true</code>, latest-wins). Review each request, set the quoted amount, and release the files via <code>POST /api/cad-unlock</code> once the quoted amount is paid.</p><table style="border-collapse:collapse;width:100%;font-size:13px;background:#fff;border:1px solid #ccd6df"><thead><tr style="text-align:left"><th style="padding:10px;border-bottom:1px solid #ccd6df">Project</th><th style="padding:10px;border-bottom:1px solid #ccd6df">Address</th><th style="padding:10px;border-bottom:1px solid #ccd6df">Contact</th><th style="padding:10px;border-bottom:1px solid #ccd6df">Documents held</th><th style="padding:10px;border-bottom:1px solid #ccd6df">Survey visit</th><th style="padding:10px;border-bottom:1px solid #ccd6df">Notes</th><th style="padding:10px;border-bottom:1px solid #ccd6df">Requested at</th><th style="padding:10px;border-bottom:1px solid #ccd6df">CAD state</th></tr></thead><tbody>${body}</tbody></table><p style="color:#555;font-size:12px">Request timestamp taken from the source row of the latest <code>cad_quote_requested</code> fact.</p></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
} } } });
