import { describe, expect, it, vi } from "vitest";

import { buildPwrAgentMessagingToolRouter } from "../agent-tools/pwragent-messaging-agent-tools";
import {
  handlePwrAgentMessagingDynamicToolCall,
  isPwrAgentMessagingDynamicToolCall,
} from "../agent-tools/pwragent-messaging-codex-tools";

describe("PwrAgent messaging agent tools", () => {
  it("does not advertise deprecated location tool but still recognizes legacy calls", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        location: {
          binding: {
            id: "binding-1",
            backend: "codex" as const,
            threadId: "agent-thread",
            targetKind: "agent_thread" as const,
          },
          channel: "telegram" as const,
          conversation: {
            id: "topic-1",
            kind: "topic" as const,
          },
          managedConversation: {
            canCreateChild: false,
            operations: [],
            outcome: "unsupported" as const,
            providerSupportsCreation: false,
          },
        },
      },
    }));
    const router = buildPwrAgentMessagingToolRouter(handler);

    const specs = router.buildDynamicToolSpecs();
    expect(specs.map((tool) => tool.name)).toEqual([
      "get_current_messaging_surface",
      "attach_thread_here",
    ]);
    expect(
      isPwrAgentMessagingDynamicToolCall({
        namespace: "pwragent_messaging",
        tool: "get_current_location",
      }),
    ).toBe(true);
    expect(
      isPwrAgentMessagingDynamicToolCall({
        namespace: "pwragent",
        tool: "get_current_location",
      }),
    ).toBe(true);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "get_current_location",
          arguments: {},
        },
      }),
    ).resolves.toMatchObject({
      success: true,
    });
    expect(handler).toHaveBeenCalledWith({
      operation: "get_current_location",
      context: {
        backend: "codex",
        threadId: "agent-thread",
        turnId: "turn-1",
      },
      args: {},
    });

    handler.mockClear();
    await expect(
      handlePwrAgentMessagingDynamicToolCall({
        backend: "codex",
        handler,
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_messaging",
          tool: "get_current_location",
          arguments: {},
        },
      }),
    ).resolves.toMatchObject({
      success: true,
    });
    expect(handler).toHaveBeenCalledWith({
      operation: "get_current_location",
      context: {
        backend: "codex",
        threadId: "agent-thread",
        turnId: "turn-1",
      },
      args: {},
    });
  });
});
