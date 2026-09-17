import { describe, expect, it, vi } from "vitest";
import { createMcpSafeFetch } from "../mcp-connections/mcp-safe-fetch";

describe("createMcpSafeFetch", () => {
  it.each([
    "https://mcp.example.com/mcp",
    "https://search.internal.example/mcp",
    "https://10.80.129.12/mcp",
    "https://192.168.1.2/mcp",
    "https://172.16.0.2/mcp",
    "https://[fd00::1]/mcp",
    "https://[::ffff:10.0.0.2]/mcp",
    "https://[2606:4700:4700::1111]/mcp",
    "http://localhost:51729/mcp",
    "http://127.0.0.1:51729/mcp",
    "http://[::1]:51729/mcp",
  ])("allows configured MCP destination %s", async (url) => {
    const fetchFn = vi.fn(async () => new Response("ok"));
    await expect(createMcpSafeFetch({ fetchFn })(url))
      .resolves.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([
    ["http://mcp.example.com/mcp", "must use HTTPS"],
    ["http://10.80.129.12/mcp", "must use HTTPS"],
    ["file:///tmp/mcp", "must use HTTP or HTTPS"],
    ["https://user:password@mcp.example.com/mcp", "URL credentials"],
  ])("rejects unsafe transport %s", async (url, error) => {
    const fetchFn = vi.fn();
    await expect(createMcpSafeFetch({ fetchFn })(url)).rejects.toThrow(error);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("revalidates redirects and refuses credential-bearing cross-origin POSTs", async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: "https://auth.example.net/token" },
    }));
    const safeFetch = createMcpSafeFetch({
      fetchFn,
    });

    await expect(safeFetch("https://mcp.example.com/token", {
      body: "grant_type=refresh_token",
      method: "POST",
    })).rejects.toThrow("cross-origin redirect");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("strips authorization before following a cross-origin GET redirect", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://auth.example.net/metadata" },
      }))
      .mockResolvedValueOnce(new Response("ok"));
    const safeFetch = createMcpSafeFetch({
      fetchFn,
    });

    await safeFetch("https://mcp.example.com/metadata", {
      headers: { authorization: "Bearer do-not-forward" },
    });

    const redirectedInit = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(redirectedInit.headers).has("authorization")).toBe(false);
  });

  it("follows private-network discovery redirects without forwarding credentials", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://10.80.129.12/metadata" },
      }))
      .mockResolvedValueOnce(new Response("ok"));
    await expect(createMcpSafeFetch({ fetchFn })("https://mcp.example.com/metadata", {
      headers: { authorization: "Bearer secret", cookie: "session=secret" },
    })).resolves.toMatchObject({ status: 200 });
    const headers = new Headers(fetchFn.mock.calls[1]?.[1].headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });

  it("rejects an HTTPS downgrade on redirect", async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://10.80.129.12/metadata" },
    }));
    await expect(createMcpSafeFetch({ fetchFn })("https://mcp.example.com/metadata"))
      .rejects.toThrow("must use HTTPS");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
