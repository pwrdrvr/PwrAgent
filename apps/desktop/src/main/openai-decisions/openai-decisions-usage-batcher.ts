import { randomUUID } from "node:crypto";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { OPENAI_DECISIONS_PROVIDER } from "@pwragent/shared/openai-decisions";

/**
 * One ledger row costs about 16 B-tree leaf pages (~66 KB of WAL): the
 * usage-line table and its ten indexes, the turn table and its three, and the
 * thread's pricing summary. A decision can run hundreds of times in one agent
 * loop, so per-request rows are not affordable.
 *
 * Requests are summed in memory instead, one group per thread, decision
 * version, account, model and price band, and every group is written in one
 * transaction: after `flushAfterMs` (60 s) from the first pending request,
 * once `flushAtCount` (50) requests are pending, or on an explicit flush at
 * owner shutdown. Idle costs nothing: no timer runs and nothing is written
 * while nothing is pending. A crash loses at most one window of spend display;
 * OpenAI's own usage records stay complete.
 *
 * Each request was priced on its own before it was added, so a sum never
 * crosses the long-context band, and the line's pricing basis keeps the store
 * from re-pricing the total.
 */

export const OPENAI_DECISIONS_USAGE_FLUSH_MS = 60_000;
export const OPENAI_DECISIONS_USAGE_FLUSH_COUNT = 50;

export type OpenAIDecisionsUsageGroup = { decisionId: string; version: number };

type PendingGroup = {
  group: OpenAIDecisionsUsageGroup;
  line: ThreadUsageLineRecord;
  requests: number;
};

const SUMMED_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "uncachedInputCostMicros",
  "cachedInputCostMicros",
  "cacheWriteInputCostMicros",
  "outputCostMicros",
  "totalCostMicros",
] as const satisfies ReadonlyArray<keyof ThreadUsageLineRecord>;

export class OpenAIDecisionsUsageBatcher {
  private pending = new Map<string, PendingGroup>();
  private pendingRequests = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    /** Writes every line in one transaction. */
    write: (lines: ThreadUsageLineRecord[]) => Promise<void>;
    flushAfterMs?: number;
    flushAtCount?: number;
    newBatchId?: () => string;
    onWriteError?: (error: unknown, lines: number, requests: number) => void;
  }) {}

  /** Adds one request's usage line. Nothing is written yet. */
  add(group: OpenAIDecisionsUsageGroup, line: ThreadUsageLineRecord): void {
    const key = JSON.stringify([
      line.backend,
      line.threadId,
      group.decisionId,
      group.version,
      line.accountKey ?? null,
      line.model ?? null,
      line.priceStatus,
      line.pricingRateId ?? null,
    ]);
    const existing = this.pending.get(key);
    if (existing) {
      const merged = { ...existing.line };
      for (const field of SUMMED_FIELDS) merged[field] = (merged[field] ?? 0) + (line[field] ?? 0);
      merged.createdAt = Math.min(merged.createdAt, line.createdAt);
      merged.completedAt = Math.max(merged.completedAt ?? merged.createdAt, line.completedAt ?? line.createdAt);
      existing.line = merged;
      existing.requests += 1;
    } else {
      this.pending.set(key, { group, line: { ...line }, requests: 1 });
    }
    this.pendingRequests += 1;
    if (this.pendingRequests >= (this.options.flushAtCount ?? OPENAI_DECISIONS_USAGE_FLUSH_COUNT)) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.options.flushAfterMs ?? OPENAI_DECISIONS_USAGE_FLUSH_MS);
      this.timer.unref?.();
    }
  }

  get pendingRequestCount(): number {
    return this.pendingRequests;
  }

  /** Writes everything pending in one transaction. Resolves after the write. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) return this.writing;
    const groups = [...this.pending.values()];
    const requests = this.pendingRequests;
    this.pending = new Map();
    this.pendingRequests = 0;
    const batchId = (this.options.newBatchId ?? randomUUID)();
    const lines = groups.map(({ group, line }, index) => ({
      ...line,
      usageLineId: `${OPENAI_DECISIONS_PROVIDER}:${batchId}:${index}`,
      sourceItemId: `${group.decisionId}:${group.version}:batch:${batchId}`,
    }));
    this.writing = this.writing.then(async () => {
      try {
        await this.options.write(lines);
      } catch (error) {
        this.options.onWriteError?.(error, lines.length, requests);
      }
    });
    return this.writing;
  }
}
