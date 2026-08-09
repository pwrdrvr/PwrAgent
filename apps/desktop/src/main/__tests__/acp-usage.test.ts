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

  // Grok Build reports each model call on `response_completed`, a transient
  // xAI extension update that never reaches updates.jsonl. It was the only
  // mid-turn usage Grok emits and the parser ignored it outright, so a long
  // turn reported nothing at all until it finished.
  //
  // Its shape is NOT the turn total's shape. `ResponseUsage` is snake_case and
  // its `input_tokens` is the *uncached* prompt remainder
  // (prompt − cache_read − cache_creation), whereas `turn_completed.usage` is
  // camelCase with an `inputTokens` that includes both. Reading the field
  // straight across would undercount every running total by the cached
  // portion, then jump when the turn total landed.
  describe("Grok response_completed model-call usage", () => {
    function responseCompleted(usage: Record<string, number>) {
      return readAcpUsageEnvelope({
        sessionUpdate: "response_completed",
        message_id: "msg_1",
        stop_reason: "tool_use",
        usage,
      });
    }

    it("normalizes the uncached input remainder to an inclusive total", () => {
      expect(
        responseCompleted({
          input_tokens: 300,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
          output_tokens: 40,
          reasoning_tokens: 12,
        }),
      ).toEqual({
        scope: "model-call",
        tokenUsage: {
          cachedInputTokens: 900,
          inputTokens: 1_300,
          outputTokens: 40,
          reasoningOutputTokens: 12,
          totalTokens: 1_340,
        },
      });
    });

    it("ignores a response that carries no usage", () => {
      expect(
        readAcpUsageEnvelope({
          sessionUpdate: "response_completed",
          stop_reason: "end_turn",
        }),
      ).toBeUndefined();
    });

    it("accumulates to the same totals Grok reports at turn end", () => {
      // Two model calls whose sums must match what turn_completed would say:
      // prompt 1,300 + 2,050, of which 900 + 1,800 cached.
      const folded = [
        responseCompleted({
          input_tokens: 300,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
          output_tokens: 40,
          reasoning_tokens: 12,
        }),
        responseCompleted({
          input_tokens: 250,
          cache_read_input_tokens: 1_800,
          cache_creation_input_tokens: 0,
          output_tokens: 60,
          reasoning_tokens: 30,
        }),
      ].reduce<AcpTokenUsage | undefined>(
        (total, envelope) =>
          envelope ? foldAcpTurnUsage(total, envelope) : total,
        undefined,
      );

      expect(folded).toEqual({
        cachedInputTokens: 2_700,
        inputTokens: 3_350,
        outputTokens: 100,
        reasoningOutputTokens: 42,
        totalTokens: 3_450,
      });
      // The authoritative turn total still overwrites the running sum.
      const turnTotal = readAcpUsageEnvelope({
        sessionUpdate: "turn_completed",
        usage: {
          inputTokens: 3_350,
          cachedReadTokens: 2_700,
          outputTokens: 100,
          reasoningTokens: 42,
          totalTokens: 3_450,
        },
      });
      expect(turnTotal && foldAcpTurnUsage(folded, turnTotal)).toEqual(folded);
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
