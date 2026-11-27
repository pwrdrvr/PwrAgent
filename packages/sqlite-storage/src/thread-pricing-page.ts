import { addUsageLineToSummary, emptyPricingSummary, PricingModelSpendProjection } from "@pwragent/shared/pricing-spend-by-model";
import {
  aggregateSummaries, compareUsageLinesAscending, isEstimatedUsageGap, PricingRunningTotals,
  summaryKey, usageLineSummaryKey, type PricingHistoryPage, type PricingUsageLine,
} from "@pwragent/shared/thread-pricing-display";
import { appendUsageGapLine, createUsageGapProjection } from "@pwragent/shared/thread-pricing-projection";
import { createHash } from "node:crypto";
import type { ThreadCompactionRecord } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadPricingSummary, ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";

/** Chronological rows of an open turn ledger. Every prefix total is computed
 * once. A page needs its slice, one entry per spend bucket and its markers. */
export class ThreadPricingPageIndex {
  private readonly rows: PricingUsageLine[] = [];
  private running = new PricingRunningTotals();
  private readonly lineTotals: ReturnType<PricingRunningTotals["add"]>[] = [];
  private models = new PricingModelSpendProjection();
  private readonly gaps = createUsageGapProjection();
  private gapSummaries = new Map<string, ThreadPricingSummary>();
  private fallback?: ThreadPricingSummary;
  private readonly lineIds = new Set<string>();
  readonly usageTurns = new Map<string, Set<string>>();
  private lastBatch?: { ids: Set<string>; rewind: () => void };
  private readonly newestByTurn = new Map<string, string>();
  private hash = createHash("sha256");
  private lastSource?: ThreadUsageLineRecord;

  static fromHistory(lines: ThreadUsageLineRecord[]): ThreadPricingPageIndex | undefined {
    let index = new ThreadPricingPageIndex();
    if (lines.length > 1) {
      // Retain a checkpoint for the newest turn even on a cold open. Its
      // completion or context counters can arrive after the initial page.
      const ordered = [...lines].sort(compareUsageLinesAscending);
      if (index.append(ordered.slice(0, -1)) && index.append(ordered.slice(-1))) return index;
      // A gap introduced by the last row may sort inside the earlier prefix.
      index = new ThreadPricingPageIndex();
    }
    return index.append(lines) ? index : undefined;
  }

  /** Reprice a recent in-flight batch from its preceding counters. Earlier
   * corrections can reorder every subsequent gap and require a fresh fold. */
  rewindChanged(dirty: Set<string>): boolean {
    const known = [...dirty].filter((id) => this.lineIds.has(id));
    if (!known.length) return true;
    const batch = this.lastBatch;
    if (!batch || known.some((id) => !batch.ids.has(id))) return false;
    batch.rewind();
    for (const id of batch.ids) dirty.add(id);
    this.lastBatch = undefined;
    return true;
  }

  append(lines: ThreadUsageLineRecord[]): boolean {
    if (!lines.length) return true;
    this.lastBatch = undefined;
    if (lines.length <= 16) {
      const size = this.rows.length;
      const before = {
        running: this.running.copy(),
        models: this.models.copy(),
        gaps: this.gaps.accountedMainTokens,
        gapSummaries: new Map(this.gapSummaries),
        fallback: this.fallback,
        hash: this.hash.copy(),
        lastSource: this.lastSource,
      };
      const oldTurns = new Map(lines.flatMap((line) => line.turnId ? [[line.turnId, this.newestByTurn.get(line.turnId)] as const] : []));
      this.lastBatch = { ids: new Set(lines.map((line) => line.usageLineId)), rewind: () => {
        this.rows.length = size;
        this.lineTotals.length = size;
        this.running = before.running;
        this.models = before.models;
        this.gaps.accountedMainTokens = before.gaps;
        this.gapSummaries = before.gapSummaries;
        this.fallback = before.fallback;
        this.hash = before.hash;
        this.lastSource = before.lastSource;
        for (const line of lines) {
          this.lineIds.delete(line.usageLineId);
          if (line.usageTurnId) {
            const ids = this.usageTurns.get(line.usageTurnId);
            ids?.delete(line.usageLineId);
            if (!ids?.size) this.usageTurns.delete(line.usageTurnId);
          }
        }
        for (const [id, old] of oldTurns) {
          if (old) this.newestByTurn.set(id, old);
          else this.newestByTurn.delete(id);
        }
      } };
    }
    const incoming = [...lines].sort(compareUsageLinesAscending);
    const display: PricingUsageLine[] = [];
    for (const line of incoming) {
      if (line.scope === "monitor" || line.usageLineId.startsWith("estimated-gap:") || this.lineIds.has(line.usageLineId)
        || (this.lastSource && compareUsageLinesAscending(this.lastSource, line) >= 0)) return false;
      this.hash.update(JSON.stringify(line)).update("\n");
      this.lastSource = line;
      this.lineIds.add(line.usageLineId);
      if (line.usageTurnId) {
        const ids = this.usageTurns.get(line.usageTurnId) ?? new Set<string>();
        ids.add(line.usageLineId);
        this.usageTurns.set(line.usageTurnId, ids);
      }
      const gap = appendUsageGapLine(this.gaps, line);
      if (gap) display.push(gap);
      display.push(line);
    }
    display.sort(compareUsageLinesAscending);
    const last = this.rows.at(-1);
    if (last && display[0] && compareUsageLinesAscending(last, display[0]) >= 0) return false;
    for (const line of display) {
      this.rows.push(line);
      this.lineTotals.push(this.running.add(line));
      this.models.add(line, line.model, true);
      if (line.turnId) this.newestByTurn.set(line.turnId, line.usageLineId);
      const identity = emptyPricingSummary(line);
      this.fallback = addUsageLineToSummary(this.fallback ? {
        ...this.fallback, threadId: identity.threadId, backend: line.backend, currency: line.currency, provider: line.provider,
      } : identity, line);
      if (isEstimatedUsageGap(line)) {
        const key = usageLineSummaryKey(line);
        this.gapSummaries.set(key, addUsageLineToSummary(this.gapSummaries.get(key) ?? identity, line));
      }
    }
    return true;
  }

