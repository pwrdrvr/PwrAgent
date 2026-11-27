import { PricingMonitorCorrections } from "./pricing-monitor-corrections";
import { PricingPageGroups } from "./pricing-page-groups";
import type { ThreadSubAgentSummary } from "@pwragent/shared/contracts/navigation";
import { isDeepStrictEqual } from "node:util";
import { addUsageLineToSummary, emptyPricingSummary, PricingModelSpendProjection } from "@pwragent/shared/pricing-spend-by-model";
import {
  aggregateSummaries, compareUsageLinesAscending, isEstimatedUsageGap, PricingRunningTotals,
  resolveUsageLineModel, summaryKey, usageLineSummaryKey, type PricingGateSelection, type PricingHistoryPage, type PricingUsageLine,
} from "@pwragent/shared/thread-pricing-display";
import { appendUsageGapLine, createUsageGapProjection } from "@pwragent/shared/thread-pricing-projection";
import { createHash } from "node:crypto";
import type { ThreadCompactionRecord } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadPricingSummary, ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";

/** Chronological usage folds and grouped display order for one open ledger.
 * A page touches its visible rows, requested expansion, spend buckets and markers. */
export class ThreadPricingPageIndex {
  private readonly rows: PricingUsageLine[] = [];
  private running = new PricingRunningTotals();
  private readonly lineTotals: ReturnType<PricingRunningTotals["add"]>[] = [];
  private models = new PricingModelSpendProjection();
  private readonly gaps = createUsageGapProjection();
  private gapSummaries = new Map<string, ThreadPricingSummary>();
  private fallback?: ThreadPricingSummary;
  private readonly source = new Map<string, ThreadUsageLineRecord>();
  private readonly positions = new Map<string, number>();
  private summaries = new Map<string, { summary: ThreadPricingSummary; newest: ThreadUsageLineRecord }>();
  private readonly groups: PricingPageGroups;

  constructor(cards = new Map<string, ThreadSubAgentSummary>()) {
    this.groups = new PricingPageGroups(cards);
  }

  get(id: string) { return this.source.get(id); }

  sameLine(id: string, line: ThreadUsageLineRecord | undefined): boolean {
    return isDeepStrictEqual(this.source.get(id), line);
  }

  setCard(id: string, card?: ThreadSubAgentSummary): boolean {
    return this.groups.setCard(id, card);
  }

  readonly usageTurns = new Map<string, Set<string>>();
  private lastBatch?: { ids: Set<string>; rewind: () => void };
  private readonly newestByTurn = new Map<string, string>();
  private hash = Buffer.alloc(32);
  private readonly correctedHash = Buffer.alloc(32);
  private corrections?: PricingMonitorCorrections;
  private lastSource?: ThreadUsageLineRecord;

  static fromHistory(lines: ThreadUsageLineRecord[], cards?: Map<string, ThreadSubAgentSummary>): ThreadPricingPageIndex | undefined {
    let index = new ThreadPricingPageIndex(cards);
    if (lines.length > 1) {
      // Retain a checkpoint for the newest turn even on a cold open. Its
      // completion or context counters can arrive after the initial page.
      const ordered = [...lines].sort(compareUsageLinesAscending);
      if (index.append(ordered.slice(0, -1)) && index.append(ordered.slice(-1))) return index;
      // A gap introduced by the last row may sort inside the earlier prefix.
      index = new ThreadPricingPageIndex(cards);
    }
    return index.append(lines) ? index : undefined;
  }

