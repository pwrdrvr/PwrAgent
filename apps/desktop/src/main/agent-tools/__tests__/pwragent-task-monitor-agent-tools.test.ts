import { describe, expect, it, vi } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tool-catalog-registry";
import { PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION } from "../agent-tool-router";
import { buildPwrAgentTaskMonitorToolRouter } from "../pwragent-task-monitor-agent-tools";

describe("PwrAgent task monitor agent tools", () => {
  it("includes monitor creation and cancellation in both parent transports", () => {
    const catalogs = resolveAgentToolCatalogs({});
    const mcpCatalogs = resolveAgentToolCatalogs(
      {},
      { taskMonitorRole: "all" },
    );
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
    const mcpTools = mcpCatalogs
      .flatMap((catalog) => catalog.router.buildMcpTools())
      .sort((left, right) => left.name.localeCompare(right.name));

    const dynamicOnlyToolNames = new Set([
      "inspect_messaging_pdfs",
      "render_messaging_pdf_pages",
      "search_messaging_pdf_text",
    ]);
    expect(dynamicTools).toHaveLength(37);
    expect(mcpTools).toEqual(expect.arrayContaining(
      dynamicTools.filter((tool) => !dynamicOnlyToolNames.has(tool.name)),
    ));
    expect(mcpTools.map((tool) => tool.name))
      .toContain("create_monitor_delegation");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("cancel_monitor_delegation");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("inject_progress");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("complete_monitoring");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("start_review");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("stop_thread");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("steer_thread");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("send_messaging_file");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("read_star_map_view");
    expect(mcpTools.map((tool) => tool.name))
      .toContain("capture_star_map");
    expect(mcpTools.map((tool) => tool.name))
      .not.toEqual(expect.arrayContaining([...dynamicOnlyToolNames]));
    const createMonitorTool = mcpTools.find(
      (tool) => tool.name === "create_monitor_delegation",
    );
    expect(createMonitorTool?.description).toContain(
      "Omit preferredModel and preferredReasoningEffort",
    );
    expect(createMonitorTool?.description).toContain(
      "Do not use this for an attached PR",
    );
    expect(createMonitorTool?.description).toContain(
      "A successful response means the monitor thread and turn have started",
    );
    expect(createMonitorTool?.description).toContain(
      "Do not inspect the monitor thread, poll, or sleep in the parent",
    );
    expect(createMonitorTool?.inputSchema).toMatchObject({
      properties: {
        task: {
          description: expect.stringContaining("Self-contained polling procedure"),
        },
        pollIntervalSeconds: {
          description: expect.stringContaining("Polling and heartbeat cadence"),
        },
        preferredModel: {
          description: expect.stringContaining(
            "Omit it to use the monitor default",
          ),
        },
        preferredReasoningEffort: {
          description: expect.stringContaining(
            "Omit it to use the monitor default",
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

  it("keeps reflected descriptions at 20 words or fewer", () => {
    const descriptions = new Set<string>([
      PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
    ]);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") {
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "description" && typeof child === "string") {
          descriptions.add(child);
        } else {
          visit(child);
        }
      }
    };
    for (const catalog of resolveAgentToolCatalogs({})) {
      visit(catalog.dynamicTools);
    }

    for (const description of descriptions) {
      expect(description).not.toContain(";");
      for (const sentence of description.split(/[.!?]+(?:\s|$)/u)) {
        const wordCount = sentence.trim().split(/\s+/u).filter(Boolean).length;
        expect(wordCount, sentence).toBeLessThanOrEqual(20);
      }
    }
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
        startupConfirmed: true as const,
        parentShouldPoll: false as const,
        completionWakesParentByDefault: true as const,
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
