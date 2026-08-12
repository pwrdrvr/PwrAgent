import { describe, expect, it, vi } from "vitest";
import { createMcpSafeFetch } from "../mcp-connections/mcp-safe-fetch";

describe("createMcpSafeFetch", () => {
  it("allows public HTTPS destinations", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));
    const safeFetch = createMcpSafeFetch({
      fetchFn,
      lookupHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    });

    await expect(safeFetch("https://mcp.example.com/mcp"))
      .resolves.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("blocks private, metadata, and loopback resolution by default", async () => {
    for (const address of ["10.0.0.2", "169.254.169.254", "127.0.0.1", "::1"]) {
      const fetchFn = vi.fn();
      const safeFetch = createMcpSafeFetch({
        fetchFn,
        lookupHost: vi.fn(async () => [{
          address,
          family: address.includes(":") ? 6 : 4,
        }]),
      });

      await expect(safeFetch("https://mcp.example.com/mcp"))
        .rejects.toThrow(/blocked/);
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it("allows explicit loopback HTTP but rejects public HTTP", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));
    const loopbackFetch = createMcpSafeFetch({
      allowLoopback: true,
      fetchFn,
    });
    await expect(loopbackFetch("http://127.0.0.1:51729/mcp"))
      .resolves.toMatchObject({ status: 200 });

    const publicFetch = createMcpSafeFetch({
      fetchFn,
      lookupHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    });
    await expect(publicFetch("http://mcp.example.com/mcp"))
      .rejects.toThrow("must use HTTPS");
  });

  it("revalidates redirects and refuses credential-bearing cross-origin POSTs", async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: "https://auth.example.net/token" },
    }));
    const safeFetch = createMcpSafeFetch({
      fetchFn,
      lookupHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
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
      lookupHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    });

    await safeFetch("https://mcp.example.com/metadata", {
      headers: { authorization: "Bearer do-not-forward" },
    });

    const redirectedInit = fetchFn.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(redirectedInit.headers).has("authorization")).toBe(false);
  });
});
