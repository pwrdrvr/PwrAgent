import type Database from "better-sqlite3";
import {
  appendUsageGapLine,
  compareUsageLinesAscending,
  createUsageGapProjection,
} from "@pwragent/shared/thread-pricing-projection";
import { isCodexPricingLine, priceLocalModelUsage } from "@pwragent/shared/local-model-pricing";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { watchThreadSpend } from "./sqlite-usage-ledger-change-version";

function usdCost(line: ThreadUsageLineRecord): number {
  return line.priceStatus === "priced" && line.currency.toUpperCase() === "USD" ? line.totalCostMicros : 0;
}

function spendLine(line: ThreadUsageLineRecord, localModels: ReadonlySet<string>): ThreadUsageLineRecord {
  return isCodexPricingLine(line) && line.model && localModels.has(line.model) ? priceLocalModelUsage(line) : line;
}

/**
 * Keep a chronological checkpoint and a few editable rows for usage redelivery
 * and turn-boundary repairs. An older correction invalidates the checkpoint.
 */
class ThreadSpendProjection {
  readonly tail = new Map<string, ThreadUsageLineRecord>();
  private boundary?: ThreadUsageLineRecord;
  private throughCreatedAt = -Infinity;
  // A later turn insert can supply the missing start and reorder one of these
  // rows. Ordinary owner turns already have their start when sealed.
  private readonly undatedTurns = new Set<string>();
  private readonly prefix = createUsageGapProjection();
  private prefixGap = 0;
  private prefixSpend = 0;
  private prefixHasLocal = false;

  mightHaveSealedLine(id: string, createdAt: number | null): boolean {
    return !this.tail.has(id) && createdAt !== null && createdAt <= this.throughCreatedAt;
  }

  mightHaveSealedTurn(id: string, old: boolean, startedAt: number | null): boolean {
    return this.undatedTurns.has(id) || Boolean(old && startedAt !== null && this.boundary
      && startedAt <= (this.boundary.startedAt ?? this.boundary.createdAt));
  }

  update(lines: ThreadUsageLineRecord[], removed: ReadonlySet<string>, localModels: ReadonlySet<string>): boolean {
    for (const id of removed) this.tail.delete(id);
    for (const line of lines) {
      if (line.scope !== "monitor" && this.boundary && compareUsageLinesAscending(line, this.boundary) <= 0) return false;
      this.tail.set(line.usageLineId, line);
    }
    const ordered = [...this.tail.values()].sort(compareUsageLinesAscending);
    for (let i = 0; i < ordered.length - 4; i++) {
      const source = ordered[i]!;
      const line = spendLine(source, localModels);
      this.prefixHasLocal ||= line !== source;
      this.prefixSpend += usdCost(line);
      if (line.scope !== "monitor") {
        const gap = appendUsageGapLine(this.prefix, line);
        if (gap) this.prefixGap += usdCost(gap);
        if (line.startedAt === undefined && line.usageTurnId) this.undatedTurns.add(line.usageTurnId);
        this.boundary = line;
      }
      this.throughCreatedAt = Math.max(this.throughCreatedAt, source.createdAt);
      this.tail.delete(line.usageLineId);
    }
    return true;
  }

  total(summary: number, hasLive: boolean, localModels: ReadonlySet<string>): number {
    const state = { ...this.prefix };
    let spend = this.prefixSpend;
    let gaps = this.prefixGap;
    let hasLocal = this.prefixHasLocal;
    for (const source of [...this.tail.values()].sort(compareUsageLinesAscending)) {
      const line = spendLine(source, localModels);
      const gap = appendUsageGapLine(state, line);
      if (gap) gaps += usdCost(gap);
      spend += usdCost(line);
      hasLocal ||= line !== source;
    }
    return gaps + (hasLocal || hasLive ? spend : summary);
  }
}

