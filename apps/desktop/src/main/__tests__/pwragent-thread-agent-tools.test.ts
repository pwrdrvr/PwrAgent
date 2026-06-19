import { describe, expect, it, vi } from "vitest";

import { buildPwrAgentThreadToolRouter } from "../agent-tools/pwragent-thread-agent-tools";

describe("PwrAgent thread agent tools", () => {
  it("projects thread tools and dispatches with Agent thread context", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        threads: [],
        totalCount: 0,
        limit: 10,
        truncated: false,
      },
    }));
    const router = buildPwrAgentThreadToolRouter(handler);

    expect(router.buildDynamicToolSpecs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: "pwragent",
          name: "search_threads",
        }),
        expect.objectContaining({
          namespace: "pwragent",
          name: "read_thread",
        }),
        expect.objectContaining({
          namespace: "pwragent",
          name: "get_thread_status",
        }),
        expect.objectContaining({
          namespace: "pwragent",
          name: "mutate_thread",
        }),
      ]),
    );

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "search_threads",
          arguments: {
            query: "PwrAgent",
            limit: 5,
          },
        },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              threads: [],
              totalCount: 0,
              limit: 10,
              truncated: false,
            },
            null,
            2,
          ),
        },
      ],
    });
    expect(handler).toHaveBeenCalledWith({
      operation: "search_threads",
      context: {
        backend: "codex",
        threadId: "agent-thread",
      },
      args: {
        query: "PwrAgent",
        limit: 5,
      },
    });
  });
});
