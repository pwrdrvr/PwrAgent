import { describe, expect, it, vi } from "vitest";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { buildPwrAgentMcpConnectionToolRouter } from "../pwragent-mcp-connection-agent-tools.js";

async function call(
  router: ReturnType<typeof buildPwrAgentMcpConnectionToolRouter>,
  args: Record<string, unknown>,
) {
  return await router.handleMcpToolCall({
    backend: "codex",
    threadId: "thread-1",
    namespace: PWRAGENT_TOOL_NAMESPACE,
    tool: "manage_mcp_connections",
    args,
  });
}

describe("manage_mcp_connections", () => {
  it("advertises exactly one tool, and no way to authorize or remove", () => {
    // An agent proposes and inspects; a person authorizes and enables.
    // `authorize` needs a browser consent an agent cannot give, and
    // `set_enabled`/`remove` are what an injected instruction would reach for.
    const router = buildPwrAgentMcpConnectionToolRouter(vi.fn());
    const [namespace] = router.buildDynamicToolSpecs();
    expect(namespace?.type).toBe("namespace");
    expect(namespace?.name).toBe(PWRAGENT_TOOL_NAMESPACE);
    const tool = namespace?.type === "namespace"
      ? namespace.tools.find((entry) => entry.name === "manage_mcp_connections")
      : undefined;
    expect(tool).toBeDefined();
    const actions = (tool?.inputSchema as {
      properties: { action: { enum: string[] } };
    }).properties.action.enum;
    expect(actions).toEqual(["list", "create", "describe_thread"]);
    expect(actions).not.toContain("authorize");
    expect(actions).not.toContain("set_enabled");
    expect(actions).not.toContain("remove");
  });

  it("steers the model away from writing the agent's own config file", () => {
    // Without this, a model asked to "add the Datadog MCP" does the only
    // thing it can and edits Codex's config.toml — a registration the gateway
    // never sees, never refreshes, and cannot share with an ACP backend.
    const router = buildPwrAgentMcpConnectionToolRouter(vi.fn());
    const tool = router
      .buildMcpTools()
      .find((entry) => entry.name === "manage_mcp_connections");
    expect(tool?.description).toMatch(
      /Prefer this to editing an agent's own MCP config file/,
    );
    expect(tool?.description).toMatch(/invisible here/);
  });

  it("passes a create through and returns the handler's next step", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        action: "create" as const,
        id: "datadog",
        displayName: "Datadog",
        serverUrl: "https://mcp.example.com/mcp",
        setupState: "not_authorized" as const,
        nextStep: "A person has to authorize Datadog in Settings → Plugins.",
      },
    }));
    const router = buildPwrAgentMcpConnectionToolRouter(handler);
    const result = await call(router, {
      action: "create",
      displayName: "Datadog",
      serverUrl: "https://mcp.example.com/mcp",
    });
    expect(result.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "manage_mcp_connections",
        args: {
          action: "create",
          displayName: "Datadog",
          serverUrl: "https://mcp.example.com/mcp",
        },
      }),
    );
  });

  it("refuses a create with no endpoint rather than writing a nameless row", async () => {
    const handler = vi.fn();
    const router = buildPwrAgentMcpConnectionToolRouter(handler);
    const result = await call(router, {
      action: "create",
      displayName: "Datadog",
    });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("defaults describe_thread to the calling thread", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        action: "describe_thread" as const,
        backend: "codex" as const,
        threadId: "thread-1",
        connections: [],
        providerServersEnabled: true,
        appliesAt: "next_turn" as const,
        agentInventoryAvailable: true,
      },
    }));
    const router = buildPwrAgentMcpConnectionToolRouter(handler);
    await call(router, { action: "describe_thread" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ threadId: "thread-1" }),
        args: { action: "describe_thread" },
      }),
    );
  });
});
