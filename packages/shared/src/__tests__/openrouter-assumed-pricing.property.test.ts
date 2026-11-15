import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { estimateTokenUsageCost } from "../token-usage-pricing";
import { attributeCodexProviderUsageLine, withCodexProviderSnapshotRates } from "../codex-model-providers";
import { buildThreadPricingSnapshotEstimate } from "../thread-pricing-display";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";
import source from "./fixtures/openrouter-assumed-pricing-2026-11-15.json";

const counts = fc.record({
  uncachedInputTokens: fc.integer({ min: 1, max: 1_000_000 }),
  cachedInputTokens: fc.integer({ min: 0, max: 1_000_000 }),
  outputTokens: fc.integer({ min: 0, max: 1_000_000 }),
});

function oracleMicros(tokens: number, usdPerToken: string): number {
  const decimals = usdPerToken.split(".")[1]?.length ?? 0;
  const denominator = 10n ** BigInt(decimals);
  const numerator = BigInt(usdPerToken.replace(".", "")) * BigInt(tokens) * 1_000_000n;
  return Number((numerator + denominator / 2n) / denominator);
}

describe("assumed OpenRouter prices", () => {
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
