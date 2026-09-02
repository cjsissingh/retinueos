import { createHash } from "node:crypto";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- Audit payloads deliberately accept arbitrary JSON-compatible values. */

const REDACTED = "[REDACTED]";
const SENSITIVE_SEGMENTS = new Set(["token", "password", "secret", "credential", "authorization"]);

function isSensitiveKey(key: string): boolean {
  const segments = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  return (
    segments.some((segment) => SENSITIVE_SEGMENTS.has(segment)) ||
    segments.includes("apikey") ||
    segments.some((segment, index) => segment === "api" && segments[index + 1] === "key")
  );
}

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  // SAFETY: `value` has been narrowed to an object and JSON serialization
  // itself consults this optional hook before enumerating object keys.
  const jsonValue = value as { toJSON?: unknown };
  if (typeof jsonValue.toJSON === "function") {
    // SAFETY: The runtime function check establishes JSON's standard
    // serialization hook before invoking it, matching JSON.stringify.
    return redactAuditValue((value as { toJSON(): unknown }).toJSON());
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactAuditValue(nestedValue),
    ]),
  );
}

export function boundJson(value: unknown, maxBytes: number): unknown {
  const redacted = redactAuditValue(value);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined) {
    return redacted;
  }

  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= maxBytes) {
    return redacted;
  }

  return {
    truncated: true,
    algorithm: "sha256",
    digest: createHash("sha256").update(serialized).digest("hex"),
    originalBytes,
  };
}
