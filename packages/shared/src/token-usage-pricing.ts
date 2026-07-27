export type TokenUsagePricingServiceTier = "standard" | "priority";

export type TokenUsagePricingProvider = "openai" | "xai";

export type TokenUsagePriceStatus = "priced" | "unpriced";

export type TokenUsagePriceUnavailableReason =
  | "missing-model"
  | "missing-rate"
  | "unsupported-service-tier"
  | "insufficient-token-breakdown";

export type ThreadUsageTokenBreakdown = {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  uncachedInputTokens?: number;
};

export type ThreadUsageSettingsSnapshot = {
  backend: string;
  fastMode?: boolean;
  model?: string;
  observedAt?: number;
  reasoningEffort?: string;
  serviceTier?: string;
  settingsSource?: "event" | "turn-context" | "observed-settings" | "thread-overlay" | "monitor" | "unknown";
  settingsConfidence?: "exact" | "observed" | "fallback" | "unknown";
};

export type ThreadUsageLineScope =
  | "turn"
  | "latest-request"
  | "total"
  | "monitor"
  | "backfill"
  // Context a thread inherited at a fork point. Its cost was already billed on
  // the parent thread, so a fork-baseline line carries the inherited token
  // counts but zero cost — it is shown as a "Fork point" card, never re-charged.
  | "fork-baseline";

export type ThreadUsageLineStatus = "pending" | "finalized" | "superseded";

export type ThreadUsageLineRecord = {
  backend: string;
  cachedInputCostMicros: number;
  cachedInputTokens: number;
  completedAt?: number;
  createdAt: number;
  currency: string;
  cumulativeCachedInputTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeReasoningOutputTokens?: number;
  cumulativeTotalCostMicros?: number;
  cumulativeTotalTokens?: number;
  cumulativeUncachedInputTokens?: number;
  fastMode?: boolean;
  inputTokens: number;
  model?: string;
  // Observed context-replay tallies for a live turn: one replay per model
  // request within the turn (each carries a fresh `last` breakdown from the
  // protocol). A replay is "hot" when its input was predominantly cache-served,
  // else "cold" (cache miss). These are observation-derived — populated only for
  // turns whose token-usage stream was watched live — and are distinct from the
  // cumulative* fields. Absent means "not observed", never "zero".
  observedColdReplayCount?: number;
  observedColdReplayUncachedTokens?: number;
  observedHotReplayCachedTokens?: number;
  observedHotReplayCount?: number;
  outputCostMicros: number;
  outputTokens: number;
  parentThreadId?: string;
  priceStatus: TokenUsagePriceStatus;
  priceUnavailableReason?: TokenUsagePriceUnavailableReason;
  provider: string;
  pricingCatalogId?: string;
  pricingCatalogVersion?: string;
  pricingRateId?: string;
  reasoningEffort?: string;
  reasoningOutputTokens: number;
  scope: ThreadUsageLineScope;
  serviceTier?: string;
  settingsConfidence?: ThreadUsageSettingsSnapshot["settingsConfidence"];
  settingsSource?: ThreadUsageSettingsSnapshot["settingsSource"];
  source: "live" | "hydration" | "backfill" | "monitor";
  sourceItemId?: string;
  startedAt?: number;
  status: ThreadUsageLineStatus;
  threadId: string;
  totalCostMicros: number;
  totalTokens: number;
  turnId?: string;
  // Whether this row's token totals are a real measurement of THIS turn.
  // Set by the live builder: `true` when usage was attributed to the turn (a
  // per-turn delta or a per-request "last" snapshot), `false` when the builder
  // had to fall back to a whole-thread/undecomposed total and the row is really
  // a summary. `undefined` = not computed (hydration/backfill rows, or rows
  // persisted before this field existed). The renderer treats `false` as a
  // historical summary instead of guessing from raw token counts.
  turnUsageAttributed?: boolean;
  uncachedInputCostMicros: number;
  uncachedInputTokens: number;
  usageLineId: string;
  usageTurnId?: string;
};

