import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildThreadPricingSnapshotEstimate } from "../thread-pricing-display";

const at = Date.UTC(2026, 10, 14);
const astraGroup = fc.record({
  uncached: fc.integer({ min: 1, max: 100_000 }),
  cached: fc.integer({ min: 0, max: 100_000 }),
  output: fc.integer({ min: 0, max: 100_000 }),
  fast: fc.boolean(),
}).map(({ uncached, cached, output, fast }) => ({
  model: "gpt-6-astra",
  serviceTier: fast ? "priority" : "standard",
  tokens: { inputTokens: uncached + cached, cachedInputTokens: cached, outputTokens: output },
  // Official Astra list-price oracle: $10/$1/$50 per million; Fast is 2x.
  expectedMicros: (uncached * 10 + cached + output * 50) * (fast ? 2 : 1),
}));

describe("historical pricing groups", () => {
  it("shows Astra's known list rates independently of missing child usage", () => {
    fc.assert(fc.property(fc.array(fc.constant("@mathos/glm-5.3"), { maxLength: 5 }), (children) => {
      const estimate = buildThreadPricingSnapshotEstimate({
        model: "gpt-6-astra", pricingSource: "provider",
        groups: children.map((model) => ({ model, tokens: {} })),
      }, at);
      expect(estimate.totalCostMicros).toBeUndefined();
      expect(estimate.currentModelRate).toMatchObject({
        inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50,
      });
    }));
  });

  it("retains a ten-microdollar Astra charge beside a wholly unknown MathOS group", () => {
    expect(buildThreadPricingSnapshotEstimate({ pricingSource: "provider", groups: [
      { model: "gpt-6-astra", tokens: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 } },
      { model: "@mathos/glm-5.3", tokens: {} },
    ] }, at)).toMatchObject({ totalCostMicros: 10, unpricedGroupCount: 1 });
  });

  it("keeps the sum of known prices when any number of unknown child groups join the set", () => {
    fc.assert(fc.property(
      fc.array(astraGroup, { minLength: 1, maxLength: 5 }),
      fc.array(fc.constantFrom("@mathos/glm-5.3", "unknown-model"), { minLength: 1, maxLength: 5 }),
      (known, unknown) => {
        const groups = [
          ...known.map(({ expectedMicros: _expected, ...group }) => group),
          ...unknown.map((model) => ({ model, tokens: {} })),
        ];
        const snapshot = { pricingSource: "provider" as const, model: "current-model-is-irrelevant", groups };
        const estimate = buildThreadPricingSnapshotEstimate(snapshot, at);
        expect(estimate.totalCostMicros).toBe(known.reduce((sum, group) => sum + group.expectedMicros, 0));
        expect(buildThreadPricingSnapshotEstimate({ ...snapshot, groups: [...groups].reverse() }, at).totalCostMicros)
          .toBe(estimate.totalCostMicros);
      },
    ));
  });

  it("does not turn a wholly unknown set into a zero-dollar estimate", () => {
    expect(buildThreadPricingSnapshotEstimate({ pricingSource: "provider", groups: [
      { model: "@mathos/gpt-6-astra", tokens: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } },
      { model: "gpt-6-astra", tokens: {} },
    ] }, at).totalCostMicros).toBeUndefined();
  });

  it("keeps the provider's complete USD total authoritative", () => {
    fc.assert(fc.property(astraGroup, fc.nat(10_000_000), (group, estimatedCostMicros) => {
      expect(buildThreadPricingSnapshotEstimate({
        pricingSource: "provider", estimatedCostMicros, groups: [group],
      }, at).totalCostMicros).toBe(estimatedCostMicros);
    }));
  });
});
