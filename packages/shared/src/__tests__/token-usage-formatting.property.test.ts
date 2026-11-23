import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadEntry } from "../contracts/normalized-app-server";
import {
  estimateTokenUsageCost,
  formatTokenUsageMicrosAsUsd,
  formatTokenUsagePriceFactor,
  formatTokenUsageStandardRateSuffix,
  formatTokenUsageUsd,
  formatTokenUsageUsdPerMillion,
  type ThreadUsageLineRecord,
} from "../token-usage-pricing";

const edgeAmounts = [
  0, -0, -0.01, -Infinity, Infinity, NaN, Number.MIN_VALUE,
  0.000999999, 0.001, 0.001000001, 0.010000001, 0.099999999,
  0.1, 0.100000001, 0.115, 1234.56789, Number.MAX_VALUE,
];

function legacyUsd(value: number): string {
  if (value > 0 && value < 0.001) return "<$0.001";
  const digits = value < 0.1 ? 3 : 2;
  const scale = 10 ** digits;
  const rounded = value <= 0 ? 0 : Math.ceil(value * scale - Number.EPSILON * scale) / scale;
  return new Intl.NumberFormat(undefined, {
    currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits, style: "currency",
  }).format(rounded);
}

function legacyMultiplier(value: number): string {
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 3, minimumFractionDigits: 1,
  }).format(value)}x`;
}

it("preserves the fresh-formatter output in the process default locale", () => {
  const check = (value: number, standard: number) => {
    expect(formatTokenUsageUsd(value)).toBe(legacyUsd(value));
    expect(formatTokenUsageMicrosAsUsd(value)).toBe(legacyUsd(value / 1_000_000));
    expect(formatTokenUsageUsdPerMillion(value)).toBe(new Intl.NumberFormat(undefined, {
      currency: "USD", maximumFractionDigits: 3, minimumFractionDigits: 2, style: "currency",
    }).format(value));
    expect(formatTokenUsagePriceFactor(value, standard)).toBe(
      standard <= 0 ? "unknown factor" : legacyMultiplier(value / standard),
    );
    expect(formatTokenUsageStandardRateSuffix(value)).toBe(` ${legacyMultiplier(value)} Standard`);
    expect(formatTokenUsageStandardRateSuffix(value, ", ")).toBe(`, ${legacyMultiplier(value)} Standard`);
  };
  for (const value of edgeAmounts) {
    check(value, 5);
    check(0.5, value);
  }
  fc.assert(fc.property(fc.double(), fc.double(), check));
  expect(formatTokenUsageStandardRateSuffix(undefined)).toBe("");
});

function completedTurns(count: number): { entries: AppServerThreadEntry[]; lines: ThreadUsageLineRecord[] } {
  const entries: AppServerThreadEntry[] = [];
  const lines: ThreadUsageLineRecord[] = [];
  for (let index = 0; index < count; index++) {
    const id = `turn-${index}`;
    const startedAt = Date.UTC(2026, 10, 20) + index * 10_000;
    const completedAt = startedAt + 9_000;
    const cachedInputTokens = 12_000 + index * 100;
    const uncachedInputTokens = 3_000 + index * 431;
    const outputTokens = 1_400 + index * 100;
    const inputTokens = cachedInputTokens + uncachedInputTokens;
    const totalTokens = inputTokens + outputTokens;
    const model = "gpt-5.5";
    const fastMode = index % 2 === 1;
    const cost = estimateTokenUsageCost({
      at: startedAt, model, fastMode, cachedInputTokens, uncachedInputTokens, outputTokens,
    })!;
    entries.push({
      id: `reply-${index}`, text: "Fixture reply", type: "message", role: "assistant",
      turn: { id, startedAt, completedAt, status: "completed" },
    });
    lines.push({
      backend: "codex", provider: "openai", currency: "USD", model, fastMode,
      threadId: "fixture", turnId: id, usageLineId: id, createdAt: startedAt, startedAt, completedAt,
      scope: "turn", source: "hydration", status: "finalized", priceStatus: "priced",
      inputTokens, cachedInputTokens, uncachedInputTokens, outputTokens, totalTokens, reasoningOutputTokens: 0,
      cachedInputCostMicros: cost.cachedInputCostMicros, uncachedInputCostMicros: cost.uncachedInputCostMicros,
      outputCostMicros: cost.outputCostMicros, totalCostMicros: cost.totalCostMicros,
    });
  }
  return { entries, lines };
}

it("bounds formatter constructions during repeated completed-turn projection", async () => {
  const shortThread = completedTurns(2);
  const longThread = completedTurns(80);
  vi.resetModules();
  const { reconcileCompletedTurnUsageEntries } = await import("../thread-usage-display");
  const numberFormat = vi.spyOn(Intl, "NumberFormat");
  try {
    const shortResult = reconcileCompletedTurnUsageEntries(shortThread);
    const coldConstructions = numberFormat.mock.calls.length;
    const longResult = reconcileCompletedTurnUsageEntries(longThread);
    const totalConstructions = numberFormat.mock.calls.length;

    expect(shortResult.filter((entry) => entry.type === "activity")).toHaveLength(2);
    expect(longResult.filter((entry) => entry.type === "activity")).toHaveLength(80);
    // The two speeds cover both USD precisions, unit rates and multipliers.
    // New turns and amounts should reuse those four configurations.
    expect(coldConstructions).toBeLessThanOrEqual(4);
    expect(totalConstructions).toBe(coldConstructions);
  } finally {
    numberFormat.mockRestore();
  }
});
