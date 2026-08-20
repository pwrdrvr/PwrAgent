// Default endpoint set written into new enrollment invites when the operator
// has not pinned an explicit advertised list.
//
// An invite is copied once and lived with for months, so the one thing it must
// not carry alone is a DHCP literal. When the lease moves, every enrolled
// client keeps dialing an address that now belongs to a different machine,
// which answers the SYN with a reset — an endless ECONNREFUSED with no way
// back short of re-enrolling. Names that follow the machine therefore come
// first, and address literals stay only as the fallback for networks that
// block mDNS.
//
// Widening the list is safe by construction: every endpoint in an invite
// authenticates against the same pinned gateway signing key and Noise static
// key, so a stale or wrong candidate can only cost a dial, never reach a
// different gateway (see federation-endpoints.ts for the walk order). It is
// not free, though — a candidate that blackholes rather than refuses burns a
// full connect timeout on every reconnect cycle. So this builder emits few,
// plausible candidates rather than every address the host owns.

import os from "node:os";
import {
  type FederationTailscaleStatus,
  isFederationGatewayEndpointUrl,
} from "@pwragent/shared";

/**
 * Upper bound on a synthesized list. Each unreachable candidate costs a
 * client one connect timeout per reconnect cycle, so the default set stays
 * short; an operator who needs more paths pins them explicitly.
 */
const MAX_ADVERTISED_ENDPOINTS = 6;

const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD_LISTEN_HOSTS = new Set(["", "0.0.0.0", "::", "[::]", "*"]);

/** Conservative DNS-label shape: rejects the spaces and quotes a descriptive
 * machine name can carry, which would otherwise reach clients as an
 * unparseable URL. */
const DNS_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

export type FederationInterfaceAddress = {
  name: string;
  address: string;
  family: string | number;
  internal: boolean;
};

/**
 * Interface name prefixes whose addresses cannot serve a remote peer: host-only
 * bridges for VMs and Internet Sharing, container bridges, and the link-local
 * radios macOS uses for AirDrop. They are not marked `internal`, so without
 * this list a machine running Docker or a VM advertises an address that every
 * client dials and every client times out on. VPN tunnels are deliberately
 * absent — a corporate tunnel can be a real path, and Tailscale's own address
 * is handled by the CGNAT rule below.
 */
const HOST_ONLY_INTERFACE_PREFIXES = [
  "anpi",
  "awdl",
  "br-",
  "bridge",
  "cni",
  "docker",
  "llw",
  "lxcbr",
  "veth",
  "vethernet",
  "virbr",
  "vmenet",
  "vmnet",
  "vboxnet",
];

export type FederationTailscaleAdvertisement = {
  dnsName?: string;
  serveUrl?: string;
};

export type FederationAdvertisedEndpointInputs = {
  listenHost: string;
  listenPort: number;
  hostname: string;
  platform: NodeJS.Platform;
  publicUrl?: string;
  interfaceAddresses?: readonly FederationInterfaceAddress[];
  tailscale?: FederationTailscaleAdvertisement;
};

/**
 * The name an invite should carry for this machine, or undefined when the
 * hostname cannot serve as one.
 *
 * macOS already returns the mDNS name from `os.hostname()` (`Studio.local`),
 * so any dotted name is used as-is — that also covers a real FQDN on a
 * managed network. A bare name gets `.local` appended only where the platform
 * answers mDNS for it: Windows advertises over LLMNR rather than mDNS, so a
 * synthesized `.local` there would never resolve and would cost every client
 * a dial timeout on each cycle.
 */
export function federationHostnameEndpointCandidate(params: {
  hostname: string;
  platform: NodeJS.Platform;
}): string | undefined {
  const hostname = params.hostname.trim().replace(/\.$/, "");
  if (!hostname || !DNS_NAME_PATTERN.test(hostname)) return undefined;
  if (hostname.includes(".")) return hostname;
  if (params.platform === "win32") return hostname;
  return `${hostname}.local`;
}

/**
 * Endpoints for a new invite, most durable first: the operator's public URL,
 * this machine's name, its tailnet path, then address literals.
 */
