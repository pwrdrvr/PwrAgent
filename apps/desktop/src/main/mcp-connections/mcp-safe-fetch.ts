import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const MAX_REDIRECTS = 5;

type LookupHost = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export type McpSafeFetchOptions = {
  allowLoopback?: boolean;
  fetchFn?: FetchLike;
  lookupHost?: LookupHost;
};

export function createMcpSafeFetch(options: McpSafeFetchOptions = {}): FetchLike {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const lookupHost: LookupHost = options.lookupHost ?? lookup;
  return async (input, init) => {
    let url = new URL(input);
    let requestInit = { ...init, redirect: "manual" as const };
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await validateOutboundUrl(url, {
        allowLoopback: options.allowLoopback === true,
        lookupHost,
      });
      const response = await fetchFn(url, requestInit);
      if (!isRedirect(response.status)) return response;
      if (redirectCount === MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("The MCP server redirected too many times.");
      }
      const location = response.headers.get("location");
      if (!location) return response;
      const nextUrl = new URL(location, url);
      const crossOrigin = nextUrl.origin !== url.origin;
      const method = (requestInit.method ?? "GET").toUpperCase();
      if (crossOrigin && method !== "GET" && method !== "HEAD") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          "The MCP server attempted a cross-origin redirect for a credential-bearing request.",
        );
      }
      const headers = new Headers(requestInit.headers);
      if (crossOrigin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      const switchToGet = response.status === 303
        || ((response.status === 301 || response.status === 302)
          && method === "POST");
      requestInit = {
        ...requestInit,
        ...(switchToGet
          ? { body: undefined, method: "GET" }
          : {}),
        headers,
      };
      await response.body?.cancel().catch(() => undefined);
      url = nextUrl;
    }
    throw new Error("The MCP server redirect could not be completed.");
  };
}

async function validateOutboundUrl(
  url: URL,
  options: {
    allowLoopback: boolean;
    lookupHost: LookupHost;
  },
): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP requests must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("MCP requests cannot contain URL credentials.");
  }
  const hostname = normalizeHostname(url.hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await options.lookupHost(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("The MCP server hostname did not resolve.");
  }
  let allLoopback = true;
  for (const entry of addresses) {
    const classification = classifyAddress(entry.address);
    if (classification === "public") {
      allLoopback = false;
      continue;
    }
    if (classification === "loopback" && options.allowLoopback) continue;
    throw new Error(
      `The MCP server resolved to a blocked ${classification} address.`,
    );
  }
  if (url.protocol === "http:" && !allLoopback) {
    throw new Error("Remote MCP requests must use HTTPS.");
  }
}

function classifyAddress(address: string): "public" | "loopback" | "private" {
  const normalized = normalizeHostname(address).toLowerCase();
  const family = isIP(normalized);
  if (family === 6) return classifyIpv6(normalized);
  if (family === 4) return classifyIpv4(normalized);
  // Not an address we can reason about. Fail closed.
  return "private";
}

/**
 * Classify an IPv6 literal by expanding it to its eight groups first.
 *
 * Matching on the textual form is not safe here: `new URL()` re-serializes a
 * literal through the WHATWG host serializer, so `[::ffff:169.254.169.254]`
 * arrives as `[::ffff:a9fe:a9fe]` and a dotted-quad pattern never sees it.
 * Several prefixes also carry an IPv4 destination in their low bits, and each
 * of those has to be classified as the IPv4 address it actually reaches.
 */
function classifyIpv6(address: string): "public" | "loopback" | "private" {
  const groups = expandIpv6(address);
  if (!groups) return "private";
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embeddedIpv4 = formatIpv4(g6, g7);
  const highZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible).
  if (highZero && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0) {
      if (g7 === 0) return "private";
      if (g7 === 1) return "loopback";
    }
    return classifyIpv4(embeddedIpv4);
  }
  // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64).
  if (g0 === 0x64 && g1 === 0xff9b) return classifyIpv4(embeddedIpv4);
  // 2002::/16 (6to4) carries its IPv4 relay in the next 32 bits.
  if (g0 === 0x2002) return classifyIpv4(formatIpv4(g1, g2));
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  if ((g0 & 0xffc0) === 0xfe80) return "private";
  if ((g0 & 0xff00) === 0xff00) return "private";
  if (g0 === 0x2001 && g1 === 0x0db8) return "private";
  if (g0 === 0x2001 && g1 === 0x0000) return "private";
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "private";
  return "public";
}

function expandIpv6(address: string): number[] | undefined {
  let text = address;
  const embedded = text.match(/:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embedded) {
    const octets = parseIpv4Octets(embedded);
    if (!octets) return undefined;
    const [a, b, c, d] = octets;
    const head = ((a << 8) | b).toString(16);
    const tail = ((c << 8) | d).toString(16);
    text = `${text.slice(0, text.length - embedded.length)}${head}:${tail}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const leading = halves[0] ? halves[0].split(":") : [];
  const trailing = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const elided = halves.length === 2
    ? 8 - leading.length - trailing.length
    : 0;
  if (halves.length === 2 && elided < 1) return undefined;
  const groups = [
    ...leading,
    ...Array.from({ length: elided }, () => "0"),
    ...trailing,
  ];
  if (groups.length !== 8) return undefined;
  const parsed = groups.map((group) => Number.parseInt(group, 16));
  if (
    parsed.some(
      (group) => !Number.isInteger(group) || group < 0 || group > 0xffff,
    )
  ) {
    return undefined;
  }
  return parsed;
}

function formatIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function parseIpv4Octets(address: string): number[] | undefined {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4
    || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return octets;
}

function classifyIpv4(address: string): "public" | "loopback" | "private" {
  const octets = parseIpv4Octets(address);
  if (!octets) return "private";
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (
    a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  ) {
    return "private";
  }
  return "public";
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isRedirect(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}
