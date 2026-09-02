import { Toggle } from "./ui/toggle";

export function notificationDeviceHint(deviceCount: number | null): string {
  if (deviceCount === null) return "Checking enabled devices…";
  if (deviceCount === 0) return "No devices are enabled yet. You can still request a notification for later delivery.";
  return `Notification will be sent to ${deviceCount} enabled ${deviceCount === 1 ? "device" : "devices"}.`;
}

export function NotificationIntentControl({
  checked,
  onChange,
  deviceCount,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  deviceCount: number | null;
}) {
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2.5 font-sans text-[13px] text-fg-muted">
      <Toggle checked={checked} onChange={onChange} label="Notify me when this finishes" />
      <span>
        <span className="block font-medium text-fg">Notify me when this finishes</span>
        <span className="mt-0.5 block text-xs text-fg-faint">{notificationDeviceHint(deviceCount)}</span>
      </span>
    </label>
  );
}
