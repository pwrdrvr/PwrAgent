import { describe, expect, it, vi } from "vitest";
import { GrokProvider } from "../providers/grok-provider.js";
import { XaiResponsesClient, buildXaiInput } from "../providers/xai-responses-client.js";
import { makeXaiResponse } from "../testing/xai-fixtures.js";

describe("buildXaiInput", () => {
  it("maps text and image items to xAI input content", () => {
    expect(
      buildXaiInput([
        { type: "text", text: "Describe this screenshot" },
        { type: "localImage", path: "/tmp/screenshot.png" },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Describe this screenshot" }],
      },
      {
        role: "user",
        content: [{ type: "input_image", image_url: "file:///tmp/screenshot.png" }],
      },
    ]);
  });
});

describe("XaiResponsesClient", () => {
  it("builds a create payload without unsupported instructions", () => {
    const client = new XaiResponsesClient({
      apiKey: "test-key",
      model: "grok-4.20-reasoning",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(
      client.buildCreatePayload({
        input: [{ role: "user", content: [{ type: "input_text", text: "Ship it" }] }],
        previousResponseId: "resp_prev",
      }),
    ).toEqual({
      model: "grok-4.20-reasoning",
      input: [{ role: "user", content: [{ type: "input_text", text: "Ship it" }] }],
      previous_response_id: "resp_prev",
      stream: false,
    });
  });

  it("raises a clear auth error when xAI responds with a failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }));
    const client = new XaiResponsesClient({
      apiKey: "bad-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.createResponse({
        input: [{ role: "user", content: [{ type: "input_text", text: "Ship it" }] }],
      }),
    ).rejects.toThrow("xAI Responses API request failed (401): Unauthorized");
  });
});

describe("GrokProvider", () => {
  it("uses the thread model and previous response id when starting a turn", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => makeXaiResponse({ id: "resp_next", text: "Shipped." }),
    }));
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        model: "grok-4.20-reasoning",
      },
      input: [{ type: "text", text: "Ship it" }],
      previousResponseId: "resp_prev",
    });

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Shipped.",
      providerResponseId: "resp_next",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.x.ai/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
        body: JSON.stringify({
          model: "grok-4.20-reasoning",
          input: [{ role: "user", content: [{ type: "input_text", text: "Ship it" }] }],
          previous_response_id: "resp_prev",
          stream: false,
        }),
      }),
    );
  });

  it("surfaces transport failures as provider errors", async () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Ship it" }],
    });

    await expect(activeTurn.result).rejects.toThrow("network down");
  });
});