  page(params: {
    offset: number; limit: number; markerRevision: string; summaries: ThreadPricingSummary[];
    markers: (lineIds: string[], pendingTurns: string[]) => ThreadCompactionRecord[];
  }): PricingHistoryPage {
    const end = Math.max(0, this.rows.length - params.offset);
    const start = Math.max(0, end - params.limit);
    const lines = this.rows.slice(start, end).reverse();
    const summaries = new Map(params.summaries.map((row) => [summaryKey(row), row]));
    if (summaries.size) {
      for (const [key, gap] of this.gapSummaries) {
        const existing = summaries.get(key);
        summaries.set(key, existing ? {
          ...aggregateSummaries([existing, gap])!, provider: existing.provider,
          ...(gap.hasAssumedPricing ? { hasAssumedPricing: true } : {}),
        } : gap);
      }
    }
    const withGaps = this.gapSummaries.size
      ? [...summaries.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency))
      : params.summaries;
    const summary = aggregateSummaries(withGaps) ?? this.fallback;
    // Only the newest displayed row for a turn can claim its pending marker,
    // including when an older row for that turn is the first row on a later page.
    const pendingTurns = lines.flatMap((line) => line.turnId && this.newestByTurn.get(line.turnId) === line.usageLineId ? [line.turnId] : []);
    return structuredClone({
      revision: this.hash.copy().update(params.markerRevision).update(JSON.stringify(params.summaries)).digest("base64url"),
      totalRows: this.rows.length,
      lines,
      summary,
      compactions: params.markers(lines.map((line) => line.usageLineId), pendingTurns),
      totals: this.running.summary(), spendByModel: this.models.groups(),
      lineTotals: new Map(lines.map((line, i) => [line.usageLineId, this.lineTotals[end - i - 1]!])),
    });
  }
}

/** Keep marker ownership independent of page offsets. A marker can move from
 * its turn to a cold usage line after either has already been displayed. */
export class PricingPageMarkers {
  private readonly byId = new Map<string, { key: string; digest: Buffer }>();
  private readonly byRow = new Map<string, Map<string, { marker: ThreadCompactionRecord; rowid: number }>>();
  private readonly checksum = Buffer.alloc(32);

  set(id: string, record?: { marker: ThreadCompactionRecord; rowid: number }): void {
    const previous = this.byId.get(id);
    if (previous) {
      const rows = this.byRow.get(previous.key)!;
      rows.delete(id);
      if (!rows.size) this.byRow.delete(previous.key);
      this.byId.delete(id);
      this.toggle(previous.digest);
    }
    if (!record) return;
    const { marker } = record;
    const key = marker.coldUsageLineId ? "line:" + marker.coldUsageLineId : "turn:" + marker.turnId;
    const bucket = this.byRow.get(key) ?? new Map<string, typeof record>();
    bucket.set(id, record);
    this.byRow.set(key, bucket);
    const digest = createHash("sha256").update(JSON.stringify(record)).digest();
    this.toggle(digest);
    this.byId.set(id, { key, digest });
  }

  private toggle(digest: Buffer): void {
    for (let i = 0; i < digest.length; i++) this.checksum[i] = this.checksum[i]! ^ digest[i]!;
  }

  revision(): string { return this.checksum.toString("base64url"); }

  read(lineIds: string[], turns: string[]): ThreadCompactionRecord[] {
    const keys = [...lineIds.map((id) => "line:" + id), ...turns.map((id) => "turn:" + id)];
    return keys.flatMap((key) => Array.from(this.byRow.get(key)?.values() ?? []))
      .sort((a, b) => a.marker.observedAt - b.marker.observedAt || b.rowid - a.rowid)
      .map(({ marker }) => marker);
  }
}
