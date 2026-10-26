import { describe, expect, it } from "vitest";
import {
  attributeCodexProviderUsageLine,
  buildCodexModelProviderConfigOverrides,
  buildCodexModelProviderShellEnvOverrides,
  codexModelProviderApiKeyEnv,
  codexProviderIdOfModel,
  formatCodexProviderModelId,
  formatModelOptionLabel,
  isValidCodexModelProviderId,
  modelOptionsForThreadProvider,
  parseCodexProviderModelId,
  resolveModelOptionReference,
  validateCodexBaseUrl,
  validateCodexModelProviders,
  type CodexModelProviderSettings,
} from "../codex-model-providers";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";

const refuseless: CodexModelProviderSettings = {
  id: "refuseless",
  name: "Refuseless",
  baseUrl: "https://api.refuseless.example/v1",
  models: ["glm-5.3-abliterated", "deepseek-v4.1-flash"],
  rates: [
    { model: "glm-5.3-abliterated", inputPerMillion: 2, outputPerMillion: 3, cachedInputPerMillion: 0.35 },
    { model: "deepseek-v4.1-flash", inputPerMillion: 0.22, outputPerMillion: 0.75 },
  ],
};

function usageLine(overrides: Partial<ThreadUsageLineRecord> = {}): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 1,
    cachedInputTokens: 200_000,
    createdAt: 1,
    currency: "USD",
    inputTokens: 1_200_000,
    model: "glm-5.3-abliterated",
    outputCostMicros: 1,
    outputTokens: 100_000,
    priceStatus: "priced",
    pricingCatalogId: "openai",
    pricingCatalogVersion: "9",
    provider: "openai",
    reasoningOutputTokens: 50_000,
    scope: "turn",
    source: "live",
    status: "completed",
    threadId: "thread-1",
    totalCostMicros: 3,
    totalTokens: 1_350_000,
    uncachedInputCostMicros: 1,
    uncachedInputTokens: 1_000_000,
    usageLineId: "line-1",
    ...overrides,
  } as ThreadUsageLineRecord;
}

describe("qualified model ids", () => {
  it("round trips a provider model and leaves Codex's own ids alone", () => {
    const id = formatCodexProviderModelId("refuseless", "glm-5.3-abliterated");
    expect(id).toBe("@refuseless/glm-5.3-abliterated");
    expect(parseCodexProviderModelId(id)).toEqual({ providerId: "refuseless", model: "glm-5.3-abliterated" });
    expect(parseCodexProviderModelId("gpt-5.5")).toEqual({ model: "gpt-5.5" });
    // A model id may itself contain a slash.
    expect(parseCodexProviderModelId("@local/qwen/qwen3-coder")).toEqual({ providerId: "local", model: "qwen/qwen3-coder" });
    expect(codexProviderIdOfModel(undefined)).toBeUndefined();
    expect(codexProviderIdOfModel("@bonsai/bonsai-2")).toBe("bonsai");
  });

  it("rejects reserved and malformed provider ids", () => {
    expect(isValidCodexModelProviderId("refuseless")).toBe(true);
    expect(isValidCodexModelProviderId("openai")).toBe(false);
    expect(isValidCodexModelProviderId("Refuseless")).toBe(false);
    expect(isValidCodexModelProviderId("1abc")).toBe(false);
    expect(isValidCodexModelProviderId("a".repeat(33))).toBe(false);
  });

  it("names each provider's key variable", () => {
    expect(codexModelProviderApiKeyEnv("my-glm")).toBe("PWRAGENT_CODEX_PROVIDER_MY_GLM_API_KEY");
  });
});

