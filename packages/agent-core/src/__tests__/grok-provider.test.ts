import { describe, expect, it, vi } from "vitest";
import { GrokProvider } from "../providers/grok-provider.js";

describe("GrokProvider", () => {
  it("uses the Responses API for supported Grok models", async () => {
    const streamTextImpl = vi.fn(() => ({
      text: Promise.resolve("Shipped."),
      response: Promise.resolve({ id: "resp_next" }),
      sources: Promise.resolve([]),
      providerMetadata: Promise.resolve(undefined),
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        model: "grok-4.20-reasoning",
        reasoningEffort: "medium",
      },
      history: [
        { role: "user", text: "Old question" },
        { role: "assistant", text: "Old answer" },
      ],
      input: [{ type: "text", text: "Ship it" }],
      previousResponseId: "resp_prev",
    });

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Shipped.",
      providerResponseId: "resp_next",
      sources: [],
      providerMetadata: undefined,
    });
    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          modelId: "grok-4.20-reasoning",
          provider: "xai.responses",
        }),
        providerOptions: {
          xai: {
            previousResponseId: "resp_prev",
          },
        },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ship it" }],
          },
        ],
      }),
    );
  });

  it("routes configured Grok models through Responses API only", async () => {
    const streamTextImpl = vi.fn(() => ({
      text: Promise.resolve("Shipped."),
      response: Promise.resolve({ id: "resp_next" }),
      sources: Promise.resolve([]),
      providerMetadata: Promise.resolve(undefined),
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        model: "grok-4.20-non-reasoning",
        reasoningEffort: "high",
      },
      history: [
        { role: "user", text: "Old question" },
        { role: "assistant", text: "Old answer" },
      ],
      input: [{ type: "text", text: "Ship it" }],
      previousResponseId: "resp_prev",
    });

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "Shipped.",
      providerResponseId: "resp_next",
    });
    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          modelId: "grok-4.20-non-reasoning",
          provider: "xai.responses",
        }),
        providerOptions: {
          xai: {
            previousResponseId: "resp_prev",
          },
        },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ship it" }],
          },
        ],
      }),
    );
  });

  it("surfaces transport failures as provider errors", async () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl: vi.fn(() => {
        throw new Error("network down");
      }),
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Ship it" }],
    });

    await expect(activeTurn.result).rejects.toThrow("network down");
  });
});
