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

    expect(router.buildDynamicToolSpecs()).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "pwragent",
        tools: expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: "search_threads",
        }),
        expect.objectContaining({
          type: "function",
          name: "read_thread",
        }),
        expect.objectContaining({
          type: "function",
          name: "get_thread_status",
        }),
        expect.objectContaining({
          type: "function",
          name: "mutate_thread",
        }),
        ]),
      }),
    ]);
    const namespace = router.buildDynamicToolSpecs()[0];
    expect(namespace?.type).toBe("namespace");
    if (!namespace || namespace.type !== "namespace") {
      throw new Error("Expected PwrAgent namespace tool spec.");
    }
    const tools = namespace.tools;
    const getThreadStatus = tools.find(
      (tool) => tool.name === "get_thread_status",
    );
    expect(getThreadStatus?.description).toContain(
      "not that another agent is repairing it",
    );
    expect(getThreadStatus?.description).toContain(
      "If Auto-fix started this thread's current turn, continue only the reported repair",
    );
    expect(getThreadStatus?.description).toContain(
      "When it is false, do not assume PwrAgent will dispatch a repair turn",
    );
    const checkPullRequestStatus = tools.find(
      (tool) => tool.name === "check_thread_pull_request_status",
    );
    expect(checkPullRequestStatus?.description).toContain(
      "not that another agent is repairing it",
    );
    expect(checkPullRequestStatus?.description).toContain(
      "Ignore unrelated prior context unless the user explicitly added it to this turn",
    );
    expect(checkPullRequestStatus?.description).toContain(
      "When it is false, do not assume PwrAgent will dispatch a repair turn",
    );
    expect(checkPullRequestStatus?.description).not.toContain(
      "In any other turn",
    );
    expect(tools.find((tool) => tool.name === "watch_thread_pull_request"))
      .toMatchObject({
        name: "watch_thread_pull_request",
        description: expect.stringContaining("After creation, end the turn"),
      });
    expect(tools.find((tool) => tool.name === "read_thread")).toMatchObject({
      description: expect.stringContaining("Pass instanceId for a known remote thread"),
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          instanceId: expect.objectContaining({ type: "string" }),
          includeRemote: expect.objectContaining({ type: "boolean" }),
        }),
      }),
    });
    expect(tools.find((tool) => tool.name === "get_thread_status"))
      .toMatchObject({
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            instanceId: expect.objectContaining({ type: "string" }),
            includeRemote: expect.objectContaining({ type: "boolean" }),
          }),
        }),
      });
    for (const name of ["search_threads", "mutate_thread"]) {
      expect(tools.find((tool) => tool.name === name)).toMatchObject({
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            instanceId: expect.objectContaining({ type: "string" }),
            includeRemote: expect.objectContaining({ type: "boolean" }),
          }),
        }),
      });
    }

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
