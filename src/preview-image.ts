/**
 * src/preview-image.ts — serves the DOWNSCALED, watermarked preview variants of
 * project renders to the public preview page.
 *
 * The full-resolution clean files (public/project-images/<id>/<view>.jpg) stay
 * behind the token gate in serve.ts. This module generates a smaller
 * (`<view>.preview.jpg`) variant on first request — scaled to at most 480px
 * wide with translucent diagonal watermark bands baked in — and caches it to
 * disk, so the token-free preview never exposes the full-res file and repeated
 * requests are cheap. Any failure returns null (the caller then 404s); the
 * preview page itself is never blocked.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_IMAGES_DIR = path.resolve(import.meta.dir, "..", "public", "project-images");
const MAX_WIDTH = 480;
const BAND_COLOR = 0x08102b; // dark navy
const BAND_OPACITY = 0.55;

export interface PreviewImageResult {
  bytes: Uint8Array;
  mime: string;
}

/**
 * Return (and lazily cache) the downscaled watermarked preview for a stored
 * render. `view` is the render name without extension ("exterior" | "interior"),
 * `ext` the stored file extension ("jpg"). Returns null when the source file is
 * missing or cannot be processed.
 */
export async function getPreviewImageBytes(
  projectId: string,
  view: string,
  ext: string,
): Promise<PreviewImageResult | null> {
  try {
    if (!/^\d+$/.test(projectId) || !/^[a-z0-9-]+$/i.test(view)) return null;
    if (!/^[a-z0-9]+$/i.test(ext)) return null;
    const cachePath = path.join(PROJECT_IMAGES_DIR, projectId, `${view}.preview.jpg`);
    const cached = await readFile(cachePath).catch(() => null);
    if (cached) return { bytes: new Uint8Array(cached), mime: "image/jpeg" };
    const src = await readFile(path.join(PROJECT_IMAGES_DIR, projectId, `${view}.${ext}`)).catch(
      () => null,
    );
    if (!src) return null;
    // Lazy import: if jimp ever fails to load, the site keeps serving — only
    // preview-variant generation is affected (returns null → 404 for that file).
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(src);
    if (img.width > MAX_WIDTH) img.scaleToFit({ w: MAX_WIDTH, h: MAX_WIDTH });
    // Baked deterrent: translucent diagonal bands across the whole image, so a
    // directly-saved file is visibly marked as a preview even without the page
    // overlay. (Browsers cannot be prevented from downloading; the watermark IS
    // the deterrent — the full-res clean file stays token-gated regardless.)
    const band = new Jimp({ width: img.width, height: 140, color: BAND_COLOR });
    band.rotate(-24);
    for (let y = -60; y < img.height; y += 230) {
      img.composite(band, 0, y, { opacitySource: BAND_OPACITY });
    }
    const out = await img.getBuffer("image/jpeg", { quality: 80 });
    await mkdir(path.join(PROJECT_IMAGES_DIR, projectId), { recursive: true });
    await writeFile(cachePath, out).catch(() => {});
    return { bytes: new Uint8Array(out), mime: "image/jpeg" };
  } catch {
    return null;
  }
}
