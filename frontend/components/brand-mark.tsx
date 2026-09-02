export function BrandMark({ size = 32, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
    >
      <path d="M7 8.5 16 3l9 5.5v10L16 29l-9-5.5z" fill="currentColor" opacity="0.16" />
      <path d="m12.5 13.5 2 4.5m5-4.5-2 4.5" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="11" cy="11.5" r="3" fill="currentColor" />
      <circle cx="21" cy="11.5" r="3" fill="currentColor" />
      <circle cx="16" cy="21" r="3" fill="currentColor" />
    </svg>
  );
}
