import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { acpUsageNotification } from "../acp/acp-live-notifications";
import {
  readAcpPromptResultUsageEnvelope,
  readAcpUsageEnvelope,
} from "../acp/acp-usage";
import { buildLiveThreadUsageLine, fallbackUsageProvider } from "../app-server/thread-usage-math";

describe("Antigravity ACP usage normalization properties", () => {
  it("converts Antigravity exclusive prompt-result usage into inclusive turn totals without token drift", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 500_000 }),
      fc.integer({ min: 0, max: 500_000 }),
      fc.integer({ min: 0, max: 200_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      fc.integer({ min: 0, max: 100_000 }),
      (uncachedInput, cachedRead, cachedWrite, output, rawThought) => {
        const thought = Math.min(rawThought, output);
        const total = uncachedInput + cachedRead + cachedWrite + output;
        const wireUsage = {
          cachedReadTokens: cachedRead,
          cachedWriteTokens: cachedWrite,
          inputTokens: uncachedInput,
          outputTokens: output,
          thoughtTokens: thought,
          totalTokens: total,
        };
        const envelope = readAcpUsageEnvelope(
          {
            kind: "turn_finished",
            outputText: "ok",
            usage: wireUsage,
          },
          "acp:antigravity",
        );

        expect(envelope).toBeDefined();
        expect(
          readAcpPromptResultUsageEnvelope(
            { stopReason: "end_turn", usage: wireUsage },
            "acp:antigravity",
          ),
        ).toEqual(envelope);
        expect(
          readAcpPromptResultUsageEnvelope(
            { stopReason: "end_turn", usage: wireUsage },
            "acp:grok",
          ),
        ).toBeUndefined();
        expect(envelope?.scope).toBe("turn");
        const expectedInput = uncachedInput + cachedRead + cachedWrite;
        expect(envelope?.tokenUsage).toEqual({
          ...(cachedWrite > 0 ? { cacheWriteInputTokens: cachedWrite } : {}),
          cachedInputTokens: cachedRead,
          inputTokens: expectedInput,
          outputTokens: output,
          reasoningOutputTokens: thought,
          totalTokens: total,
        });

        const notification = acpUsageNotification({
          envelope: envelope!,
          model: "claude-sonnet-5-5",
          threadId: "thread-1",
          totalTokenUsage: envelope!.tokenUsage,
          turnId: "turn-1",
        });
        expect(notification?.method).toBe("thread/tokenUsage/updated");
        const params = notification?.method === "thread/tokenUsage/updated"
          ? notification.params
          : undefined;
        const line = buildLiveThreadUsageLine({
          attributed: true,
          backend: "acp:antigravity",
          createdAt: Date.UTC(2026, 10, 23),
          model: typeof params?.model === "string" ? params.model : undefined,
          threadId: "thread-1",
          tokenUsage: params?.tokenUsage,
          turnId: "turn-1",
        });

        expect(line).toBeDefined();
        expect(line?.inputTokens).toBe(expectedInput);
        expect(line?.cachedInputTokens).toBe(cachedRead);
        expect(line?.uncachedInputTokens).toBe(uncachedInput + cachedWrite);
        expect(line?.cacheWriteInputTokens).toBe(cachedWrite);
        expect(line?.outputTokens).toBe(output);
        expect(line?.reasoningOutputTokens).toBe(thought);
        expect(line?.totalTokens).toBe(total);
        expect(line?.priceStatus).toBe("priced");
      },
    ));
  });

  it("attributes unpriced Antigravity turns to Google rather than OpenAI", () => {
    expect(fallbackUsageProvider("acp:antigravity")).toBe("google");
    expect(fallbackUsageProvider("acp:gemini")).toBe("google");

    const line = buildLiveThreadUsageLine({
      attributed: true,
      backend: "acp:antigravity",
      createdAt: Date.UTC(2026, 10, 23),
      model: "gemini-pro-orchestrator-neon",
      threadId: "thread-1",
      tokenUsage: {
        last_token_usage: {
          cached_input_tokens: 1_000,
          input_tokens: 5_000,
          output_tokens: 200,
          total_tokens: 5_200,
        },
      },
      turnId: "turn-1",
    });

    expect(line).toMatchObject({
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-rate",
      provider: "google",
    });
  });
});
