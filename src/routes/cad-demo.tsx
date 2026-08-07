import { createFileRoute } from "@tanstack/react-router";
import { demoDimensionedCadModel, renderCadSvg } from "~/cad";
import { accurateCadUnlocked, paymentLink } from "~/cad-access";

export const Route = createFileRoute("/cad-demo")({ server: { handlers: { GET: async ({ request }) => {
  const projectId = new URL(request.url).searchParams.get("projectId") || "17";
  const unlocked = process.env.DATABASE_URL ? await accurateCadUnlocked(projectId).catch(() => false) : false;
  const pay = paymentLink();
  const model = demoDimensionedCadModel();
  const svg = renderCadSvg(model);
  const accurateState = unlocked ? `<p><strong>Accurate CAD unlocked.</strong> Dimensioned DXF and SVG are available from the paid tier.</p><p><a href="/api/cad?projectId=${encodeURIComponent(projectId)}&format=svg">View Accurate CAD SVG</a> <a download href="/api/cad?projectId=${encodeURIComponent(projectId)}">Download Accurate CAD DXF</a></p>` : `<p><strong>Accurate CAD is locked.</strong> This paid add-on is offered where dimensioned evidence is available; document parsing is stubbed until Phase 2B.</p><p>${pay ? `<a href="${pay}">Purchase Accurate CAD</a>` : "Payment link not configured."}</p>`;
  const html = `<!doctype html><title>ATLAS AI CAD tiers</title><style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;color:#172033;padding:0 1rem}svg{width:100%;border:1px solid #ccd6df;background:#fff}a{display:inline-block;padding:.7rem 1rem;background:#172033;color:white;text-decoration:none;border-radius:5px;margin:.25rem}.tier{border:1px solid #ccd6df;padding:1rem;margin:1rem 0;border-radius:8px}</style><h1>ATLAS AI CAD tiers</h1><div class="tier"><h2>Standard — schematic</h2><p><strong>Estimated, not a survey.</strong> Free concept geometry for feasibility and design development.</p>${svg}</div><div class="tier"><h2>Accurate CAD — paid add-on</h2>${accurateState}<p>Source: client dimensioned documents or professional surveyor figures. Not a measured survey by ATLAS AI.</p></div>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
} } } });
