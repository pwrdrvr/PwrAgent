import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  foldAcpTurnUsage,
  readAcpSelectedModel,
  readAcpUsageEnvelope,
  type AcpTokenUsage,
} from "../acp/acp-usage";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/acp-transcripts/qwen-tool-usage.json",
);

describe("ACP usage normalization", () => {
  it("aggregates every Qwen model-call envelope in a tool-using turn", () => {
    const updates = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<
      Record<string, unknown>
    >;
    const envelopes = updates.flatMap((update) => {
      const envelope = readAcpUsageEnvelope(update);
      return envelope ? [envelope] : [];
    });

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      scope: "model-call",
      tokenUsage: {
        cachedInputTokens: 0,
        inputTokens: 23_851,
        outputTokens: 222,
        reasoningOutputTokens: 29,
        totalTokens: 24_073,
      },
    });
    expect(
      envelopes.reduce<AcpTokenUsage | undefined>(
        (total, envelope) => foldAcpTurnUsage(total, envelope),
        undefined,
      ),
    ).toEqual({
      cachedInputTokens: 20_000,
      inputTokens: 48_851,
      outputTokens: 322,
      reasoningOutputTokens: 49,
      totalTokens: 49_173,
    });
  });

  it("treats Grok turn_completed usage as an authoritative turn total", () => {
    const envelope = readAcpUsageEnvelope({
      sessionUpdate: "turn_completed",
      usage: {
        inputTokens: 1_200,
        cachedReadTokens: 1_000,
        outputTokens: 50,
        reasoningTokens: 10,
        totalTokens: 1_250,
        modelUsage: {
          "grok-4.5-build": {},
        },
      },
    });

    expect(envelope).toMatchObject({
      model: "grok-4.5-build",
      scope: "turn",
    });
    expect(
      envelope
        ? foldAcpTurnUsage(
            {
              inputTokens: 999,
              totalTokens: 1_000,
            },
            envelope,
          )
        : undefined,
    ).toEqual({
      cachedInputTokens: 1_000,
      inputTokens: 1_200,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      totalTokens: 1_250,
    });
  });

  it("recovers the selected ACP model from session runtime state", () => {
    expect(
      readAcpSelectedModel({
        currentModelId: "qwen3-coder-plus",
      }),
    ).toBe("qwen3-coder-plus");
    expect(
      readAcpSelectedModel({
        configValues: {
          model: "qwen3-coder-flash",
        },
      }),
    ).toBe("qwen3-coder-flash");
  });
});
