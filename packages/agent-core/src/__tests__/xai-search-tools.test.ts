import { describe, expect, it, vi } from "vitest";
import { GrokProvider } from "../providers/grok-provider.js";
import type { ProviderTurnEvent } from "../providers/provider-contract.js";

function createStreamTextWithToolCall(call: {
  id: string;
  name: string;
  input: Record<string, unknown>;
}) {
  return vi.fn((options: any) => {
    const text = (async () => {
      await options.tools[call.name].execute(call.input, {
        toolCallId: call.id,
        messages: options.messages,
        abortSignal: options.abortSignal,
      });
      return "Main answer.";
    })();
    return {
      text,
      response: text.then(() => ({ id: "resp_main" })),
      sources: Promise.resolve([]),
      providerMetadata: Promise.resolve(undefined),
    };
  });
}

function collectSubscribedEvents(
  subscribe: (listener: (event: ProviderTurnEvent) => void) => () => void,
): ProviderTurnEvent[] {
  const events: ProviderTurnEvent[] = [];
  subscribe((event) => {
    events.push(event);
  });
  return events;
}

describe("xAI search tool wrappers", () => {
  it("maps search_x arguments to xai.tools.xSearch options", async () => {
    const generateTextImpl = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Search result.",
      sources: [
        {
          sourceType: "url",
          url: "https://x.com/xai/status/1",
          title: "xAI on X",
        },
      ],
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl: createStreamTextWithToolCall({
        id: "call_x",
        name: "search_x",
        input: {
          query: "xAI posts with videos",
          allowedXHandles: ["xai"],
          fromDate: "2026-04-01",
          toDate: "2026-04-20",
          includeImages: true,
          includeVideos: true,
        },
      }),
      generateTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Search X." }],
    });
    const events = collectSubscribedEvents(activeTurn.subscribe!);

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "Main answer.",
    });
    expect(generateTextImpl.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        toolChoice: "required",
      }),
    );
    const searchTool = (generateTextImpl.mock.calls[0]?.[0] as any).tools.x_search;
    expect(searchTool.args).toEqual({
      allowedXHandles: ["xai"],
      fromDate: "2026-04-01",
      toDate: "2026-04-20",
      enableImageUnderstanding: true,
      enableVideoUnderstanding: true,
    });
    expect(events).toEqual([
      {
        type: "item_started",
        item: {
          id: "call_x",
          type: "dynamicToolCall",
          text: "search_x",
          toolName: "search_x",
          arguments: {
            query: "xAI posts with videos",
            allowedXHandles: ["xai"],
            fromDate: "2026-04-01",
            toDate: "2026-04-20",
            includeImages: true,
            includeVideos: true,
          },
        },
      },
      {
        type: "item_completed",
        item: {
          id: "call_x",
          type: "dynamicToolCall",
          text: "Search result.",
          toolName: "search_x",
          success: true,
          arguments: {
            query: "xAI posts with videos",
            allowedXHandles: ["xai"],
            fromDate: "2026-04-01",
            toDate: "2026-04-20",
            includeImages: true,
            includeVideos: true,
          },
          data: {
            output: "Search result.",
            sources: [
              {
                sourceType: "url",
                url: "https://x.com/xai/status/1",
                title: "xAI on X",
              },
            ],
          },
          sources: [
            {
              sourceType: "url",
              url: "https://x.com/xai/status/1",
              title: "xAI on X",
            },
          ],
        },
      },
    ]);
  });

  it("maps search_web arguments to xai.tools.webSearch options", async () => {
    const generateTextImpl = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Web result.",
      sources: [],
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl: createStreamTextWithToolCall({
        id: "call_web",
        name: "search_web",
        input: {
          query: "AI SDK docs",
          allowedDomains: ["ai-sdk.dev"],
          includeImages: true,
        },
      }),
      generateTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Search web." }],
    });

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "Main answer.",
    });
    expect(generateTextImpl.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        toolChoice: "required",
      }),
    );
    const searchTool = (generateTextImpl.mock.calls[0]?.[0] as any).tools.web_search;
    expect(searchTool.args).toEqual({
      allowedDomains: ["ai-sdk.dev"],
      enableImageUnderstanding: true,
    });
  });

  it("returns a failed tool result for mutually exclusive X handle filters", async () => {
    const generateTextImpl = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "unused",
      sources: [],
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl: createStreamTextWithToolCall({
        id: "call_x",
        name: "search_x",
        input: {
          query: "xAI",
          allowedXHandles: ["xai"],
          excludedXHandles: ["elonmusk"],
        },
      }),
      generateTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Search X." }],
    });
    const events = collectSubscribedEvents(activeTurn.subscribe!);

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "Main answer.",
    });
    expect(generateTextImpl).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "item_completed",
      item: {
        id: "call_x",
        type: "dynamicToolCall",
        text: "search_x cannot set both allowedXHandles and excludedXHandles",
        toolName: "search_x",
        success: false,
        arguments: {
          query: "xAI",
          allowedXHandles: ["xai"],
          excludedXHandles: ["elonmusk"],
        },
        data: {
          success: false,
          output: "search_x cannot set both allowedXHandles and excludedXHandles",
          sources: [],
          errorCode: "invalid_tool_arguments",
        },
      },
    });
  });
});
