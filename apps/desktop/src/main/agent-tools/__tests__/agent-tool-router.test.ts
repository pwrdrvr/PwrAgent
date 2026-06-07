import { describe, expect, it, vi } from "vitest";

import { agentToolFailure, agentToolSuccess } from "../agent-tool-definition";
import { AgentToolRouter, readAgentDynamicToolCall } from "../agent-tool-router";

describe("AgentToolRouter", () => {
  it("projects agent tool definitions into Codex dynamic tool specs", () => {
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "inspect",
        description: "Inspect test state.",
        inputSchema: { type: "object", additionalProperties: false },
        dispatch: () => agentToolSuccess({ ok: true }),
      },
    ]);

    expect(router.buildDynamicToolSpecs()).toEqual([
      {
        namespace: "pwragent_test",
        name: "inspect",
        description: "Inspect test state.",
        inputSchema: { type: "object", additionalProperties: false },
        deferLoading: false,
      },
    ]);
  });

  it("dispatches matching dynamic tool calls with normalized context", async () => {
    const dispatch = vi.fn(() => agentToolSuccess({ answer: 42 }));
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "inspect",
        description: "Inspect test state.",
        inputSchema: { type: "object" },
        dispatch,
      },
    ]);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_test",
          tool: "inspect",
          arguments: { limit: 2 },
        },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ answer: 42 }, null, 2),
        },
      ],
    });

    expect(dispatch).toHaveBeenCalledWith(
      { limit: 2 },
      {
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        transport: "codex_dynamic_tool",
      },
    );
  });

  it("normalizes non-object arguments to an empty object", async () => {
    const dispatch = vi.fn(() => agentToolSuccess({ ok: true }));
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "inspect",
        description: "Inspect test state.",
        inputSchema: { type: "object" },
        dispatch,
      },
    ]);

    await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent_test",
        tool: "inspect",
        arguments: ["invalid"],
      },
    });

    expect(dispatch).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });

  it("returns a structured failure for unsupported tools", async () => {
    const router = new AgentToolRouter([], {
      unsupportedMessage: "Unsupported test tool.",
    });

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_test",
          tool: "missing",
          arguments: {},
        },
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(
            {
              code: "unsupported_operation",
              message: "Unsupported test tool.",
            },
            null,
            2,
          ),
        },
      ],
    });
  });

  it("preserves custom content items from dispatch results", async () => {
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "stream",
        description: "Stream custom output.",
        inputSchema: { type: "object" },
        dispatch: () =>
          agentToolFailure({
            code: "failed",
            message: "The custom content should be used.",
            contentItems: [{ type: "inputText", text: "custom" }],
          }),
      },
    ]);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_test",
          tool: "stream",
          arguments: {},
        },
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "custom" }],
    });
  });

  it("reads Codex dynamic tool call notifications", () => {
    expect(
      readAgentDynamicToolCall({
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "request-1",
          namespace: "pwragent_test",
          tool: "inspect",
          arguments: {},
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "request-1",
      namespace: "pwragent_test",
      tool: "inspect",
      arguments: {},
    });

    expect(
      readAgentDynamicToolCall({
        method: "thread/update",
        params: {},
      }),
    ).toBeUndefined();
  });
});