export function buildFederationAdvertisedEndpoints(
  inputs: FederationAdvertisedEndpointInputs,
): string[] {
  const port = inputs.listenPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
  const listenHost = inputs.listenHost.trim().toLowerCase();
  const candidates: string[] = [];
  const publicUrl = inputs.publicUrl?.trim();
  if (publicUrl) candidates.push(publicUrl);

  if (LOOPBACK_LISTEN_HOSTS.has(listenHost)) {
    // A loopback-bound gateway serves nothing off this machine. Advertising
    // its name or LAN literals would hand every client an endpoint that
    // refuses, so keep the invite honest about the binding instead.
    candidates.push(formatEndpoint(listenHost, port));
    return finalizeEndpoints(candidates);
  }

  const hostname = federationHostnameEndpointCandidate({
    hostname: inputs.hostname,
    platform: inputs.platform,
  });
  if (hostname) candidates.push(formatEndpoint(hostname, port));

  const tailnet = tailscaleCandidate(inputs.tailscale, port);
  if (tailnet) candidates.push(tailnet);

  candidates.push(
    ...literalCandidates({
      listenHost,
      port,
      interfaceAddresses: inputs.interfaceAddresses ?? [],
      hasTailnetCandidate: tailnet !== undefined,
    }),
  );

  return finalizeEndpoints(candidates);
}

/**
 * Narrows a Tailscale status to what an invite can advertise. A Serve or
 * Funnel handler is preferred over the raw tailnet dial because the operator
 * configured it deliberately and it survives a firewall that blocks the
 * federation port on the tailnet interface.
 */
export function federationTailscaleAdvertisementFromStatus(
  status: FederationTailscaleStatus,
): FederationTailscaleAdvertisement | undefined {
  if (!status.connected) return undefined;
  const serveUrl =
    status.serveConfigured || status.funnelConfigured
      ? status.gatewayUrl
      : undefined;
  if (!serveUrl && !status.dnsName) return undefined;
  return {
    ...(status.dnsName ? { dnsName: status.dnsName } : {}),
    ...(serveUrl ? { serveUrl } : {}),
  };
}

/** Non-internal interface addresses of this machine, in `os` order. */
export function collectFederationInterfaceAddresses(): FederationInterfaceAddress[] {
  const collected: FederationInterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      collected.push({
        name,
        address: entry.address,
        family: entry.family,
        internal: entry.internal,
      });
    }
  }
  return collected;
}

function tailscaleCandidate(
  tailscale: FederationTailscaleAdvertisement | undefined,
  port: number,
): string | undefined {
  const serveUrl = tailscale?.serveUrl?.trim();
  if (serveUrl) return serveUrl;
  const dnsName = tailscale?.dnsName?.trim().replace(/\.$/, "");
  if (!dnsName || !DNS_NAME_PATTERN.test(dnsName)) return undefined;
  return formatEndpoint(dnsName, port);
}

function literalCandidates(params: {
  listenHost: string;
  port: number;
  interfaceAddresses: readonly FederationInterfaceAddress[];
  hasTailnetCandidate: boolean;
}): string[] {
  if (!WILDCARD_LISTEN_HOSTS.has(params.listenHost)) {
    // Bound to one address: that address is the only literal that can serve,
    // so enumerating the other interfaces would only add dead candidates.
    return [formatEndpoint(params.listenHost, params.port)];
  }
  const literals: string[] = [];
  for (const entry of params.interfaceAddresses) {
    if (entry.internal || isHostOnlyInterface(entry.name)) continue;
    // IPv6 is deliberately omitted: link-local addresses need a scope id that
    // does not survive the trip to another machine, and a routable v6 address
    // is reached through the same names already advertised above.
    if (entry.family !== "IPv4" && entry.family !== 4) continue;
    const address = entry.address.trim();
    if (!address || address.startsWith("169.254.")) continue;
    // The tailnet name already covers this address and resolves from any
    // network, so the CGNAT literal would be a redundant extra dial.
    if (params.hasTailnetCandidate && isCarrierGradeNat(address)) continue;
    literals.push(formatEndpoint(address, params.port));
  }
  return literals;
}

function isHostOnlyInterface(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return HOST_ONLY_INTERFACE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

/** Tailscale's 100.64.0.0/10 range. */
function isCarrierGradeNat(address: string): boolean {
  const octets = address.split(".");
  if (octets.length !== 4 || octets[0] !== "100") return false;
  const second = Number(octets[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
}

function formatEndpoint(host: string, port: number): string {
  const authority = host.includes(":") && !host.startsWith("[")
    ? `[${host}]`
    : host;
  return `ws://${authority}:${port}`;
}

function finalizeEndpoints(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || !isFederationGatewayEndpointUrl(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push(trimmed);
    if (endpoints.length >= MAX_ADVERTISED_ENDPOINTS) break;
  }
  return endpoints;
}
