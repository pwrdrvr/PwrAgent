import {
  estimateTokenUsageCost,
  type ThreadUsageLineRecord,
} from "./token-usage-pricing";

type PricingTokenBreakdown = {
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  uncachedInputTokens: number;
};

export type EstimatedThreadUsageGapLine = ThreadUsageLineRecord & {
  estimatedUsageGap: true;
};

/**
 * Reconstructs main-thread usage that appears in cumulative protocol counters
 * but has no durable pricing row. Consumers must share this projection so
 * operator-facing totals and spend alerts account for the same estimates.
 */
export function estimateHistoricalThreadUsageGapLines(
  lines: readonly ThreadUsageLineRecord[],
): EstimatedThreadUsageGapLine[] {
  const chronologicalLines = [...lines].sort(compareUsageLinesAscending);
  const estimatedLines: EstimatedThreadUsageGapLine[] = [];
  let accountedMainTokens = emptyPricingTokenBreakdown();

  for (const line of chronologicalLines) {
    if (line.scope === "monitor") {
      continue;
    }

    const cumulativeTokens = readCumulativeTokenBreakdown(line);
    const lineTokens = tokenBreakdownFromUsageLine(line);
    const gapTokens = cumulativeTokens
      ? subtractPricingTokenBreakdowns(
          cumulativeTokens,
          addPricingTokenBreakdowns(accountedMainTokens, lineTokens),
        )
      : emptyPricingTokenBreakdown();
    const gapLine = hasPricingTokenBreakdownValue(gapTokens)
      ? buildEstimatedHistoricalGapLine({
          anchorLine: line,
          gapTokens,
        })
      : undefined;
    if (gapLine) {
      estimatedLines.push(gapLine);
      accountedMainTokens = addPricingTokenBreakdowns(
        accountedMainTokens,
        gapTokens,
      );
    }

    accountedMainTokens = cumulativeTokens
      ? maxPricingTokenBreakdowns(
          addPricingTokenBreakdowns(accountedMainTokens, lineTokens),
          cumulativeTokens,
        )
      : addPricingTokenBreakdowns(accountedMainTokens, lineTokens);
  }

  return estimatedLines;
}

function compareUsageLinesAscending(
  left: ThreadUsageLineRecord,
  right: ThreadUsageLineRecord,
): number {
  const leftTimestamp = lineSortTimestamp(left);
  const rightTimestamp = lineSortTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return left.usageLineId.localeCompare(right.usageLineId);
}

function lineSortTimestamp(line: ThreadUsageLineRecord): number {
  return line.startedAt ?? line.createdAt;
}

function emptyPricingTokenBreakdown(): PricingTokenBreakdown {
  return {
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    uncachedInputTokens: 0,
  };
}

function tokenBreakdownFromUsageLine(
  line: ThreadUsageLineRecord,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, line.cachedInputTokens),
    outputTokens: Math.max(0, line.outputTokens),
    reasoningOutputTokens: Math.max(0, line.reasoningOutputTokens),
    uncachedInputTokens: Math.max(0, line.uncachedInputTokens),
  };
}

function readCumulativeTokenBreakdown(
  line: ThreadUsageLineRecord,
): PricingTokenBreakdown | undefined {
  if (!hasCumulativeTokenBreakdown(line)) {
    return undefined;
  }
  const uncachedInputTokens = readCumulativeUncachedInputTokens(line);
  if (
    uncachedInputTokens === undefined
    || line.cumulativeCachedInputTokens === undefined
    || line.cumulativeOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    cachedInputTokens: Math.max(0, line.cumulativeCachedInputTokens),
    outputTokens: Math.max(0, line.cumulativeOutputTokens),
    reasoningOutputTokens: Math.max(0, line.cumulativeReasoningOutputTokens ?? 0),
    uncachedInputTokens: Math.max(0, uncachedInputTokens),
  };
}

