import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      // The shell's third breakpoint tier (design doc §05): >= 1180px gets
      // the full 240px sidebar; 768-1179px gets the icon-only 64px one.
      // An `extend` addition, not an override -- default sm/md/lg/xl/2xl
      // are untouched, so this doesn't reflow the `lg:` grids elsewhere
      // (roster, logs) that already key off the default 1024px `lg`.
      screens: {
        "shell-lg": "1180px",
      },
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-sunken": "var(--surface-sunken)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        fg: "var(--fg)",
        "fg-muted": "var(--fg-muted)",
        "fg-faint": "var(--fg-faint)",
        accent: {
          DEFAULT: "var(--accent)",
          fg: "var(--accent-fg)",
          soft: "var(--accent-soft)",
          "soft-fg": "var(--accent-soft-fg)",
          "soft-border": "var(--accent-soft-border)",
        },
        running: {
          DEFAULT: "var(--running)",
          soft: "var(--running-soft)",
          "soft-fg": "var(--running-soft-fg)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
          "soft-fg": "var(--warning-soft-fg)",
        },
        success: {
          DEFAULT: "var(--success)",
          soft: "var(--success-soft)",
          "soft-fg": "var(--success-soft-fg)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          fg: "var(--danger-fg)",
          soft: "var(--danger-soft)",
          "soft-fg": "var(--danger-soft-fg)",
          "soft-border": "var(--danger-soft-border)",
        },
        neutral: {
          DEFAULT: "var(--neutral)",
          soft: "var(--neutral-soft)",
          "soft-fg": "var(--neutral-soft-fg)",
        },
      },
      fontFamily: {
        serif: ["var(--font-serif)"],
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        rest: "var(--shadow-rest)",
        hover: "var(--shadow-hover)",
        overlay: "var(--shadow-overlay)",
      },
      borderRadius: {
        badge: "4px",
        button: "8px",
        card: "12px",
      },
      spacing: {
        4.5: "18px",
      },
      maxWidth: {
        content: "1120px",
      },
    },
  },
  plugins: [],
} satisfies Config;
