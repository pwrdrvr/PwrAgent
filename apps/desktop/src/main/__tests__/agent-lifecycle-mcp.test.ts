import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import { buildPwrAgentAppToolRouter } from "../agent-tools/pwragent-app-agent-tools";
import { createPwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-management-service";
import { getOwnerHostServices } from "../owner-host";

it("flushes a lifecycle acknowledgement before its own MCP server shuts down", async () => {
  const handler = createPwrAgentAppManagementHandler({ startedAt: 1 });
  const router = buildPwrAgentAppToolRouter(handler);
  const server = new AgentToolMcpServer({
    resolveCatalogs: () => [{ id: "app_management", router }],
    resolveCallContext: () => ({ backend: "codex", threadId: "fixture", turnId: "turn" }),
  });
  const quit = vi.fn(async () => { await server.close(); return true; });
  getOwnerHostServices().updates = {
    read: () => ({ status: "idle" }), check: vi.fn(), install: vi.fn(), requestQuit: quit,
  };
  const registration = await server.registerClient({ backend: "codex", threadId: "fixture" });
  const client = new Client({ name: "lifecycle-fixture", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
      requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
    }));
    const result = await client.callTool({ name: "manage_pwragent", arguments: { action: "stop" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ result: { status: "stop_scheduled" }, operation: { status: "waiting_for_response" } });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  } finally {
    await client.close();
    await server.close();
  }
});
