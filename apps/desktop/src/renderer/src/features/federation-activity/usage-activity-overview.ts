import {
  estimateTokenUsageCost,
  type ThreadUsageLineRecord,
} from "@pwragent/shared/token-usage-pricing";
import { usageProviderLabel } from "./usage-activity-accounts";
import { usageBucketBounds } from "./usage-activity-presentation";
import type { OwnedUsageRow, UsageGroup } from "./usage-activity-summary";

export type OverviewMetric = "tokens" | "cost";

export type FilterMode = "include" | "exclude";
/** Map from item label (provider label or model display name) to include/exclude; absent = unfiltered. */
export type TriStateFilter = Readonly<Record<string, FilterMode>>;

/** Cycle a single key: unfiltered → include → exclude → unfiltered. */
export function cycleTriStateFilter(filter: TriStateFilter, key: string): TriStateFilter {
  const current = filter[key];
  if (current === undefined) return { ...filter, [key]: "include" };
  if (current === "include") return { ...filter, [key]: "exclude" };
  const next = { ...filter };
  delete next[key];
  return next;
}

/** Remove one key from a tri-state filter, returning it to unfiltered. */
export function removeTriStateFilterKey(filter: TriStateFilter, key: string): TriStateFilter {
  if (!(key in filter)) return filter;
  const next = { ...filter };
  delete next[key];
  return next;
}

export function hasTriStateFilter(filter: TriStateFilter | undefined): boolean {
  return filter !== undefined && Object.keys(filter).length > 0;
}

/**
 * Evaluate whether `value` passes a tri-state filter:
 * - Empty filter: every value passes.
 * - Any included values: `value` passes iff it is included (and not excluded).
 * - Only excluded values: `value` passes iff it is not excluded.
 */
export function matchesTriStateFilter(filter: TriStateFilter | undefined, value: string): boolean {
  if (!filter) return true;
  const entries = Object.entries(filter);
  if (entries.length === 0) return true;
  if (filter[value] === "exclude") return false;
  let hasInclude = false;
  for (const [, mode] of entries) {
    if (mode === "include") {
      hasInclude = true;
      break;
    }
  }
  return hasInclude ? filter[value] === "include" : true;
}

/** Canonical model display name used consistently across Overview filtering and Breakdown rows. */
export const overviewRowModelName = (line: ThreadUsageLineRecord): string =>
  line.modelLabel ?? line.model ?? "Unknown model";

/** Canonical provider label used consistently across Overview filtering and provider rows. */
export const overviewRowProviderLabel = (line: ThreadUsageLineRecord): string =>
  usageProviderLabel(line.provider || "unknown");

/**
 * Model filter key: the display name qualified by its provider, so one model
 * name served by two providers stays two rows and two filters.
 */
export const overviewRowModelKey = (line: ThreadUsageLineRecord): string =>
  `${overviewRowModelName(line)} · ${overviewRowProviderLabel(line)}`;

export type OverviewTotals = {
  /** Total processed tokens: `uncachedInputTokens + cachedInputTokens + outputTokens`. */
  processedTokens: number;
  /** Uncached input tokens including cache writes. */
  uncachedInputTokens: number;
  /** Non-cache-write uncached input tokens (`uncachedInputTokens - cacheWriteInputTokens`). */
  plainInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** Priced USD API-equivalent spend in micro-dollars. */
  costMicros: number;
  /** Estimated USD list-price savings from prompt cache reads, in micro-dollars. */
  cacheSavingsMicros: number;
  threads: number;
  turns: number;
  cacheShare: number;
};

export type OverviewProviderRow = {
  provider: string;
  label: string;
  seriesIndex: number | "other";
  tokens: number;
  tokenShare: number;
  costMicros: number;
  costShare: number;
  threads: number;
  turns: number;
};

export type OverviewModelRow = {
  model: string;
  /** Tri-state model filter key (`overviewRowModelKey`). */
  filterKey: string;
  provider: string;
  providerLabel: string;
  seriesIndex: number | "other";
  tokens: number;
  tokenShare: number;
  costMicros: number;
  costShare: number;
  cachedTokens: number;
  threads: number;
  turns: number;
};

