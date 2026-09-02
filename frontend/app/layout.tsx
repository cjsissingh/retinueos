import "./globals.css";
import type { ReactNode } from "react";
import type { Viewport } from "next";
import { AppShell } from "@/components/app-shell";
import { ThemeColorMeta } from "@/components/theme-color-meta";

export const metadata = {
  title: "RetinueOS",
  description: "Persona-driven personal agent control plane.",
  applicationName: "RetinueOS",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default" as const,
    title: "RetinueOS",
  },
  icons: {
    apple: "/icons/retinueos-180.png",
  },
};

export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <ThemeColorMeta />
      </head>
      <body className="min-h-screen bg-bg font-sans text-fg antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
