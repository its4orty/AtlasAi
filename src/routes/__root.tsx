import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";

const pageTitle = "ATLAS AI — One address. A complete redevelopment feasibility study.";
const pageDescription = "ATLAS AI turns one property address into an evidence-backed redevelopment feasibility study, in minutes, not weeks.";
const socialImage = "https://a3cbf7a8aeceb14e0d105e4cf0da7a84.ctonew.app/images/hero-transformation.webp";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: pageTitle },
      { name: "description", content: pageDescription },
      { property: "og:title", content: pageTitle },
      { property: "og:description", content: pageDescription },
      { property: "og:type", content: "website" },
      { property: "og:image", content: socialImage },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: pageTitle },
      { name: "twitter:description", content: pageDescription },
      { name: "twitter:image", content: socialImage },
    ],
    links: [{ rel: "stylesheet", href: appCss }, { rel: "icon", href: "/favicon.svg" }, { rel: "preload", as: "image", href: "/images/hero-transformation.webp" }, { rel: "preconnect", href: "https://fonts.googleapis.com" }, { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" }],
  }),
  component: () => <RootDocument><Outlet /></RootDocument>,
});
function RootDocument({ children }: { children: ReactNode }) { return <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>; }
