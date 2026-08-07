import { describe, expect, it, vi } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tool-catalog-registry";
import { buildPwrAgentTaskMonitorToolRouter } from "../pwragent-task-monitor-agent-tools";

describe("PwrAgent task monitor agent tools", () => {
  it("includes monitor creation and cancellation in both parent transports", () => {
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

    const dynamicOnlyToolNames = new Set([
      "inspect_messaging_pdfs",
      "render_messaging_pdf_pages",
      "search_messaging_pdf_text",
    ]);
    expect(dynamicTools).toHaveLength(33);
    expect(mcpTools).toEqual(
      dynamicTools.filter((tool) => !dynamicOnlyToolNames.has(tool.name)),
    );
    expect(mcpTools.map((tool) => tool.name))
      .toContain("create_monitor_delegation");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("cancel_monitor_delegation");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("start_review");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("stop_thread");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("steer_thread");
    expect(mcpTools.map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining([...dynamicOnlyToolNames]));
    const createMonitorTool = mcpTools.find(
      (tool) => tool.name === "create_monitor_delegation",
    );
    expect(createMonitorTool?.description).toContain(
      "Normally omit preferredModel and preferredReasoningEffort",
    );
    expect(createMonitorTool?.description).toContain(
      "Do not use this to poll an attached pull request",
    );
    expect(createMonitorTool?.inputSchema).toMatchObject({
      properties: {
        preferredModel: {
          description: expect.stringContaining(
            "Normally omit so PwrAgent uses its managed monitor default",
          ),
        },
        preferredReasoningEffort: {
          description: expect.stringContaining(
            "Normally omit so PwrAgent uses its managed monitor default",
          ),
        },
      },
    });
    const cancelMonitorTool = mcpTools.find(
      (tool) => tool.name === "cancel_monitor_delegation",
    );
    expect(cancelMonitorTool?.description).toContain(
      "Use this instead of send_message_to_thread",
    );
    expect(cancelMonitorTool?.inputSchema).toMatchObject({
      required: ["monitorId"],
    });
  });

  it("dispatches dynamic and MCP monitor creation with matching ACP context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      operation: "create_monitor_delegation" as const,
      data: {
        monitorId: "monitor-1",
        parentThreadId: "thread-1",
        preferredModel: "gpt-5.6-luna",
        preferredReasoningEffort: "medium",
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

  it("dispatches dynamic and MCP monitor cancellation with matching context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      operation: "cancel_monitor_delegation" as const,
      data: {
        monitorId: "monitor-1",
        parentThreadId: "thread-1",
        injected: true as const,
        outcome: "cancelled" as const,
        completionSource: { type: "parent_cancel" as const },
      },
    }));
    const router = buildPwrAgentTaskMonitorToolRouter(handler);

    const dynamicResponse = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "dynamic-call-1",
        namespace: "pwragent",
        tool: "cancel_monitor_delegation",
        arguments: {
          monitorId: "monitor-1",
          reason: "Wrong runner was selected.",
        },
      },
    });
    const mcpResponse = await router.handleMcpToolCall({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "cancel_monitor_delegation",
      args: {
        monitorId: "monitor-1",
        reason: "Wrong runner was selected.",
      },
    });

    expect(dynamicResponse).toMatchObject({ success: true });
    expect(mcpResponse).toMatchObject({
      structuredContent: {
        monitorId: "monitor-1",
        outcome: "cancelled",
      },
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, {
      operation: "cancel_monitor_delegation",
      context: {
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      args: {
        monitorId: "monitor-1",
        reason: "Wrong runner was selected.",
      },
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      operation: "cancel_monitor_delegation",
      context: {
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      args: {
        monitorId: "monitor-1",
        reason: "Wrong runner was selected.",
      },
    });
  });
});
