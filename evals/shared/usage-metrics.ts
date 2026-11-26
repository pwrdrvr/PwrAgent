import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  ThreadPricingSnapshot,
  ThreadUsageLineRecord,
} from "@pwragent/shared/token-usage-pricing";

export type CellUsageMetrics = {
  source: "ledger" | "snapshot" | "none";
  lineCount: number;
  pricedLineCount: number;
  unpricedLineCount: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  replayObserved: boolean;
  coldReplayCount: number | null;
  hotReplayCount: number | null;
  totalReplayCount: number | null;
  coldReplayUncachedTokens: number | null;
  hotReplayCachedTokens: number | null;
  peakContextTokens: number | null;
  finalContextTokens: number | null;
  totalCostMicros: number;
  uncachedInputCostMicros: number;
  cachedInputCostMicros: number;
  cacheWriteInputCostMicros: number;
  outputCostMicros: number;
  estimatedCostUsd: number | null;
  currency: string;
};

export type AggregatedUsageMetrics = {
  measuredCells: number;
  totalCells: number;
  pricedCells: number;
  unpricedCells: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  meanTotalTokens: number | null;
  replayObservedCells: number;
  coldReplayCount: number | null;
  hotReplayCount: number | null;
  totalReplayCount: number | null;
  meanReplayCount: number | null;
  maxPeakContextTokens: number | null;
  totalCostMicros: number;
  estimatedCostUsd: number | null;
  meanCostUsd: number | null;
};

function nonNeg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNonNeg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Pure rollup of PwrAgent's owner-observed `ThreadUsageLineRecord` rows (and
 * optional provider snapshot fallback when no observed lines exist).
 *
 * Deduplicates by `usageLineId`, ignores `superseded` and `fork-baseline` lines,
 * and never adds snapshot tokens on top of ledger lines.
 */
