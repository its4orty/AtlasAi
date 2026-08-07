export type CadQuoteInput = { projectId: string; name: string; email: string; docs: string[]; surveyVisit: string; notes: string };
export function validateCadQuote(input: Partial<CadQuoteInput>): string | null {
  if (!/^\d+$/.test(String(input.projectId ?? ""))) return "A numeric project id is required.";
  if (!String(input.name ?? "").trim()) return "Your name is required.";
  const email = String(input.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  if (!['yes','no','unsure'].includes(String(input.surveyVisit ?? 'unsure'))) return "Choose a survey option.";
  return null;
}

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface CadQuoteState {
  projectId: string;
  unlocked: boolean;
  requested: boolean;
  paymentLink?: string | null;
}

/**
 * Server-rendered state block + quote form for the Accurate CAD flow. Pure
 * (no DB, no env reads beyond the passed-in payment link) so the state machine
 * is unit-testable in isolation; shared by /cad-demo and the project report.
 * States: locked (quote form) → requested ("quote requested") → unlocked
 * (download links). The form posts to /api/cad-quote with projectId pre-filled.
 */
export function cadQuoteStateHtml(s: CadQuoteState): string {
  const pid = encodeURIComponent(s.projectId);
  if (s.unlocked) {
    return `<p><strong>Accurate CAD unlocked.</strong> The quoted amount has been paid and the owner has released the files.</p><p><a href="/api/cad?projectId=${pid}&format=svg">View Accurate CAD SVG</a> <a download href="/api/cad?projectId=${pid}">Download Accurate CAD DXF</a></p>`;
  }
  if (s.requested) {
    return `<p><strong>Quote requested.</strong> We will come back with a price for your project based on its complexity.</p>`;
  }
  const pay = s.paymentLink ? `<p><a href="${esc(s.paymentLink)}">Existing payment link</a></p>` : "";
  return `<p><strong>Locked — Accurate CAD is a quoted add-on.</strong> The free report already includes the schematic. Request a quote after reviewing it; pricing depends on your documents and scope.</p>${pay}<form id="quote" style="display:grid;gap:.55rem;max-width:560px"><input name="projectId" value="${esc(s.projectId)}" hidden><label>Name *<input required name="name" autocomplete="name"></label><label>Email *<input required type="email" name="email" autocomplete="email"></label><fieldset><legend>Documents held</legend><label><input type="checkbox" name="docs" value="lease"> Lease</label><label><input type="checkbox" name="docs" value="floor plan"> Floor plan</label><label><input type="checkbox" name="docs" value="building regs"> Building regs</label><label><input type="checkbox" name="docs" value="none"> None</label></fieldset><label>Site visit / measured survey possible?<select name="surveyVisit"><option value="unsure">Unsure</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Requirements note<textarea name="notes" maxlength="2000" rows="4"></textarea></label><button type="submit">Request a quote for Accurate CAD</button><span id="quoteStatus" role="status"></span></form><script>(function(){var f=document.querySelector('#quote');if(!f)return;f.onsubmit=function(e){e.preventDefault();var d=new FormData(f);var b={projectId:d.get('projectId'),name:d.get('name'),email:d.get('email'),docs:d.getAll('docs'),surveyVisit:d.get('surveyVisit'),notes:d.get('notes')};fetch('/api/cad-quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()}).then(function(j){var s=document.querySelector('#quoteStatus');if(!s)return;if(j.error){s.textContent=j.error;return}s.textContent='Quote requested — refreshing…';setTimeout(function(){location.reload()},500)}).catch(function(){var s=document.querySelector('#quoteStatus');if(s)s.textContent='Request failed — try again.'})}})();</script>`;
}
