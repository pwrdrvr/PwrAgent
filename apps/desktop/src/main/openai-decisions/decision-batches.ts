import type { RegisteredDecisionProvider } from "@pwragent/shared/openai-decisions";

/**
 * Batches of `decisions_invoke` inputs, kept in owner memory so answers that
 * were already paid for outlive the call that asked for them: a cancelled
 * turn, an MCP client that timed out, or a background run whose caller
 * ended its turn. Nothing here is written to sqlite. Decision answers are
 * model output, which the state database does not hold, so the results last
 * until PwrAgent quits or the retention limits below evict them.
 */

/** One input's outcome. A failed item carries a stable code. */
export type DecisionBatchItem =
  | {
      index: number;
      ok: true;
      model?: string;
      requestId?: string;
      response?: Record<string, unknown>;
      answers?: unknown[];
      usage?: Record<string, unknown>;
    }
  | { index: number; ok: false; code: string; message: string };

/**
 * `queued` waits for another call on the same decision; `completed` ran
 * every item; `stopped` met a failure every later item would repeat;
 * `cancelled` was cancelled by its caller, its turn, or shutdown.
 */
export type DecisionBatchState = "queued" | "running" | "completed" | "stopped" | "cancelled";

export type DecisionBatchCaller = { backend: string; threadId: string };

export type DecisionBatchDetail = "compact" | "full";

export type DecisionBatchStatusFilter = "all" | "succeeded" | "failed" | "skipped";

export type DecisionBatchRecord = {
  batchId: string;
  caller: DecisionBatchCaller;
  decisionId: string;
  name: string;
  version: number;
  provider: RegisteredDecisionProvider;
  count: number;
  concurrency: number;
  background: boolean;
  state: DecisionBatchState;
  createdAt: number;
  /** When its lane let it run; a queued batch has none. */
  startedAt?: number;
  finishedAt?: number;
  stoppedBy?: { code: string; message: string };
  cancelReason?: string;
  results: Array<DecisionBatchItem | undefined>;
  succeeded: number;
  /** Finished items that did not succeed, skipped ones included. */
  failed: number;
  skipped: number;
  /** Cancels a background run. A blocking run follows its call's signal. */
  controller: AbortController;
  /** The batch's JSONL file in its thread's storage, while it is being written. */
  resultsFile?: string;
};

/** Retention. Running batches are never evicted. */
export const DECISION_BATCH_LIMITS = {
  /** Finished batches kept per calling thread. */
  finishedPerThread: 10,
  /** Finished batches kept across the owner. */
  finishedTotal: 40,
  /** How long a finished batch stays readable. */
  finishedTtlMs: 24 * 60 * 60 * 1000,
  /** Unfinished background batches one thread may hold. */
  backgroundPerThread: 4,
  /** Compact JSON returned in one result page, whatever its item count. */
  pageMaxBytes: 64 * 1024,
  /** Items in one decisions_batch_results page. */
  pageMaxItems: 500,
  pageDefaultItems: 100,
} as const;

/** Per-request timing windows, kept only in memory. */
export const DECISION_TIMING_LIMITS = {
  /** Latest successful requests kept per decision version. */
  samplesPerDecision: 200,
  /** Decision versions tracked; the least recently run is dropped first. */
  decisions: 256,
} as const;

export type DecisionItemTiming = {
  /** Successful requests in the window: the latest 200 since PwrAgent started. */
  samples: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
};

/**
 * How long one successful request takes, per decision version, from the
 * latest requests since PwrAgent started. A caller divides by concurrency
 * to estimate a batch. Queue waits are not counted; failures are not
 * sampled, since a timeout or refusal says nothing about a normal item.
 */
export class DecisionItemTimings {
  private readonly windows = new Map<string, { durations: number[]; next: number }>();

  record(decisionId: string, version: number, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const key = JSON.stringify([decisionId, version]);
    const window = this.windows.get(key) ?? { durations: [], next: 0 };
    // Re-inserted, so the map's order is least recently run first.
    this.windows.delete(key);
    this.windows.set(key, window);
    if (window.durations.length < DECISION_TIMING_LIMITS.samplesPerDecision) {
      window.durations.push(durationMs);
    } else {
      window.durations[window.next] = durationMs;
      window.next = (window.next + 1) % DECISION_TIMING_LIMITS.samplesPerDecision;
    }
    while (this.windows.size > DECISION_TIMING_LIMITS.decisions) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }

  summary(decisionId: string, version: number): DecisionItemTiming | undefined {
    const durations = this.windows.get(JSON.stringify([decisionId, version]))?.durations;
    if (!durations || durations.length === 0) return undefined;
    const sorted = [...durations].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const p50 = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return {
      samples: sorted.length,
      minMs: Math.round(sorted[0]!),
      maxMs: Math.round(sorted.at(-1)!),
      meanMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
      p50Ms: Math.round(p50),
    };
  }
}