export function summarizeThreadUsageLines(
  rawLines: readonly ThreadUsageLineRecord[],
  snapshot?: ThreadPricingSnapshot | null,
): CellUsageMetrics {
  const byId = new Map<string, ThreadUsageLineRecord>();
  for (const line of rawLines) {
    if (!line || line.status === "superseded" || line.scope === "fork-baseline") continue;
    if (line.source === "openai_decisions") continue;
    const key = line.usageLineId || `${line.backend}:${line.threadId}:${line.turnId ?? ""}:${byId.size}`;
    const prev = byId.get(key);
    // Prefer finalized over pending if both appear in a combined parent+child read.
    if (!prev || (prev.status !== "finalized" && line.status === "finalized")) {
      byId.set(key, line);
    }
  }

  const lines = [...byId.values()];
  if (lines.length === 0) {
    const snapTokens = snapshot?.tokens;
    const hasSnapTokens = Boolean(
      snapTokens
      && (nonNeg(snapTokens.totalTokens) > 0
        || nonNeg(snapTokens.inputTokens) > 0
        || nonNeg(snapTokens.outputTokens) > 0),
    );
    if (!hasSnapTokens) {
      return {
        source: "none",
        lineCount: 0,
        pricedLineCount: 0,
        unpricedLineCount: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        replayObserved: false,
        coldReplayCount: null,
        hotReplayCount: null,
        totalReplayCount: null,
        coldReplayUncachedTokens: null,
        hotReplayCachedTokens: null,
        peakContextTokens: null,
        finalContextTokens: null,
        totalCostMicros: 0,
        uncachedInputCostMicros: 0,
        cachedInputCostMicros: 0,
        cacheWriteInputCostMicros: 0,
        outputCostMicros: 0,
        estimatedCostUsd: null,
        currency: "USD",
      };
    }
    const cached = nonNeg(snapTokens?.cachedInputTokens);
    const cacheWrite = nonNeg(snapTokens?.cacheWriteInputTokens);
    const uncached = snapTokens?.uncachedInputTokens !== undefined
      ? nonNeg(snapTokens.uncachedInputTokens)
      : Math.max(0, nonNeg(snapTokens?.inputTokens) - cached);
    const input = snapTokens?.inputTokens !== undefined
      ? nonNeg(snapTokens.inputTokens)
      : uncached + cached;
    const output = nonNeg(snapTokens?.outputTokens);
    const reasoning = nonNeg(snapTokens?.reasoningOutputTokens);
    const total = snapTokens?.totalTokens !== undefined
      ? nonNeg(snapTokens.totalTokens)
      : input + output;
    const costMicros = optionalNonNeg(snapshot?.estimatedCostMicros);
    return {
      source: "snapshot",
      lineCount: 0,
      pricedLineCount: costMicros !== null ? 1 : 0,
      unpricedLineCount: costMicros !== null ? 0 : 1,
      uncachedInputTokens: uncached,
      cachedInputTokens: cached,
      cacheWriteInputTokens: cacheWrite,
      inputTokens: input,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
      totalTokens: total,
      replayObserved: false,
      coldReplayCount: null,
      hotReplayCount: null,
      totalReplayCount: null,
      coldReplayUncachedTokens: null,
      hotReplayCachedTokens: null,
      peakContextTokens: null,
      finalContextTokens: null,
      totalCostMicros: costMicros ?? 0,
      uncachedInputCostMicros: 0,
      cachedInputCostMicros: 0,
      cacheWriteInputCostMicros: 0,
      outputCostMicros: 0,
      estimatedCostUsd: costMicros !== null ? round(costMicros / 1_000_000, 6) : null,
      currency: "USD",
    };
  }

  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let pricedLineCount = 0;
  let unpricedLineCount = 0;
  let totalCostMicros = 0;
  let uncachedInputCostMicros = 0;
  let cachedInputCostMicros = 0;
  let cacheWriteInputCostMicros = 0;
  let outputCostMicros = 0;
  let replayObserved = false;
  let coldReplayCount = 0;
  let hotReplayCount = 0;
  let coldReplayUncachedTokens = 0;
  let hotReplayCachedTokens = 0;
  let peakContextTokens: number | null = null;
  let finalContextTokens: number | null = null;
  let latestFinalAt = -1;
  let currency = "USD";

  for (const line of lines) {
    uncachedInputTokens += nonNeg(line.uncachedInputTokens);
    cachedInputTokens += nonNeg(line.cachedInputTokens);
    cacheWriteInputTokens += nonNeg(line.cacheWriteInputTokens);
    inputTokens += nonNeg(line.inputTokens);
    outputTokens += nonNeg(line.outputTokens);
    reasoningOutputTokens += nonNeg(line.reasoningOutputTokens);
    totalTokens += nonNeg(line.totalTokens);
    if (line.currency) currency = line.currency;

    if (line.priceStatus === "priced") {
      pricedLineCount += 1;
      totalCostMicros += nonNeg(line.totalCostMicros);
      uncachedInputCostMicros += nonNeg(line.uncachedInputCostMicros);
      cachedInputCostMicros += nonNeg(line.cachedInputCostMicros);
      cacheWriteInputCostMicros += nonNeg(line.cacheWriteInputCostMicros);
      outputCostMicros += nonNeg(line.outputCostMicros);
    } else {
      unpricedLineCount += 1;
    }

    const cold = optionalNonNeg(line.observedColdReplayCount);
    const hot = optionalNonNeg(line.observedHotReplayCount);
    if (cold !== null || hot !== null) {
      replayObserved = true;
      coldReplayCount += cold ?? 0;
      hotReplayCount += hot ?? 0;
      coldReplayUncachedTokens += nonNeg(line.observedColdReplayUncachedTokens);
      hotReplayCachedTokens += nonNeg(line.observedHotReplayCachedTokens);
    }

    const peak = optionalNonNeg(line.peakContextTokens);
    if (peak !== null) {
      peakContextTokens = peakContextTokens === null ? peak : Math.max(peakContextTokens, peak);
    }
    const finalCtx = optionalNonNeg(line.finalContextTokens);
    const stamp = line.completedAt ?? line.createdAt ?? 0;
    if (finalCtx !== null && stamp >= latestFinalAt) {
      latestFinalAt = stamp;
      finalContextTokens = finalCtx;
    }
  }

  return {
    source: "ledger",
    lineCount: lines.length,
    pricedLineCount,
    unpricedLineCount,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    replayObserved,
    coldReplayCount: replayObserved ? coldReplayCount : null,
    hotReplayCount: replayObserved ? hotReplayCount : null,
    totalReplayCount: replayObserved ? coldReplayCount + hotReplayCount : null,
    coldReplayUncachedTokens: replayObserved ? coldReplayUncachedTokens : null,
    hotReplayCachedTokens: replayObserved ? hotReplayCachedTokens : null,
    peakContextTokens,
    finalContextTokens,
    totalCostMicros,
    uncachedInputCostMicros,
    cachedInputCostMicros,
    cacheWriteInputCostMicros,
    outputCostMicros,
    estimatedCostUsd: pricedLineCount > 0 ? round(totalCostMicros / 1_000_000, 6) : null,
    currency,
  };
}

