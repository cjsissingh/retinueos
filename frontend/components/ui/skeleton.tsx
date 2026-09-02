function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`skeleton-shimmer rounded ${className}`} style={{ background: "var(--neutral-soft)", ...style }} />
  );
}

/** Card-shaped skeleton matching PersonaCard's geometry, so nothing jumps when real data arrives. */
export function PersonaCardSkeleton() {
  return (
    <div className="flex flex-col gap-3.5 rounded-card border border-border bg-surface p-5">
      <div className="flex items-start gap-3.5">
        <Skeleton className="h-11 w-11 flex-none rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-1/2" />
          <div className="h-2.5 w-1/3 rounded" style={{ background: "var(--neutral-soft)" }} />
        </div>
      </div>
      <div className="h-2.5 w-full rounded" style={{ background: "var(--surface-sunken)" }} />
      <div className="h-2.5 w-3/4 rounded" style={{ background: "var(--surface-sunken)" }} />
      <div className="flex items-center justify-between border-t border-border pt-3">
        <div className="h-5 w-20 rounded" style={{ background: "var(--neutral-soft)" }} />
        <div className="h-5 w-14 rounded" style={{ background: "var(--surface-sunken)" }} />
      </div>
    </div>
  );
}

/** Row-shaped skeleton for approval cards and job rows. */
export function RowSkeleton() {
  return (
    <div className="flex items-center gap-3.5 rounded-card border border-border bg-surface p-5">
      <Skeleton className="h-11 w-11 flex-none rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-1/2" />
        <div className="h-2.5 w-1/3 rounded" style={{ background: "var(--neutral-soft)" }} />
      </div>
    </div>
  );
}