export type ThreadPricingSummary = {
  backend: string;
  cachedInputTokens: number;
  currency: string;
  inputTokens: number;
  outputTokens: number;
  pricedUsageLineCount: number;
  provider: string;
  reasoningOutputTokens: number;
  threadId: string;
  totalCostMicros: number;
  totalTokens: number;
  uncachedInputTokens: number;
  unpricedUsageLineCount: number;
  updatedAt: number;
  usageLineCount: number;
};

export type TokenUsagePricingCatalogRate = {
  cachedInputMicrosPerMillion: number;
  cachedInputUsdPerMillion: number;
  catalogId: string;
  catalogVersion: string;
  currency: "USD";
  displayModel: string;
  displayName: string;
  displayTier: string;
  effectiveFrom: number;
  effectiveTo?: number;
  inputMicrosPerMillion: number;
  inputUsdPerMillion: number;
  model: string;
  outputMicrosPerMillion: number;
  outputUsdPerMillion: number;
  provider: TokenUsagePricingProvider;
  rateId: string;
  serviceTier: TokenUsagePricingServiceTier;
};

export type TokenUsageCostEstimate = {
  cachedInputCostMicros: number;
  cachedInputUsd: number;
  cachedInputUsdPerMillion: number;
  catalogId: string;
  catalogVersion: string;
  currency: "USD";
  displayName: string;
  effectiveFrom: number;
  effectiveTo?: number;
  inputUsdPerMillion: number;
  model: string;
  outputTokensIncludeReasoning: boolean;
  outputCostMicros: number;
  outputUsd: number;
  outputUsdPerMillion: number;
  provider: TokenUsagePricingProvider;
  rateId: string;
  serviceTier: TokenUsagePricingServiceTier;
  standardCachedInputRateMultiplier?: number;
  standardInputRateMultiplier?: number;
  standardOutputRateMultiplier?: number;
  totalCostMicros: number;
  totalUsd: number;
  uncachedInputCostMicros: number;
  uncachedInputUsd: number;
};

export type TokenUsageCreditEstimate = {
  cachedInputCreditMicros: number;
  cachedInputCredits: number;
  cachedInputCreditsPerMillion: number;
  catalogId: string;
  catalogVersion: string;
  displayName: string;
  effectiveFrom: number;
  effectiveTo?: number;
  inputCreditsPerMillion: number;
  model: string;
  outputCreditMicros: number;
  outputCredits: number;
  outputCreditsPerMillion: number;
  provider: "openai";
  rateId: string;
  serviceTier: TokenUsagePricingServiceTier;
  totalCreditMicros: number;
  totalCredits: number;
  uncachedInputCreditMicros: number;
  uncachedInputCredits: number;
  unit: "codex_credits";
};

type PricingCatalogEntry = {
  aliases?: readonly string[];
  cachedInputUsdPerMillion: number;
  catalogId: string;
  catalogVersion: string;
  displayModel: string;
  displayTier: string;
  effectiveFrom: number;
  effectiveTo?: number;
  inputUsdPerMillion: number;
  model: string;
  outputUsdPerMillion: number;
  outputTokensIncludeReasoning?: boolean;
  provider: TokenUsagePricingProvider;
  serviceTier: TokenUsagePricingServiceTier;
};

type CodexCreditsCatalogEntry = {
  cachedInputCreditsPerMillion: number;
  catalogId: string;
  catalogVersion: string;
  displayModel: string;
  displayTier: string;
  effectiveFrom: number;
  effectiveTo?: number;
  fastRateMultiplier?: number;
  inputCreditsPerMillion: number;
  model: string;
  outputCreditsPerMillion: number;
  provider: "openai";
  serviceTier: TokenUsagePricingServiceTier;
};

