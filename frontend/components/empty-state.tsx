import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[440px] py-8 text-center">
      <p className="m-0 font-serif text-xl text-fg">{title}</p>
      {description && (
        <p className="mx-auto mb-0 mt-2 font-sans text-sm leading-relaxed text-fg-muted">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
