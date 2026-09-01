import type {
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";

/**
 * A thread's bill, split by the model that produced it.
 *
 * The Pricing rail's stored summaries carry a provider and no model, which was
 * enough while a thread meant one model. A turn that dispatches four reviewers
 * to four different models bills them all to two or three providers, and a
 * per-provider split answers none of the questions an operator has about it.
 * These buckets are folded out of the usage lines instead, where the model is
 * recorded, and they sum to the same figures the per-turn cards below do.
 */
export type PricingModelSpend = {
  /** Stable across renders: React key, and the key expansion state is held under. */
  key: string;
  /**
   * Undefined when nothing named the model — a row written before models were
   * recorded, or a helper whose sub-agent summary never carried one.
   */
  model?: string;
  provider: string;
  /** Distinct sub-agents that billed to this model. */
  subAgentCount: number;
  summary: ThreadPricingSummary;
  /** Rows from the thread's own turns rather than from a sub-agent. */
  threadUsageLineCount: number;
};

export type PricingProviderSpend = {
  currency: string;
  key: string;
  models: PricingModelSpend[];
  provider: string;
  totalCostMicros: number;
  usageLineCount: number;
};

/**
 * Names the model a usage line should be bucketed under.
 *
 * A helper's usage row often carries no model of its own — the sub-agent
 * summary holds it. The rail's row cards already walk that fallback chain, and
 * passing the same resolver here keeps a row and its bucket agreeing on which
 * model spent the money.
 */
export type PricingSpendModelResolver = (
  line: ThreadUsageLineRecord,
) => string | undefined;

export function buildPricingSpendByModel(params: {
  lines: readonly ThreadUsageLineRecord[];
  resolveModel?: PricingSpendModelResolver;
}): PricingProviderSpend[] {
  const groups = new Map<string, MutableProviderSpend>();
  for (const line of params.lines) {
    const model = params.resolveModel?.(line) ?? line.model;
    const groupKey = `${line.provider}:${line.currency}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        currency: line.currency,
        key: groupKey,
        models: new Map(),
        provider: line.provider,
      };
      groups.set(groupKey, group);
    }
    const modelKey = `${groupKey}:${model ?? ""}`;
    let bucket = group.models.get(modelKey);
    if (!bucket) {
      bucket = {
        key: modelKey,
        ...(model === undefined ? {} : { model }),
        provider: line.provider,
        subAgentIds: new Set<string>(),
        summary: emptyPricingSummary(line),
        threadUsageLineCount: 0,
      };
      group.models.set(modelKey, bucket);
    }
    bucket.summary = addUsageLineToSummary(bucket.summary, line);
    if (line.scope === "monitor") {
      // Several rows can belong to one sub-agent; the count is of agents, not
      // of rows, because that is the number the operator dispatched.
      if (line.sourceItemId) {
        bucket.subAgentIds.add(line.sourceItemId);
      }
    } else {
      bucket.threadUsageLineCount += 1;
    }
  }

  return [...groups.values()]
    .map((group) => {
      const models = [...group.models.values()]
        .map((bucket) => ({
          key: bucket.key,
          ...(bucket.model === undefined ? {} : { model: bucket.model }),
          provider: bucket.provider,
          subAgentCount: bucket.subAgentIds.size,
          summary: bucket.summary,
          threadUsageLineCount: bucket.threadUsageLineCount,
        } satisfies PricingModelSpend))
        .sort(compareModelSpend);
      return {
        currency: group.currency,
        key: group.key,
        models,
        provider: group.provider,
        totalCostMicros: models.reduce(
          (total, bucket) => total + bucket.summary.totalCostMicros,
          0,
        ),
        usageLineCount: models.reduce(
          (total, bucket) => total + bucket.summary.usageLineCount,
          0,
        ),
      } satisfies PricingProviderSpend;
    })
    .sort(compareProviderSpend);
}

/**
 * Folds one usage line into a running summary. Shared with the rail's own
 * totals so a bucket and the headline above it are built by the same
 * arithmetic.
 */
export function addUsageLineToSummary(
  summary: ThreadPricingSummary,
  line: ThreadUsageLineRecord,
): ThreadPricingSummary {
  return {
    backend: summary.backend,
    cachedInputTokens: summary.cachedInputTokens + line.cachedInputTokens,
    currency: summary.currency,
    inputTokens: summary.inputTokens + line.inputTokens,
    outputTokens: summary.outputTokens + line.outputTokens,
    pricedUsageLineCount:
      summary.pricedUsageLineCount + (line.priceStatus === "priced" ? 1 : 0),
    provider: summary.provider,
    reasoningOutputTokens:
      summary.reasoningOutputTokens + line.reasoningOutputTokens,
    threadId: summary.threadId,
    totalCostMicros: summary.totalCostMicros + line.totalCostMicros,
    totalTokens: summary.totalTokens + line.totalTokens,
    uncachedInputTokens: summary.uncachedInputTokens + line.uncachedInputTokens,
    unpricedUsageLineCount:
      summary.unpricedUsageLineCount + (line.priceStatus === "priced" ? 0 : 1),
    updatedAt: Math.max(summary.updatedAt, line.completedAt ?? line.createdAt),
    usageLineCount: summary.usageLineCount + 1,
  };
}

export function emptyPricingSummary(
  line: ThreadUsageLineRecord,
): ThreadPricingSummary {
  return {
    backend: line.backend,
    cachedInputTokens: 0,
    currency: line.currency,
    inputTokens: 0,
    outputTokens: 0,
    pricedUsageLineCount: 0,
    provider: line.provider,
    reasoningOutputTokens: 0,
    threadId: line.parentThreadId ?? line.threadId,
    totalCostMicros: 0,
    totalTokens: 0,
    uncachedInputTokens: 0,
    unpricedUsageLineCount: 0,
    updatedAt: 0,
    usageLineCount: 0,
  };
}

type MutableModelSpend = {
  key: string;
  model?: string;
  provider: string;
  subAgentIds: Set<string>;
  summary: ThreadPricingSummary;
  threadUsageLineCount: number;
};

type MutableProviderSpend = {
  currency: string;
  key: string;
  models: Map<string, MutableModelSpend>;
  provider: string;
};

function compareProviderSpend(
  left: PricingProviderSpend,
  right: PricingProviderSpend,
): number {
  if (left.totalCostMicros !== right.totalCostMicros) {
    return right.totalCostMicros - left.totalCostMicros;
  }
  const providerCompare = left.provider.localeCompare(right.provider);
  return providerCompare !== 0
    ? providerCompare
    : left.currency.localeCompare(right.currency);
}

function compareModelSpend(
  left: PricingModelSpend,
  right: PricingModelSpend,
): number {
  const leftCost = left.summary.totalCostMicros;
  const rightCost = right.summary.totalCostMicros;
  if (leftCost !== rightCost) {
    return rightCost - leftCost;
  }
  // A bucket nothing named is leftovers, so it settles after every model that
  // has a name rather than sorting into the middle of them on a tied cost.
  if ((left.model === undefined) !== (right.model === undefined)) {
    return left.model === undefined ? 1 : -1;
  }
  return (left.model ?? "").localeCompare(right.model ?? "");
}