const OPENAI_PRICING_CATALOG_ID = "openai-api";
const OPENAI_PRICING_CATALOG_VERSION = "2026-06-16";
const OPENAI_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 3, 23);
const OPENAI_GPT56_PRICING_CATALOG_VERSION = "2026-07-09";
const OPENAI_GPT56_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 6, 9);
const OPENAI_CODEX_CREDITS_CATALOG_ID = "openai-codex-credits";
const OPENAI_CODEX_CREDITS_CATALOG_VERSION = "2026-06-16";
const OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION = "2026-07-09";
const XAI_PRICING_CATALOG_ID = "xai-api";
const XAI_PRICING_CATALOG_VERSION = "2026-07-17";
const XAI_GROK45_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 6, 8);

const OPENAI_PRICING_CATALOG: readonly PricingCatalogEntry[] = [
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Fast (Priority)",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 60,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    displayTier: "Fast (Priority)",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 6,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    displayTier: "Fast (Priority)",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_PRICING_CATALOG_VERSION,
    model: "gpt-5.5",
    displayModel: "GPT-5.5",
    displayTier: "Standard",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_PRICING_CATALOG_VERSION,
    model: "gpt-5.5",
    displayModel: "GPT-5.5",
    displayTier: "Fast (Priority)",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 12.5,
    cachedInputUsdPerMillion: 1.25,
    outputUsdPerMillion: 75,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_PRICING_CATALOG_VERSION,
    model: "gpt-5.4",
    displayModel: "GPT-5.4",
    displayTier: "Standard",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    outputUsdPerMillion: 15,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_PRICING_CATALOG_VERSION,
    model: "gpt-5.4",
    displayModel: "GPT-5.4",
    displayTier: "Fast (Priority)",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_PRICING_CATALOG_VERSION,
    model: "gpt-5.4-mini",
    displayModel: "GPT-5.4 mini",
    displayTier: "Standard",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_PRICING_CATALOG_VERSION,
    model: "gpt-5.4-mini",
    displayModel: "GPT-5.4 mini",
    displayTier: "Fast (Priority)",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.15,
    outputUsdPerMillion: 9,
  },
];

const XAI_PRICING_CATALOG: readonly PricingCatalogEntry[] = [
  {
    aliases: [
      "grok-4.5-build",
      "grok-4.5-latest",
      "grok-build-latest",
    ],
    catalogId: XAI_PRICING_CATALOG_ID,
    catalogVersion: XAI_PRICING_CATALOG_VERSION,
    model: "grok-4.5",
    displayModel: "Grok 4.5",
    displayTier: "Standard",
    effectiveFrom: XAI_GROK45_PRICING_EFFECTIVE_FROM,
    outputTokensIncludeReasoning: true,
    provider: "xai",
    serviceTier: "standard",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 6,
  },
];

const TOKEN_USAGE_PRICING_CATALOG: readonly PricingCatalogEntry[] = [
  ...OPENAI_PRICING_CATALOG,
  ...XAI_PRICING_CATALOG,
];