/**
 * Aggregate per-cell usage metrics across a cohort or subset of cells.
 */
export function aggregateCellUsage(
  cells: ReadonlyArray<CellUsageMetrics | null | undefined>,
): AggregatedUsageMetrics {
  const totalCells = cells.length;
  let measuredCells = 0;
  let pricedCells = 0;
  let unpricedCells = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let replayObservedCells = 0;
  let coldReplayCount = 0;
  let hotReplayCount = 0;
  let maxPeakContextTokens: number | null = null;
  let totalCostMicros = 0;

  for (const usage of cells) {
    if (!usage || usage.source === "none") continue;
    measuredCells += 1;
    uncachedInputTokens += nonNeg(usage.uncachedInputTokens);
    cachedInputTokens += nonNeg(usage.cachedInputTokens);
    cacheWriteInputTokens += nonNeg(usage.cacheWriteInputTokens);
    inputTokens += nonNeg(usage.inputTokens);
    outputTokens += nonNeg(usage.outputTokens);
    reasoningOutputTokens += nonNeg(usage.reasoningOutputTokens);
    totalTokens += nonNeg(usage.totalTokens);

    if (usage.pricedLineCount > 0 && usage.unpricedLineCount === 0) {
      pricedCells += 1;
      totalCostMicros += nonNeg(usage.totalCostMicros);
    } else if (usage.pricedLineCount > 0) {
      pricedCells += 1;
      unpricedCells += 1;
      totalCostMicros += nonNeg(usage.totalCostMicros);
    } else {
      unpricedCells += 1;
    }

    if (usage.replayObserved) {
      replayObservedCells += 1;
      coldReplayCount += nonNeg(usage.coldReplayCount);
      hotReplayCount += nonNeg(usage.hotReplayCount);
    }
    const peak = optionalNonNeg(usage.peakContextTokens);
    if (peak !== null) {
      maxPeakContextTokens = maxPeakContextTokens === null ? peak : Math.max(maxPeakContextTokens, peak);
    }
  }

  const totalReplayCount = replayObservedCells > 0 ? coldReplayCount + hotReplayCount : null;
  const estimatedCostUsd = pricedCells > 0 ? round(totalCostMicros / 1_000_000, 6) : null;

  return {
    measuredCells,
    totalCells,
    pricedCells,
    unpricedCells,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    meanTotalTokens: measuredCells > 0 ? Math.round(totalTokens / measuredCells) : null,
    replayObservedCells,
    coldReplayCount: replayObservedCells > 0 ? coldReplayCount : null,
    hotReplayCount: replayObservedCells > 0 ? hotReplayCount : null,
    totalReplayCount,
    meanReplayCount: totalReplayCount !== null && replayObservedCells > 0
      ? round(totalReplayCount / replayObservedCells, 2)
      : null,
    maxPeakContextTokens,
    totalCostMicros,
    estimatedCostUsd,
    meanCostUsd: estimatedCostUsd !== null && pricedCells > 0
      ? round(estimatedCostUsd / pricedCells, 6)
      : null,
  };
}

export type ThreadPricingReader = {
  readThread?: (request: {
    backend: AppServerBackendKind;
    threadId: string;
    includeTurns?: boolean;
  }) => Promise<Pick<AppServerReadThreadResponse, "pricing">>;
};

/**
 * Read observed token usage, context replay counts, and list cost through the
 * owner registry API (`readThread`) for both the review child thread and parent
 * thread, never querying SQLite or Codex storage directly.
 */
export async function readCellUsageFromRegistry(
  registry: ThreadPricingReader,
  params: {
    backend: AppServerBackendKind;
    parentThreadId?: string;
    reviewThreadId?: string;
  },
): Promise<CellUsageMetrics | null> {
  if (typeof registry.readThread !== "function") return null;
  const threadIds = [...new Set([params.reviewThreadId, params.parentThreadId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  ))];
  if (threadIds.length === 0) return null;

  const lines: ThreadUsageLineRecord[] = [];
  let snapshot: ThreadPricingSnapshot | undefined;
  for (const threadId of threadIds) {
    try {
      const view = await registry.readThread({
        backend: params.backend,
        threadId,
        includeTurns: false,
      });
      if (Array.isArray(view?.pricing?.lines)) {
        lines.push(...view.pricing.lines);
      }
      if (!snapshot && view?.pricing?.snapshot) {
        snapshot = view.pricing.snapshot;
      }
    } catch {
      // Best-effort read: a thread that failed before initialization may have no ledger view.
    }
  }
  return summarizeThreadUsageLines(lines, snapshot);
}