type SpendCheckpoint = {
  projection: ThreadSpendProjection;
  lastReadAt: number;
  dataVersion: number;
  modelKey: string;
  reset: boolean;
  dirtyLines: Set<string>;
  stop: () => void;
};

const checkpoints = new WeakMap<Database.Database, Map<string, SpendCheckpoint>>();

export function forgetThreadSpend(db: Database.Database, key: string): void {
  const entries = checkpoints.get(db);
  entries?.get(key)?.stop();
  entries?.delete(key);
}

export function projectedThreadSpend(params: {
  db: Database.Database;
  key: string;
  backend: string;
  threadId: string;
  localModelIds: readonly string[];
  liveLines: readonly ThreadUsageLineRecord[];
  retain: boolean;
  readSummaryMicros: () => number;
  readBaseline: () => ThreadUsageLineRecord[];
  readChanged: (ids: ReadonlySet<string>) => ThreadUsageLineRecord[];
}): number {
  const { db, key } = params;
  const modelKey = JSON.stringify(params.localModelIds);
  const localModels = new Set(params.localModelIds);
  const version = db.pragma("data_version", { simple: true }) as number;
  const entries = checkpoints.get(db) ?? new Map<string, SpendCheckpoint>();
  checkpoints.set(db, entries);
  const now = Date.now();
  // Keep concurrently active threads warm. Evicting the ninth publisher
  // solely by count makes a round-robin workload rebuild on every turn.
  for (const [staleKey, stale] of entries) {
    if (entries.size <= 8 || now - stale.lastReadAt < 10 * 60_000) break;
    forgetThreadSpend(db, staleKey);
  }
  let cached = params.retain ? entries.get(key) : undefined;
  if (!cached || cached.dataVersion !== version || cached.modelKey !== modelKey) {
    if (params.retain) forgetThreadSpend(db, key);
    const entry: SpendCheckpoint = {
      projection: new ThreadSpendProjection(), dataVersion: version, modelKey, lastReadAt: now,
      reset: true, dirtyLines: new Set(), stop: () => {},
    };
    if (params.retain) {
      entry.stop = watchThreadSpend(db, params.threadId, (backend, table, id, old, timestamp) => {
        if (entry.reset || backend !== params.backend) return;
        if (table === "thread_usage_lines") {
          if (old && !entry.dirtyLines.has(id) && entry.projection.mightHaveSealedLine(id, timestamp)) entry.reset = true;
          else entry.dirtyLines.add(id);
        } else if (entry.projection.mightHaveSealedTurn(id, old, timestamp)) {
          entry.reset = true;
        } else {
          for (const line of entry.projection.tail.values()) {
            if (line.usageTurnId === id) entry.dirtyLines.add(line.usageLineId);
          }
        }
        if (entry.dirtyLines.size > 256) entry.reset = true;
      });
    }
    cached = entry;
  }
  if (params.retain) {
    cached.lastReadAt = now;
    entries.delete(key);
    entries.set(key, cached);
  }
  try {
    if (!cached.reset && cached.dirtyLines.size) {
      cached.reset = !cached.projection.update(params.readChanged(cached.dirtyLines), cached.dirtyLines, localModels);
    }
    if (cached.reset) {
      cached.projection = new ThreadSpendProjection();
      cached.projection.update(params.readBaseline(), new Set(), localModels);
      cached.reset = false;
    }
    cached.dirtyLines.clear();
    let total = cached.projection.total(params.readSummaryMicros(), params.liveLines.length > 0, localModels);
    // Live gates and workers are monitor rows. Their effective price replaces
    // the corresponding stored charge and does not affect the gap fold.
    if (params.liveLines.length) {
      const live = new Map(params.liveLines.map((line) => [line.usageLineId, line]));
      for (const line of params.readChanged(new Set(live.keys()))) total -= usdCost(spendLine(line, localModels));
      for (const line of live.values()) total += usdCost(spendLine(line, localModels));
    }
    return total;
  } catch (error) {
    cached.reset = true;
    throw error;
  }
}
