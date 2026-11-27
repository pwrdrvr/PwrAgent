import type { ThreadPricingSummary, ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { estimateCodexCreditsForLine, summaryKey, usageLineSummaryKey, type PricingRunningLineTotals } from "@pwragent/shared/thread-pricing-display";

const counters = ["totalCostMicros", "cachedInputTokens", "uncachedInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
type Difference = Record<typeof counters[number], number>;
const zero = (): Difference => ({ totalCostMicros: 0, cachedInputTokens: 0, uncachedInputTokens: 0, inputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });

/** A monitor's counters can arrive again after newer turns. Its position,
 * group identity and estimate flags stay fixed. Keep signed adjustments to
 * the original folds so rewinding the newest turn cannot undo the correction. */
export class PricingMonitorCorrections {
  private readonly models = new Map<string, Difference>();
  private readonly summaries = new Map<string, Difference>();
  private readonly all = zero();
  private readonly credits = new Map<string, number | undefined>();
  private readonly prefixes = new Map<number, { cost: number; credits: number }>();
  totalCreditDelta = 0;

  replace(position: number, previous: ThreadUsageLineRecord, next: ThreadUsageLineRecord, model: string | undefined): void {
    const modelKey = next.provider + ":" + next.currency + ":" + (model ?? "");
    const summaryKey = usageLineSummaryKey(next);
    const bucket = this.models.get(modelKey) ?? zero();
    const summary = this.summaries.get(summaryKey) ?? zero();
    for (const field of counters) {
      const delta = next[field] - previous[field];
      bucket[field] += delta;
      summary[field] += delta;
      this.all[field] += delta;
    }
    this.models.set(modelKey, bucket);
    this.summaries.set(summaryKey, summary);
    const credit = estimateCodexCreditsForLine(next)?.totalCreditMicros;
    const creditDelta = (credit ?? 0) - (estimateCodexCreditsForLine(previous)?.totalCreditMicros ?? 0);
    this.credits.set(next.usageLineId, credit);
    this.totalCreditDelta += creditDelta;
    const costDelta = next.priceStatus === "priced" ? Math.max(0, next.totalCostMicros) - Math.max(0, previous.totalCostMicros) : 0;
    if (!costDelta && !creditDelta) return;
    // A sparse Fenwick tree covers current and future array indices. Updating
    // its ancestors takes at most 32 steps, even for the oldest monitor.
    for (let i = position + 1; i <= 0xffffffff; i += (i & -i) >>> 0) {
      const prefix = this.prefixes.get(i) ?? { cost: 0, credits: 0 };
      prefix.cost += costDelta;
      prefix.credits += creditDelta;
      this.prefixes.set(i, prefix);
    }
  }

  restore(position: number, current: ThreadUsageLineRecord, base: ThreadUsageLineRecord, model: string | undefined): void {
    this.replace(position, current, base, model);
    this.credits.delete(base.usageLineId);
  }

  adjust(summary: ThreadPricingSummary, modelKey?: string, fallback = false): ThreadPricingSummary {
    const delta = fallback ? this.all : modelKey === undefined ? this.summaries.get(summaryKey(summary)) : this.models.get(modelKey);
    if (!delta) return summary;
    const result = { ...summary };
    for (const field of counters) result[field] += delta[field];
    return result;
  }

  running(lineId: string, position: number, base: PricingRunningLineTotals): PricingRunningLineTotals {
    let cost = base.runningCostMicros;
    let credits = base.runningCreditMicros ?? 0;
    for (let i = position + 1; i > 0; i -= (i & -i) >>> 0) {
      const delta = this.prefixes.get(i);
      if (delta) { cost += delta.cost; credits += delta.credits; }
    }
    const credit = this.credits.has(lineId) ? this.credits.get(lineId) : base.creditMicros;
    return {
      ...(credit === undefined ? {} : { creditMicros: credit }),
      ...(base.runningHasEstimate ? { runningHasEstimate: true } : {}),
      runningCostMicros: cost, ...(credits > 0 ? { runningCreditMicros: credits } : {}),
    };
  }
}
