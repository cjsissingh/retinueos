export function ErrorState({
  title = "Couldn't reach the house",
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-r-card border border-l-0 p-4"
      style={{
        borderColor: "var(--danger-soft-border)",
        borderLeftWidth: 3,
        borderLeftColor: "var(--danger)",
        borderLeftStyle: "solid",
        background: "var(--danger-soft)",
      }}
    >
      <p className="mb-1 font-sans text-sm font-semibold" style={{ color: "var(--danger-soft-fg)" }}>
        {title}
      </p>
      {detail && <p className="mb-3 font-sans text-[13px] leading-relaxed text-fg-muted">{detail}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex min-h-11 items-center rounded-button border px-3 font-sans text-[13px] font-medium"
          style={{
            borderColor: "var(--danger-soft-border)",
            color: "var(--danger-soft-fg)",
            background: "var(--surface)",
          }}
        >
          Try again
        </button>
      )}
    </div>
  );
}
