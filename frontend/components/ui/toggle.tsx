"use client";

/** A boolean preference is a toggle, not a checkbox -- design doc §04's
 *  delivery matrix and quiet-hours mocks both show switches. Native
 *  `<input type="checkbox">` renders as the browser's own tickbox with no
 *  reliable way to restyle it as a track+knob across engines, so this is a
 *  button with `role="switch"` instead (the ARIA-correct pattern for a
 *  binary on/off control that isn't a form checkbox). */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-10 flex-none items-center rounded-full border-0 p-0 transition-colors disabled:cursor-not-allowed"
      style={{ background: checked ? "var(--accent)" : "var(--neutral-soft)" }}
    >
      <span
        aria-hidden="true"
        className="block h-4 w-4 rounded-full transition-transform"
        style={{
          background: checked ? "var(--accent-fg)" : "var(--fg-faint)",
          transform: checked ? "translateX(18px)" : "translateX(4px)",
          opacity: disabled ? 0.6 : 1,
        }}
      />
    </button>
  );
}
