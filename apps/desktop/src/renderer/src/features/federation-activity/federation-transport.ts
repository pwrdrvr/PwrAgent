import type { FederationActiveConnection } from "@pwragent/shared";

/**
 * The one word a Federation chip says about how an instance is reached.
 * Display only: it is inferred from addresses this instance observed, never
 * from anything a peer claims, and nothing is authorized on it.
 */
export type FederationTransportTag =
  | "Cloudflare"
  | "Tailscale"
  | "LAN"
  | "Local"
  | "Direct"
  | "Relay";

/** Strip a port and IPv6 brackets: `[fd00::1]:47830` → `fd00::1`. */
function hostOf(address: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) return bracketed[1];
  const colons = address.split(":").length - 1;
  return colons === 1 ? address.slice(0, address.lastIndexOf(":")) : address;
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

function classifyHost(rawHost: string): Exclude<FederationTransportTag, "Cloudflare" | "Relay"> {
  const host = rawHost.toLowerCase().replace(/^::ffff:/, "");
  if (host === "localhost" || host === "::1") return "Local";
  if (host.endsWith(".ts.net")) return "Tailscale";
  if (host.endsWith(".local")) return "LAN";
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "Local";
    // Tailscale's CGNAT range, 100.64.0.0/10.
    if (a === 100 && b >= 64 && b <= 127) return "Tailscale";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254)) return "LAN";
    return "Direct";
  }
  if (host.includes(":")) {
    if (host.startsWith("fd7a:115c:a1e0:")) return "Tailscale";
    if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return "LAN";
  }
  return "Direct";
}

export function federationTransportTag(connection: FederationActiveConnection): FederationTransportTag {
  if (connection.via === "cloudflare-tunnel") return "Cloudflare";
  if (connection.direction === "outgoing") {
    if (!connection.endpoint) return "Direct";
    try {
      return classifyHost(new URL(connection.endpoint).hostname.replace(/^\[|\]$/g, ""));
    } catch {
      return "Direct";
    }
  }
  return connection.remoteAddress ? classifyHost(hostOf(connection.remoteAddress)) : "Direct";
}