export type OverviewDayRow = {
  /** Local calendar date key `YYYY-MM-DD`. */
  key: string;
  label: string;
  from: number;
  to: number;
  tokens: number;
  tokenShare: number;
  costMicros: number;
  costShare: number;
  cachedTokens: number;
  threads: number;
  turns: number;
};

export type OverviewTrendPoint = {
  from: number;
  to: number;
  label: string;
  totalTokens: number;
  totalCostMicros: number;
  byProvider: Record<string, { tokens: number; costMicros: number }>;
};

export type StackedAreaBand = {
  key: string;
  label: string;
  seriesIndex: number | "other";
  /** Cumulative lower baseline at each trend bucket (equals previous band's `upper`). */
  lower: number[];
  /** Cumulative upper value at each trend bucket (`lower[i] + values[i]`). */
  upper: number[];
  /** This series's own non-cumulative contribution at each trend bucket. */
  values: number[];
};

export type UsageActivityOverview = {
  totals: OverviewTotals;
  providers: OverviewProviderRow[];
  models: OverviewModelRow[];
  days: OverviewDayRow[];
  trend: OverviewTrendPoint[];
  /** Providers charted as distinct colored series (up to 5, largest first). */
  chartedProviders: OverviewProviderRow[];
  /** Mutually exclusive stacked bands from 0 up to the bucket total (including Other when >5 providers). */
  stackedBands: StackedAreaBand[];
  /** Peak cumulative total across all trend buckets (top of the stacked area chart). */
  stackedPeak: number;
};

const MAX_CHARTED_PROVIDERS = 5;
const HOUR = 3_600_000;

const isPricedUsd = (line: ThreadUsageLineRecord): boolean =>
  line.priceStatus === "priced" && line.currency === "USD";

/** Non-negative token breakdown for one ledger line without double-counting cache writes. */
export function lineTokenPartition(line: ThreadUsageLineRecord): {
  processed: number;
  uncached: number;
  plainInput: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
} {
  const uncached = Math.max(0, line.uncachedInputTokens);
  const cached = Math.max(0, line.cachedInputTokens);
  // `cacheWriteInputTokens` is a provider-reported subset of `uncachedInputTokens`.
  const cacheWrite = Math.min(uncached, Math.max(0, line.cacheWriteInputTokens ?? 0));
  const plainInput = Math.max(0, uncached - cacheWrite);
  const output = Math.max(0, line.outputTokens);
  const reasoning = Math.max(0, line.reasoningOutputTokens);
  return {
    processed: uncached + cached + output,
    uncached,
    plainInput,
    cached,
    cacheWrite,
    output,
    reasoning,
  };
}

/**
 * Estimate USD list-price savings (micros) from prompt cache reads on a single
 * priced ledger line using PwrAgent's pricing catalog, falling back to the
 * line's own effective uncached rate when a custom/unlisted model was priced.
 */
const cacheSavingsByLine = new WeakMap<ThreadUsageLineRecord, number>();

export function estimateRowCacheSavingsMicros(line: ThreadUsageLineRecord): number {
  // A catalog lookup per line, rerun on every metric toggle and filter click
  // otherwise; ledger lines are immutable snapshot records.
  const cached = cacheSavingsByLine.get(line);
  if (cached !== undefined) return cached;
  const savings = estimateUncachedRowCacheSavingsMicros(line);
  cacheSavingsByLine.set(line, savings);
  return savings;
}

