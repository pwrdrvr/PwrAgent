import { describe, expect, it } from "vitest";

import {
  buildAutomationInspectionMcpTools,
  handleAutomationInspectionMcpToolCall,
} from "../automations/automation-inspection-mcp";

describe("automation inspection MCP adapter", () => {
  it("lists the shared automation inspection tools", () => {
    expect(buildAutomationInspectionMcpTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "list_automations",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
        expect.objectContaining({
          name: "get_automation_run_artifact",
          inputSchema: expect.objectContaining({ type: "object" }),
        }),
      ]),
    );
  });

  it("routes tool calls through the shared inspection handler", async () => {
    const response = await handleAutomationInspectionMcpToolCall({
      backend: "codex",
      threadId: "agent-thread",
      tool: "list_automations",
      args: { limit: 1 },
      handler: (request) => {
        expect(request).toEqual({
          operation: "list_automations",
          context: {
            backend: "codex",
            threadId: "agent-thread",
          },
          args: { limit: 1 },
        });
        return {
          ok: true,
          operation: "list_automations",
          data: {
            automations: [],
          },
        };
      },
    });

    expect(response).toEqual({
      structuredContent: { automations: [] },
      content: [
        {
          type: "text",
          text: JSON.stringify({ automations: [] }, null, 2),
        },
      ],
    });
  });

  it("returns an MCP tool error for unsupported tools", async () => {
    await expect(
      handleAutomationInspectionMcpToolCall({
        backend: "codex",
        threadId: "agent-thread",
        tool: "delete_automation",
        args: {},
        handler: undefined,
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: "unsupported_operation",
      },
    });
  });
});
