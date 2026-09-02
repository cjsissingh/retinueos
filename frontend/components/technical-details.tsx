import type { ReactNode } from "react";

/** Secondary implementation data that should remain available without
 * competing with the operator-facing account of what happened. */
export function TechnicalDetails({
  label = "Technical details",
  children,
  className = "",
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`min-w-0 max-w-full ${className}`}>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center font-mono text-[11px] uppercase tracking-wider text-fg-faint marker:hidden">
        <span className="mr-2 text-accent" aria-hidden="true">
          +
        </span>
        {label}
      </summary>
      <div className="min-w-0 pb-2">{children}</div>
    </details>
  );
}
