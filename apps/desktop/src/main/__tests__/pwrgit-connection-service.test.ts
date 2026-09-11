import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PwrGitConnectionService } from "../mcp-connections/pwrgit-connection-service";

const ENDPOINT = "http://127.0.0.1:51731/mcp";
// PwrGit's desktop HTTP surface has no /health, /pair/* or bundled stdio helper.
const METADATA = {
  resource: ENDPOINT,
  resource_name: "PwrGit",
  authorization_servers: ["http://127.0.0.1:51731/"],
};
const services: PwrGitConnectionService[] = [];
function settings(initial?: string) {
  let value = initial;
  return {
    resolvePwrGitMcpCredential: vi.fn(async () => value),
    savePwrGitMcpCredential: vi.fn(async (next: string) => { value = next; }),
    clearPwrGitMcpCredential: vi.fn(async () => { value = undefined; }),
  };
}
function reachable(input: string | URL) {
  if (String(input) === ENDPOINT) return Promise.resolve(new Response(null, { status: 405 }));
  if (String(input).endsWith("/.well-known/oauth-protected-resource/mcp")) {
    return Promise.resolve(Response.json(METADATA));
  }
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
}
function create(options: ConstructorParameters<typeof PwrGitConnectionService>[0] = {}) {
  const service = new PwrGitConnectionService({
    settings: settings(), fetchFn: reachable, resolveInstallPaths: () => [], ...options,
  });
  services.push(service);
  return service;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("PwrGit OAuth connection", () => {
  it("recognizes the running OAuth endpoint without the obsolete health or pairing API", async () => {
    const fetchFn = vi.fn(reachable);
    await expect(create({ fetchFn }).readStatus()).resolves.toMatchObject({
      availability: "running", configured: false, connectionId: "pwrgit",
    });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      ENDPOINT, "http://127.0.0.1:51731/.well-known/oauth-protected-resource/mcp",
    ]);
  });

  it("does not mistake a different service or a 404 for a running PwrGit", async () => {
    for (const fetchFn of [
      async () => Response.json({ error: "not_found" }, { status: 404 }),
      async (input: string | URL) => String(input) === ENDPOINT
        ? new Response(null, { status: 405 }) : Response.json({ ...METADATA, resource_name: "Other" }),
    ]) {
      await expect(create({ fetchFn }).readStatus()).resolves.toMatchObject({ availability: "not_installed" });
    }
  });

  it("preserves saved authorization while honestly reporting an unreachable endpoint", async () => {
    const service = create({
      settings: settings(JSON.stringify({ tokens: { access_token: "stored" } })),
      resolveInstallPaths: () => [fileURLToPath(import.meta.url)],
      fetchFn: async () => { throw new Error("ECONNREFUSED"); },
    });
    await expect(service.readStatus()).resolves.toMatchObject({
      configured: true, availability: "installed", detail: expect.stringContaining("cannot reach"),
    });
  });

  it("does not treat a legacy direct-launch token as an OAuth authorization", async () => {
    await expect(create({ settings: settings(JSON.stringify({ token: "legacy" })) }).readStatus())
      .resolves.toMatchObject({ configured: false, availability: "running" });
  });

  it("issues reusable, revocable thread grants without giving agents the provider token", async () => {
    const service = create({ settings: settings(JSON.stringify({ tokens: { access_token: "private-provider-token" } })) });
    const first = await service.registerBridge("pwrgit", "grok-thread");
    const second = await service.registerBridge("pwrgit", "grok-thread");
    expect(second.server).toEqual(first.server);
    expect(first.server.name).toBe("pwrgit");
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_TOKEN).toBeTruthy();
    expect(JSON.stringify(first.server)).not.toContain("private-provider-token");
    expect(JSON.stringify(first.server)).not.toContain("pwrgit-mcp.mjs");
    first.revoke();
    expect((await service.registerBridge("pwrgit", "grok-thread")).server).not.toEqual(first.server);
  });
  it("authorizes through OAuth and proxies tools with PwrAgent as the client", async () => {
    const store = settings();
    let registration: Record<string, unknown> | undefined;
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return Response.json(METADATA);
      if (url.includes("/.well-known/")) return Response.json({
        issuer: "http://127.0.0.1:51731/",
        authorization_endpoint: "http://127.0.0.1:51731/authorize",
        token_endpoint: "http://127.0.0.1:51731/token",
        registration_endpoint: "http://127.0.0.1:51731/register",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      });
      if (url.endsWith("/register")) {
        registration = JSON.parse(String(init?.body));
        return Response.json({ ...registration, client_id: "pwragent-test-client" });
      }
      if (url.endsWith("/token")) {
        expect(String(init?.body)).toContain("code_verifier=");
        return Response.json({ access_token: "provider-secret", token_type: "Bearer" });
      }
      if (url === ENDPOINT && init?.method === "POST") {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer provider-secret");
        const request = JSON.parse(String(init.body));
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", serverInfo: { name: "pwrgit", version: "1.0.0" }, capabilities: { tools: {} } }
          : { tools: [{ name: "pwrgit_app_profiles", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      }
      if (url === ENDPOINT) return new Response(null, { status: 405 });
      throw new Error(`Unexpected test request: ${url}`);
    });
    const service = create({ settings: store, fetchFn, openExternal: async (url) => {
      const authorization = new URL(url);
      expect(authorization.pathname).toBe("/authorize");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "approved-test-code");
      const response = await fetch(callback);
      const page = await response.text();
      expect(page).toContain("Connecting PwrAgent to PwrGit");
      expect(page).not.toContain("PwrSnap");
    } });
    await expect(service.connect()).resolves.toMatchObject({ outcome: "connected", status: { configured: true } });
    expect(registration?.client_name).toBe("PwrAgent");
    expect(JSON.parse((await store.resolvePwrGitMcpCredential())!).tokens.access_token).toBe("provider-secret");
    const bridge = service as unknown as { dispatchBridgeOperation: (op: string, params: unknown) => Promise<unknown> };
    await expect(bridge.dispatchBridgeOperation("tools/list", {})).resolves.toMatchObject({
      tools: [{ name: "pwrgit_app_profiles" }],
    });
    expect(fetchFn.mock.calls.some(([url]) => /\/health|\/pair\//u.test(String(url)))).toBe(false);
  });

});
