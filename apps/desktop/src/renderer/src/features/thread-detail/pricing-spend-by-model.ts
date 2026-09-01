import type {
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";

/**
 * A usage row as the Pricing rail sees it: the stored record, plus the flag the
 * shared projection stamps on the rows it invents to cover a history gap.
 */
export type PricingSpendUsageLine = ThreadUsageLineRecord & {
  estimatedUsageGap?: true;
};

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
  /**
   * True when any row here was invented by the history-gap projection rather
   * than observed, so the row can mark its dollars the way the headline does.
   */
  hasEstimatedRows: boolean;
  /**
   * The React key, and the key expansion state is held under. It carries the
   * resolved model, so a bucket whose model arrives late is a different bucket
   * — see `prunePricingSpendOverrides` for what that costs and who pays it.
   */
  key: string;
  /**
   * Undefined when nothing named the model — a row written before models were
   * recorded, or a helper whose sub-agent summary never carried one.
   */
  model?: string;
  provider: string;
  /** Distinct sub-agents the operator dispatched that billed to this model. */
  subAgentCount: number;
  summary: ThreadPricingSummary;
  /**
   * Distinct PwrAgent-internal helpers — Token Miser gates and the thread
   * namer — that billed to this model. They spend real money, so they are in
   * `summary`, but the operator dispatched none of them and counting them as
   * sub-agents reported reviewers that were never run.
   */
  systemHelperCount: number;
  /**
   * The thread's own turn rows alone, present only when helper rows share this
   * bucket. A sub-agent inheriting the parent's model is the common case, and
   * a merged token volume is the figure that disagrees with the turn card and
   * with Codex's context-window meter.
   */
  threadSummary?: ThreadPricingSummary;
  /** Rows from the thread's own turns rather than from a helper. */
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

/**
 * Monitor ids in this namespace belong to helpers PwrAgent runs for itself —
 * `system:token-miser:` gates and `system:title-helper:` — never to something
 * the operator asked for. `subagent-kind.ts` makes the same split on the
 * sub-agent summaries; this is the same rule applied to the usage rows, which
 * arrive before their summaries do.
 */
const SYSTEM_HELPER_SOURCE_PREFIX = "system:";

export function buildPricingSpendByModel(params: {
  lines: readonly PricingSpendUsageLine[];
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
        hasEstimatedRows: false,
        key: modelKey,
        ...(model === undefined ? {} : { model }),
        provider: line.provider,
        subAgentIds: new Set<string>(),
        summary: emptyPricingSummary(line),
        systemHelperIds: new Set<string>(),
        threadSummary: emptyPricingSummary(line),
        threadUsageLineCount: 0,
      };
      group.models.set(modelKey, bucket);
    }
    bucket.summary = addUsageLineToSummary(bucket.summary, line);
    if (line.estimatedUsageGap) {
      bucket.hasEstimatedRows = true;
    }
    if (line.scope === "monitor") {
      // Several rows can belong to one helper; the count is of helpers, not of
      // rows, because that is the number the operator dispatched.
      if (line.sourceItemId) {
        const ids = line.sourceItemId.startsWith(SYSTEM_HELPER_SOURCE_PREFIX)
          ? bucket.systemHelperIds
          : bucket.subAgentIds;
        ids.add(line.sourceItemId);
      }
    } else {
      bucket.threadSummary = addUsageLineToSummary(bucket.threadSummary, line);
      bucket.threadUsageLineCount += 1;
    }
  }

  return [...groups.values()]
    .map((group) => {
      const models = [...group.models.values()]
        .map((bucket) => {
          const helperCount = bucket.subAgentIds.size + bucket.systemHelperIds.size;
          return {
            hasEstimatedRows: bucket.hasEstimatedRows,
            key: bucket.key,
            ...(bucket.model === undefined ? {} : { model: bucket.model }),
            provider: bucket.provider,
            subAgentCount: bucket.subAgentIds.size,
            summary: bucket.summary,
            systemHelperCount: bucket.systemHelperIds.size,
            // Only worth carrying when something else shares the bucket;
            // otherwise it is the bucket, and a second identical figure on the
            // row would read as a second measurement.
            ...(helperCount > 0 && bucket.threadUsageLineCount > 0
              ? { threadSummary: bucket.threadSummary }
              : {}),
            threadUsageLineCount: bucket.threadUsageLineCount,
          } satisfies PricingModelSpend;
        })
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
 * Drops expansion overrides whose bucket no longer exists.
 *
 * A bucket's key carries its model, and a helper's model can arrive after its
 * usage row does — the row lands synchronously with pricing while the
 * sub-agent summary arrives on a scheduled refresh. The bucket the operator
 * expanded as "Unknown model" is then re-keyed, and without this its override
 * would sit in the map forever and open the next genuinely unknown bucket that
 * the operator never touched.
 */
export function prunePricingSpendOverrides(
  overrides: Readonly<Record<string, boolean>>,
  groups: readonly PricingProviderSpend[],
): Readonly<Record<string, boolean>> {
  const live = new Set<string>();
  for (const group of groups) {
    for (const model of group.models) {
      live.add(model.key);
    }
  }
  const pruned: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (live.has(key)) {
      pruned[key] = value;
    }
  }
  return pruned;
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
  hasEstimatedRows: boolean;
  key: string;
  model?: string;
  provider: string;
  subAgentIds: Set<string>;
  summary: ThreadPricingSummary;
  systemHelperIds: Set<string>;
  threadSummary: ThreadPricingSummary;
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
