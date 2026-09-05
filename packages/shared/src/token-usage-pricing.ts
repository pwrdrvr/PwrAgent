export type TokenUsagePricingServiceTier = "standard" | "priority";

export type TokenUsagePricingProvider = "openai" | "qwen" | "xai";

export type TokenUsagePricingInputScope = "aggregate" | "request";

export type TokenUsagePriceStatus = "priced" | "unpriced";

export type TokenUsagePriceUnavailableReason =
  | "missing-model"
  | "missing-rate"
  | "unsupported-service-tier"
  | "insufficient-token-breakdown";

export type ThreadUsageTokenBreakdown = {
  // Provider-reported subset of uncached input that populated a prompt cache.
  cacheWriteInputTokens?: number;
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
  // Cache-write cost is separate from uncachedInputCostMicros; the tokens are
  // still a subset of uncachedInputTokens.
  cacheWriteInputCostMicros?: number;
  cacheWriteInputTokens?: number;
  cachedInputCostMicros: number;
  cachedInputTokens: number;
  completedAt?: number;
  createdAt: number;
  currency: string;
  cumulativeCachedInputTokens?: number;
  cumulativeCacheWriteInputTokens?: number;
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
  /** Latest observed model-request context for this turn. */
  finalContextTokens?: number;
  /** Largest observed model-request context for this turn. */
  peakContextTokens?: number;
  /** Provider-reported context-window ceiling paired with these observations. */
  modelContextWindow?: number;
  outputCostMicros: number;
  outputTokens: number;
  parentThreadId?: string;
  priceStatus: TokenUsagePriceStatus;
  priceUnavailableReason?: TokenUsagePriceUnavailableReason;
  provider: string;
  pricingCatalogId?: string;
  pricingCatalogVersion?: string;
  pricingBasis?: "aggregate" | "request-components";
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
  // Cost of regular uncached input after removing cache-write tokens.
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

export type ThreadSpendAlert = {
  alertId: string;
  createdAt: number;
  currency: "USD";
  kind: "active-turn-spend" | "thread-spend";
  spendMicros: number;
  threadId: string;
  thresholdMicros: number;
  turnId?: string;
};

export type TokenUsagePricingCatalogRate = {
  cacheWriteInputMicrosPerMillion?: number;
  cacheWriteInputUsdPerMillion?: number;
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
  cacheWriteInputCostMicros: number;
  cacheWriteInputUsd: number;
  cacheWriteInputUsdPerMillion?: number;
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
  cacheWriteInputUsdPerMillion?: number;
  cachedInputUsdPerMillion: number;
  catalogId: string;
  catalogVersion: string;
  displayModel: string;
  displayTier: string;
  effectiveFrom: number;
  effectiveTo?: number;
  inputUsdPerMillion: number;
  maximumInputTokens?: number;
  minimumInputTokens?: number;
  model: string;
  outputUsdPerMillion: number;
  outputTokensIncludeReasoning?: boolean;
  provider: TokenUsagePricingProvider;
  rateBandId?: string;
  requiresRequestInputTokens?: boolean;
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
  inputCreditsPerMillion: number;
  model: string;
  outputCreditsPerMillion: number;
  provider: "openai";
  serviceTier: TokenUsagePricingServiceTier;
};

type CodexCreditsStandardRates = Pick<
  CodexCreditsCatalogEntry,
  | "cachedInputCreditsPerMillion"
  | "inputCreditsPerMillion"
  | "outputCreditsPerMillion"
>;

const OPENAI_PRICING_CATALOG_ID = "openai-api";
const OPENAI_PRICING_CATALOG_VERSION = "2026-06-16";
const OPENAI_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 3, 23);
// https://developers.openai.com/api/docs/pricing
const OPENAI_GPT56_PRICING_CATALOG_VERSION = "2026-07-09";
const OPENAI_GPT56_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 6, 9);
// https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
const OPENAI_GPT56_REPRICING_CATALOG_VERSION = "2026-07-30";
const OPENAI_GPT56_REPRICING_EFFECTIVE_FROM = Date.UTC(2026, 6, 30);
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
const OPENAI_GPT56_SOL_REPRICING_CATALOG_VERSION = "2026-08-21";
const OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM = Date.UTC(2026, 7, 21);
// https://developers.openai.com/api/docs/models/gpt-6-astra
const OPENAI_GPT6_ASTRA_PRICING_CATALOG_VERSION = "2026-09-04";
const OPENAI_GPT6_ASTRA_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 8, 4);
const OPENAI_CODEX_CREDITS_CATALOG_ID = "openai-codex-credits";
const OPENAI_CODEX_CREDITS_CATALOG_VERSION = "2026-06-16";
const OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION = "2026-07-27";
// ChatGPT/Codex Fast credit multipliers are separate from API Fast rates.
// https://learn.chatgpt.com/docs/agent-configuration/speed.md currently says
// GPT-5.6 consumes 2.5x credits, while API Fast remains 2x. Keep one value
// here so every derived rate stays aligned.
const OPENAI_CODEX_FAST_RATE_MULTIPLIERS = {
  "gpt-5.4": 2,
  "gpt-5.5": 2.5,
  "gpt-5.6": 2.5,
} as const;
const XAI_PRICING_CATALOG_ID = "xai-api";
const XAI_PRICING_CATALOG_VERSION = "2026-07-17";
const XAI_GROK45_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 6, 8);
// https://docs.x.ai/developers/pricing
const XAI_GROK46_PRICING_CATALOG_VERSION = "2026-08-12";
const XAI_GROK46_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 7, 12);
// ModelStudio Standard, Singapore / International list pricing:
// https://www.alibabacloud.com/help/en/model-studio/model-pricing
// Implicit-cache hits cost 20% of the normal input-token rate:
// https://www.alibabacloud.com/help/en/model-studio/context-cache
const QWEN_PRICING_CATALOG_ID = "qwen-modelstudio-international";
const QWEN_PRICING_CATALOG_VERSION = "2026-07-15";
const QWEN37_PLUS_PRICING_EFFECTIVE_FROM = Date.UTC(2026, 4, 26);

