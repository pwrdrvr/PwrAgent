import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOXER_MCP_CONNECTION_ID, SANDBOXER_MCP_URL } from "@pwragent/shared";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { SandboxerConnection } from "../mcp-connections/sandboxer-connection";

const services: McpConnectionGatewayService[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** All remote HTTP is synthetic. Only the actual loopback OAuth callback opens a socket. */
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandboxer-hosted-fixture-"));
  directories.push(directory);
  const registry = new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") });
  let stored: string | undefined;
  const settings = {
    clearMcpConnectionCredentials: vi.fn(async () => { stored = undefined; }),
    resolveMcpConnectionCredentials: vi.fn(async () => stored),
    saveMcpConnectionCredentials: vi.fn(async (value: string) => { stored = value; }),
    resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
    clearPwrSnapMcpCredential: vi.fn(async () => undefined),
    savePwrSnapMcpCredential: vi.fn(async () => undefined),
    resolvePwrGitMcpCredential: vi.fn(async () => undefined),
    clearPwrGitMcpCredential: vi.fn(async () => undefined),
  };
  const cli = vi.fn(async () => { throw new Error("Hosted mode must not probe the CLI"); });
  const sandboxer = new SandboxerConnection(cli);
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let rejectAccess = false;
  let rejectRefresh = false;
  const grants: string[] = [];
  const recordCreatedSandbox = vi.fn();
  let selected = true;
  const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    expect(url.origin).toBe("https://sandboxer.com");
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({
      resource: SANDBOXER_MCP_URL, authorization_servers: [url.origin], scopes_supported: ["sandboxer"],
    });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({
      issuer: url.origin, authorization_endpoint: `${url.origin}/oauth/authorize`,
      token_endpoint: `${url.origin}/oauth/token`, registration_endpoint: `${url.origin}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
    });
    if (url.pathname === "/oauth/register") return json({
      ...JSON.parse(String(init?.body)), client_id: "fixture-public-client",
    });
    if (url.pathname === "/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      grants.push(body.get("grant_type")!);
      if (body.get("grant_type") === "refresh_token" && rejectRefresh) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      rejectAccess = false;
      return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") throw new Error(`Unexpected fixture path: ${url.pathname}`);
    if (!new Headers(init?.headers).has("authorization") || rejectAccess) {
      return new Response(null, { status: 401, headers: {
        "www-authenticate": 'Bearer resource_metadata="https://sandboxer.com/.well-known/oauth-protected-resource/mcp", scope="sandboxer"',
      } });
    }
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Sandboxer fixture", version: "1" }, instructions: "Use explicit sandbox IDs." }
      : message.method === "tools/list"
        ? { tools: [
            { name: "list_sandboxes", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
            { name: "create_sandbox", inputSchema: { type: "object", properties: { noEnv: { type: "boolean" } }, required: ["noEnv"] } },
          ] }
        : { content: [{ type: "text", text: JSON.stringify({ id: "sb_fixtureowned", name: "owned fixture" }) }] };
    return json({ jsonrpc: "2.0", id: message.id, result });
  });
  const redirects: URL[] = [];
  const callbacks: Promise<Response>[] = [];
  let completeConsent = true;
  const service = new McpConnectionGatewayService({
    registry, settings, sandboxer, fetchFn, leaseManager: null,
    gatewayEnabled: () => true,
    readGatewaySelection: async () => selected ? [SANDBOXER_MCP_CONNECTION_ID] : [],
    recordCreatedSandbox,
    openExternal: async (value) => {
      const url = new URL(value);
      redirects.push(url);
      if (!completeConsent) return;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-authorization-code");
      callbacks.push(fetch(callback));
    },
  });
  services.push(service);
  return {
    service, registry, cli, settings, redirects, callbacks, grants, recordCreatedSandbox,
    deselect: () => { selected = false; },
    deferConsent: () => { completeConsent = false; },
    rejectCredentials: () => { rejectAccess = true; rejectRefresh = true; },
    expireAccess: () => { rejectAccess = true; },
  };
}

describe("built-in Sandboxer hosted connection", () => {
  it("authorizes through real OAuth coordination and discovers HTTP tools without the CLI", async () => {
    const f = fixture();
    const id = SANDBOXER_MCP_CONNECTION_ID;
    expect((await f.service.listConnections()).find((entry) => entry.id === id)).toMatchObject({ configured: false, authMode: "oauth", enabled: false });
    await expect(f.service.authorizeConnection(id)).resolves.toMatchObject({ configured: true, enabled: false });
    expect((await Promise.all(f.callbacks))[0].status).toBe(200);
    expect(f.redirects[0].searchParams.get("scope")).toBe("sandboxer");
    expect(f.redirects[0].searchParams.get("resource")).toBe(SANDBOXER_MCP_URL);
    expect(f.redirects[0].searchParams.get("code_challenge_method")).toBe("S256");
    expect(f.settings.saveMcpConnectionCredentials).toHaveBeenCalled();
    await f.service.setConnectionEnabled(id, true);
    await expect(f.service.listConnectionTools({ connectionId: id })).resolves.toMatchObject({ tools: ["list_sandboxes", "create_sandbox"] });
    expect(f.cli).not.toHaveBeenCalled();
    await expect(f.service.disconnectConnection(id)).resolves.toMatchObject({ configured: false, enabled: true });
  });

  it("keeps built-in ownership and rechecks selection for hosted tool calls", async () => {
    const f = fixture();
    await f.service.authorizeConnection(SANDBOXER_MCP_CONNECTION_ID);
    await Promise.all(f.callbacks);
    await f.service.setConnectionEnabled(SANDBOXER_MCP_CONNECTION_ID, true);
    const request = {
      connectionId: SANDBOXER_MCP_CONNECTION_ID,
      scopeKey: JSON.stringify(["gateway", "codex", "fixture-thread"]),
      signal: new AbortController().signal,
    };
    const tools = await f.service.requestGatewayToolOperation({ ...request, operation: "gateway/tools/list" }) as McpGatewayTool[];
    expect(tools[0].serverInstructions).toBe("Use explicit sandbox IDs.");
    const create = tools.find((tool) => tool.toolName === "create_sandbox")!;
    await f.service.requestGatewayToolOperation({ ...request, operation: "gateway/tools/call", invocation: { ...create, arguments: { noEnv: true } } });
    expect(f.recordCreatedSandbox).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: SANDBOXER_MCP_CONNECTION_ID, sandboxId: "sb_fixtureowned", backend: "codex", threadId: "fixture-thread",
    }));
    f.deselect();
    await expect(f.service.requestGatewayToolOperation({ ...request, operation: "gateway/tools/call", invocation: { ...create, arguments: { noEnv: true } } })).rejects.toThrow();
    expect(f.recordCreatedSandbox).toHaveBeenCalledOnce();
    expect(f.cli).not.toHaveBeenCalled();
  });

  it("refreshes rejected access and requests reauthorization for a rejected refresh grant", async () => {
    const f = fixture();
    const id = SANDBOXER_MCP_CONNECTION_ID;
    await f.service.authorizeConnection(id);
    await Promise.all(f.callbacks);
    await f.service.setConnectionEnabled(id, true);
    f.expireAccess();
    await expect(f.service.listConnectionTools({ connectionId: id })).resolves.toMatchObject({ tools: ["list_sandboxes", "create_sandbox"] });
    expect(f.grants).toContain("refresh_token");
    f.rejectCredentials();
    await expect(f.service.listConnectionTools({ connectionId: id, refresh: true })).rejects.toThrow();
    expect((await f.service.listConnections()).find((entry) => entry.id === id)?.state).toBe("reauthorization_required");
    expect(f.cli).not.toHaveBeenCalled();
  });

  it("cancels a pending hosted login and retries without writing cancelled credentials", async () => {
    const f = fixture();
    f.deferConsent();
    const id = SANDBOXER_MCP_CONNECTION_ID;
    const first = f.service.authorizeConnection(id).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.redirects).toHaveLength(1));
    await f.service.cancelAuthorization(id);
    expect(await first).toBeInstanceOf(Error);
    expect(f.settings.saveMcpConnectionCredentials).not.toHaveBeenCalled();
    const second = f.service.authorizeConnection(id).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.redirects).toHaveLength(2));
    expect(f.redirects[1].searchParams.get("state")).not.toBe(f.redirects[0].searchParams.get("state"));
    await f.service.setSandboxerTransport("local_cli");
    expect(await second).toBeInstanceOf(Error);
    expect(f.registry.get(id)).toMatchObject({ authMode: "local_cli", serverUrl: "sandboxer:compute" });
    await f.service.setSandboxerTransport("hosted");
    expect((await f.service.listConnections()).find((entry) => entry.id === id)?.configured).toBe(false);
  });
});