const OPENAI_CODEX_CREDITS_CATALOG: readonly CodexCreditsCatalogEntry[] = [
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputCreditsPerMillion: 125,
    cachedInputCreditsPerMillion: 12.5,
    outputCreditsPerMillion: 750,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Fast",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: 2,
    provider: "openai",
    serviceTier: "priority",
    inputCreditsPerMillion: 250,
    cachedInputCreditsPerMillion: 25,
    outputCreditsPerMillion: 1500,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputCreditsPerMillion: 62.5,
    cachedInputCreditsPerMillion: 6.25,
    outputCreditsPerMillion: 375,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    displayTier: "Fast",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: 2,
    provider: "openai",
    serviceTier: "priority",
    inputCreditsPerMillion: 125,
    cachedInputCreditsPerMillion: 12.5,
    outputCreditsPerMillion: 750,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputCreditsPerMillion: 25,
    cachedInputCreditsPerMillion: 2.5,
    outputCreditsPerMillion: 150,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    displayTier: "Fast",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: 2,
    provider: "openai",
    serviceTier: "priority",
    inputCreditsPerMillion: 50,
    cachedInputCreditsPerMillion: 5,
    outputCreditsPerMillion: 300,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.5",
    displayModel: "GPT-5.5",
    displayTier: "Standard",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputCreditsPerMillion: 125,
    cachedInputCreditsPerMillion: 12.5,
    outputCreditsPerMillion: 750,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.5",
    displayModel: "GPT-5.5",
    displayTier: "Fast",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: 2.5,
    provider: "openai",
    serviceTier: "priority",
    inputCreditsPerMillion: 312.5,
    cachedInputCreditsPerMillion: 31.25,
    outputCreditsPerMillion: 1875,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.4",
    displayModel: "GPT-5.4",
    displayTier: "Standard",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputCreditsPerMillion: 62.5,
    cachedInputCreditsPerMillion: 6.25,
    outputCreditsPerMillion: 375,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.4",
    displayModel: "GPT-5.4",
    displayTier: "Fast",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: 2,
    provider: "openai",
    serviceTier: "priority",
    inputCreditsPerMillion: 125,
    cachedInputCreditsPerMillion: 12.5,
    outputCreditsPerMillion: 750,
  },
  {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.4-mini",
    displayModel: "GPT-5.4 mini",
    displayTier: "Standard",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputCreditsPerMillion: 18.75,
    cachedInputCreditsPerMillion: 1.875,
    outputCreditsPerMillion: 113,
  },
];

export function listOpenAiTokenUsagePricingRates(): TokenUsagePricingCatalogRate[] {
  return OPENAI_PRICING_CATALOG.map(toPublicRate);
}

export function listTokenUsagePricingRates(): TokenUsagePricingCatalogRate[] {
  return TOKEN_USAGE_PRICING_CATALOG.map(toPublicRate);
}

export function estimateOpenAiTokenUsageCost(params: {
  cachedInputTokens: number;
  at?: number;
  fastMode?: boolean;
  outputTokensIncludeReasoning?: boolean;
  model?: string;
  outputTokens: number;
  reasoningOutputTokens?: number;
  serviceTier?: string;
  uncachedInputTokens: number;
}): TokenUsageCostEstimate | undefined {
  return estimateTokenUsageCostFromCatalog(params, OPENAI_PRICING_CATALOG);
}

export function estimateTokenUsageCost(params: {
  cachedInputTokens: number;
  at?: number;
  fastMode?: boolean;
  outputTokensIncludeReasoning?: boolean;
  model?: string;
  outputTokens: number;
  reasoningOutputTokens?: number;
  serviceTier?: string;
  uncachedInputTokens: number;
}): TokenUsageCostEstimate | undefined {
  return estimateTokenUsageCostFromCatalog(params, TOKEN_USAGE_PRICING_CATALOG);
}

