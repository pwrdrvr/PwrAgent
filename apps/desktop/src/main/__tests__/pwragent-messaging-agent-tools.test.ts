import { describe, expect, it, vi } from "vitest";

import {
  buildPwrAgentMessagingPdfToolRouter,
  buildPwrAgentMessagingToolRouter,
} from "../agent-tools/pwragent-messaging-agent-tools";
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
    expect(specs).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "pwragent",
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            name: "get_current_messaging_surface",
          }),
          expect.objectContaining({
            type: "function",
            name: "attach_thread_here",
          }),
        ]),
      }),
    ]);
    expect(specs[0]?.type === "namespace" ? specs[0].tools.map((tool) => tool.name) : [])
      .toEqual([
      "get_current_messaging_surface",
      "send_private_response",
      "attach_thread_here",
      "inspect_messaging_pdfs",
      "search_messaging_pdf_text",
      "render_messaging_pdf_pages",
    ]);
    expect(router.buildMcpTools().map((tool) => tool.name)).toEqual([
      "get_current_messaging_surface",
      "send_private_response",
      "attach_thread_here",
    ]);
    const privateResponseTool = specs[0]?.type === "namespace"
      ? specs[0].tools.find((tool) => tool.name === "send_private_response")
      : undefined;
    expect(privateResponseTool).toMatchObject({
      description: expect.stringContaining(
        "Only the continuation's final response returns to the source surface",
      ),
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          awaitReply: expect.objectContaining({
            description: expect.stringContaining(
              "start a continuation from the first private reply",
            ),
          }),
        }),
      }),
    });
    const attachTool = specs[0]?.type === "namespace"
      ? specs[0].tools.find((tool) => tool.name === "attach_thread_here")
      : undefined;
    expect(attachTool).toMatchObject({
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          instanceId: expect.objectContaining({ type: "string" }),
          includeRemote: expect.objectContaining({ type: "boolean" }),
        }),
      }),
    });
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

  it("keeps rendered PDF pages on the legacy Codex dynamic-tool surface", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        attachmentId: "pdf-1",
        alreadySuppliedPageNumbers: [],
        name: "window-sticker.pdf",
        pages: [{ height: 1988, pageNumber: 3, width: 3072 }],
      },
      imageContent: [
        {
          base64: "AQID",
          mimeType: "image/png",
          pageNumber: 3,
        },
      ],
    }));
    const router = buildPwrAgentMessagingToolRouter(handler);

    const response = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "agent-thread",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "render_messaging_pdf_pages",
        arguments: {
          attachmentId: "pdf-1",
          pageNumbers: [3],
        },
      },
    });

    expect(response).toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.any(String),
        },
      ],
    });
    const dynamicPayload = JSON.parse(
      response.contentItems?.[0]?.type === "inputText"
        ? response.contentItems[0].text
        : "{}",
    );
    expect(dynamicPayload).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "PwrAgent returned rendered PDF page image(s) with this tool result.",
          ),
        },
        {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
        },
      ],
      result: {
        attachmentId: "pdf-1",
        alreadySuppliedPageNumbers: [],
        name: "window-sticker.pdf",
        pages: [{ height: 1988, pageNumber: 3, width: 3072 }],
      },
    });

    await expect(router.handleMcpToolCall({
      backend: "codex",
      threadId: "agent-thread",
      turnId: "turn-1",
      tool: "render_messaging_pdf_pages",
      args: {
        attachmentId: "pdf-1",
        pageNumbers: [3],
      },
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: "unsupported_operation",
      },
    });
  });

  it("exposes only bounded PDF tools through the dedicated MCP surface", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        attachmentId: "pdf-1",
        alreadySuppliedPageNumbers: [],
        name: "window-sticker.pdf",
        pages: [{ height: 1988, pageNumber: 3, width: 3072 }],
      },
      imageContent: [
        {
          base64: "AQID",
          mimeType: "image/png",
          pageNumber: 3,
        },
      ],
    }));
    const router = buildPwrAgentMessagingPdfToolRouter(handler);

    expect(router.buildMcpTools().map((tool) => tool.name)).toEqual([
      "inspect_messaging_pdfs",
      "search_messaging_pdf_text",
      "render_messaging_pdf_pages",
    ]);

    const response = await router.handleMcpToolCall({
      backend: "codex",
      threadId: "agent-thread",
      turnId: "turn-1",
      tool: "render_messaging_pdf_pages",
      args: {
        attachmentId: "pdf-1",
        pageNumbers: [3],
      },
    });

    expect(response).toMatchObject({
      structuredContent: {
        attachmentId: "pdf-1",
        pages: [{ height: 1988, pageNumber: 3, width: 3072 }],
      },
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "PwrAgent returned rendered PDF page image(s) with this tool result.",
          ),
        },
        {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
        },
      ],
    });
    expect(handler).toHaveBeenCalledWith({
      operation: "render_messaging_pdf_pages",
      context: {
        backend: "codex",
        threadId: "agent-thread",
        turnId: "turn-1",
      },
      args: {
        attachmentId: "pdf-1",
        pageNumbers: [3],
      },
    });
  });
});
