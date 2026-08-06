/** Licensed-image facade reference and deterministic schematic elevation extraction. */
export type FacadeUnavailable = { status: "unavailable"; reason: "no token" | "no image" | "fetch failed" | "no features" | "invalid coordinates" | "api error" };
export type FacadeImage = { status: "available"; imageId: string; thumbUrl: string; creator: string; license: string; attribution: string; retrievedAt: string };
export type FacadeLookup = FacadeImage | FacadeUnavailable;
export type FacadeSvg = { status: "generated"; svg: string } | FacadeUnavailable;

const unavailable = (reason: FacadeUnavailable["reason"]): FacadeUnavailable => ({ status: "unavailable", reason });

export async function lookupFacadeImage(coords: { lat: number; lon: number }): Promise<FacadeLookup> {
  const token = process.env.MAPILLARY_TOKEN?.trim();
  if (!token) return unavailable("no token");
  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) return unavailable("invalid coordinates");
  const d = 0.0007;
  const url = `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}&fields=id,thumb_1024_url,creator,license,computed_geometry&bbox=${coords.lon - d},${coords.lat - d},${coords.lon + d},${coords.lat + d}&limit=10`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return unavailable("api error");
    const body = await res.json() as { data?: Array<{ id?: string; thumb_1024_url?: string; creator?: { username?: string; id?: string }; license?: string }> };
    const item = body.data?.find((x) => x.id && x.thumb_1024_url);
    if (!item) return unavailable("no image");
    const creator = item.creator?.username || item.creator?.id || "Mapillary contributor";
    const license = item.license || "CC BY-SA 4.0 (verify provider terms)";
    return { status: "available", imageId: String(item.id), thumbUrl: String(item.thumb_1024_url), creator, license, attribution: `© ${creator} via Mapillary · ${license}`, retrievedAt: new Date().toISOString() };
  } catch { return unavailable("api error"); }
}

function esc(v: string): string { return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** Decode with Sharp/libvips when present, then use stable grayscale connected-region heuristics. */
export async function facadeToSvg(imageBuffer: Uint8Array | ArrayBuffer): Promise<FacadeSvg> {
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(imageBuffer).resize({ width: 640, height: 480, fit: "inside", withoutEnlargement: true }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;
    if (w < 40 || h < 40) return unavailable("no features");
    // Find a substantive, darker facade mass. This deliberately refuses plain/empty images.
    let minX = w, minY = h, maxX = -1, maxY = -1, dark = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = data[y * w + x]; if (p < 215) { dark++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); } }
    if (dark < w * h * 0.03 || maxX < minX) return unavailable("no features");
    minX = Math.max(4, minX); maxX = Math.min(w - 5, maxX); minY = Math.max(4, minY); maxY = Math.min(h - 5, maxY);
    // Connected bright regions inside the mass are candidate openings (windows/doors).
    const seen = new Uint8Array(w * h); const openings: Array<[number, number, number, number]> = [];
    for (let y = minY + 2; y < maxY - 1; y++) for (let x = minX + 2; x < maxX - 1; x++) {
      const i = y * w + x; if (seen[i] || data[i] < 220) continue;
      const q: Array<[number, number]> = [[x, y]]; seen[i] = 1; let ax = x, bx = x, ay = y, by = y, n = 0;
      while (q.length) { const [cx, cy] = q.pop()!; n++; ax = Math.min(ax, cx); bx = Math.max(bx, cx); ay = Math.min(ay, cy); by = Math.max(by, cy);
        for (const [nx, ny] of [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]] as Array<[number,number]>) { if (nx < minX || nx >= maxX || ny < minY || ny >= maxY) continue; const ni = ny*w+nx; if (!seen[ni] && data[ni] >= 220) { seen[ni] = 1; q.push([nx, ny]); } }
      }
      const rw = bx-ax+1, rh = by-ay+1; if (n >= 12 && rw >= 4 && rh >= 6 && rw <= w * .65 && rh <= h * .75) openings.push([ax, ay, rw, rh]);
    }
    if (!openings.length) return unavailable("no features");
    const W = 800, H = 560, sx = 680 / Math.max(1, maxX-minX), sy = 390 / Math.max(1, maxY-minY);
    const ox = 60, oy = 70; const rects = openings.sort((a,b) => a[1]-b[1] || a[0]-b[0]).map(([x,y,rw,rh], i) => `<rect class="opening inferred" x="${(ox+(x-minX)*sx).toFixed(1)}" y="${(oy+(y-minY)*sy).toFixed(1)}" width="${(rw*sx).toFixed(1)}" height="${(rh*sy).toFixed(1)}" data-confidence="0.55" data-inferred="true"><title>Opening ${i+1} — inferred, confidence 0.55</title></rect>`).join("");
    const title = "Schematic facade elevation — inferred from a single image; not a measured survey.";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#64748b" stroke-width="1"/></pattern></defs><style>.boundary{fill:#eef2f5;stroke:#17212b;stroke-width:3}.roof,.ground{stroke:#17212b;stroke-width:4}.opening{fill:url(#hatch);stroke:#2563eb;stroke-width:2}.label{font:12px sans-serif;fill:#334155}.title{font:bold 13px sans-serif;fill:#17212b}</style><path class="roof" d="M${ox-12} ${oy}H${ox+680+12}" data-confidence="0.5" data-inferred="true"/><rect class="boundary" x="${ox}" y="${oy}" width="680" height="390" data-confidence="0.5" data-inferred="true"/>${rects}<path class="ground" d="M40 465H760" data-confidence="0.9" data-inferred="true"/><text class="label" x="60" y="490">GROUND LINE · inferred</text><rect x="40" y="510" width="720" height="34" fill="#fff" stroke="#94a3b8"/><text class="title" x="50" y="532">${esc(title)}</text></svg>`;
    return { status: "generated", svg };
  } catch { return unavailable("no features"); }
}

export async function fetchFacadeSvg(coords: { lat: number; lon: number }): Promise<{ image: FacadeLookup; elevation: FacadeSvg }> {
  const image = await lookupFacadeImage(coords);
  if (image.status !== "available") return { image, elevation: image };
  try { const r = await fetch(image.thumbUrl, { signal: AbortSignal.timeout(5000) }); if (!r.ok) return { image, elevation: unavailable("fetch failed") }; return { image, elevation: await facadeToSvg(await r.arrayBuffer()) }; }
  catch { return { image, elevation: unavailable("fetch failed") }; }
}