function estimateTokenUsageCostFromCatalog(
  params: {
    cachedInputTokens: number;
    at?: number;
    fastMode?: boolean;
    outputTokensIncludeReasoning?: boolean;
    model?: string;
    outputTokens: number;
    reasoningOutputTokens?: number;
    serviceTier?: string;
    uncachedInputTokens: number;
  },
  catalog: readonly PricingCatalogEntry[],
): TokenUsageCostEstimate | undefined {
  const model = params.model?.trim();
  if (!model) {
    return undefined;
  }

  const matchingEntries = catalog.filter(
    (candidate) =>
      pricingEntryMatchesModel(candidate, model)
      && pricingEntryAppliesAt(candidate, params.at),
  );
  const provider = matchingEntries[0]?.provider;
  const serviceTier =
    provider === "xai"
      ? resolveXaiPricingServiceTier(params.serviceTier)
      : resolveOpenAiPricingServiceTier({
          fastMode: params.fastMode,
          serviceTier: params.serviceTier,
        });
  const entry = matchingEntries.find(
    (candidate) =>
      candidate.serviceTier === serviceTier,
  );
  if (!entry) {
    return undefined;
  }

  const standardEntry = catalog.find(
    (candidate) =>
      candidate.model === entry.model
      && candidate.provider === entry.provider
      && candidate.serviceTier === "standard"
      && pricingEntryAppliesAt(candidate, params.at),
  );
  const uncachedInputCostMicros = calculateTokenCostMicros(
    params.uncachedInputTokens,
    entry.inputUsdPerMillion,
  );
  const cachedInputCostMicros = calculateTokenCostMicros(
    params.cachedInputTokens,
    entry.cachedInputUsdPerMillion,
  );
  const outputTokensIncludeReasoning =
    params.outputTokensIncludeReasoning
    ?? entry.outputTokensIncludeReasoning
    ?? false;
  const billedOutputTokens = outputTokensIncludeReasoning
    ? params.outputTokens
    : params.outputTokens + Math.max(0, params.reasoningOutputTokens ?? 0);
  const outputCostMicros = calculateTokenCostMicros(
    billedOutputTokens,
    entry.outputUsdPerMillion,
  );
  const totalCostMicros =
    uncachedInputCostMicros + cachedInputCostMicros + outputCostMicros;
  const uncachedInputUsd = microsToCurrencyUnits(uncachedInputCostMicros);
  const cachedInputUsd = microsToCurrencyUnits(cachedInputCostMicros);
  const outputUsd = microsToCurrencyUnits(outputCostMicros);

  return {
    cachedInputCostMicros,
    cachedInputUsd,
    cachedInputUsdPerMillion: entry.cachedInputUsdPerMillion,
    catalogId: entry.catalogId,
    catalogVersion: entry.catalogVersion,
    currency: "USD",
    displayName: `${entry.displayModel} ${entry.displayTier}`,
    effectiveFrom: entry.effectiveFrom,
    ...(entry.effectiveTo ? { effectiveTo: entry.effectiveTo } : {}),
    inputUsdPerMillion: entry.inputUsdPerMillion,
    model,
    outputTokensIncludeReasoning,
    outputCostMicros,
    outputUsd,
    outputUsdPerMillion: entry.outputUsdPerMillion,
    provider: entry.provider,
    rateId: buildPricingRateId(entry),
    serviceTier: entry.serviceTier,
    standardCachedInputRateMultiplier: tokenUsageRateMultiplier(
      entry.cachedInputUsdPerMillion,
      standardEntry?.cachedInputUsdPerMillion,
    ),
    standardInputRateMultiplier: tokenUsageRateMultiplier(
      entry.inputUsdPerMillion,
      standardEntry?.inputUsdPerMillion,
    ),
    standardOutputRateMultiplier: tokenUsageRateMultiplier(
      entry.outputUsdPerMillion,
      standardEntry?.outputUsdPerMillion,
    ),
    totalCostMicros,
    totalUsd: microsToCurrencyUnits(totalCostMicros),
    uncachedInputCostMicros,
    uncachedInputUsd,
  };
}