function hasCumulativeTokenBreakdown(line: ThreadUsageLineRecord): boolean {
  return (
    line.cumulativeUncachedInputTokens !== undefined
    || line.cumulativeInputTokens !== undefined
    || line.cumulativeCachedInputTokens !== undefined
    || line.cumulativeOutputTokens !== undefined
    || line.cumulativeReasoningOutputTokens !== undefined
    || line.cumulativeTotalTokens !== undefined
  );
}

function readCumulativeUncachedInputTokens(
  line: ThreadUsageLineRecord,
): number | undefined {
  if (line.cumulativeUncachedInputTokens !== undefined) {
    return line.cumulativeUncachedInputTokens;
  }
  if (
    line.cumulativeInputTokens === undefined
    || line.cumulativeCachedInputTokens === undefined
  ) {
    return undefined;
  }
  return Math.max(
    0,
    line.cumulativeInputTokens - line.cumulativeCachedInputTokens,
  );
}

function addPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
  };
}

function subtractPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, left.cachedInputTokens - right.cachedInputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      left.reasoningOutputTokens - right.reasoningOutputTokens,
    ),
    uncachedInputTokens: Math.max(
      0,
      left.uncachedInputTokens - right.uncachedInputTokens,
    ),
  };
}

function maxPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(
      left.reasoningOutputTokens,
      right.reasoningOutputTokens,
    ),
    uncachedInputTokens: Math.max(
      left.uncachedInputTokens,
      right.uncachedInputTokens,
    ),
  };
}

function hasPricingTokenBreakdownValue(tokens: PricingTokenBreakdown): boolean {
  return (
    tokens.cachedInputTokens > 0
    || tokens.outputTokens > 0
    || tokens.reasoningOutputTokens > 0
    || tokens.uncachedInputTokens > 0
  );
}

function buildEstimatedHistoricalGapLine(params: {
  anchorLine: ThreadUsageLineRecord;
  gapTokens: PricingTokenBreakdown;
}): EstimatedThreadUsageGapLine | undefined {
  const cost = estimateTokenUsageCost({
    at: params.anchorLine.createdAt,
    cachedInputTokens: params.gapTokens.cachedInputTokens,
    fastMode: false,
    model: params.anchorLine.model,
    outputTokens: params.gapTokens.outputTokens,
    reasoningOutputTokens: params.gapTokens.reasoningOutputTokens,
    serviceTier: "standard",
    uncachedInputTokens: params.gapTokens.uncachedInputTokens,
  });
  const inputTokens =
    params.gapTokens.cachedInputTokens + params.gapTokens.uncachedInputTokens;
  const totalTokens =
    inputTokens
    + params.gapTokens.outputTokens
    + params.gapTokens.reasoningOutputTokens;
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost ? undefined : params.anchorLine.model ? "missing-rate" : "missing-model";

  return {
    backend: params.anchorLine.backend,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens: params.gapTokens.cachedInputTokens,
    createdAt: Math.max(0, lineSortTimestamp(params.anchorLine) - 1),
    currency: cost?.currency ?? params.anchorLine.currency,
    estimatedUsageGap: true,
    inputTokens,
    model: params.anchorLine.model,
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens: params.gapTokens.outputTokens,
    parentThreadId: params.anchorLine.parentThreadId,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: cost?.provider ?? params.anchorLine.provider,
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    reasoningEffort: params.anchorLine.reasoningEffort,
    reasoningOutputTokens: params.gapTokens.reasoningOutputTokens,
    scope: "backfill",
    serviceTier: "standard",
    settingsConfidence: "fallback",
    settingsSource: "observed-settings",
    source: "backfill",
    sourceItemId: `estimated-gap:${params.anchorLine.usageLineId}`,
    status: "finalized",
    threadId: params.anchorLine.threadId,
    totalCostMicros: cost?.totalCostMicros ?? 0,
    totalTokens,
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens: params.gapTokens.uncachedInputTokens,
    usageLineId: `estimated-gap:${params.anchorLine.usageLineId}`,
    usageTurnId: `estimated-gap:${params.anchorLine.usageTurnId ?? params.anchorLine.usageLineId}`,
  };
}
