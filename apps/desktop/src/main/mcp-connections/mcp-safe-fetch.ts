import { randomUUID } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getMainLogger } from "../log";
import { discoveryFailure, mcpDiscoveryContext, mcpDiscoveryPhaseContext } from "./mcp-discovery";

const MAX_REDIRECTS = 5;
const log = getMainLogger("pwragent:mcp-connections");

export type McpSafeFetchOptions = {
  fetchFn?: FetchLike;
  connectionId?: string;
};

export function createMcpSafeFetch(options: McpSafeFetchOptions = {}): FetchLike {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    let url = new URL(input);
    let requestInit = { ...init, redirect: "manual" as const };
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      validateOutboundUrl(url);
      const startedAt = Date.now();
      const fields = {
        connectionId: options.connectionId,
        requestId: randomUUID(),
        discoveryId: mcpDiscoveryContext.getStore()?.id,
        ...mcpDiscoveryPhaseContext.getStore(),
        method: (requestInit.method ?? "GET").toUpperCase(),
        endpoint: diagnosticEndpoint(url),
        redirectCount,
      };
      if (options.connectionId) log.info("MCP HTTP request started", fields);
      let response: Response;
      try {
        response = await fetchFn(url, requestInit);
      } catch (error) {
        if (options.connectionId) log.warn("MCP HTTP request failed before response headers", {
          ...fields, elapsedMs: Date.now() - startedAt, ...discoveryFailure(error, requestInit.signal ?? undefined),
        });
        throw error;
      }
      if (options.connectionId) log.info("MCP HTTP response headers received", {
        ...fields, status: response.status, elapsedMs: Date.now() - startedAt,
      });
      if (!isRedirect(response.status)) {
        return await sanitizeHtmlResponse(response, url);
      }
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

/** Identify the route without credentials, query values or fragments. */
function diagnosticEndpoint(url: URL): string {
  const pathname = url.pathname
    .replace(/(\/(?:tokens?|secrets?|api[_-]?keys?|passwords?|bearer)\/)[^/]+/gi, "$1[redacted]")
    .replace(/[^/]{32,}/g, "[redacted]");
  return `${url.origin}${pathname}`;
}

async function sanitizeHtmlResponse(response: Response, url: URL): Promise<Response> {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const challenged = response.headers.get("cf-mitigated") === "challenge";
  if (!challenged && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return response;
  }
  if (response.ok && !challenged) {
    // Frameworks can label empty acknowledgements as HTML. A network 202
    // can have a stream even when it contains no bytes; do not trust headers
    // or buffer a whole HTML page just to distinguish it from an empty body.
    if (!response.body) return response;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        if (value.byteLength > 0) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
  // The SDK includes non-JSON error bodies verbatim in exceptions. Never
  // forward a website or browser challenge into status, logs, or IPC errors.
  await response.body?.cancel().catch(() => undefined);
  const detail = challenged
    ? `The server at ${url.origin} blocked the MCP request with a browser verification page (HTTP ${response.status}). Check the provider's MCP URL or contact the provider; this request must work without browser verification.`
    : `The server at ${url.origin} returned an HTML page instead of an MCP or OAuth response (HTTP ${response.status}). Check the provider's MCP URL and try again.`;
  if (response.ok) throw new Error(detail);
  // Keep HTTP status and authentication headers: discovery uses 404 to try
  // another endpoint, and transports use 401 / WWW-Authenticate to start OAuth.
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify({
    error: "server_error",
    error_description: detail,
  }), { status: response.status, headers });
}

function validateOutboundUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP requests must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("MCP requests cannot contain URL credentials.");
  }
  // A desktop client's configured servers can live on a VPN, LAN, or this
  // machine. Address reachability belongs to the OS, not a public-IP filter.
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Remote MCP requests must use HTTPS.");
  }
}

function isRedirect(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}
