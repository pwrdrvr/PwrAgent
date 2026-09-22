import { describe, expect, it, vi } from "vitest";
import { createMcpSafeFetch } from "../mcp-connections/mcp-safe-fetch";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

describe("createMcpSafeFetch", () => {
  it("keeps Cloudflare challenge HTML out of SDK OAuth errors", async () => {
    const response = new Response("<!DOCTYPE html><script>private-challenge</script>", {
      status: 403,
      headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchFn = vi.fn(async () => response);
    const result = await createMcpSafeFetch({ fetchFn })("https://claude.ai/register?secret=value");
    const error = await parseErrorResponse(result);
    expect(error.message).toContain("browser verification");
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toMatch(/private-challenge|<script>|secret=value/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([401, 404, 502])("preserves HTTP %s semantics while replacing HTML", async (status) => {
    const fetchFn = vi.fn(async () => new Response("<html>private page</html>", {
      status,
      headers: {
        "content-type": "Text/HTML; charset=utf-8",
        "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.com/metadata\"",
        "content-length": "999",
        "content-encoding": "gzip",
      },
    }));
    const result = await createMcpSafeFetch({ fetchFn })("https://mcp.example.com/mcp");
    expect(result.status).toBe(status);
    expect(result.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(result.headers.has("content-length")).toBe(false);
    expect(result.headers.has("content-encoding")).toBe(false);
    expect(await result.text()).not.toContain("private page");
  });

  it.each([200, 202])("rejects an HTTP %s HTML landing page without exposing its body", async (status) => {
    const fetchFn = vi.fn(async () => new Response("<html>private page</html>", {
      status,
      headers: { "content-type": "text/html" },
    }));
    await expect(createMcpSafeFetch({ fetchFn })("https://mcp.example.com/mcp"))
      .rejects.toThrow("returned an HTML page instead of an MCP or OAuth response");
  });

  it.each([null, "", "empty-stream"])("delivers SDK notifications with an empty HTML-labelled 202 (%s)", async (body) => {
    const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
      // Initialization starts an optional SSE GET after the acknowledged POST.
      if (init?.method === "GET") return new Response(null, { status: 405 });
      return new Response(
        body === "empty-stream"
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array());
                controller.close();
              },
            })
          : body,
        { status: 202, headers: { "content-type": "text/html" } },
      );
    });
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
      fetch: createMcpSafeFetch({ fetchFn }),
    });
    await transport.start();
    try {
      await expect(transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }))
        .resolves.toBeUndefined();
      expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally {
      await transport.close();
    }
  });

  it("terminates an SDK session with an empty HTML-labelled 204", async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 204,
      headers: { "content-type": "text/html" },
    }));
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
      sessionId: "test-session",
      fetch: createMcpSafeFetch({ fetchFn }),
    });
    await transport.start();
    try {
      await expect(transport.terminateSession()).resolves.toBeUndefined();
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(transport.sessionId).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it("preserves JSON OAuth errors without consuming the response", async () => {
    const response = new Response(JSON.stringify({ error: "invalid_client" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const fetchFn = vi.fn(async () => response);
    expect(await createMcpSafeFetch({ fetchFn })("https://mcp.example.com/token")).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });

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
