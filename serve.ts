// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server on port 3000 — static files first, SSR for the
// rest. Run `bun run build` before starting. Restart it with `bun run publish`.
//
// Starting a new instance supersedes the old one: it frees the port no matter
// which user owns the current server (provisioning starts it as `engine`; a team
// member's `bun run publish` runs as their own user), so publish never collides
// with an already-running server. Every sandbox user has passwordless sudo, so
// the takeover works across user boundaries.
import handler from "./dist/server/server.js";
import { sql } from "./src/db";
import { ensureSchema } from "./src/project-schema";
import { getPreviewImageBytes } from "./src/preview-image";

// Pinned, NOT read from the environment. The published preview URL
// (<label>.<PUBLIC_SITE_DOMAIN>) is reverse-proxied to 0.0.0.0:3000 inside the
// sandbox, so the default site MUST bind there. Bun auto-loads .env files, so
// honouring process.env.PORT/HOST would let a stray env var or a .env in the site
// dir silently move the site off :3000 (or onto loopback) and break the public URL.
const PORT = 3000;
const HOST = "0.0.0.0";
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

// Explicit MIME types for static files. `new Response(BunFile)` does not reliably
// set Content-Type, and browsers will not render an image (or strict-load a
// module script) without it.
const STATIC_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json",
  svg: "image/svg+xml",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

// Free PORT regardless of which user owns the current listener. lsof runs under
// sudo so it can see (and the kill can signal) a process owned by another user;
// the loop waits for the socket to actually release before we bind.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success.
for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        // Project renders are handled EXCLUSIVELY here — never by the generic
        // static branch below. vite copies public/ into dist/client at build
        // time, so the clean full-res files would otherwise be served with no
        // token check at all. This block always returns (or 404s) for every
        // /project-images/ request: full-res clean files require the release
        // token (demo project 17 stays public); <view>.preview.* variants are
        // token-free but always downscaled + watermarked copies.
        if (pathname.startsWith("/project-images/")) {
          const match = pathname.match(/^\/project-images\/(\d+)\/([^/]+)\.(?:jpg|jpeg|png|webp)$/i);
          const projectId = match?.[1];
          const fileName = match?.[2] ?? "";
          const fileExt = pathname.split(".").pop()?.toLowerCase() ?? "";
          // Public preview variant (`<view>.preview.jpg`): served WITHOUT a
          // token, but always a downscaled + watermarked copy generated from
          // the stored render — never the full-resolution clean file, which
          // remains token-gated below. Used by the /report/$id preview page.
          if (projectId && /\.preview$/i.test(fileName)) {
            const preview = await getPreviewImageBytes(
              projectId,
              fileName.replace(/\.preview$/i, ""),
              fileExt,
            );
            if (preview) {
              return new Response(preview.bytes, {
                headers: {
                  "Content-Type": preview.mime,
                  "Cache-Control": "public, max-age=3600",
                },
              });
            }
            return new Response("preview unavailable", { status: 404 });
          }
          if (projectId) {
            const token = new URL(req.url).searchParams.get("token");
            if (projectId !== "17") {
              // Admin test token unlocks any project for owner testing.
              const isTestToken = !!process.env.TEST_TOKEN && token === process.env.TEST_TOKEN;
              if (!token || !isTestToken) {
                if (!token) return Response.json({ error: "This report is locked — purchase to unlock" }, { status: 403 });
                await ensureSchema();
                const rows = await sql()`SELECT 1 FROM projects WHERE id = ${projectId} AND release_token = ${token} LIMIT 1`;
                if (!rows.length) return Response.json({ error: "This report is locked — purchase to unlock" }, { status: 403 });
              }
            }
            const runtimeFile = Bun.file(`${import.meta.dir}/public${pathname}`);
            if (await runtimeFile.exists()) {
              const mime =
                (STATIC_MIME as Record<string, string>)[fileExt] ??
                "application/octet-stream";
              return new Response(runtimeFile, {
                headers: { "Content-Type": mime },
              });
            }
          }
          return new Response("not found", { status: 404 });
        }
        if (pathname !== "/") {
          const file = Bun.file(CLIENT_DIR + pathname);
          if (await file.exists()) {
            // Explicit Content-Type: `new Response(BunFile)` does not reliably
            // emit one, and browsers refuse to render images without a MIME type.
            const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
            const mime =
              (STATIC_MIME as Record<string, string>)[ext] ??
              "application/octet-stream";
            return new Response(file, { headers: { "Content-Type": mime } });
          }
        }
        return (
          handler as { fetch: (r: Request) => Response | Promise<Response> }
        ).fetch(req);
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}

console.log(`team-site serving on http://${HOST}:${String(PORT)}`);
