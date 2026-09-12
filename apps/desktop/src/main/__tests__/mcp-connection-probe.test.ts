import { describe, expect, it, vi } from "vitest";
import { probeMcpConnectionUrl } from "../mcp-connections/mcp-connection-probe";

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: vi.fn(async (url: URL) => {
    if (url.host === "oauth.example.com") return { authorizationServerMetadata: {} };
    throw new Error("no OAuth metadata");
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("probeMcpConnectionUrl", () => {
  it("names where a stdio command belongs instead of failing discovery on it", async () => {
    // This is the common case, not an edge case: most servers an operator has
    // already run are launched with npx. The gateway cannot host one, and the
    // shipped flow reported it as an OAuth failure after saving a record.
    const result = await probeMcpConnectionUrl(
      "npx -y @modelcontextprotocol/server-filesystem /tmp",
      vi.fn() as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("looks_like_stdio");
    expect(result.message).toContain("configured in the agent itself");
  });

  it("rejects text that is not a URL at all", async () => {
    const result = await probeMcpConnectionUrl("   ", vi.fn() as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("not_a_url");
  });

  it("refuses plain http to a remote host that create would reject", async () => {
    // Discovery can succeed over http, so without this the probe reported
    // "Found an MCP server ..." and offered Add for an address
    // `normalizeMcpServerUrl` then refused. The two-step flow is only worth
    // having if Check answers the same question the save does.
    const fetchFn = vi.fn();
    const result = await probeMcpConnectionUrl(
      "http://oauth.example.com/mcp",
      fetchFn as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("not_a_url");
    expect(result.message).toContain("HTTPS");
    // Refused before anything left the machine.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still allows a loopback http endpoint, as the registry does", async () => {
    const result = await probeMcpConnectionUrl(
      "http://127.0.0.1:51729/mcp",
      vi.fn(async () => jsonResponse({ jsonrpc: "2.0", result: {} })) as never,
    );
    // Reaches the probe rather than being refused for its scheme; the
    // built-in PwrSuite connections live on exactly these addresses.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).not.toBe("not_a_url");
  });

  it("accepts an endpoint that offers OAuth discovery", async () => {
    const result = await probeMcpConnectionUrl(
      "https://oauth.example.com/mcp",
      vi.fn() as never,
    );
    expect(result).toEqual({
      ok: true,
      serverUrl: "https://oauth.example.com/mcp",
      authMode: "oauth",
    });
  });

  it("tells a token-authenticated MCP server apart from a wrong address", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ "www-authenticate": "Bearer realm=\"mcp\"" }),
      text: async () => "",
    })) as never;
    const result = await probeMcpConnectionUrl("https://api.example.com/mcp", fetchFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("unsupported_auth");
    expect(result.message).toContain("rather than OAuth");
  });

  it("reports a reachable host that is not an MCP server", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "<html></html>",
    })) as never;
    const result = await probeMcpConnectionUrl("https://www.example.com", fetchFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("not_mcp");
  });

  it("reports an MCP server that wants no authorization at all", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "local" } } }),
    ) as never;
    const result = await probeMcpConnectionUrl("https://open.example.com/mcp", fetchFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("unsupported_auth");
    expect(result.message).toContain("nothing for the gateway to hold");
  });

  it("reports an unreachable host", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as never;
    const result = await probeMcpConnectionUrl("https://nope.example.com/mcp", fetchFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe("unreachable");
  });
});
