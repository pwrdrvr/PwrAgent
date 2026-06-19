import { describe, expect, it } from "vitest";

import {
  buildAutomationInspectionDynamicToolSpecs,
  handleAutomationInspectionDynamicToolCall,
} from "../automations/automation-inspection-codex-tools";

describe("automation inspection Codex dynamic tools", () => {
  it("projects automation inspection tools into dynamic tool specs", () => {
    expect(buildAutomationInspectionDynamicToolSpecs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "pwragent",
          name: "list_automations",
          inputSchema: expect.objectContaining({ type: "object" }),
          deferLoading: false,
        }),
        expect.objectContaining({
          namespace: "pwragent",
          name: "get_automation_run_artifact",
          inputSchema: expect.objectContaining({ type: "object" }),
          deferLoading: false,
        }),
      ]),
    );
  });

  it("routes dynamic tool calls through the shared inspection handler", async () => {
    const response = await handleAutomationInspectionDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent_automations",
        tool: "list_automations",
        arguments: { limit: 1 },
      },
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
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ automations: [] }, null, 2),
        },
      ],
    });
  });

  it("returns a dynamic tool error for unsupported tools", async () => {
    await expect(
      handleAutomationInspectionDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_automations",
          tool: "delete_automation",
          arguments: {},
        },
        handler: undefined,
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "unsupported_operation",
              message: "Unsupported PwrAgent automation tool.",
            },
            null,
            2,
          ),
        },
      ],
    });
  });
});