export function estimateOpenAiCodexCreditUsage(params: {
  cachedInputTokens: number;
  at?: number;
  fastMode?: boolean;
  outputTokensIncludeReasoning?: boolean;
  model?: string;
  outputTokens: number;
  reasoningOutputTokens?: number;
  serviceTier?: string;
  uncachedInputTokens: number;
}): TokenUsageCreditEstimate | undefined {
  const model = params.model?.trim();
  if (!model) {
    return undefined;
  }

  const serviceTier = resolveOpenAiPricingServiceTier({
    fastMode: params.fastMode,
    serviceTier: params.serviceTier,
  });
  const entry = OPENAI_CODEX_CREDITS_CATALOG.find(
    (candidate) =>
      candidate.model === model &&
      candidate.serviceTier === serviceTier &&
      pricingEntryAppliesAt(candidate, params.at),
  );
  if (!entry) {
    return undefined;
  }

  const uncachedInputCreditMicros = calculateTokenCreditMicros(
    params.uncachedInputTokens,
    entry.inputCreditsPerMillion,
  );
  const cachedInputCreditMicros = calculateTokenCreditMicros(
    params.cachedInputTokens,
    entry.cachedInputCreditsPerMillion,
  );
  const billedOutputTokens = params.outputTokensIncludeReasoning
    ? params.outputTokens
    : params.outputTokens + Math.max(0, params.reasoningOutputTokens ?? 0);
  const outputCreditMicros = calculateTokenCreditMicros(
    billedOutputTokens,
    entry.outputCreditsPerMillion,
  );
  const totalCreditMicros =
    uncachedInputCreditMicros + cachedInputCreditMicros + outputCreditMicros;

  return {
    cachedInputCreditMicros,
    cachedInputCredits: microsToCurrencyUnits(cachedInputCreditMicros),
    cachedInputCreditsPerMillion: entry.cachedInputCreditsPerMillion,
    catalogId: entry.catalogId,
    catalogVersion: entry.catalogVersion,
    displayName: `${entry.displayModel} ${entry.displayTier}`,
    effectiveFrom: entry.effectiveFrom,
    ...(entry.effectiveTo ? { effectiveTo: entry.effectiveTo } : {}),
    inputCreditsPerMillion: entry.inputCreditsPerMillion,
    model,
    outputCreditMicros,
    outputCredits: microsToCurrencyUnits(outputCreditMicros),
    outputCreditsPerMillion: entry.outputCreditsPerMillion,
    provider: entry.provider,
    rateId: buildCodexCreditRateId(entry),
    serviceTier: entry.serviceTier,
    totalCreditMicros,
    totalCredits: microsToCurrencyUnits(totalCreditMicros),
    uncachedInputCreditMicros,
    uncachedInputCredits: microsToCurrencyUnits(uncachedInputCreditMicros),
    unit: "codex_credits",
  };
}

export function resolveOpenAiPricingServiceTier(params: {
  fastMode?: boolean;
  serviceTier?: string;
}): "standard" | "priority" | undefined {
  if (params.fastMode === true) {
    return "priority";
  }

  const serviceTier = params.serviceTier?.trim().toLowerCase();
  if (!serviceTier || serviceTier === "default" || serviceTier === "standard") {
    return "standard";
  }
  if (serviceTier === "fast" || serviceTier === "priority") {
    return "priority";
  }
  return undefined;
}

function resolveXaiPricingServiceTier(
  serviceTier: string | undefined,
): TokenUsagePricingServiceTier | undefined {
  const normalized = serviceTier?.trim().toLowerCase();
  return !normalized || normalized === "default" || normalized === "standard"
    ? "standard"
    : undefined;
}

export function formatTokenUsageUsd(value: number): string {
  if (value > 0 && value < 0.001) {
    return "<$0.001";
  }
  if (value < 0.1) {
    return new Intl.NumberFormat(undefined, {
      currency: "USD",
      maximumFractionDigits: 3,
      minimumFractionDigits: 3,
      style: "currency",
    }).format(roundUpCurrency(value, 3));
  }

  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(roundUpCurrency(value, 2));
}

export function formatTokenUsageMicrosAsUsd(value: number): string {
  return formatTokenUsageUsd(microsToCurrencyUnits(value));
}

