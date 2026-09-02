import type { ReactNode } from "react";
import Link from "next/link";

/** Eyebrow + serif title + right-aligned actions, single hairline under —
 * the header pattern every route repeats. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  backHref,
}: {
  eyebrow: ReactNode;
  title: string;
  description?: string;
  actions?: ReactNode;
  backHref?: string;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        {backHref && (
          <Link href={backHref} className="mb-3 inline-flex min-h-11 items-center font-sans text-sm text-fg-muted">
            <span aria-hidden="true">←</span>&nbsp; Back
          </Link>
        )}
        <p className="m-0 mb-1 font-mono text-[11px] uppercase tracking-wider text-fg-faint">{eyebrow}</p>
        <h1 className="m-0 text-balance font-serif text-[30px] leading-[1.1] text-fg sm:text-[34px]">{title}</h1>
        {description && (
          <p className="m-0 mt-2 max-w-[660px] font-sans text-sm leading-relaxed text-fg-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 [&_button]:min-h-11">{actions}</div>}
    </header>
  );
}
