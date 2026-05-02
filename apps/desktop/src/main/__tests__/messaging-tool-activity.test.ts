import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragnt/shared";
import {
  formatToolActivityLine,
  summarizeToolActivityFromBackendEvent,
} from "../messaging/core/messaging-tool-activity";

describe("messaging tool activity", () => {
  it("summarizes completed shell commands without shell wrappers", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "tool-1",
        type: "commandExecution",
        command: "/bin/zsh -lc 'npm view dive'",
        durationMs: 1200,
        status: "completed",
      }),
    );

    expect(activity).toMatchObject({
      durationMs: 1200,
      id: "tool-1",
      kind: "command",
      status: "completed",
      title: "npm view dive",
    });
    expect(formatToolActivityLine(activity!)).toBe("npm view dive (1.2s)");
  });

  it("marks failed tools without including raw output", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "tool-2",
        type: "commandExecution",
        command: "pnpm test -- messaging-controller",
        output: "xai-api-key should not appear",
        exitCode: 1,
      }),
    );

    expect(activity).toMatchObject({
      status: "failed",
      title: "pnpm test -- messaging-controller",
    });
    expect(JSON.stringify(activity)).not.toContain("xai-api-key");
    expect(formatToolActivityLine(activity!)).toBe(
      "Failed: pnpm test -- messaging-controller",
    );
  });

  it("summarizes file changes without embedding diffs", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "file-1",
        type: "fileChange",
        changes: [
          {
            path: "/repo/src/settings.ts",
            diff: "+secret",
          },
          {
            path: "/repo/src/controller.ts",
            diff: "-token",
          },
        ],
      }),
    );

    expect(activity).toMatchObject({
      kind: "file",
      status: "completed",
      title: "Edited 2 files",
    });
    expect(JSON.stringify(activity)).not.toContain("+secret");
    expect(JSON.stringify(activity)).not.toContain("-token");
  });

  it("ignores unknown item types", () => {
    expect(
      summarizeToolActivityFromBackendEvent(
        buildCompletedItem({
          id: "message-1",
          type: "agentMessage",
          text: "Done",
        }),
      ),
    ).toBeUndefined();
  });

  it("redacts token-like command fragments from titles", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "tool-3",
        type: "commandExecution",
        command:
          "/bin/zsh -lc 'curl --api-key sk-secret TOKEN=abc123 https://example.test'",
      }),
    );

    expect(activity?.title).toBe(
      "curl --api-key [redacted] TOKEN=[redacted] https://example.test",
    );
    expect(activity?.title).not.toContain("sk-secret");
    expect(activity?.title).not.toContain("abc123");
  });
});

function buildCompletedItem(item: Record<string, unknown>): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item,
      },
    },
  } as AgentEvent;
}
