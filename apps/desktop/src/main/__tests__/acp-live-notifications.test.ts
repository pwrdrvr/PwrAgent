import { describe, expect, it } from "vitest";
import {
  acpToolUpdateNotifications,
  acpTurnCompletedUsageNotification,
} from "../acp/acp-live-notifications";

describe("acpToolUpdateNotifications", () => {
  it("maps ACP tool calls to live item notifications", () => {
    const notifications = acpToolUpdateNotifications({
      threadId: "session-1",
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-file-1",
        kind: "read",
        title: "README.md",
        status: "in_progress",
        locations: [{ path: "/repo/README.md" }],
      },
    });

    expect(notifications).toEqual([
      {
        method: "item/started",
        params: {
          threadId: "session-1",
          turnId: "turn-1",
          item: expect.objectContaining({
            id: "read-file-1",
            type: "commandExecution",
            status: "in_progress",
            toolName: "read",
            command: "README.md",
            commandActions: [
              {
                type: "read",
                path: "/repo/README.md",
                name: "README.md",
              },
            ],
          }),
        },
      },
    ]);
  });

  it("maps nested ACP tool update content into live output", () => {
    const notifications = acpToolUpdateNotifications({
      threadId: "session-1",
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "grep-1",
        kind: "search",
        title: "'MODE_UPDATE'",
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Found 3 matching lines",
            },
          },
        ],
      },
    });

    expect(notifications).toEqual([
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            id: "grep-1",
            status: "completed",
            command: "'MODE_UPDATE'",
            data: {
              output: "Found 3 matching lines",
            },
            commandActions: [
              {
                type: "search",
                name: "'MODE_UPDATE'",
              },
            ],
          }),
        }),
      }),
    ]);
  });

  it("keeps non-shell ACP content with command fields as live output", () => {
    const output = "{\"command\":\"npm view pnpm\",\"result\":\"found text\"}";
    const notifications = acpToolUpdateNotifications({
      threadId: "session-1",
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "search-1",
        kind: "search",
        title: "Search package metadata",
        status: "completed",
        content: {
          type: "text",
          text: output,
        },
      },
    });

    expect(notifications).toEqual([
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            id: "search-1",
            command: "Search package metadata",
            data: {
              output,
            },
            commandActions: [
              {
                type: "search",
                name: "Search package metadata",
              },
            ],
          }),
        }),
      }),
    ]);
  });

  it("maps Kimi snake_case ACP tool updates to stable live item ids", () => {
    const notifications = acpToolUpdateNotifications({
      threadId: "session-1",
      turnId: "turn-1",
      update: {
        session_update: "tool_call_update",
        tool_call_id: "turn-1:tool-7",
        title: "pnpm build",
        status: "in_progress",
      },
    });

    expect(notifications).toEqual([
      expect.objectContaining({
        method: "item/started",
        params: expect.objectContaining({
          item: expect.objectContaining({
            id: "turn-1:tool-7",
            command: "pnpm build",
            toolName: "tool",
            status: "in_progress",
          }),
        }),
      }),
    ]);
  });

  it("extracts Kimi shell commands from raw input and command JSON content", () => {
    const notifications = acpToolUpdateNotifications({
      threadId: "session-1",
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "2:tool_FepVvUHmSL1YkNrQrdMD9alt",
        kind: "execute",
        title: "Bash",
        status: "in_progress",
        rawInput: { command: "npm view pnpm" },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "{\"command\":\"npm view pnpm\"}",
            },
          },
        ],
      },
    });

    const params = notifications[0]?.params as
      | { item?: Record<string, unknown> }
      | undefined;
    const item = params?.item;
    expect(item).toMatchObject({
      id: "2:tool_FepVvUHmSL1YkNrQrdMD9alt",
      command: "npm view pnpm",
    });
    expect(item?.data).toBeUndefined();
  });

  it("surfaces Grok search arguments as a structured tool invocation", () => {
    const notifications = acpToolUpdateNotifications({
      threadId: "session-1",
      turnId: "turn-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "grep-1",
        title: "grep",
        rawInput: {
          pattern: "grok",
          glob: "*.{ts,tsx,md,json}",
          head_limit: 20,
        },
        _meta: {
          "x.ai/tool": {
            name: "grep",
            kind: "search",
          },
        },
      },
    });

    expect(notifications).toEqual([
      expect.objectContaining({
        method: "item/started",
        params: expect.objectContaining({
          item: expect.objectContaining({
            id: "grep-1",
            command:
              'grep(pattern="grok", glob="*.{ts,tsx,md,json}", head_limit=20)',
            commandSource: "tool",
          }),
        }),
      }),
    ]);
  });

  it("does not render ACP topic updates as live tool activity", () => {
    expect(
      acpToolUpdateNotifications({
        threadId: "session-1",
        turnId: "turn-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "update_topic_1",
          kind: "think",
          title: 'Update topic to: "Investigating UI Issues"',
          status: "completed",
        },
      }),
    ).toEqual([]);
  });

  it("maps Grok turn completion usage to the standard token usage notification", () => {
    expect(
      acpTurnCompletedUsageNotification({
        threadId: "session-1",
        turnId: "turn-1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "prompt-1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 348_051,
            outputTokens: 3_124,
            totalTokens: 351_175,
            cachedReadTokens: 335_488,
            reasoningTokens: 1_808,
            modelCalls: 5,
            apiDurationMs: 48_226,
            costUsdTicks: 1_445_164_000,
            modelUsage: {
              "grok-4.5-build": {
                inputTokens: 348_051,
                outputTokens: 3_124,
              },
            },
          },
        },
      }),
    ).toEqual({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        model: "grok-4.5-build",
        tokenUsage: {
          last_token_usage: {
            input_tokens: 348_051,
            cached_input_tokens: 335_488,
            output_tokens: 3_124,
            reasoning_output_tokens: 1_808,
            total_tokens: 351_175,
          },
        },
      },
    });
  });

  it("ignores replayed turn completion usage without a live turn", () => {
    expect(
      acpTurnCompletedUsageNotification({
        threadId: "session-1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 348_051,
            outputTokens: 3_124,
            totalTokens: 351_175,
          },
        },
      }),
    ).toBeUndefined();
  });

  it("ignores turn completion notifications without usable token counts", () => {
    expect(
      acpTurnCompletedUsageNotification({
        threadId: "session-1",
        turnId: "turn-1",
        update: {
          sessionUpdate: "turn_completed",
          stop_reason: "end_turn",
        },
      }),
    ).toBeUndefined();
  });
});
