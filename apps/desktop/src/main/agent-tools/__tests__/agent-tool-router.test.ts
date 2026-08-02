import { describe, expect, it, vi } from "vitest";

import { agentToolFailure, agentToolSuccess } from "../agent-tool-definition";
import {
  AgentToolRouter,
  PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
  readAgentDynamicToolCall,
} from "../agent-tool-router";

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
        type: "namespace",
        name: "pwragent_test",
        description: PWRAGENT_AGENT_TOOL_NAMESPACE_DESCRIPTION,
        tools: [
          {
            type: "function",
            name: "inspect",
            description: "Inspect test state.",
            inputSchema: { type: "object", additionalProperties: false },
            deferLoading: false,
          },
        ],
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
        callId: "call-1",
        threadId: "thread-1",
        turnId: "turn-1",
        transport: "codex_dynamic_tool",
      },
    );
  });

  it("projects and dispatches MCP tool calls", async () => {
    const dispatch = vi.fn(() => agentToolSuccess({ status: "ok" }));
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "inspect",
        description: "Inspect test state.",
        inputSchema: { type: "object" },
        dispatch,
      },
    ]);

    expect(router.buildMcpTools()).toEqual([
      {
        name: "inspect",
        description: "Inspect test state.",
        inputSchema: { type: "object" },
      },
    ]);

    await expect(
      router.handleMcpToolCall({
        backend: "codex",
        threadId: "thread-1",
        namespace: "pwragent_test",
        tool: "inspect",
        args: { limit: 1 },
      }),
    ).resolves.toEqual({
      structuredContent: { status: "ok" },
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "ok" }, null, 2),
        },
      ],
    });

    expect(dispatch).toHaveBeenCalledWith(
      { limit: 1 },
      {
        backend: "codex",
        callId: undefined,
        threadId: "thread-1",
        transport: "mcp",
        turnId: undefined,
      },
    );
  });

  it("keeps dynamic-only tools out of MCP", async () => {
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "render_page",
        description: "Render a local PDF page.",
        inputSchema: { type: "object" },
        advertiseMcp: false,
        dispatch: () => agentToolSuccess(
          { pageNumber: 3 },
          {
            contentItems: [
              { type: "inputText", text: "page 3" },
              { type: "inputImage", imageUrl: "data:image/png;base64,AQID" },
            ],
            mcpContentItems: [
              { type: "text", text: "page 3" },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          },
        ),
      },
    ]);

    const specs = router.buildDynamicToolSpecs();
    const [namespace] = specs;
    expect(namespace?.type).toBe("namespace");
    if (!namespace || namespace.type !== "namespace") {
      throw new Error("Expected a dynamic-tool namespace.");
    }
    expect(namespace.tools.map((tool) => tool.name)).toEqual(["render_page"]);
    expect(router.buildMcpTools()).toEqual([]);

    await expect(
      router.handleMcpToolCall({
        backend: "codex",
        threadId: "thread-1",
        namespace: "pwragent_test",
        tool: "render_page",
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { code: "unsupported_operation" },
    });
  });

  it("uses supplied MCP image blocks without parsing dynamic data URLs", async () => {
    const router = new AgentToolRouter([
      {
        namespace: "pwragent_test",
        name: "render_page",
        description: "Render a local PDF page.",
        inputSchema: { type: "object" },
        dispatch: () => agentToolSuccess(
          { pageNumber: 3 },
          {
            contentItems: [
              { type: "inputText", text: "page 3" },
              { type: "inputImage", imageUrl: "unsupported://image" },
            ],
            mcpContentItems: [
              { type: "text", text: "page 3" },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          },
        ),
      },
    ]);

    await expect(
      router.handleMcpToolCall({
        backend: "codex",
        threadId: "thread-1",
        namespace: "pwragent_test",
        tool: "render_page",
      }),
    ).resolves.toEqual({
      structuredContent: { pageNumber: 3 },
      content: [
        { type: "text", text: "page 3" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ],
    });
  });

  it("returns MCP errors for unsupported MCP tools", async () => {
    const router = new AgentToolRouter([], {
      unsupportedMessage: "Unsupported test MCP tool.",
    });

    await expect(
      router.handleMcpToolCall({
        backend: "codex",
        threadId: "thread-1",
        namespace: "pwragent_test",
        tool: "missing",
        args: {},
      }),
    ).resolves.toEqual({
      isError: true,
      structuredContent: {
        code: "unsupported_operation",
        message: "Unsupported test MCP tool.",
      },
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              code: "unsupported_operation",
              message: "Unsupported test MCP tool.",
            },
            null,
            2,
          ),
        },
      ],
    });
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
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "inspect",
          arguments: {},
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "pwragent",
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
