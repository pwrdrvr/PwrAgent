import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { estimateTokenUsageCost } from "../token-usage-pricing";
import { attributeCodexProviderUsageLine, withCodexProviderSnapshotRates } from "../codex-model-providers";
import { buildThreadPricingSnapshotEstimate } from "../thread-pricing-display";
import { estimateHistoricalThreadUsageGapLines } from "../thread-pricing-projection";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";
import source from "./fixtures/openrouter-assumed-pricing-2026-11-15.json";

const counts = fc.record({
  uncachedInputTokens: fc.integer({ min: 1, max: 1_000_000 }),
  cachedInputTokens: fc.integer({ min: 0, max: 1_000_000 }),
  outputTokens: fc.integer({ min: 0, max: 1_000_000 }),
});

const mathos = { id: "mathos", name: "MathOS", baseUrl: "https://os.openmathmodel.org/v1" };

function usageLine(tokens: { uncachedInputTokens: number; cachedInputTokens: number; outputTokens: number }, overrides: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    ...tokens, backend: "codex", threadId: "child", usageLineId: "turn-1", turnId: "turn-1",
    createdAt: Date.UTC(2026, 10, 15), currency: "USD", model: "@mathos/glm-5.3", provider: "mathos",
    inputTokens: tokens.uncachedInputTokens + tokens.cachedInputTokens, reasoningOutputTokens: 0,
    totalTokens: tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.outputTokens,
    scope: "turn", source: "live", status: "finalized", priceStatus: "unpriced",
    uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
    ...overrides,
  };
}

function oracleMicros(tokens: number, usdPerToken: string): number {
  const decimals = usdPerToken.split(".")[1]?.length ?? 0;
  const denominator = 10n ** BigInt(decimals);
  const numerator = BigInt(usdPerToken.replace(".", "")) * BigInt(tokens) * 1_000_000n;
  return Number((numerator + denominator / 2n) / denominator);
}