  replaceMonitor(id: string, next: ThreadUsageLineRecord | undefined): boolean {
    const old = this.source.get(id);
    if (!next || !old || old.scope !== "monitor" || next.scope !== "monitor" || this.lastBatch?.ids.has(id)) return false;
    // Changes to ordering, bucket membership, latest timestamps or estimate
    // flags need a new baseline. Counter substitutions affect only sums.
    const identity = ["createdAt", "startedAt", "completedAt", "backend", "threadId", "parentThreadId", "usageTurnId",
      "sourceItemId", "model", "modelLabel", "currency", "provider", "priceStatus", "pricingCatalogId"] as const;
    if (identity.some((key) => old[key] !== next[key])) return false;
    const position = this.positions.get(id)!;
    this.corrections ??= new PricingMonitorCorrections();
    this.corrections.replace(position, old, next, resolveUsageLineModel(next, this.groups.cards.get(next.sourceItemId ?? "")));
    toggleLineHash(this.correctedHash, old);
    toggleLineHash(this.correctedHash, next);
    this.groups.update(old, false);
    this.groups.update(next, true);
    this.rows[position] = next;
    this.source.set(id, next);
    return true;
  }

  /** Reprice a recent in-flight batch from its preceding counters. Earlier
   * corrections can reorder every subsequent gap and require a fresh fold. */
  rewindChanged(dirty: Set<string>): boolean {
    const known = [...dirty].filter((id) => this.source.has(id));
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
        models: this.models.checkpoint(),
        summaries: new Map(this.summaries),
        gaps: this.gaps.accountedMainTokens,
        gapSummaries: new Map(this.gapSummaries),
        fallback: this.fallback,
        hash: Buffer.from(this.hash),
        lastSource: this.lastSource,
      };
      const oldTurns = new Map(lines.flatMap((line) => line.turnId ? [[line.turnId, this.newestByTurn.get(line.turnId)] as const] : []));
      this.lastBatch = { ids: new Set(lines.map((line) => line.usageLineId)), rewind: () => {
        for (let i = this.rows.length - 1; i >= size; i--) {
          const row = this.rows[i]!;
          this.groups.update(row, false);
          this.positions.delete(row.usageLineId);
        }
        this.rows.length = size;
        this.lineTotals.length = size;
        this.running = before.running;
        before.models();
        this.summaries = before.summaries;
        this.gaps.accountedMainTokens = before.gaps;
        this.gapSummaries = before.gapSummaries;
        this.fallback = before.fallback;
        this.hash = before.hash;
        this.lastSource = before.lastSource;
        for (const line of lines) {
          this.source.delete(line.usageLineId);
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
    if (lines.length > 16) this.models.finishBatch();
    const incoming = [...lines].sort(compareUsageLinesAscending);
    const display: PricingUsageLine[] = [];
    for (const line of incoming) {
      if (line.usageLineId.startsWith("estimated-gap:") || this.source.has(line.usageLineId)
        || (this.lastSource && compareUsageLinesAscending(this.lastSource, line) >= 0)) return false;
      toggleLineHash(this.hash, line);
      this.lastSource = line;
      this.source.set(line.usageLineId, line);
      if (line.usageTurnId) {
        const ids = this.usageTurns.get(line.usageTurnId) ?? new Set<string>();
        ids.add(line.usageLineId);
        this.usageTurns.set(line.usageTurnId, ids);
      }
      const key = usageLineSummaryKey(line);
      const previous = this.summaries.get(key);
      this.summaries.set(key, {
        summary: addUsageLineToSummary(previous?.summary ?? emptyPricingSummary(line), line),
        newest: previous && compareLedgerRows(previous.newest, line) <= 0 ? previous.newest : line,
      });
      const gap = appendUsageGapLine(this.gaps, line);
      if (gap) display.push(gap);
      display.push(line);
    }
    display.sort(compareUsageLinesAscending);
    const last = this.rows.at(-1);
    if (last && display[0] && compareUsageLinesAscending(last, display[0]) >= 0) return false;
    for (const line of display) {
      this.positions.set(line.usageLineId, this.rows.length);
      this.groups.update(line, true);
      this.rows.push(line);
      this.lineTotals.push(this.running.add(line));
      this.models.add(line, resolveUsageLineModel(line, line.scope === "monitor" && line.sourceItemId ? this.groups.cards.get(line.sourceItemId) : undefined), true);
      if (line.scope !== "monitor" && line.turnId) this.newestByTurn.set(line.turnId, line.usageLineId);
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
    merged?: boolean; deferGates?: boolean; gateSelection?: PricingGateSelection;
    markers: (lineIds: string[], pendingTurns: string[]) => ThreadCompactionRecord[];
  }): PricingHistoryPage {
    const { lines, totalRows } = this.groups.page(params.offset, params.limit, params.gateSelection);
    // Live substitutions rebuild provider summaries from effective real rows.
    const base = params.merged ? [...this.summaries.values()]
      .sort((a, b) => a.summary.provider.localeCompare(b.summary.provider) || a.summary.currency.localeCompare(b.summary.currency)
        || compareLedgerRows(a.newest, b.newest))
      .map(({ summary: { hasAssumedPricing: _assumed, ...summary } }) => this.corrections?.adjust(summary) ?? summary) : params.summaries;
    const summaries = new Map(base.map((row) => [summaryKey(row), row]));
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
      : base;
    const summary = aggregateSummaries(withGaps) ?? (this.fallback && this.corrections?.adjust(this.fallback, undefined, true)) ?? this.fallback;
    // Only the newest displayed row for a turn can claim its pending marker,
    // including when an older row for that turn is the first row on a later page.
    const pendingTurns = lines.flatMap((line) => line.turnId && this.newestByTurn.get(line.turnId) === line.usageLineId ? [line.turnId] : []);
    const groups: NonNullable<PricingHistoryPage["groups"]> = new Map();
    const included = new Map(lines.map((line) => [line.usageLineId, line]));
    for (const line of lines) {
      const group = !params.gateSelection && this.groups.group(line);
      if (!group) continue;
      const gates = params.deferGates ? [] : group.all.page();
      for (const gate of gates) included.set(gate.usageLineId, gate);
      const orphan = this.groups.isOrphan(line);
      groups.set(line.usageLineId, {
        gates, orphan, summary: group.summary(),
        parentTurnId: orphan ? this.groups.cards.get(line.sourceItemId!)?.parentTurnId : line.turnId,
      });
    }
    const cards = new Map<string, ThreadSubAgentSummary>();
    const lineTotals = new Map<string, ReturnType<PricingRunningTotals["add"]>>();
    for (const line of included.values()) {
      const position = this.positions.get(line.usageLineId)!;
      const baseTotals = this.lineTotals[position]!;
      lineTotals.set(line.usageLineId, this.corrections?.running(line.usageLineId, position, baseTotals) ?? baseTotals);
      const card = line.sourceItemId && this.groups.cards.get(line.sourceItemId);
      if (card) cards.set(card.monitorId, card);
    }
    const hash = Buffer.from(this.hash);
    for (let i = 0; i < hash.length; i++) hash[i] = hash[i]! ^ this.correctedHash[i]!;
    const totals = this.running.summary();
    totals.totalCreditMicros += this.corrections?.totalCreditDelta ?? 0;
    return structuredClone({
      revision: createHash("sha256").update(hash).update(params.markerRevision).update(JSON.stringify(base)).digest("base64url"),
      totalRows, groups, cards: [...cards.values()],
      lines,
      summary,
      compactions: params.markers(lines.map((line) => line.usageLineId), pendingTurns),
      totals, spendByModel: this.models.groups(this.corrections && ((key, summary) => this.corrections!.adjust(summary, key))),
      lineTotals,
    });
  }
}

/** Live merging folds raw lines newest-created first, independently of startedAt. */
function compareLedgerRows(left: ThreadUsageLineRecord, right: ThreadUsageLineRecord): number {
  return right.createdAt - left.createdAt || right.usageLineId.localeCompare(left.usageLineId);
}

function toggleLineHash(hash: Buffer, line: ThreadUsageLineRecord): void {
  const digest = createHash("sha256").update(JSON.stringify(line)).digest();
  for (let i = 0; i < hash.length; i++) hash[i] = hash[i]! ^ digest[i]!;
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
