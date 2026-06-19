import { describe, expect, it, vi } from "vitest";

import { handlePwrAgentMessagingDynamicToolCall } from "../agent-tools/pwragent-messaging-codex-tools";
import { handlePwrAgentThreadDynamicToolCall } from "../agent-tools/pwragent-thread-codex-tools";

describe("PwrAgent legacy agent tool namespaces", () => {
  it("routes pwragent_threads calls through the unified thread handler", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        threads: [],
        totalCount: 0,
        limit: 5,
        truncated: false,
      },
    }));

    await expect(
      handlePwrAgentThreadDynamicToolCall({
        backend: "codex",
        handler,
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_threads",
          tool: "search_threads",
          arguments: { limit: 5 },
        },
      }),
    ).resolves.toMatchObject({ success: true });
    expect(handler).toHaveBeenCalledWith({
      operation: "search_threads",
      context: {
        backend: "codex",
        threadId: "agent-thread",
      },
      args: { limit: 5 },
    });
  });

  it("routes pwragent_messaging calls through the unified messaging handler", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        binding: {
          id: "binding-1",
          backend: "codex" as const,
          threadId: "child-thread",
          targetKind: "agent_thread" as const,
        },
        channel: "discord" as const,
        conversation: {
          id: "thread-1",
          kind: "thread" as const,
          title: "Child thread",
        },
        location: {
          binding: {
            id: "binding-parent",
            backend: "codex" as const,
            threadId: "agent-thread",
            targetKind: "agent_thread" as const,
          },
          channel: "discord" as const,
          conversation: {
            id: "channel-1",
            kind: "channel" as const,
            title: "ops",
          },
          managedConversation: {
            canCreateChild: true,
            operations: [],
            outcome: "ok" as const,
            providerSupportsCreation: true,
          },
        },
        outcome: "attached" as const,
        placement: "current_conversation" as const,
      },
    }));

    await expect(
      handlePwrAgentMessagingDynamicToolCall({
        backend: "codex",
        handler,
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_messaging",
          tool: "attach_thread_here",
          arguments: {
            backend: "codex",
            threadId: "child-thread",
            placement: "current_conversation",
          },
        },
      }),
    ).resolves.toMatchObject({ success: true });
    expect(handler).toHaveBeenCalledWith({
      operation: "attach_thread_here",
      context: {
        backend: "codex",
        threadId: "agent-thread",
        turnId: "turn-1",
      },
      args: {
        backend: "codex",
        threadId: "child-thread",
        placement: "current_conversation",
      },
    });
  });
});