export function formatTokenUsageUsdPerMillion(value: number): string {
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: 3,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

export function formatTokenUsagePriceFactor(
  discountedRate: number,
  standardRate: number,
): string {
  if (standardRate <= 0) {
    return "unknown factor";
  }
  const factor = discountedRate / standardRate;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 3,
    minimumFractionDigits: 1,
  }).format(factor)}x`;
}

export function formatTokenUsageStandardRateSuffix(
  multiplier: number | undefined,
  prefix = " ",
): string {
  return multiplier === undefined
    ? ""
    : `${prefix}${formatTokenUsageMultiplier(multiplier)} Standard`;
}

function tokenUsageRateMultiplier(
  rate: number,
  standardRate: number | undefined,
): number | undefined {
  if (!standardRate || standardRate <= 0) {
    return undefined;
  }
  const multiplier = rate / standardRate;
  return Math.abs(multiplier - 1) < 0.001 ? undefined : multiplier;
}

function toPublicRate(entry: PricingCatalogEntry): TokenUsagePricingCatalogRate {
  return {
    cachedInputMicrosPerMillion: dollarsToMicros(entry.cachedInputUsdPerMillion),
    cachedInputUsdPerMillion: entry.cachedInputUsdPerMillion,
    catalogId: entry.catalogId,
    catalogVersion: entry.catalogVersion,
    currency: "USD",
    displayModel: entry.displayModel,
    displayName: `${entry.displayModel} ${entry.displayTier}`,
    displayTier: entry.displayTier,
    effectiveFrom: entry.effectiveFrom,
    ...(entry.effectiveTo ? { effectiveTo: entry.effectiveTo } : {}),
    inputMicrosPerMillion: dollarsToMicros(entry.inputUsdPerMillion),
    inputUsdPerMillion: entry.inputUsdPerMillion,
    model: entry.model,
    outputMicrosPerMillion: dollarsToMicros(entry.outputUsdPerMillion),
    outputUsdPerMillion: entry.outputUsdPerMillion,
    provider: entry.provider,
    rateId: buildPricingRateId(entry),
    serviceTier: entry.serviceTier,
  };
}

function pricingEntryAppliesAt(
  entry: Pick<PricingCatalogEntry, "effectiveFrom" | "effectiveTo">,
  at: number | undefined,
): boolean {
  if (at === undefined) {
    return entry.effectiveTo === undefined;
  }
  return entry.effectiveFrom <= at && (entry.effectiveTo === undefined || entry.effectiveTo > at);
}

function pricingEntryMatchesModel(
  entry: PricingCatalogEntry,
  model: string,
): boolean {
  return entry.model === model || entry.aliases?.includes(model) === true;
}

function buildPricingRateId(entry: PricingCatalogEntry): string {
  return [
    entry.provider,
    entry.catalogVersion,
    entry.model,
    entry.serviceTier,
  ].join(":");
}

function buildCodexCreditRateId(entry: CodexCreditsCatalogEntry): string {
  return [
    entry.provider,
    entry.catalogVersion,
    "codex-credits",
    entry.model,
    entry.serviceTier,
  ].join(":");
}

function calculateTokenCostMicros(tokens: number, usdPerMillion: number): number {
  if (tokens <= 0 || usdPerMillion <= 0) {
    return 0;
  }
  return Math.round((tokens * dollarsToMicros(usdPerMillion)) / 1_000_000);
}

function calculateTokenCreditMicros(tokens: number, creditsPerMillion: number): number {
  if (tokens <= 0 || creditsPerMillion <= 0) {
    return 0;
  }
  return Math.round((tokens * creditsPerMillion * 1_000_000) / 1_000_000);
}

function dollarsToMicros(value: number): number {
  return Math.round(value * 1_000_000);
}

function microsToCurrencyUnits(value: number): number {
  return value / 1_000_000;
}

function formatTokenUsageMultiplier(multiplier: number): string {
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 3,
    minimumFractionDigits: 1,
  }).format(multiplier)}x`;
}

function roundUpCurrency(value: number, fractionDigits: number): number {
  if (value <= 0) {
    return 0;
  }
  const scale = 10 ** fractionDigits;
  return Math.ceil(value * scale - Number.EPSILON * scale) / scale;
}
