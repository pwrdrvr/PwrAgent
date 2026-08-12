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
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "private";
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return classifyIpv4(mappedIpv4);
  if (normalized.includes(":")) {
    const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return "private";
    if ((first & 0xffc0) === 0xfe80) return "private";
    if ((first & 0xff00) === 0xff00) return "private";
    if (normalized.startsWith("2001:db8:")) return "private";
    return "public";
  }
  return classifyIpv4(normalized);
}

function classifyIpv4(address: string): "public" | "loopback" | "private" {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4
    || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return "private";
  }
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
