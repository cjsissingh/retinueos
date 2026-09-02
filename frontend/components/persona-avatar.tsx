import type { CSSProperties } from "react";

/**
 * Persona identity — colour hashed from `persona.id` (six-colour fixed
 * palette), initials from `persona.name`, shape from a role heuristic so a
 * glance at the shape alone signals what kind of staff you're looking at.
 * See the look & feel spec's "Persona identity" section.
 */
const PALETTE: Array<{ fg: string; bg: string }> = [
  { fg: "var(--accent)", bg: "var(--accent-soft)" }, // brass
  { fg: "var(--running)", bg: "var(--running-soft)" }, // teal
  { fg: "#4c4478", bg: "#e9e6f2" }, // violet
  { fg: "var(--danger)", bg: "var(--danger-soft)" }, // rose
  { fg: "var(--success)", bg: "var(--success-soft)" }, // green
  { fg: "#2f5a78", bg: "#e3eef5" }, // steel
];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export type PersonaShape = "circle" | "square" | "diamond" | "pill" | "hex";

const SHAPE_KEYWORDS: Array<[RegExp, PersonaShape]> = [
  [/financ|ledger|account|book/i, "square"],
  [/research|analy|data|map|cartograph|intel/i, "diamond"],
  [/comm|outreach|market|herald|press|social/i, "pill"],
  [/ops|operation|monitor|watch|sentinel|infra|security/i, "hex"],
];

function roleShape(role: string): PersonaShape {
  for (const [pattern, shape] of SHAPE_KEYWORDS) {
    if (pattern.test(role)) return shape;
  }
  return "circle";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const SIZES = {
  sm: { box: 32, font: 12 },
  md: { box: 44, font: 15 },
  lg: { box: 64, font: 21 },
} as const;

export function PersonaAvatar({
  id,
  name,
  role,
  size = "md",
  className = "",
}: {
  id: string;
  name: string;
  role: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { fg, bg } = PALETTE[hashString(id) % PALETTE.length]!;
  const shape = roleShape(role);
  const { box, font } = SIZES[size];

  const style: CSSProperties = {
    color: fg,
    background: bg,
    fontFamily: "var(--font-sans)",
    fontWeight: 600,
    fontSize: font,
    display: "grid",
    placeItems: "center",
    flex: "none",
    lineHeight: 1,
  };

  switch (shape) {
    case "circle":
      style.width = box;
      style.height = box;
      style.borderRadius = 999;
      break;
    case "square":
      style.width = box;
      style.height = box;
      style.borderRadius = box * 0.14;
      break;
    case "diamond":
      style.width = box;
      style.height = box;
      style.clipPath = "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)";
      break;
    case "pill":
      style.width = box * 1.27;
      style.height = box * 0.82;
      style.borderRadius = 999;
      break;
    case "hex":
      style.width = box;
      style.height = box * 1.05;
      style.clipPath = "polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)";
      break;
  }

  return (
    <span style={style} className={className} title={name} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
