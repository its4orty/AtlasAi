/**
 * src/preview.ts — the token-gated report PREVIEW page.
 *
 * When a project has generated output (AI concept renders recorded in project
 * memory) but the visitor has no release token, /report/$id renders this
 * watermarked preview instead of the bare 403. It shows only:
 *   - the address and a brief, honest teaser of the full report's contents
 *     (target use, programme, key facts) — never the analysis, financials or
 *     compliance verdict, which stay token-gated;
 *   - downscaled preview images served via /project-images/<id>/<view>.preview.jpg
 *     (the full-resolution clean files stay behind the token gate);
 *   - the public Google Street View embed when recorded (real public imagery);
 *   - an "Unlock full report" CTA to the Stripe checkout (BUY_URL).
 *
 * The page carries a small inline gate script (no external dependencies):
 * clicking, right-clicking, dragging or selecting any preview image sends the
 * visitor straight to the checkout. The CSS watermark overlay renders on top of
 * every preview image in normal flow, so any screenshot of the page captures a
 * visibly watermarked image.
 */
import type { MemoryFact, ProjectMemoryLike } from "./report";
import { BUY_URL } from "./access";

const WATERMARK_TEXT = "ATLAS AI — PREVIEW";
const GATE_SCRIPT = `<script>
(function () {
  var BUY = ${JSON.stringify(BUY_URL)};
  var els = document.querySelectorAll("figure.preview-media");
  var go = function (e) {
    e.preventDefault();
    e.stopPropagation();
    window.location.href = BUY;
  };
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    el.addEventListener("click", go);
    el.addEventListener("contextmenu", go);
    el.addEventListener("dragstart", go);
    el.addEventListener("selectstart", go);
  }
})();
<\/script>`;

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Latest-wins view of a category's facts (facts accumulate across re-runs). */
function latest(category: string, facts: MemoryFact[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of facts) if (f.category === category) m.set(f.key, f.value);
  return m;
}

export interface PreviewImage {
  view: string;
  /** Downscaled, watermarked preview URL — never the clean full-res file. */
  previewUrl: string;
}

/** The generated renders that have a real file behind them (status "generated"). */
export function previewImages(memory: ProjectMemoryLike): PreviewImage[] {
  const im = latest("imagery", memory.facts);
  const out: PreviewImage[] = [];
  for (const view of ["exterior", "interior"]) {
    const url = im.get(`imagery_${view}_url`);
    const status = im.get(`imagery_${view}_status`);
    if (!url || status !== "generated") continue;
    const previewUrl = url.replace(
      /^(\/project-images\/\d+\/[^/]+)\.(jpg|jpeg|png|webp)$/i,
      "$1.preview.$2",
    );
    // Only accept URLs that actually transformed — never leak a clean URL.
    if (previewUrl !== url) out.push({ view, previewUrl });
  }
  return out;
}

export function hasPreviewImagery(memory: ProjectMemoryLike): boolean {
  return previewImages(memory).length > 0;
}

/** Brief, honest teaser facts — no analysis, financials or compliance verdict. */
function teaserItems(memory: ProjectMemoryLike): string[] {
  const items: string[] = [];
  const design = latest("design", memory.facts);
  const address = latest("address", memory.facts);
  const discovery = latest("discovery", memory.facts);
  const program = design.get("design_program_label") ?? design.get("design_target_use");
  if (program) items.push(`Concept design: convert to <strong>${esc(program)}</strong>`);
  const area = Number(design.get("design_total_floor_area_m2"));
  if (Number.isFinite(area) && area > 0) items.push(`Concept floor area: ${area} m²`);
  const rooms = Number(design.get("design_rooms_count"));
  if (Number.isFinite(rooms) && rooms > 0) items.push(`${rooms} rooms in the concept layout`);
  const postcode = address.get("postcode");
  if (postcode) items.push(`Postcode: ${esc(postcode)}`);
  const localAuthority = discovery.get("local_authority");
  if (localAuthority) items.push(`Local authority: ${esc(localAuthority)}`);
  const nearbyCount = Number(latest("nearby", memory.facts).get("nearby_count"));
  if (Number.isFinite(nearbyCount) && nearbyCount > 0) {
    items.push(`Nearby opportunities: ${nearbyCount} sites/premises within 1.5 km flagged — unlock the full report to see them.`);
  }
  return items;
}

const FULL_REPORT_CONTENTS = [
  "Complete feasibility screening with the financial model",
  "Change-of-use compliance review (England 2020 Use Classes Order)",
  "Full design drawings and high-resolution concept renders",
  "Confidence-scored sources and assumptions, fully traceable",
];

/**
 * Render the watermarked preview page. Returns null when the project has no
 * generated imagery to preview — the route then keeps the bare 403.
 */