const OPENAI_PRICING_CATALOG: readonly PricingCatalogEntry[] = [
  // Codex App Server reports cache-write tokens separately. They remain a
  // subset of uncached input tokens and are charged at the write rate below.
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT6_ASTRA_PRICING_CATALOG_VERSION,
    model: "gpt-6-astra",
    displayModel: "GPT-6 Astra",
    displayTier: "Standard (<=272K input)",
    effectiveFrom: OPENAI_GPT6_ASTRA_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    cacheWriteInputUsdPerMillion: 12.5,
    inputUsdPerMillion: 10,
    cachedInputUsdPerMillion: 1,
    outputUsdPerMillion: 50,
    maximumInputTokens: 272_000,
    rateBandId: "input-lte-272k",
  },
  // OpenAI applies the higher band per request. Turn-wide totals above the
  // boundary are ambiguous and must not select this rate.
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT6_ASTRA_PRICING_CATALOG_VERSION,
    model: "gpt-6-astra",
    displayModel: "GPT-6 Astra",
    displayTier: "Standard (>272K input)",
    effectiveFrom: OPENAI_GPT6_ASTRA_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    cacheWriteInputUsdPerMillion: 25,
    inputUsdPerMillion: 20,
    cachedInputUsdPerMillion: 2,
    outputUsdPerMillion: 75,
    minimumInputTokens: 272_001,
    rateBandId: "input-gt-272k",
    requiresRequestInputTokens: true,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT6_ASTRA_PRICING_CATALOG_VERSION,
    model: "gpt-6-astra",
    displayModel: "GPT-6 Astra",
    displayTier: "Fast (<=272K input)",
    effectiveFrom: OPENAI_GPT6_ASTRA_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    cacheWriteInputUsdPerMillion: 25,
    inputUsdPerMillion: 20,
    cachedInputUsdPerMillion: 2,
    outputUsdPerMillion: 100,
    maximumInputTokens: 272_000,
    rateBandId: "input-lte-272k",
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT6_ASTRA_PRICING_CATALOG_VERSION,
    model: "gpt-6-astra",
    displayModel: "GPT-6 Astra",
    displayTier: "Fast (>272K input)",
    effectiveFrom: OPENAI_GPT6_ASTRA_PRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    cacheWriteInputUsdPerMillion: 50,
    inputUsdPerMillion: 40,
    cachedInputUsdPerMillion: 4,
    outputUsdPerMillion: 150,
    minimumInputTokens: 272_001,
    rateBandId: "input-gt-272k",
    requiresRequestInputTokens: true,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_SOL_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 20,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_SOL_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Fast",
    effectiveFrom: OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 8,
    cachedInputUsdPerMillion: 0.8,
    outputUsdPerMillion: 40,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    displayTier: "Fast",
    effectiveFrom: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 4,
    cachedInputUsdPerMillion: 0.4,
    outputUsdPerMillion: 24,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "standard",
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    displayTier: "Fast",
    effectiveFrom: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    provider: "openai",
    serviceTier: "priority",
    inputUsdPerMillion: 0.4,
    cachedInputUsdPerMillion: 0.04,
    outputUsdPerMillion: 2.4,
  },
  {
    catalogId: OPENAI_PRICING_CATALOG_ID,
    catalogVersion: OPENAI_GPT56_PRICING_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    displayTier: "Standard",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    effectiveTo: OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM,
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
    effectiveTo: OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM,
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
    effectiveTo: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
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
    effectiveTo: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
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
    effectiveTo: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
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
    effectiveTo: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
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
  // Grok ACP authenticates the signed-in Grok account rather than an API key.
  // Estimate account usage at the standard rate across all context sizes.
  {
    aliases: ["grok-4.6-build", "grok-4.6-latest"],
    cachedInputUsdPerMillion: 0.5,
    catalogId: XAI_PRICING_CATALOG_ID,
    catalogVersion: XAI_GROK46_PRICING_CATALOG_VERSION,
    displayModel: "Grok 4.6",
    displayTier: "Standard",
    effectiveFrom: XAI_GROK46_PRICING_EFFECTIVE_FROM,
    inputUsdPerMillion: 2,
    model: "grok-4.6",
    outputTokensIncludeReasoning: true,
    outputUsdPerMillion: 6,
    provider: "xai",
    serviceTier: "standard",
  },
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

const QWEN_PRICING_CATALOG: readonly PricingCatalogEntry[] = [
  {
    aliases: [
      "qwen3.7-plus(openai)",
      "qwen3.7-plus (openai)",
      "qwen3.7-plus-2026-05-26",
      "qwen3.7-plus-2026-05-26(openai)",
      "qwen3.7-plus-2026-05-26 (openai)",
    ],
    cachedInputUsdPerMillion: 0.08,
    catalogId: QWEN_PRICING_CATALOG_ID,
    catalogVersion: QWEN_PRICING_CATALOG_VERSION,
    displayModel: "Qwen 3.7 Plus",
    displayTier: "International (<=256K input)",
    effectiveFrom: QWEN37_PLUS_PRICING_EFFECTIVE_FROM,
    inputUsdPerMillion: 0.4,
    // ModelStudio selects a pricing tier from each request's input count. ACP
    // usage is persisted as a multi-call turn aggregate, so an aggregate at or
    // below this boundary proves every call used the first tier. Larger turns
    // stay unpriced until ACP carries enough per-call detail to price safely.
    maximumInputTokens: 256_000,
    model: "qwen3.7-plus",
    outputTokensIncludeReasoning: true,
    outputUsdPerMillion: 1.6,
    provider: "qwen",
    rateBandId: "input-lte-256k",
    serviceTier: "standard",
  },
];

const TOKEN_USAGE_PRICING_CATALOG: readonly PricingCatalogEntry[] = [
  ...OPENAI_PRICING_CATALOG,
  ...XAI_PRICING_CATALOG,
  ...QWEN_PRICING_CATALOG,
];

function buildCodexCreditsCatalogEntries(params: {
  catalogVersion: string;
  displayModel: string;
  effectiveFrom: number;
  effectiveTo?: number;
  fastRateMultiplier?: number;
  model: string;
  standardRates: CodexCreditsStandardRates;
}): CodexCreditsCatalogEntry[] {
  const standardEntry: CodexCreditsCatalogEntry = {
    catalogId: OPENAI_CODEX_CREDITS_CATALOG_ID,
    catalogVersion: params.catalogVersion,
    model: params.model,
    displayModel: params.displayModel,
    displayTier: "Standard",
    effectiveFrom: params.effectiveFrom,
    ...(params.effectiveTo ? { effectiveTo: params.effectiveTo } : {}),
    provider: "openai",
    serviceTier: "standard",
    ...params.standardRates,
  };
  if (params.fastRateMultiplier === undefined) {
    return [standardEntry];
  }

  return [
    standardEntry,
    {
      ...standardEntry,
      displayTier: "Fast",
      serviceTier: "priority",
      inputCreditsPerMillion:
        params.standardRates.inputCreditsPerMillion
        * params.fastRateMultiplier,
      cachedInputCreditsPerMillion:
        params.standardRates.cachedInputCreditsPerMillion
        * params.fastRateMultiplier,
      outputCreditsPerMillion:
        params.standardRates.outputCreditsPerMillion
        * params.fastRateMultiplier,
    },
  ];
}

const OPENAI_CODEX_CREDITS_CATALOG: readonly CodexCreditsCatalogEntry[] = [
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_GPT56_SOL_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    effectiveFrom: OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.6"],
    standardRates: {
      inputCreditsPerMillion: 100,
      cachedInputCreditsPerMillion: 10,
      outputCreditsPerMillion: 500,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-sol",
    displayModel: "GPT-5.6 Sol",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    effectiveTo: OPENAI_GPT56_SOL_REPRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.6"],
    standardRates: {
      inputCreditsPerMillion: 125,
      cachedInputCreditsPerMillion: 12.5,
      outputCreditsPerMillion: 750,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_GPT56_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    effectiveFrom: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.6"],
    standardRates: {
      inputCreditsPerMillion: 50,
      cachedInputCreditsPerMillion: 5,
      outputCreditsPerMillion: 300,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_GPT56_REPRICING_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    effectiveFrom: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.6"],
    standardRates: {
      inputCreditsPerMillion: 5,
      cachedInputCreditsPerMillion: 0.5,
      outputCreditsPerMillion: 30,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-terra",
    displayModel: "GPT-5.6 Terra",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    effectiveTo: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.6"],
    standardRates: {
      inputCreditsPerMillion: 62.5,
      cachedInputCreditsPerMillion: 6.25,
      outputCreditsPerMillion: 375,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_GPT56_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.6-luna",
    displayModel: "GPT-5.6 Luna",
    effectiveFrom: OPENAI_GPT56_PRICING_EFFECTIVE_FROM,
    effectiveTo: OPENAI_GPT56_REPRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.6"],
    standardRates: {
      inputCreditsPerMillion: 25,
      cachedInputCreditsPerMillion: 2.5,
      outputCreditsPerMillion: 150,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.5",
    displayModel: "GPT-5.5",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.5"],
    standardRates: {
      inputCreditsPerMillion: 125,
      cachedInputCreditsPerMillion: 12.5,
      outputCreditsPerMillion: 750,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.4",
    displayModel: "GPT-5.4",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    fastRateMultiplier: OPENAI_CODEX_FAST_RATE_MULTIPLIERS["gpt-5.4"],
    standardRates: {
      inputCreditsPerMillion: 62.5,
      cachedInputCreditsPerMillion: 6.25,
      outputCreditsPerMillion: 375,
    },
  }),
  ...buildCodexCreditsCatalogEntries({
    catalogVersion: OPENAI_CODEX_CREDITS_CATALOG_VERSION,
    model: "gpt-5.4-mini",
    displayModel: "GPT-5.4 mini",
    effectiveFrom: OPENAI_PRICING_EFFECTIVE_FROM,
    standardRates: {
      inputCreditsPerMillion: 18.75,
      cachedInputCreditsPerMillion: 1.875,
      outputCreditsPerMillion: 113,
    },
  }),
];

export function listOpenAiTokenUsagePricingRates(): TokenUsagePricingCatalogRate[] {
  return OPENAI_PRICING_CATALOG.map(toPublicRate);
}

export function listTokenUsagePricingRates(): TokenUsagePricingCatalogRate[] {
  return TOKEN_USAGE_PRICING_CATALOG.map(toPublicRate);
}

export function estimateOpenAiTokenUsageCost(params: {
  cacheWriteInputTokens?: number;
  cachedInputTokens: number;
  at?: number;
  fastMode?: boolean;
  inputTokenScope?: TokenUsagePricingInputScope;
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
  cacheWriteInputTokens?: number;
  cachedInputTokens: number;
  at?: number;
  fastMode?: boolean;
  inputTokenScope?: TokenUsagePricingInputScope;
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
    cacheWriteInputTokens?: number;
    cachedInputTokens: number;
    at?: number;
    fastMode?: boolean;
    inputTokenScope?: TokenUsagePricingInputScope;
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
      && pricingEntryAppliesAt(candidate, params.at)
      && pricingEntryMatchesInputTokens(
        candidate,
        params.cachedInputTokens + params.uncachedInputTokens,
        params.inputTokenScope,
      ),
  );
  const provider = matchingEntries[0]?.provider;
  const serviceTier =
    provider === "xai" || provider === "qwen"
      ? resolveStandardOnlyPricingServiceTier(params.serviceTier)
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

  const cacheWriteInputTokens = Math.max(0, params.cacheWriteInputTokens ?? 0);
  if (
    cacheWriteInputTokens > params.uncachedInputTokens
    || (
      cacheWriteInputTokens > 0
      && entry.cacheWriteInputUsdPerMillion === undefined
    )
  ) {
    return undefined;
  }

  const standardEntry = catalog.find(
    (candidate) =>
      candidate.model === entry.model
      && candidate.provider === entry.provider
      && candidate.serviceTier === "standard"
      && pricingEntryAppliesAt(candidate, params.at)
      && pricingEntryMatchesInputTokens(
        candidate,
        params.cachedInputTokens + params.uncachedInputTokens,
        params.inputTokenScope,
      ),
  );
  const uncachedInputCostMicros = calculateTokenCostMicros(
    params.uncachedInputTokens - cacheWriteInputTokens,
    entry.inputUsdPerMillion,
  );
  const cacheWriteInputCostMicros = calculateTokenCostMicros(
    cacheWriteInputTokens,
    entry.cacheWriteInputUsdPerMillion ?? 0,
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
    uncachedInputCostMicros
    + cacheWriteInputCostMicros
    + cachedInputCostMicros
    + outputCostMicros;
  const uncachedInputUsd = microsToCurrencyUnits(uncachedInputCostMicros);
  const cacheWriteInputUsd = microsToCurrencyUnits(cacheWriteInputCostMicros);
  const cachedInputUsd = microsToCurrencyUnits(cachedInputCostMicros);
  const outputUsd = microsToCurrencyUnits(outputCostMicros);

  return {
    cacheWriteInputCostMicros,
    cacheWriteInputUsd,
    ...(entry.cacheWriteInputUsdPerMillion !== undefined
      ? { cacheWriteInputUsdPerMillion: entry.cacheWriteInputUsdPerMillion }
      : {}),
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
  // Prefer an explicit tier over the legacy Boolean intent so callers that can
  // observe an effective response tier can override the requested Fast mode.
  const serviceTier = params.serviceTier?.trim().toLowerCase();
  if (serviceTier === "default" || serviceTier === "standard") {
    return "standard";
  }
  if (serviceTier === "fast" || serviceTier === "priority") {
    return "priority";
  }
  if (serviceTier) {
    return undefined;
  }
  return params.fastMode === true ? "priority" : "standard";
}

export function resolveTokenUsagePriceUnavailableReason(params: {
  at?: number;
  cachedInputTokens: number;
  fastMode?: boolean;
  inputTokenScope?: TokenUsagePricingInputScope;
  model?: string;
  serviceTier?: string;
  uncachedInputTokens: number;
}): TokenUsagePriceUnavailableReason {
  const model = params.model?.trim();
  if (!model) {
    return "missing-model";
  }

  const inputTokens = params.cachedInputTokens + params.uncachedInputTokens;
  const matchingEntries = TOKEN_USAGE_PRICING_CATALOG.filter(
    (candidate) =>
      pricingEntryMatchesModel(candidate, model)
      && pricingEntryAppliesAt(candidate, params.at)
      // A request scope answers only whether the token count belongs in this
      // entry's numeric band. The caller's actual scope is checked below.
      && pricingEntryMatchesInputTokens(candidate, inputTokens, "request"),
  );
  const provider = matchingEntries[0]?.provider;
  const serviceTier =
    provider === "xai" || provider === "qwen"
      ? resolveStandardOnlyPricingServiceTier(params.serviceTier)
      : resolveOpenAiPricingServiceTier({
          fastMode: params.fastMode,
          serviceTier: params.serviceTier,
        });
  if (serviceTier === undefined) {
    return "unsupported-service-tier";
  }

  const entry = matchingEntries.find(
    (candidate) => candidate.serviceTier === serviceTier,
  );
  if (
    entry?.requiresRequestInputTokens
    && params.inputTokenScope !== "request"
  ) {
    return "insufficient-token-breakdown";
  }
  return "missing-rate";
}

function resolveStandardOnlyPricingServiceTier(
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
    ...(entry.cacheWriteInputUsdPerMillion !== undefined
      ? {
          cacheWriteInputMicrosPerMillion: dollarsToMicros(
            entry.cacheWriteInputUsdPerMillion,
          ),
          cacheWriteInputUsdPerMillion: entry.cacheWriteInputUsdPerMillion,
        }
      : {}),
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

function pricingEntryMatchesInputTokens(
  entry: PricingCatalogEntry,
  inputTokens: number,
  inputTokenScope: TokenUsagePricingInputScope | undefined,
): boolean {
  return (
    (!entry.requiresRequestInputTokens || inputTokenScope === "request")
    && (
      entry.minimumInputTokens === undefined
      || inputTokens >= entry.minimumInputTokens
    )
    && (
      entry.maximumInputTokens === undefined
      || inputTokens <= entry.maximumInputTokens
    )
  );
}

function buildPricingRateId(entry: PricingCatalogEntry): string {
  return [
    entry.provider,
    entry.catalogVersion,
    entry.model,
    entry.serviceTier,
    entry.rateBandId,
  ].filter(Boolean).join(":");
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
