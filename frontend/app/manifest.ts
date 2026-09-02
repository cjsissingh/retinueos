import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "RetinueOS",
    short_name: "RetinueOS",
    description: "Persona-driven personal agent control plane.",
    start_url: "/today",
    display: "standalone",
    display_override: ["standalone"],
    // Light-theme value only -- the JSON manifest has no per-scheme colour
    // slot. Installed-PWA chrome gets the real light/dark pair from the
    // <meta name="theme-color" media="..."> tags in app/layout.tsx; this is
    // just what a browser reads before the page (and its media query) has
    // ever loaded.
    background_color: "#f7f5f1",
    theme_color: "#8a6a2f",
    shortcuts: [
      { name: "Ask someone to…", url: "/today?ask=1" },
      { name: "Approvals", url: "/approvals" },
    ],
    icons: [
      { src: "/icons/retinueos-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/retinueos-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/retinueos-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/retinueos-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
