import { describe, expect, it, vi } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tool-catalog-registry";
import { buildPwrAgentTaskMonitorToolRouter } from "../pwragent-task-monitor-agent-tools";

describe("PwrAgent task monitor agent tools", () => {
  it("includes create_monitor_delegation in both parent transports", () => {
    const catalogs = resolveAgentToolCatalogs({});
    const dynamicTools = catalogs
      .flatMap((catalog) => catalog.dynamicTools)
      .flatMap((tool) =>
        tool.type === "namespace"
          ? tool.tools.map((nestedTool) => ({
              name: nestedTool.name,
              description: nestedTool.description,
              inputSchema: nestedTool.inputSchema,
            }))
          : [{
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            }],
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    const mcpTools = catalogs
      .flatMap((catalog) => catalog.router.buildMcpTools())
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(dynamicTools).toHaveLength(20);
    expect(mcpTools).toEqual(dynamicTools);
    expect(mcpTools.map((tool) => tool.name))
      .toContain("create_monitor_delegation");
  });

  it("dispatches dynamic and MCP monitor creation with matching ACP context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      operation: "create_monitor_delegation" as const,
      data: {
        monitorId: "monitor-1",
        parentThreadId: "thread-1",
        preferredModel: "gpt-5.4-mini",
        preferredReasoningEffort: "low",
        pollIntervalSeconds: 30,
        heartbeatIntervalSeconds: 30,
        startupTimeoutSeconds: 45,
        startedByPwrAgent: true,
        parentAgentGuidance: "Wait for completion.",
        prompt: "Monitor the task.",
      },
    }));
    const router = buildPwrAgentTaskMonitorToolRouter(handler);

    const dynamicResponse = await router.handleDynamicToolCall({
      backend: "acp:grok",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "dynamic-call-1",
        namespace: "pwragent",
        tool: "create_monitor_delegation",
        arguments: {
          task: "Watch PR checks.",
          pollIntervalSeconds: 30,
        },
      },
    });
    const mcpResponse = await router.handleMcpToolCall({
      backend: "acp:grok",
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "create_monitor_delegation",
      args: {
        task: "Watch PR checks.",
        pollIntervalSeconds: 30,
      },
    });

    expect(mcpResponse).toMatchObject({
      structuredContent: {
        monitorId: "monitor-1",
        parentThreadId: "thread-1",
      },
    });
    expect(dynamicResponse).toMatchObject({ success: true });
    const dynamicText = dynamicResponse.contentItems.find(
      (item) => item.type === "inputText",
    )?.text;
    expect(JSON.parse(dynamicText ?? "{}"))
      .toEqual(mcpResponse.structuredContent);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, {
      operation: "create_monitor_delegation",
      context: {
        backend: "acp:grok",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      args: {
        task: "Watch PR checks.",
        monitorContext: undefined,
        cwd: undefined,
        pollIntervalSeconds: 30,
        preferredModel: undefined,
        preferredReasoningEffort: undefined,
        finalHandoffPrompt: undefined,
      },
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      operation: "create_monitor_delegation",
      context: {
        backend: "acp:grok",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      args: {
        task: "Watch PR checks.",
        monitorContext: undefined,
        cwd: undefined,
        pollIntervalSeconds: 30,
        preferredModel: undefined,
        preferredReasoningEffort: undefined,
        finalHandoffPrompt: undefined,
      },
    });
  });
});