export function isFinishedBatch(record: Pick<DecisionBatchRecord, "state">): boolean {
  return record.state === "completed" || record.state === "stopped" || record.state === "cancelled";
}

export class DecisionBatchRegistry {
  private readonly batches = new Map<string, DecisionBatchRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  add(record: DecisionBatchRecord): void {
    this.evict();
    this.batches.set(record.batchId, record);
  }

  /** The caller's own batch. Another thread's id reads as not found. */
  get(caller: DecisionBatchCaller, batchId: string): DecisionBatchRecord | undefined {
    this.evict();
    const record = this.batches.get(batchId);
    return record && sameCaller(record.caller, caller) ? record : undefined;
  }

  /** The caller's batches, newest first. */
  list(caller: DecisionBatchCaller): DecisionBatchRecord[] {
    this.evict();
    return [...this.batches.values()]
      .filter((record) => sameCaller(record.caller, caller))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  unfinishedBackground(caller: DecisionBatchCaller): number {
    return this.list(caller).filter((record) => record.background && !isFinishedBatch(record)).length;
  }

  unfinished(): DecisionBatchRecord[] {
    return [...this.batches.values()].filter((record) => !isFinishedBatch(record));
  }

  /** Called after each change of state, so limits apply to finished batches. */
  evict(): void {
    const now = this.now();
    const finished = [...this.batches.values()]
      .filter(isFinishedBatch)
      .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0));
    const perThread = new Map<string, number>();
    let kept = 0;
    for (const record of finished) {
      const key = JSON.stringify([record.caller.backend, record.caller.threadId]);
      const threadCount = perThread.get(key) ?? 0;
      const expired = now - (record.finishedAt ?? now) > DECISION_BATCH_LIMITS.finishedTtlMs;
      if (
        expired
        || threadCount >= DECISION_BATCH_LIMITS.finishedPerThread
        || kept >= DECISION_BATCH_LIMITS.finishedTotal
      ) {
        this.batches.delete(record.batchId);
        continue;
      }
      perThread.set(key, threadCount + 1);
      kept += 1;
    }
  }
}

function sameCaller(left: DecisionBatchCaller, right: DecisionBatchCaller): boolean {
  return left.backend === right.backend && left.threadId === right.threadId;
}

/** Records one finished item and keeps the counts in step. False when already recorded. */
export function recordBatchItem(record: DecisionBatchRecord, item: DecisionBatchItem): boolean {
  if (record.results[item.index] !== undefined) return false;
  record.results[item.index] = item;
  if (item.ok) {
    record.succeeded += 1;
  } else {
    record.failed += 1;
    if (item.code === "skipped") record.skipped += 1;
  }
  return true;
}

export function finishedItems(record: Pick<DecisionBatchRecord, "succeeded" | "failed">): number {
  return record.succeeded + record.failed;
}

/** The batch without its items: what a list, a card, or a wake-up shows. */
export function summarizeBatch(record: DecisionBatchRecord) {
  return {
    batchId: record.batchId,
    decisionId: record.decisionId,
    name: record.name,
    version: record.version,
    provider: record.provider,
    state: record.state,
    background: record.background,
    count: record.count,
    succeeded: record.succeeded,
    failed: record.failed,
    skipped: record.skipped,
    pending: record.count - finishedItems(record),
    ...(record.stoppedBy ? { stoppedBy: record.stoppedBy } : {}),
    ...(record.cancelReason ? { cancelReason: record.cancelReason } : {}),
    createdAt: record.createdAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.startedAt !== undefined && record.finishedAt !== undefined
      ? { elapsedMs: record.finishedAt - record.startedAt }
      : {}),
    usage: batchUsage(record.results),
    ...(record.resultsFile ? { resultsFile: record.resultsFile } : {}),
  };
}

/**
 * A page of finished items in input order, from index `from`, that match
 * `status`. A page stops at `limit` items or at the byte bound, whichever
 * comes first, but always holds at least one item. `nextFrom` is the index
 * to pass back for the rest; it is absent when nothing later matches yet.
 */
export function pageBatchResults(
  record: DecisionBatchRecord,
  params: {
    from: number;
    limit: number;
    status: DecisionBatchStatusFilter;
    detail: DecisionBatchDetail;
    maxBytes?: number;
  },
): { results: unknown[]; nextFrom?: number } {
  const maxBytes = params.maxBytes ?? DECISION_BATCH_LIMITS.pageMaxBytes;
  const results: unknown[] = [];
  let bytes = 0;
  for (let index = Math.max(0, params.from); index < record.count; index += 1) {
    const item = record.results[index];
    if (!item || !matchesStatus(item, params.status)) continue;
    const view = params.detail === "full" ? item : compactBatchItem(item);
    const size = Buffer.byteLength(JSON.stringify(view));
    if (results.length >= params.limit || (results.length > 0 && bytes + size > maxBytes)) {
      return { results, nextFrom: index };
    }
    results.push(view);
    bytes += size;
  }
  return { results };
}

