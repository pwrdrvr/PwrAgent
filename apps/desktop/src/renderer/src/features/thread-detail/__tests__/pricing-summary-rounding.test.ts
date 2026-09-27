import { describe, expect, it } from "vitest";
import { formatRoundedSummaryMoney, roundPricingSummary } from "../pricing-summary-rounding";

describe("summary display rounding", () => {
  it("reconciles the reported summary amounts at cent precision", () => {
    expect(roundPricingSummary(42_412_403, {
      withoutGateCostMicros: 29_486_274,
      gateCostMicros: 113_330,
      revealedCostMicros: 16_310_766,
      savingsMicros: 13_062_178,
    }, [42_299_073, 113_330])).toEqual({
      costMicros: 42_410_000,
      savingsMicros: 13_060_000,
      unfilteredCostMicros: 55_470_000,
      withoutGateCostMicros: 29_480_000,
      gateCostMicros: 110_000,
      revealedCostMicros: 16_310_000,
      modelCostsMicros: [42_300_000, 110_000],
    });
  });

  it("preserves equations across savings, overhead, ties, and sub-cent amounts", () => {
    for (const without of [0, 499, 500, 1_499, 5_000, 99_999, 100_000, 1_234_567]) {
      for (const gate of [0, 499, 500, 1_499, 5_000, 99_999, 100_000, 1_234_567]) {
        for (const revealed of [0, 499, 500, 1_499, 5_000, 99_999, 100_000, 1_234_567]) {
          const cost = gate + revealed;
          const terms = { withoutGateCostMicros: without, gateCostMicros: gate,
            revealedCostMicros: revealed, savingsMicros: without - cost };
          const rounded = roundPricingSummary(cost, terms, [gate, revealed]);
          expect(rounded.costMicros + rounded.savingsMicros).toBe(rounded.unfilteredCostMicros);
          expect(rounded.withoutGateCostMicros - rounded.gateCostMicros - rounded.revealedCostMicros)
            .toBe(rounded.savingsMicros);
          expect(rounded.modelCostsMicros!.reduce((sum, value) => sum + value, 0)).toBe(rounded.costMicros);
          expect(rounded.withoutGateCostMicros).toBeGreaterThanOrEqual(0);
          expect(rounded.gateCostMicros).toBeGreaterThanOrEqual(0);
          expect(rounded.revealedCostMicros).toBeGreaterThanOrEqual(0);
          expect(Math.abs(rounded.withoutGateCostMicros - without)).toBeLessThan(10_000);
          expect(Math.abs(rounded.gateCostMicros - gate)).toBeLessThan(10_000);
          expect(Math.abs(rounded.revealedCostMicros - revealed)).toBeLessThan(10_000);
          expect(roundPricingSummary(cost, terms, [gate, revealed])).toEqual(rounded);
        }
      }
    }
  });

  it("does not invent model charges when the model ledger is incomplete", () => {
    expect(roundPricingSummary(100_000, {
      withoutGateCostMicros: 200_000, gateCostMicros: 10_000,
      revealedCostMicros: 50_000, savingsMicros: 140_000,
    }, [50_000]).modelCostsMicros).toBeUndefined();
  });

  it("formats allocated units without applying the upward rounding again", () => {
    expect(formatRoundedSummaryMoney(32_450_000)).toBe("$32.45");
    expect(formatRoundedSummaryMoney(1_000)).toBe("$0.001");
    expect(formatRoundedSummaryMoney(0)).toBe("$0.000");
  });
});