describe("validateCodexModelProviders", () => {
  it("normalizes a provider and its rates", () => {
    expect(validateCodexModelProviders([{
      id: " refuseless ",
      name: "",
      baseUrl: "https://api.refuseless.example/v1/",
      models: ["glm-5.3-abliterated", "glm-5.3-abliterated"],
      discoverModels: false,
      rates: [{ model: "glm-5.3-abliterated", inputPerMillion: 2 }],
    }])).toEqual([{
      id: "refuseless",
      name: "refuseless",
      baseUrl: "https://api.refuseless.example/v1",
      models: ["glm-5.3-abliterated"],
      discoverModels: false,
      rates: [{ model: "glm-5.3-abliterated", inputPerMillion: 2 }],
    }]);
  });

  it("refuses duplicate ids, reserved ids and unsafe URLs", () => {
    expect(() => validateCodexModelProviders([refuseless, refuseless])).toThrow(/used twice/);
    expect(() => validateCodexModelProviders([{ ...refuseless, id: "openai" }])).toThrow(/reserved/);
    expect(() => validateCodexBaseUrl("ftp://example.com")).toThrow();
    expect(() => validateCodexBaseUrl("https://user:secret@example.com/v1")).toThrow();
    expect(() => validateCodexBaseUrl("https://example.com/v1?key=1")).toThrow();
    expect(validateCodexBaseUrl("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
  });
});

describe("buildCodexModelProviderConfigOverrides", () => {
  it("defines a Responses provider and names a key only when one is stored", () => {
    expect(buildCodexModelProviderConfigOverrides([refuseless], new Set(["refuseless"]))).toEqual([
      "model_providers.refuseless.name=\"Refuseless\"",
      "model_providers.refuseless.base_url=\"https://api.refuseless.example/v1\"",
      "model_providers.refuseless.wire_api=\"responses\"",
      "model_providers.refuseless.requires_openai_auth=false",
      "model_providers.refuseless.env_key=\"PWRAGENT_CODEX_PROVIDER_REFUSELESS_API_KEY\"",
    ]);
    expect(buildCodexModelProviderShellEnvOverrides(["refuseless"])).toEqual([
      "shell_environment_policy.set.PWRAGENT_CODEX_PROVIDER_REFUSELESS_API_KEY=\"\"",
    ]);
    expect(buildCodexModelProviderConfigOverrides([refuseless], new Set()).some((entry) => entry.includes("env_key")))
      .toBe(false);
  });
});

describe("attributeCodexProviderUsageLine", () => {
  it("moves usage off OpenAI and prices it at the provider's rates", () => {
    const line = attributeCodexProviderUsageLine(usageLine(), refuseless, "acct-1");
    expect(line).toMatchObject({
      provider: "refuseless",
      accountKey: "acct-1",
      model: "@refuseless/glm-5.3-abliterated",
      priceStatus: "priced",
      pricingCatalogId: "codex-model-provider",
      pricingRateId: "refuseless:glm-5.3-abliterated",
      // 1,000,000 × $2/M, 200,000 × $0.35/M, (100,000 + 50,000) × $3/M.
      uncachedInputCostMicros: 2_000_000,
      cachedInputCostMicros: 70_000,
      outputCostMicros: 450_000,
      totalCostMicros: 2_520_000,
    });
  });

  it("falls back to the input rate for cached input", () => {
    const line = attributeCodexProviderUsageLine(
      usageLine({ model: "@refuseless/deepseek-v4.1-flash" }),
      refuseless,
      undefined,
    );
    expect(line.cachedInputCostMicros).toBe(44_000);
    expect(line.accountKey).toBeUndefined();
  });

  it("records a model without a rate as unpriced, never at an OpenAI price", () => {
    const line = attributeCodexProviderUsageLine(usageLine({ model: "unknown-model" }), refuseless, "acct-1");
    expect(line).toMatchObject({
      provider: "refuseless",
      priceStatus: "unpriced",
      priceUnavailableReason: "missing-rate",
      totalCostMicros: 0,
    });
  });

  it("prices a local provider at zero", () => {
    const line = attributeCodexProviderUsageLine(
      usageLine({ model: "bonsai-2" }),
      { id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:8080/v1", local: true },
      undefined,
    );
    expect(line).toMatchObject({ priceStatus: "priced", totalCostMicros: 0, pricingRateId: "bonsai:local" });
  });

  it("keeps the catalog price for a second OpenAI API account with no rates", () => {
    const line = attributeCodexProviderUsageLine(
      usageLine({ model: "gpt-5.5", totalCostMicros: 99 }),
      { id: "work-openai", name: "Work OpenAI", baseUrl: "https://api.openai.com/v1" },
      "acct-2",
    );
    expect(line).toMatchObject({
      provider: "work-openai",
      accountKey: "acct-2",
      model: "@work-openai/gpt-5.5",
      pricingCatalogId: "openai",
      totalCostMicros: 99,
    });
  });
});

describe("model option references", () => {
  const options = [
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "@refuseless/glm-5.3-abliterated", label: "glm-5.3-abliterated", providerId: "refuseless", providerLabel: "Refuseless" },
    { id: "@refuseless/glm-5.3-flash", label: "glm-5.3-flash", providerId: "refuseless", providerLabel: "Refuseless" },
    { id: "@other/glm-5.3-flash", label: "glm-5.3-flash", providerId: "other", providerLabel: "Other" },
  ];

  it("resolves an exact id, a provider and model name, or a unique model name", () => {
    expect(resolveModelOptionReference(options, "gpt-5.5").id).toBe("gpt-5.5");
    expect(resolveModelOptionReference(options, "Refuseless / GLM-5.3 abliterated").id)
      .toBe("@refuseless/glm-5.3-abliterated");
    expect(resolveModelOptionReference(options, "glm 5.3 abliterated").id)
      .toBe("@refuseless/glm-5.3-abliterated");
  });

  it("refuses a name two providers serve and reports both", () => {
    const result = resolveModelOptionReference(options, "glm-5.3-flash");
    expect(result.id).toBeUndefined();
    expect(result.candidates.map((option) => option.id)).toEqual(["@refuseless/glm-5.3-flash", "@other/glm-5.3-flash"]);
    expect(resolveModelOptionReference(options, "Other glm-5.3-flash").id).toBe("@other/glm-5.3-flash");
  });

  it("labels provider models with their provider", () => {
    expect(formatModelOptionLabel(options[1])).toBe("Refuseless · glm-5.3-abliterated");
    expect(formatModelOptionLabel(options[0])).toBe("GPT-5.5");
  });

  it("offers an existing thread only its own provider's models", () => {
    expect(modelOptionsForThreadProvider(options, "gpt-5.5").map((option) => option.id)).toEqual(["gpt-5.5"]);
    expect(modelOptionsForThreadProvider(options, "@refuseless/glm-5.3-flash").map((option) => option.id))
      .toEqual(["@refuseless/glm-5.3-abliterated", "@refuseless/glm-5.3-flash"]);
  });
});
