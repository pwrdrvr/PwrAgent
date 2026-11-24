import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  foldAcpTurnUsage,
  mergeAcpPromptResultUsage,
  readAcpPromptResultUsageEnvelope,
  readAcpSelectedModel,
  readAcpUsageEnvelope,
  type AcpTokenUsage,
} from "../acp/acp-usage";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/acp-transcripts",
);
const fixturePath = path.join(fixtureDir, "qwen-tool-usage.json");

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

  // Whether Kimi reports usage was previously "unknown", and before that it
  // was wrongly asserted to be "no" on the strength of a fixture that could
  // not have shown usage either way. This is a purpose-made capture: a real
  // `kimi acp` turn end to end, driven with a prompt chosen to need no tools
  // ("tell me your favorite breakfast cereal"), recorded off the wire.
  //
  // Kimi Code 0.31.1 sends no usage anywhere in a complete turn. It tracks
  // tokens internally — `/usage` is in its advertised command list — but does
  // not put them on the ACP wire, so PwrAgent has nothing to price a Kimi
  // thread from. Recapture and revisit when Kimi's ACP surface changes.
  it("finds no token usage in a complete Kimi Code 0.31.1 turn", () => {
    const updates = JSON.parse(
      readFileSync(
        path.join(fixtureDir, "kimi-code-0-31-cereal.json"),
        "utf8",
      ),
    ) as Array<Record<string, unknown>>;

    // A real turn, not a stub: the agent thought, answered, and advertised
    // its commands.
    expect(
      new Set(updates.map((update) => update.sessionUpdate)),
    ).toEqual(
      new Set([
        "available_commands_update",
        "agent_thought_chunk",
        "agent_message_chunk",
      ]),
    );
    expect(
      updates.flatMap((update) => {
        const envelope = readAcpUsageEnvelope(update);
        return envelope ? [envelope] : [];
      }),
    ).toEqual([]);
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

  it("merges Antigravity per-prompt usage payloads additively with normalized turn envelopes", () => {
    const usageArb = fc.record({
      inputTokens: fc.integer({ min: 0, max: 100_000 }),
      cachedReadTokens: fc.integer({ min: 0, max: 100_000 }),
      cachedWriteTokens: fc.integer({ min: 0, max: 20_000 }),
      thoughtTokens: fc.integer({ min: 0, max: 10_000 }),
      visibleOutputTokens: fc.integer({ min: 0, max: 10_000 }),
      includeExplicitTotal: fc.boolean(),
    }).map(({
      inputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      thoughtTokens,
      visibleOutputTokens,
      includeExplicitTotal,
    }): Record<string, unknown> => {
      const outputTokens = thoughtTokens + visibleOutputTokens;
      return {
        inputTokens,
        cachedReadTokens,
        cachedWriteTokens,
        outputTokens,
        thoughtTokens,
        ...(includeExplicitTotal
          ? { totalTokens: inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens }
          : {}),
      };
    });

    fc.assert(fc.property(usageArb, usageArb, (first, second) => {
      const merged = mergeAcpPromptResultUsage(first, second);
      const mergedEnvelope = readAcpPromptResultUsageEnvelope({ usage: merged }, "acp:antigravity");
      const firstEnvelope = readAcpPromptResultUsageEnvelope({ usage: first }, "acp:antigravity");
      const secondEnvelope = readAcpPromptResultUsageEnvelope({ usage: second }, "acp:antigravity");
      expect(mergedEnvelope).toBeDefined();
      expect(firstEnvelope).toBeDefined();
      expect(secondEnvelope).toBeDefined();
      expect(mergedEnvelope!.tokenUsage).toEqual({
        ...(
          ((firstEnvelope!.tokenUsage.cacheWriteInputTokens ?? 0)
            + (secondEnvelope!.tokenUsage.cacheWriteInputTokens ?? 0)) > 0
            ? {
                cacheWriteInputTokens:
                  (firstEnvelope!.tokenUsage.cacheWriteInputTokens ?? 0)
                  + (secondEnvelope!.tokenUsage.cacheWriteInputTokens ?? 0),
              }
            : {}
        ),
        cachedInputTokens:
          (firstEnvelope!.tokenUsage.cachedInputTokens ?? 0)
          + (secondEnvelope!.tokenUsage.cachedInputTokens ?? 0),
        inputTokens:
          (firstEnvelope!.tokenUsage.inputTokens ?? 0)
          + (secondEnvelope!.tokenUsage.inputTokens ?? 0),
        outputTokens:
          (firstEnvelope!.tokenUsage.outputTokens ?? 0)
          + (secondEnvelope!.tokenUsage.outputTokens ?? 0),
        reasoningOutputTokens:
          (firstEnvelope!.tokenUsage.reasoningOutputTokens ?? 0)
          + (secondEnvelope!.tokenUsage.reasoningOutputTokens ?? 0),
        totalTokens:
          (firstEnvelope!.tokenUsage.totalTokens ?? 0)
          + (secondEnvelope!.tokenUsage.totalTokens ?? 0),
      });
      expect(mergeAcpPromptResultUsage(undefined, first)).toBe(first);
      expect(mergeAcpPromptResultUsage(first, undefined)).toBe(first);
    }));
  });
});
