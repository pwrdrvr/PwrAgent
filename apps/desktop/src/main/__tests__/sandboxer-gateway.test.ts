import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxerConnection } from "../mcp-connections/sandboxer-connection";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandboxer-gateway-"));
  const registry = new McpConnectionRegistry({ configPath: path.join(root, "config.toml") });
  registry.setSandboxerTransport("local_cli");
  registry.setEnabled("builtin:sandboxer", true);
  let status = '{"signedIn":true,"apiReachable":true}';
  const sandboxer = new SandboxerConnection(async () => status);
  const calls = vi.fn();
  const closed = vi.fn();
  const servers: Server[] = [];
  const names = ["create_sandbox", "list_sandboxes", "exec", "read_file", "write_file", "host_port", "stop_sandbox", "resume_sandbox"];
  const spawn = vi.spyOn(sandboxer, "createTransport").mockImplementation(() => {
    const [client, remote] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "mock-sbx", version: "1" }, {
      capabilities: { tools: {} },
      instructions: "Call stop_sandbox when you are done.",
    });
    let lastSandbox: string | undefined;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map((name) => ({
      name, inputSchema: { type: "object" as const, properties: { sandboxId: { type: "string" }, type: { type: "string" } } },
      annotations: { readOnlyHint: name === "list_sandboxes" || name === "read_file", openWorldHint: true },
    })) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls(request.params);
      if (typeof request.params.arguments?.sandboxId === "string") lastSandbox = request.params.arguments.sandboxId;
      return { content: [{ type: "text", text: lastSandbox ?? "none" }], structuredContent: { exitCode: 1 } };
    });
    server.onclose = closed;
    void server.connect(remote);
    servers.push(server);
    return client;
  });
  const credentialRead = vi.fn(async () => undefined);
  const settings = {
    resolveMcpConnectionCredentials: credentialRead,
    resolvePwrSnapMcpCredential: credentialRead,
    resolvePwrGitMcpCredential: credentialRead,
    clearMcpConnectionCredentials: vi.fn(async () => undefined),
    clearPwrSnapMcpCredential: vi.fn(async () => undefined),
    clearPwrGitMcpCredential: vi.fn(async () => undefined),
    saveMcpConnectionCredentials: vi.fn(async () => undefined),
    savePwrSnapMcpCredential: vi.fn(async () => undefined),
  };
  let selected = true;
  const service = new McpConnectionGatewayService({
    registry, sandboxer, settings, leaseManager: null,
    readGatewaySelection: async () => selected ? ["builtin:sandboxer"] : [],
  });
  disposals.push(async () => {
    await service.close();
    await Promise.all(servers.map(async (server) => await server.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scope = (id: string) => ({ connectionId: "builtin:sandboxer", scopeKey: JSON.stringify(["gateway", "codex", id]), signal: new AbortController().signal });
  const list = async (id: string) => await service.requestGatewayToolOperation({ ...scope(id), operation: "gateway/tools/list" }) as McpGatewayTool[];
  const call = async (id: string, tool: McpGatewayTool, args: Record<string, unknown>) => await service.requestGatewayToolOperation({ ...scope(id), operation: "gateway/tools/call", invocation: { ...tool, arguments: args } });
  return {
    service, list, call, spawn, calls, closed, credentialRead,
    deselect: () => { selected = false; },
    setStatus: (next: string) => { status = next; },
  };
}

describe("Sandboxer thread gateway", () => {
  it("discovers and calls all official tools without OAuth, isolating each thread's last sandbox", async () => {
    const f = fixture();
    const tools = await f.list("a");
    expect(tools.map((tool) => tool.toolName)).toEqual(["create_sandbox", "list_sandboxes", "exec", "read_file", "write_file", "host_port", "stop_sandbox", "resume_sandbox"]);
    for (const tool of tools) await f.call("a", tool, { sandboxId: "fixture-a", type: "large" });
    expect(f.calls).toHaveBeenCalledTimes(8);
    expect(f.calls).toHaveBeenCalledWith({ name: "create_sandbox", arguments: { sandboxId: "fixture-a", type: "large" } });
    const other = await f.list("b");
    expect(await f.call("b", other[2]!, {})).toMatchObject({ content: [{ text: "none" }], structuredContent: { exitCode: 1 } });
    expect(await f.call("a", tools[2]!, {})).toMatchObject({ content: [{ text: "fixture-a" }] });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(f.credentialRead).not.toHaveBeenCalled();
    await f.service.setConnectionEnabled("builtin:sandboxer", false);
    expect(f.closed).toHaveBeenCalledTimes(2);
    await expect(f.list("a")).rejects.toThrow("not available");
  });

  it("keeps Settings discovery separate, checks selection, and closes on gateway shutdown", async () => {
    const f = fixture();
    expect((await f.service.authorizeConnection("builtin:sandboxer")).configured).toBe(true);
    expect((await f.service.listConnectionTools({ connectionId: "builtin:sandboxer" })).tools).toHaveLength(8);
    expect(f.closed).toHaveBeenCalledOnce();
    const tools = await f.list("a");
    f.deselect();
    await expect(f.call("a", tools[0]!, {})).rejects.toThrow("no longer selected");
    expect(f.calls).not.toHaveBeenCalled();
    await f.service.closeAllUpstreamSessions();
    expect(f.closed).toHaveBeenCalledTimes(2);
    expect(f.credentialRead).not.toHaveBeenCalled();
  });

  it("closes failed initialization and permits a later fresh session", async () => {
    const f = fixture();
    const close = vi.fn(async () => undefined);
    f.spawn.mockImplementationOnce(() => ({
      start: async () => { throw new Error("fixture startup failure"); },
      close,
      send: async () => undefined,
    }));
    await expect(f.list("a")).rejects.toThrow("initialize");
    expect(close).toHaveBeenCalled();
    expect(await f.list("a")).toHaveLength(8);
  });

  it("retires the old CLI session when refreshing a changed local login", async () => {
    const f = fixture();
    const tools = await f.list("a");
    await f.call("a", tools[2]!, { sandboxId: "fixture-old-account" });
    await f.service.authorizeConnection("builtin:sandboxer");
    expect(f.closed).toHaveBeenCalledOnce();
    const refreshed = await f.list("a");
    expect(await f.call("a", refreshed[2]!, {})).toMatchObject({ content: [{ text: "none" }] });
    expect(f.credentialRead).not.toHaveBeenCalled();
  });

  it("keeps live sessions when a refresh finds the same account", async () => {
    const f = fixture();
    const account = (id: string, canStart = true) => JSON.stringify({
      signedIn: true, apiReachable: true, user: { id, email: `${id}@example.com` },
      plan: { canStart, dollars: 20, billingStatus: canStart ? "active" : "past_due", creditBalanceHours: 3 },
    });
    f.setStatus(account("usr_a"));
    await f.service.authorizeConnection("builtin:sandboxer");
    const tools = await f.list("a");
    await f.call("a", tools[2]!, { sandboxId: "fixture-running" });
    // Settings refreshes on window focus; that must not drop the thread's sandbox.
    await f.service.authorizeConnection("builtin:sandboxer");
    // A billing problem stops new machines. Running ones still need stop.
    f.setStatus(account("usr_a", false));
    expect(await f.service.authorizeConnection("builtin:sandboxer")).toMatchObject({
      configured: true, sandboxerCliState: "billing_issue",
    });
    expect(f.closed).not.toHaveBeenCalled();
    expect(await f.call("a", tools[2]!, {})).toMatchObject({ content: [{ text: "fixture-running" }] });
    f.setStatus(account("usr_b"));
    await f.service.authorizeConnection("builtin:sandboxer");
    expect(f.closed).toHaveBeenCalledOnce();
  });

  it("forwards only Sandboxer's own server instructions with its catalog", async () => {
    const f = fixture();
    const tools = await f.list("a");
    expect(tools[0]!.serverInstructions).toBe("Call stop_sandbox when you are done.");
    expect(tools.slice(1).some((tool) => tool.serverInstructions)).toBe(false);
  });

  it("reports missing CLI without OAuth or attempting to spawn MCP", async () => {
    const f = fixture();
    const sandboxer = new SandboxerConnection(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    Object.assign(f.service, { sandboxer });
    expect(await f.service.authorizeConnection("builtin:sandboxer")).toMatchObject({ configured: false, sandboxerCliState: "cli_missing" });
    await expect(f.service.listConnectionTools({ connectionId: "builtin:sandboxer" })).rejects.toThrow("initialize");
    await expect(f.service.registerBridge("builtin:sandboxer", "missing-cli-thread")).rejects.toThrow("Install");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.credentialRead).not.toHaveBeenCalled();
  });
});