function estimateUncachedRowCacheSavingsMicros(line: ThreadUsageLineRecord): number {
  if (!isPricedUsd(line) || line.cachedInputTokens <= 0) return 0;
  if (line.model) {
    const hypothetical = estimateTokenUsageCost({
      model: line.model,
      serviceTier: line.serviceTier,
      fastMode: line.fastMode,
      at: line.completedAt ?? line.createdAt,
      uncachedInputTokens: line.cachedInputTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    if (hypothetical) {
      return Math.max(0, hypothetical.uncachedInputCostMicros - line.cachedInputCostMicros);
    }
  }
  const { plainInput } = lineTokenPartition(line);
  if (plainInput > 0 && line.uncachedInputCostMicros > 0) {
    const fullInputMicros = Math.round(line.cachedInputTokens * (line.uncachedInputCostMicros / plainInput));
    return Math.max(0, fullInputMicros - line.cachedInputCostMicros);
  }
  return 0;
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDayEnd(dayStart: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function formatDayShort(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTrendLabel(bucket: { from: number; to: number }, span: number): string {
  if (span > 36 * HOUR) return formatDayShort(bucket.from);
  const date = new Date(bucket.from);
  return date.toLocaleTimeString(undefined, date.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
}

/**
 * Build daily buckets across `[from, to]` when spanning more than 36 hours,
 * else reuse clock-aligned `usageBucketBounds` for intraday windows.
 */
function overviewTrendBounds(from: number, to: number): Array<{ from: number; to: number }> {
  if (to - from <= 36 * HOUR) return usageBucketBounds(from, to);
  const bounds: Array<{ from: number; to: number }> = [];
  for (let start = localDayStart(from); start < to;) {
    const end = Math.max(localDayEnd(start), start + 60_000);
    bounds.push({ from: Math.max(from, start), to: Math.min(to, end) });
    start = end;
  }
  return bounds;
}

/**
 * Aggregate deduplicated contained Usage Activity rows into an overview across
 * providers, models, calendar days, token types, and cache savings.
 */
export function buildUsageActivityOverview(params: {
  groups: readonly UsageGroup[];
  from: number;
  to: number;
  metric: OverviewMetric;
  /** Optional tri-state provider filter keyed by provider label (e.g. "OpenAI"). */
  providerFilters?: TriStateFilter;
  /** Optional tri-state model filter keyed by model display name (e.g. "GPT-5.4"). */
  modelFilters?: TriStateFilter;
}): UsageActivityOverview {
  const { groups, from, to, metric, providerFilters, modelFilters } = params;

  // Map each contained row to its root thread group so helper threads roll up
  // to their parent thread count, matching the rest of Usage Activity.
  const allRows: Array<{ row: OwnedUsageRow; rootKey: string }> = [];
  for (const group of groups) {
    for (const row of group.rows) {
      allRows.push({ row, rootKey: group.key });
    }
  }

  // First pass: always compute provider totals across ALL rows in the window so
  // the provider list stays visible and selectable even while filtered to one.
  type ProviderAcc = {
    provider: string;
    label: string;
    tokens: number;
    costMicros: number;
    threads: Set<string>;
    turns: number;
  };
  const providerMap = new Map<string, ProviderAcc>();
  let allProcessedTokens = 0;
  let allCostMicros = 0;

  for (const { row, rootKey } of allRows) {
    const { processed } = lineTokenPartition(row.line);
    const cost = isPricedUsd(row.line) ? row.line.totalCostMicros : 0;
    allProcessedTokens += processed;
    allCostMicros += cost;
    const provider = row.line.provider || "unknown";
    let acc = providerMap.get(provider);
    if (!acc) {
      acc = {
        provider,
        label: usageProviderLabel(provider),
        tokens: 0,
        costMicros: 0,
        threads: new Set(),
        turns: 0,
      };
      providerMap.set(provider, acc);
    }
    acc.tokens += processed;
    acc.costMicros += cost;
    acc.threads.add(rootKey);
    acc.turns += 1;
  }

  const compareByMetric = (a: { tokens: number; costMicros: number }, b: { tokens: number; costMicros: number }) =>
    metric === "tokens"
      ? (b.tokens - a.tokens) || (b.costMicros - a.costMicros)
      : (b.costMicros - a.costMicros) || (b.tokens - a.tokens);

  const sortedProviders = [...providerMap.values()].sort(
    (a, b) => compareByMetric(a, b) || a.label.localeCompare(b.label),
  );
  // Colors and band membership follow a metric-independent rank, so the
  // Tokens | Cost toggle re-sorts the list without repainting a provider.
  const colorRankedProviders = [...providerMap.values()].sort(
    (a, b) => (b.tokens - a.tokens) || (b.costMicros - a.costMicros) || a.label.localeCompare(b.label),
  );
  const providerSeriesIndex = new Map<string, number | "other">();
  colorRankedProviders.forEach((entry, index) => {
    providerSeriesIndex.set(entry.provider, index < MAX_CHARTED_PROVIDERS ? index : "other");
  });

  const providers: OverviewProviderRow[] = sortedProviders.map((entry) => ({
    provider: entry.provider,
    label: entry.label,
    seriesIndex: providerSeriesIndex.get(entry.provider) ?? "other",
    tokens: entry.tokens,
    tokenShare: allProcessedTokens > 0 ? entry.tokens / allProcessedTokens : 0,
    costMicros: entry.costMicros,
    costShare: allCostMicros > 0 ? entry.costMicros / allCostMicros : 0,
    threads: entry.threads.size,
    turns: entry.turns,
  }));

  const providerRows = hasTriStateFilter(providerFilters)
    ? allRows.filter(({ row }) => matchesTriStateFilter(providerFilters, overviewRowProviderLabel(row.line)))
    : allRows;

  // Build the Model breakdown over provider-filtered rows (before modelFilters)
  // so every model stays visible and clickable while including/excluding models.
  type ModelAcc = {
    model: string;
    filterKey: string;
    provider: string;
    providerLabel: string;
    tokens: number;
    costMicros: number;
    cachedTokens: number;
    threads: Set<string>;
    turns: number;
  };
  const modelMap = new Map<string, ModelAcc>();
  let providerScopeTokens = 0;
  let providerScopeCostMicros = 0;
  for (const { row, rootKey } of providerRows) {
    const part = lineTokenPartition(row.line);
    const cost = isPricedUsd(row.line) ? row.line.totalCostMicros : 0;
    providerScopeTokens += part.processed;
    providerScopeCostMicros += cost;
    const provider = row.line.provider || "unknown";
    const providerLabel = usageProviderLabel(provider);
    const modelName = overviewRowModelName(row.line);
    const modelKey = JSON.stringify([provider, modelName]);
    let modelAcc = modelMap.get(modelKey);
    if (!modelAcc) {
      modelAcc = {
        model: modelName,
        filterKey: overviewRowModelKey(row.line),
        provider,
        providerLabel,
        tokens: 0,
        costMicros: 0,
        cachedTokens: 0,
        threads: new Set(),
        turns: 0,
      };
      modelMap.set(modelKey, modelAcc);
    }
    modelAcc.tokens += part.processed;
    modelAcc.costMicros += cost;
    modelAcc.cachedTokens += part.cached;
    modelAcc.threads.add(rootKey);
    modelAcc.turns += 1;
  }

  const activeRows = hasTriStateFilter(modelFilters)
    ? providerRows.filter(({ row }) => matchesTriStateFilter(modelFilters, overviewRowModelKey(row.line)))
    : providerRows;

  // Compute totals, day breakdown, and trend buckets over rows passing both provider and model filters.
  const activeThreads = new Set<string>();
  let processedTokens = 0;
  let uncachedInputTokens = 0;
  let plainInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let costMicros = 0;
  let cacheSavingsMicros = 0;

  type DayAcc = {
    key: string;
    from: number;
    to: number;
    tokens: number;
    costMicros: number;
    cachedTokens: number;
    threads: Set<string>;
    turns: number;
  };
  const dayMap = new Map<string, DayAcc>();

  const bounds = overviewTrendBounds(from, to);
  const span = to - from;
  const trend: OverviewTrendPoint[] = bounds.map((bound) => ({
    from: bound.from,
    to: bound.to,
    label: formatTrendLabel(bound, span),
    totalTokens: 0,
    totalCostMicros: 0,
    byProvider: {},
  }));

  for (const { row, rootKey } of activeRows) {
    const part = lineTokenPartition(row.line);
    const cost = isPricedUsd(row.line) ? row.line.totalCostMicros : 0;
    const savings = estimateRowCacheSavingsMicros(row.line);
    const provider = row.line.provider || "unknown";

    activeThreads.add(rootKey);
    processedTokens += part.processed;
    uncachedInputTokens += part.uncached;
    plainInputTokens += part.plainInput;
    cachedInputTokens += part.cached;
    cacheWriteInputTokens += part.cacheWrite;
    outputTokens += part.output;
    reasoningOutputTokens += part.reasoning;
    costMicros += cost;
    cacheSavingsMicros += savings;

    const completedAt = row.line.completedAt;
    if (completedAt !== undefined) {
      const dayKey = localDayKey(completedAt);
      let dayAcc = dayMap.get(dayKey);
      if (!dayAcc) {
        const start = localDayStart(completedAt);
        dayAcc = {
          key: dayKey,
          from: start,
          to: localDayEnd(start),
          tokens: 0,
          costMicros: 0,
          cachedTokens: 0,
          threads: new Set(),
          turns: 0,
        };
        dayMap.set(dayKey, dayAcc);
      }
      dayAcc.tokens += part.processed;
      dayAcc.costMicros += cost;
      dayAcc.cachedTokens += part.cached;
      dayAcc.threads.add(rootKey);
      dayAcc.turns += 1;

      const bucketIdx = trend.findIndex((point) => completedAt >= point.from && completedAt < point.to);
      if (bucketIdx >= 0) {
        const point = trend[bucketIdx];
        point.totalTokens += part.processed;
        point.totalCostMicros += cost;
        const seriesKey = providerSeriesIndex.get(provider) === "other" ? "other" : provider;
        const current = point.byProvider[seriesKey] ?? { tokens: 0, costMicros: 0 };
        current.tokens += part.processed;
        current.costMicros += cost;
        point.byProvider[seriesKey] = current;
      }
    }
  }

  const models: OverviewModelRow[] = [...modelMap.values()]
    .sort((a, b) => compareByMetric(a, b) || a.model.localeCompare(b.model))
    .map((entry) => ({
      model: entry.model,
      filterKey: entry.filterKey,
      provider: entry.provider,
      providerLabel: entry.providerLabel,
      seriesIndex: providerSeriesIndex.get(entry.provider) ?? "other",
      tokens: entry.tokens,
      tokenShare: providerScopeTokens > 0 ? entry.tokens / providerScopeTokens : 0,
      costMicros: entry.costMicros,
      costShare: providerScopeCostMicros > 0 ? entry.costMicros / providerScopeCostMicros : 0,
      cachedTokens: entry.cachedTokens,
      threads: entry.threads.size,
      turns: entry.turns,
    }));

  const days: OverviewDayRow[] = [...dayMap.values()]
    .sort((a, b) => b.from - a.from)
    .map((entry) => ({
      key: entry.key,
      label: new Date(entry.from).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      from: entry.from,
      to: entry.to,
      tokens: entry.tokens,
      tokenShare: processedTokens > 0 ? entry.tokens / processedTokens : 0,
      costMicros: entry.costMicros,
      costShare: costMicros > 0 ? entry.costMicros / costMicros : 0,
      cachedTokens: entry.cachedTokens,
      threads: entry.threads.size,
      turns: entry.turns,
    }));

  const chartedProviders = providers
    .filter((entry) => entry.seriesIndex !== "other")
    .filter((entry) => matchesTriStateFilter(providerFilters, entry.label));

  const hasOtherBand = trend.some((point) => {
    const other = point.byProvider.other;
    return other !== undefined && (metric === "tokens" ? other.tokens : other.costMicros) > 0;
  });

  const bandSpecs: Array<{ key: string; label: string; seriesIndex: number | "other" }> = [
    ...chartedProviders.map((entry) => ({
      key: entry.provider,
      label: entry.label,
      seriesIndex: entry.seriesIndex,
    })),
    ...(hasOtherBand ? [{ key: "other", label: "Other providers", seriesIndex: "other" as const }] : []),
  ];

  const running = Array<number>(trend.length).fill(0);
  const stackedBands: StackedAreaBand[] = bandSpecs.map((spec) => {
    const lower = [...running];
    const values = trend.map((point) => {
      const entry = point.byProvider[spec.key];
      return !entry ? 0 : metric === "tokens" ? entry.tokens : entry.costMicros;
    });
    const upper = values.map((value, index) => {
      const next = lower[index] + value;
      running[index] = next;
      return next;
    });
    return { ...spec, lower, upper, values };
  });
  const stackedPeak = running.reduce((peak, value) => Math.max(peak, value), 0);

  const totalInput = cachedInputTokens + uncachedInputTokens;
  return {
    totals: {
      processedTokens,
      uncachedInputTokens,
      plainInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
      costMicros,
      cacheSavingsMicros,
      threads: activeThreads.size,
      turns: activeRows.length,
      cacheShare: totalInput > 0 ? cachedInputTokens / totalInput : 0,
    },
    providers,
    models,
    days,
    trend,
    chartedProviders,
    stackedBands,
    stackedPeak,
  };
}
