export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

const COL_CLASS = {
  2: "grid-cols-2",
  3: "grid-cols-3",
} as const;

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}) {
  const cols = options.length === 2 ? COL_CLASS[2] : COL_CLASS[3];

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`grid ${cols} gap-1 rounded-button border border-border-strong bg-surface-sunken p-1 ${className}`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.disabledReason}
            onClick={() => onChange(option.value)}
            className={
              selected
                ? "min-h-11 min-w-0 rounded-button border-0 bg-surface px-3 font-sans text-xs font-medium text-fg shadow-rest focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-35"
                : "min-h-11 min-w-0 rounded-button border-0 bg-transparent px-3 font-sans text-xs font-medium text-fg-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-35"
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