describe("assumed OpenRouter prices", () => {
  it("never bills inherited fork context, regardless of reference or configured rates", () => {
    fc.assert(fc.property(counts, fc.boolean(), (tokens, configured) => {
      const line = usageLine(tokens, { scope: "fork-baseline" });
      const provider = { ...mathos, ...(configured ? { rates: [{ model: "glm-5.3", inputPerMillion: 100, outputPerMillion: 200 }] } : {}) };
      const priced = attributeCodexProviderUsageLine(line, provider, undefined);
      expect(priced).toMatchObject({ priceStatus: "priced", totalCostMicros: 0, outputCostMicros: 0, uncachedInputCostMicros: 0, cachedInputCostMicros: 0 });
      expect(priced.pricingCatalogId).toBeUndefined();
    }));
  });

  it("keeps a million-token MathOS fork baseline free", () => {
    expect(attributeCodexProviderUsageLine(usageLine({ uncachedInputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 }, { scope: "fork-baseline" }), mathos, undefined).totalCostMicros).toBe(0);
  });

  it("prices separate reasoning consistently in configured-rate snapshots and observed usage", () => {
    fc.assert(fc.property(counts, fc.integer({ min: 1, max: 100_000 }), (tokens, reasoningOutputTokens) => {
      const rate = { model: "glm-5.3", inputPerMillion: 100, cachedInputPerMillion: 10, outputPerMillion: 200 };
      const line = usageLine(tokens, { reasoningOutputTokens });
      const observed = attributeCodexProviderUsageLine(line, { ...mathos, rates: [rate] }, undefined);
      const snapshot = { model: line.model, rate, tokens: {
        inputTokens: line.inputTokens, cachedInputTokens: line.cachedInputTokens,
        outputTokens: line.outputTokens, reasoningOutputTokens,
      } };
      const expected = tokens.uncachedInputTokens * 100 + tokens.cachedInputTokens * 10 + (tokens.outputTokens + reasoningOutputTokens) * 200;
      expect(observed.totalCostMicros).toBe(expected);
      expect(buildThreadPricingSnapshotEstimate(snapshot).totalCostMicros).toBe(expected);
      expect(buildThreadPricingSnapshotEstimate({ pricingSource: "provider", groups: [snapshot] }).totalCostMicros).toBe(expected);
    }));
  });

  it("charges a separate reasoning token at the configured output rate and rejects invalid counts", () => {
    const snapshot = { rate: { inputPerMillion: 100, outputPerMillion: 200 }, tokens: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 1 } };
    expect(buildThreadPricingSnapshotEstimate(snapshot).totalCostMicros).toBe(200);
    fc.assert(fc.property(fc.constantFrom(-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1), (reasoningOutputTokens) => {
      expect(buildThreadPricingSnapshotEstimate({ ...snapshot, tokens: { ...snapshot.tokens, reasoningOutputTokens } }).totalCostMicros).toBeUndefined();
    }));
  });

  it("keeps historical gaps in the actual provider's bucket while retaining the reference source", () => {
    fc.assert(fc.property(counts, fc.constantFrom(...source.models), (tokens, model) => {
      const line = usageLine(tokens, {
        model: `@mathos/${model.id}`, cumulativeUncachedInputTokens: tokens.uncachedInputTokens * 2,
        cumulativeCachedInputTokens: tokens.cachedInputTokens * 2, cumulativeOutputTokens: tokens.outputTokens * 2,
      });
      const observed = attributeCodexProviderUsageLine(line, mathos, undefined);
      const gaps = estimateHistoricalThreadUsageGapLines([observed]);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ provider: observed.provider, pricingCatalogId: "openrouter-assumed", totalCostMicros: observed.totalCostMicros });
    }));
  });

  it("attributes a one-token historical GLM gap to MathOS", () => {
    const observed = attributeCodexProviderUsageLine(usageLine({ uncachedInputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, {
      cumulativeUncachedInputTokens: 2, cumulativeCachedInputTokens: 0, cumulativeOutputTokens: 0,
    }), mathos, undefined);
    expect(estimateHistoricalThreadUsageGapLines([observed])[0]).toMatchObject({ provider: "mathos", pricingCatalogId: "openrouter-assumed" });
  });

  it("never substitutes reference rates for an explicit provider rate on a historical gap", () => {
    fc.assert(fc.property(counts, fc.boolean(), (tokens, complete) => {
      const observed = attributeCodexProviderUsageLine(usageLine(tokens, {
        cumulativeUncachedInputTokens: tokens.uncachedInputTokens * 2,
        cumulativeCachedInputTokens: tokens.cachedInputTokens * 2, cumulativeOutputTokens: tokens.outputTokens * 2,
      }), { ...mathos, rates: [{ model: "glm-5.3", inputPerMillion: 100, ...(complete ? { outputPerMillion: 200 } : {}) }] }, undefined);
      // The anchor records the decision, but not the rate values needed to
      // price unseen earlier requests. A different provider's price cannot fill it.
      expect(estimateHistoricalThreadUsageGapLines([observed])[0]).toMatchObject({ provider: "mathos", priceStatus: "unpriced", totalCostMicros: 0 });
    }));
  });

  it("keeps the known GLM reference rate and its source on the smallest priced usage", () => {
    expect(estimateTokenUsageCost({ model: "@mathos/glm-5.3", uncachedInputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }))
      .toMatchObject({ catalogId: "openrouter-assumed", inputUsdPerMillion: 0.084, totalCostMicros: 0 });
  });

  it("rounds fractional reference rates exactly at half-microdollar boundaries", () => {
    expect(estimateTokenUsageCost({ model: "mistralai/mistral-large-4-0", uncachedInputTokens: 45, cachedInputTokens: 0, outputTokens: 0 })?.totalCostMicros)
      .toBe(32);
    expect(estimateTokenUsageCost({ model: "deepseek/deepseek-v4.1-flash", uncachedInputTokens: 0, cachedInputTokens: 250_000, outputTokens: 0 })?.totalCostMicros)
      .toBe(254);
    const line = { model: "@mathos/mistral-large-4-0", uncachedInputTokens: 45, cachedInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0 } as ThreadUsageLineRecord;
    expect(attributeCodexProviderUsageLine(line, { id: "mathos", name: "MathOS", baseUrl: "https://os.openmathmodel.org/v1" }, undefined).totalCostMicros)
      .toBe(32);
  });

  it("matches the dated public API oracle for exact models, aliases and qualified provider IDs", () => {
    fc.assert(fc.property(fc.constantFrom(...source.models), counts, fc.boolean(), (model, tokens, qualified) => {
      const id = qualified ? `@mathos/${model.id.split("/")[1]!.toUpperCase()}` : model.id;
      const price = model.pricing;
      const expected = oracleMicros(tokens.uncachedInputTokens, price.prompt)
        + oracleMicros(tokens.cachedInputTokens, price.input_cache_read ?? price.prompt)
        + oracleMicros(tokens.outputTokens, price.completion);
      expect(estimateTokenUsageCost({ model: id, ...tokens, inputTokenScope: "aggregate" }))
        .toMatchObject({ catalogId: "openrouter-assumed", catalogVersion: "2026-11-15", totalCostMicros: expected });
    }));
  });

  it("does not infer a price for a different revision, fine-tune or free tier", () => {
    fc.assert(fc.property(fc.constantFrom(...source.models), fc.constantFrom(":free", "-abliterated", "-unknown"), (model, suffix) => {
      expect(estimateTokenUsageCost({ model: `${model.id}${suffix}`, uncachedInputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }))
        .toBeUndefined();
    }));
  });

  it("uses direct provider rates before reference rates, and declared local cost before either", () => {
    fc.assert(fc.property(counts, fc.integer({ min: 1, max: 100 }), (tokens, directRate) => {
      const line = {
        ...tokens, model: "@mathos/glm-5.3", backend: "codex", provider: "openai", reasoningOutputTokens: 0,
        inputTokens: tokens.uncachedInputTokens + tokens.cachedInputTokens,
        priceStatus: "unpriced", totalCostMicros: 0,
      } as ThreadUsageLineRecord;
      const provider = { id: "mathos", name: "MathOS", baseUrl: "https://os.openmathmodel.org/v1" };
      const direct = { model: "glm-5.3", inputPerMillion: directRate, cachedInputPerMillion: directRate, outputPerMillion: directRate };
      const expected = (line.inputTokens + line.outputTokens) * directRate;
      expect(attributeCodexProviderUsageLine(line, { ...provider, rates: [direct] }, undefined))
        .toMatchObject({ pricingCatalogId: "codex-model-provider", totalCostMicros: expected });
      expect(attributeCodexProviderUsageLine(line, { ...provider, rates: [direct], local: true }, undefined).totalCostMicros).toBe(0);
      expect(attributeCodexProviderUsageLine(line, provider, undefined))
        .toMatchObject({ priceStatus: "priced", pricingCatalogId: "openrouter-assumed" });
    }));
  });

  it("keeps historical group provenance and lets only the owner's direct rates override it", () => {
    fc.assert(fc.property(counts, fc.integer({ min: 1, max: 100 }), (tokens, directRate) => {
      const snapshot = { pricingSource: "provider" as const, groups: [{ model: "@mathos/glm-5.3", tokens: {
        inputTokens: tokens.uncachedInputTokens + tokens.cachedInputTokens,
        cachedInputTokens: tokens.cachedInputTokens, outputTokens: tokens.outputTokens,
      } }] };
      expect(buildThreadPricingSnapshotEstimate(snapshot).assumedPricing).toBe("2026-11-15");
      const provider = { id: "mathos", name: "MathOS", baseUrl: "https://os.openmathmodel.org/v1", rates: [
        { model: "glm-5.3", inputPerMillion: directRate, outputPerMillion: directRate },
      ] };
      const estimate = buildThreadPricingSnapshotEstimate(withCodexProviderSnapshotRates(snapshot, [provider]));
      expect(estimate.assumedPricing).toBeUndefined();
      expect(estimate.totalCostMicros).toBe((tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.outputTokens) * directRate);
      expect(buildThreadPricingSnapshotEstimate(withCodexProviderSnapshotRates(snapshot, [{ ...provider, local: true }])).totalCostMicros).toBe(0);
    }));
  });
});
