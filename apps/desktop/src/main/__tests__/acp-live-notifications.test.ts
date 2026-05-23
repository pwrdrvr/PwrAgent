import { describe, expect, it } from "vitest";
import { acpToolUpdateNotifications } from "../acp/acp-live-notifications";

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
});
