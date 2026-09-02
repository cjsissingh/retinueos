import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

interface Cidr {
  network: bigint;
  prefix: number;
}

function ipv4Value(address: string): bigint | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(address: string): bigint | undefined {
  const normalized = address.toLowerCase().split("%")[0];
  if (!normalized || isIP(normalized) !== 6) return undefined;
  let text = normalized;
  const dottedTail = text.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const v4 = ipv4Value(dottedTail);
    if (v4 === undefined) return undefined;
    text = `${text.slice(0, -dottedTail.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return undefined;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function cidr4(network: string, prefix: number): Cidr {
  return { network: ipv4Value(network)!, prefix };
}

function cidr6(network: string, prefix: number): Cidr {
  return { network: ipv6Value(network)!, prefix };
}

function contains(value: bigint, cidr: Cidr, bits: number): boolean {
  const shift = BigInt(bits - cidr.prefix);
  return value >> shift === cidr.network >> shift;
}

// Non-global entries from the IANA IPv4 Special-Purpose Address Registry.
// The whole 192.0.0.0/24 protocol-assignment block is denied, including its
// otherwise-global anycast exceptions: MCP servers have no reason to live on
// protocol anycast addresses and a conservative boundary is safer here.
const NON_GLOBAL_IPV4 = [
  cidr4("0.0.0.0", 8),
  cidr4("10.0.0.0", 8),
  cidr4("100.64.0.0", 10),
  cidr4("127.0.0.0", 8),
  cidr4("169.254.0.0", 16),
  cidr4("172.16.0.0", 12),
  cidr4("192.0.0.0", 24),
  cidr4("192.0.2.0", 24),
  cidr4("192.88.99.0", 24),
  cidr4("192.168.0.0", 16),
  cidr4("198.18.0.0", 15),
  cidr4("198.51.100.0", 24),
  cidr4("203.0.113.0", 24),
  cidr4("224.0.0.0", 4),
  cidr4("240.0.0.0", 4),
];

// IPv6 uses a positive outer allow boundary (2000::/3, global unicast) plus
// the IANA non-global subranges inside it. Mapped, translated, NAT64,
// site/link-local, ULA, discard-only, and multicast ranges are outside the
// outer allocation, eliminating format-specific bypasses.
const GLOBAL_UNICAST_IPV6 = cidr6("2000::", 3);
const IETF_PROTOCOL_ASSIGNMENTS = cidr6("2001::", 23);
// IANA marks the containing 2001::/23 non-global by default. Only these
// more-specific entries currently carry Globally Reachable=True.
const GLOBAL_IETF_PROTOCOL_EXCEPTIONS = [
  cidr6("2001:1::1", 128), // PCP anycast
  cidr6("2001:1::2", 128), // TURN anycast
  cidr6("2001:1::3", 128), // DNS-SD service registration anycast
  cidr6("2001:3::", 32), // AMT
  cidr6("2001:4:112::", 48), // AS112-v6
  cidr6("2001:20::", 28), // ORCHIDv2
  cidr6("2001:30::", 28), // Drone Remote ID entity tags
];
const NON_GLOBAL_IPV6 = [
  cidr6("2001::", 32), // Teredo
  cidr6("2001:2::", 48), // benchmarking
  cidr6("2001:10::", 28), // ORCHID (deprecated)
  cidr6("2001:20::", 28), // ORCHIDv2
  cidr6("2001:db8::", 32), // documentation
  cidr6("2002::", 16), // 6to4 translation
  cidr6("3fff::", 20), // documentation
];

function isGlobalUnicastAddress(address: string): boolean {
  const normalized = normalizedHostname(address).toLowerCase().split("%")[0] ?? "";
  const version = isIP(normalized);
  if (version === 4) {
    const value = ipv4Value(normalized)!;
    return !NON_GLOBAL_IPV4.some((cidr) => contains(value, cidr, 32));
  }
  if (version === 6) {
    const value = ipv6Value(normalized)!;
    if (contains(value, IETF_PROTOCOL_ASSIGNMENTS, 128)) {
      return GLOBAL_IETF_PROTOCOL_EXCEPTIONS.some((cidr) => contains(value, cidr, 128));
    }
    return contains(value, GLOBAL_UNICAST_IPV6, 128) && !NON_GLOBAL_IPV6.some((cidr) => contains(value, cidr, 128));
  }
  return false;
}

export type McpHostnameResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<Array<{ address: string; family: number }>>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("MCP DNS preflight aborted");
}

function resolveWithSignal(
  resolve: McpHostnameResolver,
  hostname: string,
  signal?: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
  if (!signal) return resolve(hostname);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const pending = resolve(hostname, signal);
  return new Promise((accept, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    // Both outcomes always have handlers, even if abort wins the race, so a
    // resolver that rejects later cannot create an unhandled rejection.
    pending.then(
      (addresses) => {
        signal.removeEventListener("abort", onAbort);
        accept(addresses);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

/** Synchronous storage-boundary validation. DNS is checked again immediately
 * before every outbound request by assertRemoteMcpDestination. */
export function parseRemoteMcpUrl(value: string): URL {
  const url = new URL(value);
  const hostname = normalizedHostname(url.hostname).toLowerCase();
  const ipVersion = isIP(hostname);
  if (url.protocol !== "https:") throw new Error("MCP server URL must use HTTPS");
  if (url.username || url.password) throw new Error("MCP server URL must not contain credentials");
  if (url.hash) throw new Error("MCP server URL must not contain a fragment");
  // Non-default HTTPS ports are allowed deliberately: remote MCP deployments
  // commonly expose a dedicated TLS port, and the same DNS/IP SSRF checks
  // apply regardless of port.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (ipVersion === 0 && !hostname.includes(".")) ||
    (ipVersion !== 0 && !isGlobalUnicastAddress(hostname))
  ) {
    throw new Error("MCP server URL must resolve to a public remote host");
  }
  return url;
}

export interface RemoteMcpDestination {
  url: URL;
  /** The exact address DNS resolved to and validated as global-unicast, with
   *  its address family — null when the URL already used an IP literal (no
   *  DNS involved, so there's no rebinding window to close). Callers MUST
   *  connect to this pinned address instead of letting the outbound request
   *  re-resolve the hostname itself: a hostile MCP server operator controls
   *  authoritative DNS for their own hostname and can answer this preflight
   *  with a public address while answering a second, independent resolution
   *  moments later with a private one. Pinning the validated address closes
   *  that window; see mcp-client.ts's post() for how the pinned address is
   *  threaded into the actual connection (undici dispatcher `connect.lookup`
   *  override) while the original hostname is preserved for Host/SNI. */
  address: { host: string; family: 4 | 6 } | null;
}

/** Request-boundary SSRF check. Every hostname is resolved, including DNS
 * names reserved for examples/tests; tests inject a deterministic resolver.
 * The returned `address` (when set) is the specific validated address the
 * caller must pin its connection to — see RemoteMcpDestination's doc comment
 * for why re-resolving the hostname a second time would reopen a DNS-
 * rebinding SSRF bypass. */
export async function assertRemoteMcpDestination(
  value: string,
  resolve: McpHostnameResolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  signal?: AbortSignal,
): Promise<RemoteMcpDestination> {
  const url = parseRemoteMcpUrl(value);
  const hostname = normalizedHostname(url.hostname).toLowerCase();
  const literalVersion = isIP(hostname);
  if (literalVersion) return { url, address: null };

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveWithSignal(resolve, hostname, signal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw new Error(`could not resolve MCP server hostname ${hostname}`, { cause: error });
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isGlobalUnicastAddress(address))) {
    throw new Error("MCP server URL resolves to a private or non-routable address");
  }
  const pinned = addresses[0]!;
  return { url, address: { host: pinned.address, family: isIP(pinned.address) === 6 ? 6 : 4 } };
}
