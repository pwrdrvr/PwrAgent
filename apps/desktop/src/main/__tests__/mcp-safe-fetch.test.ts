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

  it("blocks IPv6 literals that reach a blocked IPv4 destination", async () => {
    // `new URL()` re-serializes these through the WHATWG host serializer, so
    // the classifier only ever sees the hex form: `[::ffff:169.254.169.254]`
    // arrives as `[::ffff:a9fe:a9fe]`.
    const blocked = [
      "https://[::ffff:169.254.169.254]/mcp",
      "https://[::ffff:127.0.0.1]/mcp",
      "https://[::ffff:10.0.0.2]/mcp",
      "https://[::127.0.0.1]/mcp",
      "https://[64:ff9b::169.254.169.254]/mcp",
      "https://[2002:a9fe:a9fe::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://[fe80::1]/mcp",
      "https://[2001:db8::1]/mcp",
      "https://[::]/mcp",
    ];
    for (const url of blocked) {
      const fetchFn = vi.fn();
      const safeFetch = createMcpSafeFetch({ fetchFn });

      await expect(safeFetch(url)).rejects.toThrow(/blocked/);
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it("still allows public IPv6 literals", async () => {
    for (const url of [
      "https://[2606:4700:4700::1111]/mcp",
      "https://[::ffff:93.184.216.34]/mcp",
    ]) {
      const fetchFn = vi.fn(async () => new Response("ok"));
      const safeFetch = createMcpSafeFetch({ fetchFn });

      await expect(safeFetch(url)).resolves.toMatchObject({ status: 200 });
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });

  it("blocks a hostname that resolves to a mapped IPv6 loopback address", async () => {
    const fetchFn = vi.fn();
    const safeFetch = createMcpSafeFetch({
      fetchFn,
      lookupHost: vi.fn(async () => [{ address: "::ffff:7f00:1", family: 6 }]),
    });

    await expect(safeFetch("https://mcp.example.com/mcp"))
      .rejects.toThrow(/blocked loopback/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
