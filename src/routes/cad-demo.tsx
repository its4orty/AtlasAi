import { createFileRoute } from "@tanstack/react-router";
import { demoDimensionedCadModel, renderCadSvg } from "~/cad";
import { accurateCadUnlocked, paymentLink } from "~/cad-access";
import { cadQuoteStateHtml } from "~/cad-quote";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";

export const Route = createFileRoute("/cad-demo")({ server: { handlers: { GET: async ({ request }) => {
  const projectId = new URL(request.url).searchParams.get("projectId") || "17";
  const unlocked = process.env.DATABASE_URL ? await accurateCadUnlocked(projectId).catch(() => false) : false;
  let requested = false;
  if (process.env.DATABASE_URL && /^\d+$/.test(projectId)) { await ensureSchema().catch(() => {}); const rows = await sql()`SELECT value FROM facts WHERE project_id=${projectId} AND category='cad' AND key='cad_quote_requested' ORDER BY id DESC LIMIT 1`.catch(() => []); requested = String(rows[0]?.value ?? '').toLowerCase() === 'true'; }
  const svg = renderCadSvg(demoDimensionedCadModel());
  const state = cadQuoteStateHtml({ projectId, unlocked, requested, paymentLink: paymentLink() });
  const html = `<!doctype html><title>ATLAS AI CAD tiers</title><style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;color:#172033;padding:0 1rem}svg{width:100%;border:1px solid #ccd6df;background:#fff}a,button{display:inline-block;padding:.7rem 1rem;background:#172033;color:white;text-decoration:none;border:0;border-radius:5px;margin:.25rem}.tier{border:1px solid #ccd6df;padding:1rem;margin:1rem 0;border-radius:8px}input,select,textarea{display:block;width:100%;box-sizing:border-box;padding:.5rem;margin-top:.25rem}fieldset label{display:inline-block;margin-right:1rem}</style><h1>ATLAS AI CAD tiers</h1><div class="tier"><h2>Standard — schematic</h2><p><strong>Estimated, not a survey.</strong> Free concept geometry for feasibility and design development.</p>${svg}</div><div class="tier"><h2>Accurate CAD — quoted add-on</h2>${state}<p>Source: client dimensioned documents or professional surveyor figures. ATLAS AI does not claim to provide a measured survey.</p></div>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
} } } });
