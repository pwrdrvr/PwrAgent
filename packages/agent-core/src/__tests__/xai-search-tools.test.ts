import { describe, expect, it, vi } from "vitest";
import { GrokProvider } from "../providers/grok-provider.js";
import type { ProviderTurnEvent } from "../providers/provider-contract.js";
import { Deferred } from "../testing/test-harness.js";

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

function createStreamTextWithParallelToolCalls(calls: Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}>) {
  return vi.fn((options: any) => {
    const text = (async () => {
      await Promise.all(
        calls.map(async (call) => {
          await options.tools[call.name].execute(call.input, {
            toolCallId: call.id,
            messages: options.messages,
            abortSignal: options.abortSignal,
          });
        }),
      );
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
        system: expect.stringContaining("Return at most 5 findings."),
        prompt: expect.stringContaining("xAI posts with videos"),
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
        item: expect.objectContaining({
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
          data: expect.objectContaining({
            output: "Search result.",
            sources: [
              {
                sourceType: "url",
                url: "https://x.com/xai/status/1",
                title: "xAI on X",
              },
            ],
            startedAt: expect.any(Number),
            completedAt: expect.any(Number),
            elapsedMs: expect.any(Number),
          }),
          sources: [
            {
              sourceType: "url",
              url: "https://x.com/xai/status/1",
              title: "xAI on X",
            },
          ],
        }),
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
        system: expect.stringContaining("Return at most 5 findings."),
        prompt: expect.stringContaining("AI SDK docs"),
        toolChoice: "required",
      }),
    );
    const searchTool = (generateTextImpl.mock.calls[0]?.[0] as any).tools.web_search;
    expect(searchTool.args).toEqual({
      allowedDomains: ["ai-sdk.dev"],
      enableImageUnderstanding: true,
    });
    expect((generateTextImpl.mock.calls[0]?.[0].model as { modelId?: string }).modelId).toBe(
      "grok-4-1-fast-non-reasoning",
    );
  });

  it("uses a 90 second default timeout for nested search tools", async () => {
    vi.useFakeTimers();
    try {
      const provider = new GrokProvider({
        apiKey: "test-key",
        streamTextImpl: createStreamTextWithToolCall({
          id: "call_web",
          name: "search_web",
          input: { query: "slow query" },
        }),
        generateTextImpl: vi.fn(async () => {
          await new Promise(() => undefined);
          return { text: "unused", sources: [] };
        }),
      });

      const activeTurn = provider.startTurn({
        thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
        input: [{ type: "text", text: "Search web." }],
      });
      const events = collectSubscribedEvents(activeTurn.subscribe!);

      await vi.advanceTimersByTimeAsync(89_999);
      expect(events).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(activeTurn.result).resolves.toMatchObject({
        assistantText: "Main answer.",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "item_completed",
          item: expect.objectContaining({
            success: false,
            text: "search_web timed out after 90 seconds",
            toolName: "search_web",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured fast non-reasoning model for nested web and X search", async () => {
    const generateTextImpl = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Search result.",
      sources: [],
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      searchModel: "grok-4-1-fast-non-reasoning",
      streamTextImpl: createStreamTextWithParallelToolCalls([
        {
          id: "call_web",
          name: "search_web",
          input: { query: "Matt Van Horn" },
        },
        {
          id: "call_x",
          name: "search_x",
          input: { query: "from:mattvanhorn", fromDate: "2025-04-20" },
        },
      ]),
      generateTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Search web and X." }],
    });

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "Main answer.",
    });

    expect(generateTextImpl).toHaveBeenCalledTimes(2);
    const modelIds = generateTextImpl.mock.calls.map(
      ([params]) => (params.model as { modelId?: string }).modelId,
    );
    expect(modelIds).toEqual([
      "grok-4-1-fast-non-reasoning",
      "grok-4-1-fast-non-reasoning",
    ]);
    expect(generateTextImpl.mock.calls.map(([params]) => Object.keys(params.tools ?? {}))).toEqual([
      ["web_search"],
      ["x_search"],
    ]);
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
          startedAt: expect.any(Number),
          completedAt: expect.any(Number),
          elapsedMs: expect.any(Number),
          success: false,
          output: "search_x cannot set both allowedXHandles and excludedXHandles",
          sources: [],
          errorCode: "invalid_tool_arguments",
        },
      },
    });
  });

  it("fails a nested X search when it exceeds the wrapper timeout", async () => {
    vi.useFakeTimers();
    try {
      const generateTextImpl = vi.fn(
        (params: Record<string, unknown>) =>
          new Promise((_resolve, reject) => {
            const signal = params.abortSignal as AbortSignal | undefined;
            signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      );
      const provider = new GrokProvider({
        apiKey: "test-key",
        searchToolTimeoutMs: 1_000,
        streamTextImpl: createStreamTextWithToolCall({
          id: "call_x",
          name: "search_x",
          input: {
            query: "\"Matt Van Horn\" OR @mattvanhorn OR from:mattvanhorn",
          },
        }),
        generateTextImpl,
      });

      const activeTurn = provider.startTurn({
        thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
        input: [{ type: "text", text: "Search X." }],
      });
      const events = collectSubscribedEvents(activeTurn.subscribe!);
      const resultPromise = activeTurn.result;

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(resultPromise).resolves.toMatchObject({
        assistantText: "Main answer.",
      });
      expect(events).toContainEqual({
        type: "item_completed",
        item: {
          id: "call_x",
          type: "dynamicToolCall",
          text: "search_x timed out after 1 seconds",
          toolName: "search_x",
          success: false,
          arguments: {
            query: "\"Matt Van Horn\" OR @mattvanhorn OR from:mattvanhorn",
          },
          data: {
            startedAt: expect.any(Number),
            completedAt: expect.any(Number),
            elapsedMs: expect.any(Number),
            success: false,
            output: "search_x timed out after 1 seconds",
            sources: [],
            errorCode: "search_tool_timeout",
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes each parallel search tool call independently", async () => {
    const deferredCalls = [
      new Deferred<{ text: string; sources: unknown[] }>(),
      new Deferred<{ text: string; sources: unknown[] }>(),
      new Deferred<{ text: string; sources: unknown[] }>(),
    ];
    const generateTextImpl = vi.fn(
      () => deferredCalls[generateTextImpl.mock.calls.length - 1].promise,
    );
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl: createStreamTextWithParallelToolCalls([
        {
          id: "call_web",
          name: "search_web",
          input: { query: "Matt Van Horn" },
        },
        {
          id: "call_x_primary",
          name: "search_x",
          input: { query: "Matt Van Horn" },
        },
        {
          id: "call_x_secondary",
          name: "search_x",
          input: { query: "\"Matt Van Horn\" OR @mattvanhorn OR from:mattvanhorn" },
        },
      ]),
      generateTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Search everywhere." }],
    });
    const events = collectSubscribedEvents(activeTurn.subscribe!);

    deferredCalls[1].resolve({ text: "X result.", sources: [] });
    deferredCalls[2].resolve({ text: "Specific X result.", sources: [] });
    deferredCalls[0].resolve({ text: "Web result.", sources: [] });

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "Main answer.",
    });

    const startedIds = events
      .filter((event) => event.type === "item_started")
      .flatMap((event) => ("item" in event ? [event.item.id] : []))
      .sort();
    const completedIds = events
      .filter((event) => event.type === "item_completed")
      .flatMap((event) => ("item" in event ? [event.item.id] : []))
      .sort();

    expect(startedIds).toEqual(["call_web", "call_x_primary", "call_x_secondary"]);
    expect(completedIds).toEqual(["call_web", "call_x_primary", "call_x_secondary"]);
  });
});