export function renderPreviewHtml(memory: ProjectMemoryLike): string | null {
  const images = previewImages(memory);
  if (!images.length) return null;
  const { project } = memory;
  const teaser = teaserItems(memory);
  const teaserHtml = teaser.length
    ? `<ul>${teaser.map((t) => `<li>${t}</li>`).join("")}</ul>`
    : `<p>Concept renders have been generated for this property (shown below).</p>`;
  const figures = images
    .map(
      (img) => `<figure class="preview-media">
  <img src="${esc(img.previewUrl)}" alt="AI-generated ${img.view} concept visualisation — preview" draggable="false"/>
  <div class="watermark" aria-hidden="true"><span>${WATERMARK_TEXT}</span></div>
  <figcaption>${img.view === "exterior" ? "Exterior" : "Interior"} concept visualisation · <strong>Click to unlock</strong></figcaption>
</figure>`,
    )
    .join("\n");
  const streetView = (() => {
    const embedUrl = latest("imagery", memory.facts).get("imagery_streetview_embed_url");
    if (!embedUrl) return "";
    return `<section class="sv">
  <h2>Current property — Street View</h2>
  <iframe src="${esc(embedUrl)}" width="100%" height="380" style="border:0" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" title="Google Street View of the current property"></iframe>
  <p class="note">Real Google Street View imagery of the current frontage (public imagery; approximate location).</p>
</section>`;
  })();
  const contentsList = FULL_REPORT_CONTENTS.map((c) => `    <li>${esc(c)}</li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>Preview — ${esc(project.address)} · ATLAS AI</title>
<style>
  :root { color-scheme: light; --ink:#101a33; --slate:#4a5670; --line:#e4e8f2; --brand:#1d2f6e; --accent:#0e7c5b; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:#f4f6fb; }
  .topbar { background:var(--brand); color:#fff; padding:12px 20px; font-weight:700; letter-spacing:.04em; display:flex; gap:8px; align-items:center; }
  .topbar .logo { width:26px; height:26px; }
  main { max-width:880px; margin:0 auto; padding:28px 20px 64px; }
  .kicker { color:var(--slate); text-transform:uppercase; letter-spacing:.14em; font-size:12px; font-weight:700; margin:0 0 6px; }
  h1 { font-size:28px; line-height:1.2; margin:0 0 18px; }
  .teaser { background:#fff; border:1px solid var(--line); border-radius:12px; padding:18px 22px; margin:0 0 24px; box-shadow:0 1px 6px rgba(16,26,51,.06); }
  .teaser h2 { font-size:16px; margin:0 0 10px; }
  .teaser ul { margin:0; padding-left:20px; }
  .teaser li { margin:4px 0; }
  .note { color:var(--slate); font-size:13.5px; margin:10px 0 0; }
  .gallery { display:flex; flex-wrap:wrap; gap:18px; justify-content:center; margin:0 0 26px; }
  .preview-media { position:relative; display:inline-block; margin:0; overflow:hidden; border-radius:10px; box-shadow:0 4px 18px rgba(16,26,51,.16); background:#fff; cursor:pointer; }
  .preview-media img { display:block; width:100%; max-width:460px; height:auto; user-select:none; -webkit-user-drag:none; -webkit-touch-callout:none; pointer-events:none; }
  .preview-media .watermark { position:absolute; inset:0; z-index:2; display:flex; align-items:center; justify-content:center; pointer-events:none; }
  .preview-media .watermark span { transform:rotate(-24deg); background:rgba(8,12,40,.62); border:1.5px solid rgba(255,255,255,.85); color:#fff; font-size:13px; font-weight:700; letter-spacing:.16em; padding:7px 16px; border-radius:5px; box-shadow:0 2px 8px rgba(0,0,0,.4); white-space:nowrap; }
  .preview-media figcaption { background:#fff; border-top:1px solid var(--line); font-size:12.5px; color:var(--slate); padding:8px 12px; text-align:center; }
  .sv { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; margin:0 0 24px; }
  .sv h2 { font-size:16px; margin:0 0 10px; }
  .sv iframe { display:block; border-radius:8px; }
  .cta { text-align:center; background:#fff; border:1px solid var(--line); border-radius:12px; padding:26px; }
  .btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; font-weight:700; font-size:17px; padding:14px 34px; border-radius:10px; box-shadow:0 3px 12px rgba(14,124,91,.35); }
  .btn:hover { filter:brightness(1.07); }
  .price { color:var(--slate); font-size:13px; margin:10px 0 0; }
  .fine { color:var(--slate); font-size:12.5px; text-align:center; margin:18px 0 0; }
  @media (max-width:560px) { h1 { font-size:22px; } .preview-media img { max-width:100%; } }
</style>
</head>
<body>
<header class="topbar"><img class="logo" src="/brand/atlas-logo.svg" alt=""/>ATLAS AI · Property report preview</header>
<main>
  <p class="kicker">Report #${esc(project.id)} · preview</p>
  <h1>${esc(project.address)}</h1>
  <section class="teaser">
    <h2>What's inside the full report</h2>
    ${teaserHtml}
    <p class="note">This is a watermarked preview. The full report — feasibility screening, financial model, compliance review and complete design drawings — unlocks after purchase.</p>
  </section>
  <div class="gallery">
${figures}
  </div>
${streetView}
  <section class="cta">
    <a class="btn" href="${esc(BUY_URL)}" rel="noopener">Unlock full report</a>
    <p class="price">One-off payment · instant access · full-resolution images</p>
  </section>
  <p class="fine">With the full report you also get:</p>
  <ul style="color:var(--slate);font-size:13.5px;text-align:left;max-width:520px;margin:6px auto 0;">
${contentsList}
  </ul>
</main>
${GATE_SCRIPT}
</body>
</html>`;
}
