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

  it("keeps Codex command action summaries stable", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "codex-read-1",
        type: "commandExecution",
        command: "cat docs/messaging-platform-integration.md",
        commandActions: [
          {
            type: "read",
            path: "docs/messaging-platform-integration.md",
          },
        ],
      }),
    );

    expect(activity).toMatchObject({
      kind: "search",
      title: "Read messaging-platform-integration.md",
    });
  });

  it("summarizes Grok read_file dynamic tools with path context", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "grok-read-1",
        type: "dynamicToolCall",
        toolName: "read_file",
        arguments: {
          path: "docs/messaging-adapter-contract.md",
        },
      }),
    );

    expect(activity).toMatchObject({
      id: "grok-read-1",
      kind: "tool",
      status: "completed",
      title: "Read messaging-adapter-contract.md",
    });
  });

  it("summarizes Grok list_files dynamic tools with path context", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "grok-list-1",
        type: "dynamicToolCall",
        toolName: "list_files",
        arguments: JSON.stringify({
          path: "packages/messaging",
        }),
      }),
    );

    expect(activity).toMatchObject({
      title: "Listed messaging",
    });
  });

  it("summarizes Grok search_code dynamic tools with safe context", () => {
    const withPath = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "grok-search-1",
        type: "dynamicToolCall",
        toolName: "search_code",
        arguments: {
          path: "apps/desktop/src/main/messaging",
          query: "stream_update",
        },
      }),
    );
    const withQuery = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "grok-search-2",
        type: "dynamicToolCall",
        toolName: "search_code",
        arguments: {
          query: "token=abc123",
        },
      }),
    );

    expect(withPath?.title).toBe("Searched messaging");
    expect(withQuery?.title).toBe("Searched code: token=[redacted]");
    expect(withQuery?.title).not.toContain("abc123");
  });

  it("summarizes command-like Grok dynamic tools through safe command titles", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "grok-command-1",
        type: "dynamicToolCall",
        toolName: "exec_command",
        arguments: {
          cmd: "/bin/zsh -lc 'git status --short'",
        },
      }),
    );

    expect(activity).toMatchObject({
      title: "git status --short",
    });
  });

  it("keeps Grok dynamic tool fallbacks readable without empty titles", () => {
    const activity = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "grok-read-2",
        type: "dynamicToolCall",
        toolName: "read_file",
        arguments: {},
      }),
    );

    expect(activity?.title).toBe("Read file");
  });

  it("redacts token-like web search query fragments from titles", () => {
    const directQuery = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "web-search-1",
        type: "webSearch",
        query: "xai token=abc123 failure",
      }),
    );
    const argumentQuery = summarizeToolActivityFromBackendEvent(
      buildCompletedItem({
        id: "web-search-2",
        type: "webSearch",
        arguments: {
          query: "authorization BearerSecret stack trace",
        },
      }),
    );

    expect(directQuery?.title).toBe("Searched web: xai token=[redacted] failure");
    expect(argumentQuery?.title).toBe(
      "Searched web: authorization [redacted] stack trace",
    );
    expect(directQuery?.title).not.toContain("abc123");
    expect(argumentQuery?.title).not.toContain("BearerSecret");
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