function matchesStatus(item: DecisionBatchItem, status: DecisionBatchStatusFilter): boolean {
  switch (status) {
    case "all": return true;
    case "succeeded": return item.ok;
    case "failed": return !item.ok;
    case "skipped": return !item.ok && item.code === "skipped";
  }
}

/**
 * Answers and confidence only. An OpenAI item's answers come out of its
 * response body; per-item usage, request ids and probability tables stay
 * behind `detail: "full"`.
 */
export function compactBatchItem(item: DecisionBatchItem): Record<string, unknown> {
  if (!item.ok) return { index: item.index, ok: false, code: item.code, message: item.message };
  const answers = item.answers ?? (Array.isArray(item.response?.answers) ? item.response.answers : undefined);
  if (!answers) {
    // A body without the documented answers array: keep it rather than
    // return an item with nothing in it.
    return { index: item.index, ok: true, ...(item.response ? { response: item.response } : {}) };
  }
  return { index: item.index, ok: true, answers: answers.map(compactAnswer) };
}

function compactAnswer(answer: unknown): unknown {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return answer;
  const value = answer as Record<string, unknown>;
  const named = typeof value.name === "string" ? { name: value.name } : {};
  switch (value.type) {
    case "predicate":
      return { type: "predicate", ...named, probability: value.probability };
    case "choice":
      return { type: "choice", ...named, choice: value.choice, confidence: value.confidence };
    case "score":
      return { type: "score", ...named, score: value.score, confidence: value.confidence };
    case "refusal":
      return { type: "refusal", ...named };
    case "unavailable":
      return { type: "unavailable", ...named, reason: value.reason };
    default:
      return value;
  }
}

/** Token and price totals across a batch's OpenAI items. */
export function batchUsage(results: ReadonlyArray<DecisionBatchItem | undefined>) {
  const totals = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let costUsd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const result of results) {
    if (!result?.ok || !result.usage) continue;
    const usage = result.usage;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      if (typeof usage[key] === "number") totals[key] += usage[key] as number;
    }
    if (usage.priceStatus === "estimated" && typeof usage.estimatedCostUsd === "number") {
      priced += 1;
      costUsd += usage.estimatedCostUsd;
    } else {
      unpriced += 1;
    }
  }
  if (priced === 0 && unpriced === 0) {
    return { priceStatus: "unavailable", priceUnavailableReason: "the provider reports no token usage" };
  }
  return {
    ...totals,
    priceStatus: unpriced === 0 ? "estimated" : priced === 0 ? "unavailable" : "partial",
    estimatedCostUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    pricedItems: priced,
    unpricedItems: unpriced,
  };
}

/** The thread card's one-line label, which the live strip shows. */
export function batchCardTask(record: DecisionBatchRecord): string {
  const done = finishedItems(record);
  const failed = record.failed > 0 ? `, ${record.failed} failed` : "";
  return `Decision batch ${record.name}: ${done} of ${record.count} done${failed}`;
}

/** The thread card's detail line. */
export function batchCardMessage(record: DecisionBatchRecord): string {
  const state = record.state === "queued"
    ? "Waiting for another call on this decision."
    : record.state === "running"
      ? `${record.succeeded} answered, ${record.failed} failed, ${record.count - finishedItems(record)} to go.`
      : record.state === "completed"
        ? `Finished: ${record.succeeded} answered, ${record.failed} failed.`
        : record.state === "stopped"
          ? `Stopped by ${record.stoppedBy?.code ?? "an error"} after ${finishedItems(record) - record.skipped} items; ${record.skipped} skipped.`
          : `Cancelled after ${finishedItems(record) - record.skipped} items (${record.cancelReason ?? "cancelled"}); ${record.skipped} skipped.`;
  return `${state} Batch ${record.batchId}.`;
}

/**
 * The text of the turn that wakes a thread when its background batch ends.
 * It names the batch and how to read it; the answers stay in the batch.
 */
export function batchWakeupText(record: DecisionBatchRecord): string {
  const summary = summarizeBatch(record);
  const outcome = record.state === "completed"
    ? "finished"
    : record.state === "stopped"
      ? `stopped after ${record.stoppedBy?.code ?? "an error"}`
      : "was cancelled";
  const cost = "estimatedCostUsd" in summary.usage
    ? ` Estimated API cost $${summary.usage.estimatedCostUsd}.`
    : "";
  return [
    `PwrAgent: background decision batch ${record.batchId} (${record.name} v${record.version}) ${outcome}.`,
    `${record.succeeded} of ${record.count} items answered, ${record.failed} failed (${record.skipped} skipped).${cost}`,
    `Read the answers with decisions_batch_results { "batchId": "${record.batchId}" }.`,
    "Pass status \"failed\" to see only the failures, and from to read the next page.",
    ...(record.resultsFile ? [`Every item is also in ${record.resultsFile} (JSONL, one line per item).`] : []),
  ].join("\n");
}
