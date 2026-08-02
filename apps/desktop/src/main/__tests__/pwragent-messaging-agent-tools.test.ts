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
      "attach_thread_here",
      "inspect_messaging_pdfs",
      "search_messaging_pdf_text",
      "render_messaging_pdf_pages",
    ]);
    expect(router.buildMcpTools().map((tool) => tool.name)).toEqual([
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

  it("returns rendered PDF pages as image input for Codex dynamic tools", async () => {
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

    expect(response).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: [
            "PwrAgent has already added the rendered PDF page image(s) to this turn's model context. Analyze those images directly. Read requested values from their printed labels, not inferred arithmetic. Do not use web search or other external sources for this PDF unless the user explicitly requests outside research. Do not serialize this result, call image(), use exec or other local tools to reprocess the page, or render the same page again.",
            JSON.stringify({
              attachmentId: "pdf-1",
              alreadySuppliedPageNumbers: [],
              name: "window-sticker.pdf",
              pages: [{ height: 1988, pageNumber: 3, width: 3072 }],
            }, null, 2),
          ].join("\n\n"),
        },
        {
          type: "inputImage",
          imageUrl: "data:image/png;base64,AQID",
        },
      ],
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
});
