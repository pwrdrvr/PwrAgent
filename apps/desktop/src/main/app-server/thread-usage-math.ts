import { type TokenMiserCachedReplayIndex } from "./token-miser-ledger-index";
import { readUuidV7Timestamp } from "@pwragent/shared";
import { type UsageLimitObservation } from "@pwragent/shared";
import {
  isUsageActivityEntry,
  usageActivityScope,
} from "./overlay-transcript-entries";
import {
  anchorTurnUsageEntries,
  estimateTokenUsageCost,
  formatTokenUsageUsd,
  resolveTokenUsagePriceUnavailableReason,
  type AgentEvent,
  type AppServerThreadActivityEntry,
  type AppServerThreadEntry,
  type AppServerThreadReplay,
  type AppServerBackendKind,
  type ThreadSubAgentSummary,
  type ThreadTokenMiserAccounting,
  type ThreadReadEvaluationPricing,
  type ThreadReadEvaluationTokenMiser,
  type ThreadPricingSummary,
  type ThreadUsageLineRecord,
  MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES,
  type TaskMonitorUsageSnapshot,
} from "@pwragent/shared";
import {
  estimateTokenCount,
  type TokenMiserObjectMetadata,
} from "../token-miser/token-miser-types";
import {
  type ClaudeTurnTimes,
  type LiveCodexNativeSubAgentUsage,
  type LiveThreadContextWindowObservation,
  type LiveThreadRequestUsage,
  type ObservedContextReplayCursor,
  type ObservedContextReplayTally,
  type ObservedContextWindowDrop,
  type PersistedCodexNativeUsageBackfill,
  type RequestComponentsCost,
  type TaskMonitorTokenUsageBreakdown,
  type TaskMonitorTokenUsageRecords,
  type TaskMonitorUsageTotals,
  type ThreadCompactionBoundary,
  type ThreadPricingLedger,
  type TokenMiserLedgerIndexes,
} from "./backend-registry-types";
import {
  readNotificationItemType,
} from "./backend-registry-notifications";
import {
  readNonEmptyString,
  readRecord,
} from "./backend-registry-notification-values";


// Below this per-request input size, the request is the new prompt/tool payload
// rather than a full context replay — do not count it. Mirrors the renderer's
// former MIN_CONTEXT_REPLAY_INPUT_TOKENS floor.
export const MIN_OBSERVED_CONTEXT_REPLAY_INPUT_TOKENS = 32_000;
// A replay counts as "hot" when at least this fraction of its input was cached.
export const OBSERVED_HOT_CACHE_FRACTION = 0.9;
// The item lifecycle event and deprecated thread notification are emitted next
// to each other. Keep their semantic boundary briefly so the notification can
// omit its optional item id without creating a second durable marker.
export const COMPACTION_NOTIFICATION_DEDUP_WINDOW_MS = 30_000;

export function buildThreadCompactionIdentity(params: {
  backend: AppServerBackendKind;
  cumulativeInputTokens?: number;
  itemId?: string;
  threadId: string;
  turnId?: string;
}): string {
  if (params.itemId) {
    return [params.backend, params.threadId, params.itemId].join(":");
  }
  return [
    params.backend,
    params.threadId,
    params.turnId ?? "unknown",
    `request-${params.cumulativeInputTokens ?? "unobserved"}`,
  ].join(":");
}

/**
 * Compaction is the hard stop for Token Miser replay savings: once Codex
 * replaces the prior window, a preserved payload is no longer in context and
 * must not keep accruing cached-replay credit.
 *
 * Codex's automatic window compaction surfaces as a `ContextCompaction` item
 * (`item/started` then `item/completed`). The dedicated `thread/compacted`
 * notification is the same boundary when the app-server emits it, often with
 * the same item id. Treat both as one event so a missing `thread/compacted`
 * cannot leave the replay window open across later windows.
 */
export function readThreadCompactionBoundary(
  event: AgentEvent,
): ThreadCompactionBoundary | undefined {
  const notification = event.notification;
  if (notification.method === "thread/compacted") {
    return {
      threadId: notification.params.threadId,
      ...(typeof notification.params.itemId === "string"
        ? { itemId: notification.params.itemId }
        : {}),
    };
  }
  // `item/started` and `item/completed` share one union member, so method
  // narrowing does not expose `params.item`. Read it the same way the rest of
  // this file does.
  const itemType = readNotificationItemType(notification);
  if (
    !itemType
    || itemType.replace(/[-_\s]/g, "").toLowerCase() !== "contextcompaction"
  ) {
    return undefined;
  }
  const params = readRecord(notification.params);
  const item = readRecord(params?.item);
  const threadId = readNonEmptyString(params?.threadId);
  const itemId = readNonEmptyString(item?.id);
  if (!threadId || !itemId) {
    return undefined;
  }
  const turnId = readNonEmptyString(params?.turnId);
  return {
    itemId,
    threadId,
    ...(turnId ? { turnId } : {}),
  };
}

/**
 * Detect the safety-net compaction signal: a genuinely new cold model request
 * whose working context is smaller than the preceding request's context.
 *
 * The cumulative input high-water mark rejects duplicate and stale usage
 * emissions. A smaller hot request is an ordinary replay whose fresh tail got
 * shorter, so it is not enough to infer compaction. Requiring the smaller
 * request to miss the cache gives the fallback independent evidence that the
 * prior replay window was replaced.
 */
export function detectObservedContextWindowDrop(params: {
  cursor: ObservedContextReplayCursor | undefined;
  tokenUsage: unknown;
}): ObservedContextWindowDrop | undefined {
  const cursor = params.cursor;
  const previousContextTokens = cursor?.lastContextTokens;
  if (
    !cursor
    || typeof previousContextTokens !== "number"
    || previousContextTokens <= 0
  ) {
    return undefined;
  }
  const records = readTaskMonitorTokenUsageRecords(params.tokenUsage);
  const cumulativeInputTokens = records?.totalUsage?.inputTokens;
  const latest = records?.latestUsage;
  const latestInputTokens = latest?.inputTokens;
  const cachedInputTokens = latest?.cachedInputTokens;
  const currentContextTokens = latest?.totalTokens
    ?? (typeof latestInputTokens === "number"
      ? latestInputTokens + (latest?.outputTokens ?? 0)
      : undefined);
  if (
    typeof cumulativeInputTokens !== "number"
    || cumulativeInputTokens <= cursor.cumulativeInputTokens
    || typeof latestInputTokens !== "number"
    || latestInputTokens <= 0
    || typeof cachedInputTokens !== "number"
    || cachedInputTokens >= OBSERVED_HOT_CACHE_FRACTION * latestInputTokens
    || typeof currentContextTokens !== "number"
    || currentContextTokens < 0
    || currentContextTokens >= previousContextTokens
  ) {
    return undefined;
  }
  return {
    cumulativeInputTokens,
    currentContextTokens,
    previousCumulativeInputTokens: cursor.cumulativeInputTokens,
    previousContextTokens,
  };
}

// Pure core of the context-replay accumulator: fold one token-usage update into
// a running per-turn tally, given the per-thread cursor. A replay is counted
// only when the cumulative input grows past the cursor, the growing request
// meets the replay-size floor, and it is classified hot/cold by its own cache
// split. Cold token attribution is the replayed portion minus the cache-served
// slice (see ObservedContextReplayCursor.lastContextTokens); hot attribution is
// the cached tokens themselves, which are previously-seen content by
// definition. Returns fresh objects whenever state advances; inputs are never
// mutated.
export function foldObservedContextReplay(params: {
  cursor: ObservedContextReplayCursor | undefined;
  tally: ObservedContextReplayTally | undefined;
  tokenUsage: unknown;
}): {
  cursor: ObservedContextReplayCursor | undefined;
  tally: ObservedContextReplayTally | undefined;
} {
  const records = readTaskMonitorTokenUsageRecords(params.tokenUsage);
  const total = records?.totalUsage;
  const last = records?.latestUsage;
  if (
    !total ||
    typeof total.inputTokens !== "number" ||
    !last ||
    typeof last.inputTokens !== "number"
  ) {
    return { cursor: params.cursor, tally: params.tally };
  }

  const lastInput = last.inputTokens;
  const lastOutput =
    typeof last.outputTokens === "number" ? Math.max(0, last.outputTokens) : 0;
  const cumulativeInputTokens =
    params.cursor?.cumulativeInputTokens ??
    Math.max(0, total.inputTokens - lastInput);
  if (total.inputTokens <= cumulativeInputTokens) {
    // Duplicate re-emission or no new request — cumulative input did not grow.
    // On an exact match this is the same already-folded request; refresh the
    // context snapshot in case this re-emission books output the first
    // emission had not seen yet (input-first emission cadence). A stale
    // re-emission of an older request (total below the cursor) is left alone.
    if (params.cursor && total.inputTokens === cumulativeInputTokens) {
      const refreshedContextTokens = Math.max(
        params.cursor.lastContextTokens ?? 0,
        lastInput + lastOutput,
      );
      return {
        cursor: {
          cumulativeInputTokens,
          ...(refreshedContextTokens > 0
            ? { lastContextTokens: refreshedContextTokens }
            : {}),
        },
        tally: params.tally,
      };
    }
    return {
      cursor: params.cursor ?? { cumulativeInputTokens },
      tally: params.tally,
    };
  }
  const nextCursor: ObservedContextReplayCursor = {
    cumulativeInputTokens: total.inputTokens,
    lastContextTokens: lastInput + lastOutput,
  };
  // The replayed portion of this request: everything up to the prior context
  // size existed before and was resubmitted; the remainder is fresh prompt/tool
  // content sent WITH the request (large file reads, command output). Fresh
  // content is excluded from all replay logic — it is paid for regardless of
  // caching. With no prior snapshot (first observed request after app start),
  // treat the whole input as replayed.
  const priorContextTokens = params.cursor?.lastContextTokens;
  const replayedTokens =
    typeof priorContextTokens === "number" && priorContextTokens > 0
      ? Math.min(lastInput, priorContextTokens)
      : lastInput;
  if (replayedTokens < MIN_OBSERVED_CONTEXT_REPLAY_INPUT_TOKENS) {
    // The replayed context is too small to be a full context replay (the
    // request itself may still be large from fresh payload). Still advance the
    // cursor — the context grew, and the next request replays it.
    return { cursor: nextCursor, tally: params.tally };
  }

  const cached =
    typeof last.cachedInputTokens === "number"
      ? Math.min(Math.max(0, last.cachedInputTokens), lastInput)
      : 0;
  const uncached = Math.max(0, lastInput - cached);
  const tally: ObservedContextReplayTally = params.tally
    ? { ...params.tally }
    : {
        coldReplayCount: 0,
        coldReplayUncachedTokens: 0,
        hotReplayCachedTokens: 0,
        hotReplayCount: 0,
      };
  // Classify against the REPLAYED portion, not the whole input: a request
  // carrying a large fresh payload has a diluted cache fraction even when its
  // replayed context was fully cache-served — that is a hot replay plus fresh
  // content, not a cold replay.
  if (cached >= OBSERVED_HOT_CACHE_FRACTION * replayedTokens) {
    tally.hotReplayCount += 1;
    tally.hotReplayCachedTokens += cached;
  } else {
    // The uncached replay overhead is the replayed portion minus whatever the
    // cache DID serve — cached tokens are previously-seen content, so they sit
    // inside the replayed window even on a partial miss. (Always positive here:
    // the cold branch means cached < 0.9 × replayed. Also never exceeds
    // `uncached`, since replayed <= last.input.)
    tally.coldReplayCount += 1;
    tally.coldReplayUncachedTokens += Math.min(
      uncached,
      Math.max(0, replayedTokens - cached),
    );
  }
  return { cursor: nextCursor, tally };
}

export function buildTaskMonitorUsageSnapshot(params: {
  fastMode?: boolean;
  model?: string;
  providerCostUsd?: number;
  serviceTier?: string;
  tokenUsage: unknown;
}): TaskMonitorUsageSnapshot | undefined {
  const usage = buildTaskMonitorUsageTotals(params);
  if (!usage) {
    return undefined;
  }
  const { cost, tokenUsage } = usage;
  const summary = [
    `${formatTaskMonitorTokenCount(tokenUsage.uncachedInputTokens)} uncached in`,
    `${formatTaskMonitorTokenCount(tokenUsage.cachedInputTokens)} cached`,
    tokenUsage.reasoningOutputTokens > 0
      ? `${formatTaskMonitorTokenCount(tokenUsage.outputTokens)} out (${formatTaskMonitorTokenCount(
          tokenUsage.reasoningOutputTokens,
        )} reasoning)`
      : `${formatTaskMonitorTokenCount(tokenUsage.outputTokens)} out`,
    cost ? `${formatTokenUsageUsd(cost.totalUsd)} ${cost.pricingBasis === "provider-reported" ? "provider estimate" : "list price"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    ...(cost ? { cost } : {}),
    ...(usage.fastMode !== undefined ? { fastMode: usage.fastMode } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(usage.serviceTier ? { serviceTier: usage.serviceTier } : {}),
    summary,
    tokenUsage,
  };
}

/**
 * The numbers behind a usage snapshot, without its locale-formatted summary.
 * Totals that are only summed, such as Token Miser savings, use this so they
 * never format text they discard.
 */
export function buildTaskMonitorUsageTotals(params: {
  fastMode?: boolean;
  model?: string;
  providerCostUsd?: number;
  serviceTier?: string;
  tokenUsage: unknown;
}): TaskMonitorUsageTotals | undefined {
  const tokens = normalizeTaskMonitorTokenUsage(params.tokenUsage);
  if (!tokens) {
    return undefined;
  }

  const cachedInputTokens = Math.max(0, tokens.cachedInputTokens ?? 0);
  const inputTokens = Math.max(0, tokens.inputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cacheWriteInputTokens = Math.min(
    uncachedInputTokens,
    Math.max(0, tokens.cacheWriteInputTokens ?? 0),
  );
  const outputTokens = Math.max(0, tokens.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokens.reasoningOutputTokens ?? 0);
  const totalTokens = Math.max(
    0,
    tokens.totalTokens ?? inputTokens + outputTokens + reasoningOutputTokens,
  );
  const cost: TaskMonitorUsageSnapshot["cost"] =
    params.model && typeof params.providerCostUsd === "number"
      && Number.isFinite(params.providerCostUsd) && params.providerCostUsd >= 0
      ? { model: params.model, pricingBasis: "provider-reported", totalUsd: params.providerCostUsd }
      : estimateTaskMonitorUsageCost({
          cacheWriteInputTokens,
          cachedInputTokens,
          fastMode: params.fastMode,
          model: params.model,
          outputTokens,
          reasoningOutputTokens,
          serviceTier: params.serviceTier,
          uncachedInputTokens,
        });

  return {
    ...(cost ? { cost } : {}),
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    tokenUsage: {
      ...(tokens.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens }
        : {}),
      cachedInputTokens,
      inputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      uncachedInputTokens,
    },
  };
}

export function readFormattedTokenCount(
  value: string,
  pattern: RegExp,
): number | undefined {
  const match = value.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1].replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Final turn usage is persisted as transcript metadata even when PwrAgent did
 * not observe the native spawn event that would have created a parent card.
 * The activity summary is PwrAgent-owned, deterministic copy; reading it here
 * lets thread-list discovery repair both the card and its parent pricing row.
 */
export function buildPersistedCodexNativeUsageBackfill(params: {
  activities?: readonly AppServerThreadActivityEntry[];
  fastMode?: boolean;
  model?: string;
  serviceTier?: string;
}): PersistedCodexNativeUsageBackfill | undefined {
  const activities = (params.activities ?? []).filter(
    (activity) =>
      activity.status === "completed"
      && (
        activity.id.startsWith("live-turn-usage-")
        || activity.summary.startsWith("Turn usage:")
      ),
  );
  if (activities.length === 0) {
    return undefined;
  }

  const seenTurnIds = new Set<string>();
  let cachedInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let completedAt: number | undefined;
  let monitorTurnId: string | undefined;
  let observed = false;

  for (const activity of activities) {
    const turnId = activity.turn?.id;
    if (turnId && seenTurnIds.has(turnId)) {
      continue;
    }
    if (turnId) {
      seenTurnIds.add(turnId);
    }

    const line = activity.usageLine;
    const uncached = line?.uncachedInputTokens ?? readFormattedTokenCount(
      activity.summary,
      /([\d,]+)\s+uncached in/i,
    );
    const cached = line?.cachedInputTokens ?? readFormattedTokenCount(
      activity.summary,
      /([\d,]+)\s+cached/i,
    );
    const output = line?.outputTokens ?? readFormattedTokenCount(
      activity.summary,
      /([\d,]+)\s+out/i,
    );
    const reasoning = line?.reasoningOutputTokens ?? readFormattedTokenCount(
      activity.summary,
      /\(([\d,]+)\s+reasoning\)/i,
    ) ?? 0;
    if (uncached === undefined || cached === undefined || output === undefined) {
      continue;
    }

    observed = true;
    cachedInputTokens += cached;
    inputTokens += uncached + cached;
    outputTokens += output;
    reasoningOutputTokens += reasoning;
    const activityCompletedAt = activity.turn?.completedAt ?? activity.createdAt;
    if (
      typeof activityCompletedAt === "number"
      && (completedAt === undefined || activityCompletedAt >= completedAt)
    ) {
      completedAt = activityCompletedAt;
      monitorTurnId = turnId ?? monitorTurnId;
    }
  }

  if (!observed) {
    return undefined;
  }
  const usage = buildTaskMonitorUsageSnapshot({
    fastMode: params.fastMode,
    model: params.model,
    serviceTier: params.serviceTier,
    tokenUsage: {
      total: {
        cachedInputTokens,
        inputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens: inputTokens + outputTokens + reasoningOutputTokens,
      },
    },
  });
  return usage
    ? {
        usage,
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(monitorTurnId ? { monitorTurnId } : {}),
      }
    : undefined;
}

export function normalizeTaskMonitorTokenUsage(
  tokenUsage: unknown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const root = readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const container =
    readRecord(root.tokenUsage) ??
    readRecord(root.token_usage) ??
    readRecord(root.info) ??
    root;
  const current =
    readRecord(container.total) ??
    readRecord(container.total_token_usage) ??
    readRecord(container.last) ??
    readRecord(container.last_token_usage) ??
    container;
  const direct = readTaskMonitorTokenBreakdown(current);
  if (direct) {
    return direct;
  }

  for (const key of ["data", "payload", "info", "usage", "result"]) {
    const nested = normalizeTaskMonitorTokenUsage(root[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function readTaskMonitorTokenUsageRecords(
  tokenUsage: unknown,
): TaskMonitorTokenUsageRecords | undefined {
  const root = readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const container =
    readRecord(root.tokenUsage) ??
    readRecord(root.token_usage) ??
    readRecord(root.info) ??
    root;
  const latestUsage =
    readTaskMonitorTokenBreakdownFromUnknown(container.last) ??
    readTaskMonitorTokenBreakdownFromUnknown(container.last_token_usage);
  const totalUsage =
    readTaskMonitorTokenBreakdownFromUnknown(container.total) ??
    readTaskMonitorTokenBreakdownFromUnknown(container.total_token_usage);
  const currentUsage =
    latestUsage ?? totalUsage ?? readTaskMonitorTokenBreakdown(container);
  if (latestUsage || totalUsage || currentUsage) {
    return {
      ...(currentUsage ? { currentUsage } : {}),
      ...(latestUsage ? { latestUsage } : {}),
      ...(totalUsage ? { totalUsage } : {}),
    };
  }

  for (const key of ["data", "payload", "info", "usage", "result"]) {
    const nested = readTaskMonitorTokenUsageRecords(root[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function foldLiveThreadRequestUsage(params: {
  current: LiveThreadRequestUsage | undefined;
  tokenUsage: unknown;
}): LiveThreadRequestUsage | undefined {
  const records = readTaskMonitorTokenUsageRecords(params.tokenUsage);
  const latestUsage = records?.latestUsage;
  const cumulativeInputTokens = records?.totalUsage?.inputTokens;
  if (
    !latestUsage
    || typeof cumulativeInputTokens !== "number"
    || !Number.isFinite(cumulativeInputTokens)
  ) {
    return params.current;
  }

  const normalizedCumulativeInputTokens = Math.max(0, cumulativeInputTokens);
  if (
    params.current
    && normalizedCumulativeInputTokens < params.current.cumulativeInputTokens
  ) {
    return params.current;
  }
  if (
    params.current
    && normalizedCumulativeInputTokens === params.current.cumulativeInputTokens
  ) {
    const priorRequest = params.current.requests.at(-1);
    const latestTokens = normalizeTaskMonitorPricingTokens(latestUsage);
    // Codex recomputes context size using an empty last-request breakdown
    // while retaining cumulative billed usage. Rate-limit notifications can
    // repeat it. It is not a correction to the last measured model request.
    if (
      latestTokens.inputTokens === 0
      && latestTokens.cachedInputTokens === 0
      && latestTokens.cacheWriteInputTokens === 0
      && latestTokens.outputTokens === 0
      && latestTokens.reasoningOutputTokens === 0
    ) {
      return params.current;
    }
    if (taskMonitorTokenUsageEqual(priorRequest, latestUsage)) {
      return params.current;
    }
    return {
      cumulativeInputTokens: normalizedCumulativeInputTokens,
      requests: [
        ...params.current.requests.slice(0, -1),
        latestUsage,
      ],
    };
  }
  return {
    cumulativeInputTokens: normalizedCumulativeInputTokens,
    requests: [...(params.current?.requests ?? []), latestUsage],
  };
}

export function readTaskMonitorTokenBreakdownFromUnknown(
  value: unknown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const record = readRecord(value);
  return record ? readTaskMonitorTokenBreakdown(record) : undefined;
}

export function readTaskMonitorTokenBreakdown(
  record: Record<string, unknown>,
): TaskMonitorTokenUsageBreakdown | undefined {
  const explicitTotal = readTaskMonitorNumber(record, "totalTokens", "total_tokens");
  const inputTokens = readTaskMonitorNumber(record, "inputTokens", "input_tokens");
  const cacheWriteInputTokens = readTaskMonitorNumber(
    record,
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
    "cache_write_tokens",
  );
  const cachedInputTokens = readTaskMonitorNumber(
    record,
    "cachedInputTokens",
    "cached_input_tokens",
  );
  const outputTokens = readTaskMonitorNumber(record, "outputTokens", "output_tokens");
  const reasoningOutputTokens = readTaskMonitorNumber(
    record,
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  );
  const derivedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0);
  const totalTokens = explicitTotal ?? (derivedTotal > 0 ? derivedTotal : undefined);
  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cacheWriteInputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

export function subtractTaskMonitorTokenUsage(
  total: TaskMonitorTokenUsageBreakdown,
  baseline: TaskMonitorTokenUsageBreakdown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const result: TaskMonitorTokenUsageBreakdown = {};
  for (const key of [
    "cacheWriteInputTokens",
    "cachedInputTokens",
    "inputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const) {
    const totalValue = total[key];
    if (typeof totalValue === "number" && Number.isFinite(totalValue)) {
      const baselineValue = baseline[key] ?? 0;
      result[key] = Math.max(0, totalValue - baselineValue);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function addTaskMonitorTokenUsage(
  first: TaskMonitorTokenUsageBreakdown,
  second: TaskMonitorTokenUsageBreakdown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const result: TaskMonitorTokenUsageBreakdown = {};
  for (const key of [
    "cacheWriteInputTokens",
    "cachedInputTokens",
    "inputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const) {
    const firstValue = first[key];
    const secondValue = second[key];
    if (typeof firstValue === "number" || typeof secondValue === "number") {
      result[key] = (firstValue ?? 0) + (secondValue ?? 0);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function taskMonitorTokenUsageEqual(
  first: TaskMonitorTokenUsageBreakdown | undefined,
  second: TaskMonitorTokenUsageBreakdown | undefined,
): boolean {
  if (!first || !second) {
    return false;
  }
  return (
    first.cacheWriteInputTokens === second.cacheWriteInputTokens
    && first.cachedInputTokens === second.cachedInputTokens
    && first.inputTokens === second.inputTokens
    && first.uncachedInputTokens === second.uncachedInputTokens
    && first.outputTokens === second.outputTokens
    && first.reasoningOutputTokens === second.reasoningOutputTokens
    && first.totalTokens === second.totalTokens
  );
}

export function canSubtractTaskMonitorTokenUsage(
  total: TaskMonitorTokenUsageBreakdown,
  baseline: TaskMonitorTokenUsageBreakdown,
): boolean {
  let compared = false;
  for (const key of [
    "cacheWriteInputTokens",
    "cachedInputTokens",
    "inputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const) {
    const totalValue = total[key];
    const baselineValue = baseline[key];
    if (
      typeof totalValue !== "number"
      || !Number.isFinite(totalValue)
      || typeof baselineValue !== "number"
      || !Number.isFinite(baselineValue)
    ) {
      continue;
    }
    compared = true;
    if (totalValue < baselineValue) {
      return false;
    }
  }
  return compared;
}

export function normalizeTaskMonitorPricingTokens(
  tokens: TaskMonitorTokenUsageBreakdown,
): Required<TaskMonitorTokenUsageBreakdown> {
  const inputTokens = Math.max(0, tokens.inputTokens ?? 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, tokens.cachedInputTokens ?? 0),
  );
  const cacheWriteInputTokens = Math.min(
    Math.max(0, inputTokens - cachedInputTokens),
    Math.max(0, tokens.cacheWriteInputTokens ?? 0),
  );
  const uncachedInputTokens = Math.max(
    0,
    tokens.uncachedInputTokens ?? inputTokens - cachedInputTokens,
  );
  const outputTokens = Math.max(0, tokens.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokens.reasoningOutputTokens ?? 0);
  const totalTokens = Math.max(
    0,
    tokens.totalTokens ?? inputTokens + outputTokens + reasoningOutputTokens,
  );
  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    uncachedInputTokens,
  };
}

export function estimateRequestComponentsCost(params: {
  at?: number;
  fastMode?: boolean;
  model?: string;
  requests: readonly TaskMonitorTokenUsageBreakdown[];
  serviceTier?: string;
  turnTokenUsage: TaskMonitorTokenUsageBreakdown;
}): RequestComponentsCost | undefined {
  if (params.requests.length === 0) {
    return undefined;
  }
  const requestTotal = params.requests.reduce<TaskMonitorTokenUsageBreakdown>(
    (total, request) => addTaskMonitorTokenUsage(total, request) ?? total,
    {},
  );
  const normalizedRequestTotal = normalizeTaskMonitorPricingTokens(requestTotal);
  const normalizedTurnTotal = normalizeTaskMonitorPricingTokens(
    params.turnTokenUsage,
  );
  if (
    normalizedRequestTotal.cacheWriteInputTokens
      !== normalizedTurnTotal.cacheWriteInputTokens
    || normalizedRequestTotal.cachedInputTokens
      !== normalizedTurnTotal.cachedInputTokens
    || normalizedRequestTotal.inputTokens !== normalizedTurnTotal.inputTokens
    || normalizedRequestTotal.outputTokens !== normalizedTurnTotal.outputTokens
    || normalizedRequestTotal.reasoningOutputTokens
      !== normalizedTurnTotal.reasoningOutputTokens
  ) {
    return undefined;
  }

  const costs = params.requests.map((request) => {
    const tokens = normalizeTaskMonitorPricingTokens(request);
    return estimateTokenUsageCost({
      at: params.at,
      cacheWriteInputTokens: tokens.cacheWriteInputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      fastMode: params.fastMode,
      inputTokenScope: "request",
      model: params.model,
      outputTokens: tokens.outputTokens,
      reasoningOutputTokens: tokens.reasoningOutputTokens,
      serviceTier: params.serviceTier,
      uncachedInputTokens: tokens.uncachedInputTokens,
    });
  });
  if (costs.some((cost) => cost === undefined)) {
    return undefined;
  }
  const priced = costs.filter(
    (cost): cost is NonNullable<typeof cost> => cost !== undefined,
  );
  const first = priced[0]!;
  if (
    priced.some(
      (cost) =>
        cost.catalogId !== first.catalogId
        || cost.catalogVersion !== first.catalogVersion
        || cost.currency !== first.currency
        || cost.provider !== first.provider
        || cost.serviceTier !== first.serviceTier,
    )
  ) {
    return undefined;
  }
  const rateIds = new Set(priced.map((cost) => cost.rateId));
  return {
    cacheWriteInputCostMicros: priced.reduce(
      (total, cost) => total + cost.cacheWriteInputCostMicros,
      0,
    ),
    cachedInputCostMicros: priced.reduce(
      (total, cost) => total + cost.cachedInputCostMicros,
      0,
    ),
    catalogId: first.catalogId,
    catalogVersion: first.catalogVersion,
    currency: first.currency,
    outputCostMicros: priced.reduce(
      (total, cost) => total + cost.outputCostMicros,
      0,
    ),
    provider: first.provider,
    ...(rateIds.size === 1 ? { rateId: first.rateId } : {}),
    serviceTier: first.serviceTier,
    totalCostMicros: priced.reduce(
      (total, cost) => total + cost.totalCostMicros,
      0,
    ),
    uncachedInputCostMicros: priced.reduce(
      (total, cost) => total + cost.uncachedInputCostMicros,
      0,
    ),
  };
}

export function readTaskMonitorNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function estimateTaskMonitorUsageCost(params: {
  cacheWriteInputTokens?: number;
  cachedInputTokens: number;
  fastMode?: boolean;
  model?: string;
  outputTokens: number;
  reasoningOutputTokens?: number;
  serviceTier?: string;
  uncachedInputTokens: number;
}): { model: string; totalUsd: number } | undefined {
  const cost = estimateTokenUsageCost(params);
  return cost ? { model: cost.model, totalUsd: cost.totalUsd } : undefined;
}

export function formatTaskMonitorTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

export function collectThreadUsageLinesFromReplay(
  replay: AppServerThreadReplay,
): ThreadUsageLineRecord[] {
  const lines: ThreadUsageLineRecord[] = [];
  const seen = new Set<string>();
  for (const entry of replay.entries) {
    if (entry.type !== "activity" || !entry.usageLine) {
      continue;
    }
    if (seen.has(entry.usageLine.usageLineId)) {
      continue;
    }
    seen.add(entry.usageLine.usageLineId);
    lines.push(entry.usageLine);
  }
  return lines;
}

export function buildTaskMonitorUsageLine(params: {
  backend: AppServerBackendKind;
  accountKey?: string;
  fastMode?: boolean;
  model?: string;
  monitorId: string;
  monitorThreadId: string;
  monitorTurnId?: string;
  observedReplays?: ObservedContextReplayTally;
  parentThreadId: string;
  reasoningEffort?: string;
  serviceTier?: string;
  source: ThreadUsageLineRecord["source"];
  usage: Pick<TaskMonitorUsageSnapshot, "cost" | "model" | "tokenUsage">;
}): ThreadUsageLineRecord {
  const tokenUsage = params.usage.tokenUsage;
  const inputTokens = Math.max(0, tokenUsage.inputTokens ?? 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, tokenUsage.cachedInputTokens ?? 0),
  );
  const cacheWriteInputTokens = Math.min(
    Math.max(0, inputTokens - cachedInputTokens),
    Math.max(0, tokenUsage.cacheWriteInputTokens ?? 0),
  );
  const uncachedInputTokens = Math.max(
    0,
    tokenUsage.uncachedInputTokens ?? inputTokens - cachedInputTokens,
  );
  const outputTokens = Math.max(0, tokenUsage.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokenUsage.reasoningOutputTokens ?? 0);
  const totalTokens = Math.max(
    0,
    tokenUsage.totalTokens ?? inputTokens + outputTokens + reasoningOutputTokens,
  );
  const model = params.model ?? params.usage.model ?? params.usage.cost?.model;
  const reportedCost = params.usage.cost?.pricingBasis === "provider-reported"
    && Number.isFinite(params.usage.cost.totalUsd) && params.usage.cost.totalUsd >= 0
      ? params.usage.cost.totalUsd : undefined;
  const cost = reportedCost === undefined ? estimateTokenUsageCost({
    cacheWriteInputTokens,
    cachedInputTokens,
    fastMode: params.fastMode,
    model,
    outputTokens,
    reasoningOutputTokens,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  }) : undefined;
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost || reportedCost !== undefined
      ? undefined
      : resolveTokenUsagePriceUnavailableReason({
          cachedInputTokens,
          fastMode: params.fastMode,
          model,
          serviceTier: params.serviceTier,
          uncachedInputTokens,
        });

  return {
    backend: params.backend,
    cacheWriteInputCostMicros: cost?.cacheWriteInputCostMicros ?? 0,
    ...(params.accountKey ? { accountKey: params.accountKey } : {}),
    cacheWriteInputTokens,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens,
    createdAt: Date.now(),
    currency: cost?.currency ?? "USD",
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    inputTokens,
    ...(model ? { model } : {}),
    ...(params.observedReplays
      ? {
          observedColdReplayCount: params.observedReplays.coldReplayCount,
          observedColdReplayUncachedTokens:
            params.observedReplays.coldReplayUncachedTokens,
          observedHotReplayCachedTokens:
            params.observedReplays.hotReplayCachedTokens,
          observedHotReplayCount: params.observedReplays.hotReplayCount,
        }
      : {}),
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens,
    parentThreadId: params.parentThreadId,
    priceStatus: cost || reportedCost !== undefined ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: reportedCost !== undefined ? "anthropic" : cost?.provider ?? fallbackUsageProvider(params.backend),
    ...(reportedCost !== undefined ? { pricingBasis: "provider-reported" as const } : {}),
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    ...(params.reasoningEffort
      ? { reasoningEffort: params.reasoningEffort }
      : {}),
    reasoningOutputTokens,
    scope: "monitor",
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    settingsConfidence: model ? "fallback" : "unknown",
    settingsSource: "monitor",
    source: params.source,
    sourceItemId: params.monitorId,
    status: "finalized",
    threadId: params.monitorThreadId,
    totalCostMicros: reportedCost !== undefined ? Math.round(reportedCost * 1_000_000) : cost?.totalCostMicros ?? 0,
    totalTokens,
    ...(params.monitorTurnId ? { turnId: params.monitorTurnId } : {}),
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens,
    usageLineId: [
      params.backend,
      params.parentThreadId,
      params.monitorId,
      params.monitorThreadId,
      params.monitorTurnId ?? "no-turn",
      "monitor",
    ].join(":"),
  };
}

/**
 * Whether a persisted gate sub-agent needs rewriting. Only the fields the rail
 * renders and that are stable across processes take part; see the call site.
 */
export function tokenMiserSubAgentProjectionChanged(
  existing: ThreadSubAgentSummary,
  next: ThreadSubAgentSummary,
): boolean {
  return existing.parentTurnId !== next.parentTurnId
    || JSON.stringify(existing.tokenMiserAccounting)
      !== JSON.stringify(next.tokenMiserAccounting);
}

export function buildTokenMiserSubAgentAccounting(params: {
  entry: TokenMiserObjectMetadata;
  gateUsageLine?: ThreadUsageLineRecord;
  legacyCachedReplayCount?: number;
  parentUsageLine?: ThreadUsageLineRecord;
}): ThreadSubAgentSummary["tokenMiserAccounting"] {
  // Prefer the live parent line; fall back to the model stamped at creation.
  // The stamp is what lets a review-turn gate price at all — the reviewer has
  // no usage line — and what keeps a mid-turn gate priced before its parent
  // line lands.
  const originalModel = params.parentUsageLine?.model ?? params.entry.parentModel;
  const originalServiceTier =
    params.parentUsageLine?.serviceTier ?? params.entry.parentServiceTier;
  const policyPassThrough =
    params.entry.disposition === "passed_through"
    && !params.entry.helperUsage;
  const gateModel = params.gateUsageLine?.model
    ?? (policyPassThrough ? "policy" : undefined);
  if (
    !originalModel
    || !gateModel
    || (!policyPassThrough && params.gateUsageLine?.priceStatus !== "priced")
    || (!policyPassThrough && params.gateUsageLine?.currency !== "USD")
  ) {
    return undefined;
  }
  const pricingParams = {
    at: params.entry.createdAt,
    cachedInputTokens: 0,
    fastMode: params.parentUsageLine?.fastMode,
    model: originalModel,
    outputTokens: 0,
    serviceTier: originalServiceTier,
  };
  const baselineCost = estimateTokenUsageCost({
    ...pricingParams,
    uncachedInputTokens: params.entry.baselineParentTokens,
  });
  const revealedParentTokens =
    estimateTokenCount(params.entry.replacementCharacters)
    + estimateTokenCount(params.entry.retrievedCharacters);
  const revealedCost = estimateTokenUsageCost({
    ...pricingParams,
    uncachedInputTokens: revealedParentTokens,
  });
  const cachedReplayCount = params.entry.replayTrackingVersion === 2
    ? params.entry.cachedReplayCount ?? 0
    : params.legacyCachedReplayCount ?? 0;
  const cachedBaselineTokens = params.entry.replayTrackingVersion === 2
    ? params.entry.cachedBaselineTokens ?? 0
    : params.entry.baselineParentTokens * cachedReplayCount;
  const cachedRevealedTokens = params.entry.replayTrackingVersion === 2
    ? params.entry.cachedRevealedTokens ?? 0
    : revealedParentTokens * cachedReplayCount;
  const cachedBaselineCost = estimateTokenUsageCost({
    ...pricingParams,
    cachedInputTokens: cachedBaselineTokens,
    uncachedInputTokens: 0,
  });
  const cachedRevealedCost = estimateTokenUsageCost({
    ...pricingParams,
    cachedInputTokens: cachedRevealedTokens,
    uncachedInputTokens: 0,
  });
  if (
    !baselineCost
    || !revealedCost
    || !cachedBaselineCost
    || !cachedRevealedCost
  ) {
    return undefined;
  }
  const gateCostMicros = params.gateUsageLine?.totalCostMicros ?? 0;
  const savingsMicros =
    baselineCost.uncachedInputCostMicros
    + cachedBaselineCost.cachedInputCostMicros
    - gateCostMicros
    - revealedCost.uncachedInputCostMicros
    - cachedRevealedCost.cachedInputCostMicros;
  return {
    currency: "USD",
    decisionSource: policyPassThrough ? "policy" : "helper",
    ...(params.entry.disposition
      ? { disposition: params.entry.disposition }
      : {}),
    originalModel,
    ...(originalServiceTier ? { originalServiceTier } : {}),
    baselineParentTokens: params.entry.baselineParentTokens,
    baselineParentCostMicros: baselineCost.uncachedInputCostMicros,
    cachedReplayCount,
    cachedBaselineTokens,
    cachedBaselineCostMicros: cachedBaselineCost.cachedInputCostMicros,
    gateModel,
    gateTotalTokens: params.gateUsageLine?.totalTokens ?? 0,
    gateCostMicros,
    revealedParentTokens,
    revealedParentCostMicros: revealedCost.uncachedInputCostMicros,
    cachedRevealedTokens,
    cachedRevealedCostMicros: cachedRevealedCost.cachedInputCostMicros,
    savingsMicros,
  };
}

export function tokenMiserMonitorId(entry: TokenMiserObjectMetadata): string {
  return `system:token-miser:${entry.objectId}`;
}

/**
 * One gate's dollar accounting and the lines it was priced from. The rail
 * card and the thread savings total both call this, so they cannot drift.
 * `helperUsage` supplies the helper's reported usage, which prices a gate
 * whose usage line has not landed. It runs only then. The card passes its
 * display snapshot and the total passes bare numbers, which price
 * identically.
 */
export function resolveTokenMiserGateAccounting(params: {
  entry: TokenMiserObjectMetadata;
  helperUsage: () =>
    | Pick<TaskMonitorUsageSnapshot, "cost" | "model" | "tokenUsage">
    | undefined;
  indexes: TokenMiserLedgerIndexes;
}): {
  gateUsageLine?: ThreadUsageLineRecord;
  tokenMiserAccounting: ThreadSubAgentSummary["tokenMiserAccounting"];
} {
  const { entry, indexes } = params;
  const monitorId = tokenMiserMonitorId(entry);
  let gateUsageLine = indexes.pricing.gateUsageLine(monitorId);
  const usage = gateUsageLine ? undefined : params.helperUsage();
  if (!gateUsageLine && usage) {
    gateUsageLine = buildTaskMonitorUsageLine({
      backend: "codex",
      accountKey: entry.helperUsage?.accountKey,
      model: entry.helperUsage?.model,
      monitorId,
      monitorThreadId:
        entry.helperUsage?.helperThreadId ?? `token-miser:${entry.objectId}`,
      monitorTurnId: entry.helperUsage?.helperTurnId ?? entry.turnId,
      parentThreadId: entry.threadId,
      reasoningEffort: entry.helperUsage?.reasoningEffort,
      serviceTier: entry.helperUsage?.serviceTier,
      source: "monitor",
      usage,
    });
    gateUsageLine.createdAt = entry.createdAt;
  }
  const tokenMiserAccounting = buildTokenMiserSubAgentAccounting({
    entry,
    gateUsageLine,
    legacyCachedReplayCount: countLegacyTokenMiserCachedReplays({
      entry,
      replays: indexes.replays,
    }),
    parentUsageLine: indexes.pricing.parentUsageLine(
      entry.threadId,
      entry.turnId,
    ),
  });
  return {
    ...(gateUsageLine ? { gateUsageLine } : {}),
    tokenMiserAccounting,
  };
}

export function countLegacyTokenMiserCachedReplays(params: {
  entry: TokenMiserObjectMetadata;
  replays: TokenMiserCachedReplayIndex;
}): number {
  if (params.entry.replayTrackingVersion === 2) {
    return 0;
  }
  return params.replays.countAfterInvocation({
    toolUseId: params.entry.toolUseId,
    turnId: params.entry.turnId,
  });
}

export function withLegacyTokenMiserReplayAccounting(
  accounting: ThreadTokenMiserAccounting,
  replays: TokenMiserCachedReplayIndex,
): ThreadTokenMiserAccounting {
  if (!accounting.interceptions) {
    return accounting;
  }
  const interceptions = accounting.interceptions.map((entry) => {
    if (entry.replayTrackingVersion === 2) {
      return entry;
    }
    const cachedReplayCount = replays.countAfterInvocation({
      toolUseId: entry.toolUseId,
      turnId: entry.turnId,
    });
    const revealedTokens = entry.replacementTokens + entry.retrievedTokens;
    const cachedBaselineTokens = entry.baselineParentTokens * cachedReplayCount;
    const cachedRevealedTokens = revealedTokens * cachedReplayCount;
    return {
      ...entry,
      cachedReplayCount,
      cachedBaselineTokens,
      cachedRevealedTokens,
      estimatedCachedReplayTokensSaved:
        cachedBaselineTokens - cachedRevealedTokens,
    };
  });
  const cachedBaselineTokens = interceptions.reduce(
    (total, entry) => total + (entry.cachedBaselineTokens ?? 0),
    0,
  );
  const cachedRevealedTokens = interceptions.reduce(
    (total, entry) => total + (entry.cachedRevealedTokens ?? 0),
    0,
  );
  return {
    ...accounting,
    interceptions,
    cachedReplayCount: interceptions.reduce(
      (total, entry) => total + (entry.cachedReplayCount ?? 0),
      0,
    ),
    cachedBaselineTokens,
    cachedRevealedTokens,
    estimatedCachedReplayTokensSaved:
      cachedBaselineTokens - cachedRevealedTokens,
  };
}

export function toThreadReadEvaluationPricing(
  pricing: ThreadPricingLedger,
): ThreadReadEvaluationPricing {
  return {
    summaries: pricing.summaries.slice(
      0,
      MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES,
    ),
    summaryCount: pricing.summaries.length,
    usageLineCount: pricing.lines.length,
    compactionCount: pricing.compactions?.length ?? 0,
    truncated:
      pricing.summaries.length
      > MAX_THREAD_READ_EVALUATION_PRICING_SUMMARIES,
  };
}

export function toThreadReadEvaluationTokenMiser(
  accounting: ThreadTokenMiserAccounting,
): ThreadReadEvaluationTokenMiser {
  return {
    ...(accounting.savings
      ? {
          savings: {
            currency: accounting.savings.currency,
            pricedGateCount: accounting.savings.pricedGateCount,
            gateCount: accounting.savings.gateCount,
            ...(accounting.savings.passThroughCount !== undefined
              ? { passThroughCount: accounting.savings.passThroughCount }
              : {}),
            ...(accounting.savings.policyPassThroughCount !== undefined
              ? {
                  policyPassThroughCount:
                    accounting.savings.policyPassThroughCount,
                }
              : {}),
            ...(accounting.savings.helperPassThroughCount !== undefined
              ? {
                  helperPassThroughCount:
                    accounting.savings.helperPassThroughCount,
                }
              : {}),
            ...(accounting.savings.helperDecisionCount !== undefined
              ? { helperDecisionCount: accounting.savings.helperDecisionCount }
              : {}),
            withoutGateCostMicros: accounting.savings.withoutGateCostMicros,
            gateCostMicros: accounting.savings.gateCostMicros,
            revealedCostMicros: accounting.savings.revealedCostMicros,
            savingsMicros: accounting.savings.savingsMicros,
            directlyObservedReplayCount:
              accounting.savings.directlyObservedReplayCount,
            reconstructedReplayCount:
              accounting.savings.reconstructedReplayCount,
            ...(accounting.savings.gateModel
              ? { gateModel: accounting.savings.gateModel }
              : {}),
            ...(accounting.savings.parentModel
              ? { parentModel: accounting.savings.parentModel }
              : {}),
          },
        }
      : {}),
    interceptionCount: accounting.interceptionCount,
    ...(accounting.passThroughCount !== undefined
      ? { passThroughCount: accounting.passThroughCount }
      : {}),
    ...(accounting.policyPassThroughCount !== undefined
      ? { policyPassThroughCount: accounting.policyPassThroughCount }
      : {}),
    ...(accounting.helperPassThroughCount !== undefined
      ? { helperPassThroughCount: accounting.helperPassThroughCount }
      : {}),
    ...(accounting.helperDecisionCount !== undefined
      ? { helperDecisionCount: accounting.helperDecisionCount }
      : {}),
    originalCharacters: accounting.originalCharacters,
    baselineParentTokens: accounting.baselineParentTokens,
    replacementTokens: accounting.replacementTokens,
    retrievedTokens: accounting.retrievedTokens,
    estimatedParentTokensSaved: accounting.estimatedParentTokensSaved,
    ...(accounting.cachedReplayCount !== undefined
      ? { cachedReplayCount: accounting.cachedReplayCount }
      : {}),
    ...(accounting.cachedBaselineTokens !== undefined
      ? { cachedBaselineTokens: accounting.cachedBaselineTokens }
      : {}),
    ...(accounting.cachedRevealedTokens !== undefined
      ? { cachedRevealedTokens: accounting.cachedRevealedTokens }
      : {}),
    ...(accounting.estimatedCachedReplayTokensSaved !== undefined
      ? {
          estimatedCachedReplayTokensSaved:
            accounting.estimatedCachedReplayTokensSaved,
        }
      : {}),
    interceptionDetailCount: accounting.interceptions?.length ?? 0,
    ...(accounting.codeMode
      ? {
          codeMode: {
            callCount: accounting.codeMode.callCount,
            unclassifiedCellCount: accounting.codeMode.unclassifiedCellCount,
            commandCellCount: accounting.codeMode.commandCellCount,
            directCommandCellCount: accounting.codeMode.directCommandCellCount,
            dispatchClusterCount: accounting.codeMode.dispatchClusterCount,
            multiInvocationClusterCount:
              accounting.codeMode.multiInvocationClusterCount,
            largestDispatchCluster: accounting.codeMode.largestDispatchCluster,
            nestedCommandInvocationCount:
              accounting.codeMode.nestedCommandInvocationCount,
            patchCellCount: accounting.codeMode.patchCellCount,
            otherCellCount: accounting.codeMode.otherCellCount,
            pollingCellCount: accounting.codeMode.pollingCellCount,
            directCount: accounting.codeMode.directCount,
            summarizedCount: accounting.codeMode.summarizedCount,
            passThroughCount: accounting.codeMode.passThroughCount,
            retrievalCount: accounting.codeMode.retrievalCount,
            capturedNestedInvocationCount:
              accounting.codeMode.capturedNestedInvocationCount,
            observationCount: accounting.codeMode.observations.length,
          },
        }
      : {}),
  };
}

export function mergeThreadPricingLines(
  pricing: ThreadPricingLedger,
  extraLines: readonly ThreadUsageLineRecord[],
): ThreadPricingLedger {
  if (extraLines.length === 0) {
    return pricing;
  }
  const linesById = new Map(
    pricing.lines.map((line) => [line.usageLineId, line]),
  );
  for (const line of extraLines) {
    linesById.set(line.usageLineId, line);
  }
  const lines = [...linesById.values()].sort((left, right) =>
    right.createdAt - left.createdAt
    || right.usageLineId.localeCompare(left.usageLineId)
  );
  const summariesByKey = new Map<string, ThreadPricingSummary>();
  for (const line of lines) {
    const threadId = line.parentThreadId ?? line.threadId;
    const key = [line.backend, threadId, line.provider, line.currency].join(":");
    const summary = summariesByKey.get(key) ?? {
      backend: line.backend,
      cachedInputTokens: 0,
      currency: line.currency,
      inputTokens: 0,
      outputTokens: 0,
      pricedUsageLineCount: 0,
      provider: line.provider,
      reasoningOutputTokens: 0,
      threadId,
      totalCostMicros: 0,
      totalTokens: 0,
      uncachedInputTokens: 0,
      unpricedUsageLineCount: 0,
      updatedAt: 0,
      usageLineCount: 0,
    };
    summary.cachedInputTokens += line.cachedInputTokens;
    summary.inputTokens += line.inputTokens;
    summary.outputTokens += line.outputTokens;
    summary.pricedUsageLineCount += line.priceStatus === "priced" ? 1 : 0;
    summary.reasoningOutputTokens += line.reasoningOutputTokens;
    summary.totalCostMicros += line.totalCostMicros;
    summary.totalTokens += line.totalTokens;
    summary.uncachedInputTokens += line.uncachedInputTokens;
    summary.unpricedUsageLineCount += line.priceStatus === "priced" ? 0 : 1;
    summary.updatedAt = Math.max(
      summary.updatedAt,
      line.completedAt ?? line.createdAt,
    );
    summary.usageLineCount += 1;
    summariesByKey.set(key, summary);
  }
  return {
    // Spread the source ledger: rebuilding it field-by-field silently dropped
    // `compactions` for every thread with a live gate line, which is exactly
    // the thread that has compaction markers worth showing.
    ...pricing,
    lines,
    summaries: [...summariesByKey.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider)
      || left.currency.localeCompare(right.currency)
    ),
  };
}

export function findNestedUsageValue(value: unknown, keys: string[]): unknown {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  for (const child of Object.values(record)) {
    const nested = findNestedUsageValue(child, keys);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function readUsageString(value: unknown, keys: string[]): string | undefined {
  const nested = findNestedUsageValue(value, keys);
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

export function readUsageBoolean(value: unknown, keys: string[]): boolean | undefined {
  const nested = findNestedUsageValue(value, keys);
  return typeof nested === "boolean" ? nested : undefined;
}

export function readUsageNumber(value: unknown, keys: string[]): number | undefined {
  const nested = findNestedUsageValue(value, keys);
  return typeof nested === "number" && Number.isFinite(nested)
    ? nested
    : undefined;
}

export function readTaskMonitorUsageModel(params: {
  notificationModel?: unknown;
  tokenUsage: unknown;
}): string | undefined {
  return (
    (typeof params.notificationModel === "string" && params.notificationModel.trim()
      ? params.notificationModel.trim()
      : undefined) ??
    readUsageString(params.tokenUsage, ["model", "modelId", "model_id"])
  );
}

export function readTaskMonitorUsageServiceTier(tokenUsage: unknown): string | undefined {
  return readUsageString(tokenUsage, ["serviceTier", "service_tier"]);
}

export function readTaskMonitorUsageFastMode(tokenUsage: unknown): boolean | undefined {
  return readUsageBoolean(tokenUsage, ["fastMode", "fast_mode"]);
}

/**
 * Each turn's times in a Claude transcript, by turn id: its earliest
 * recorded start or entry, and its latest recorded end.
 */
export function claudeTurnTimes(replay: AppServerThreadReplay): Map<string, ClaudeTurnTimes> {
  const turns = new Map<string, ClaudeTurnTimes>();
  for (const entry of replay.entries) {
    const turnId = entry.turn?.id;
    if (!turnId) {
      continue;
    }
    const times = turns.get(turnId) ?? {};
    const startedAt = entry.turn?.startedAt ?? entry.createdAt;
    if (typeof startedAt === "number") {
      times.startedAt = Math.min(times.startedAt ?? startedAt, startedAt);
    }
    const completedAt = entry.turn?.completedAt;
    if (typeof completedAt === "number") {
      times.completedAt = Math.max(times.completedAt ?? completedAt, completedAt);
    }
    turns.set(turnId, times);
  }
  return turns;
}

export function resolveLiveThreadUsageTiming(params: {
  /** The thread's persisted usage activity for `turnId`, if any. */
  activity?: AppServerThreadActivityEntry;
  reportedStartedAt?: number;
  turnId?: string;
}): {
  completedAt?: number;
  createdAt?: number;
  startedAt?: number;
} {
  if (!params.turnId) {
    return {};
  }

  const activity = params.activity?.turn?.id === params.turnId
    ? params.activity
    : undefined;
  const turn = activity?.turn;
  // Only a UUIDv7 id carries its own start time. Other backends (Claude's ids
  // are UUIDv4) report the start on turn/started instead.
  const startedAt =
    turn?.startedAt
    ?? readUuidV7Timestamp(params.turnId)
    ?? params.reportedStartedAt;
  const completedAt = turn?.completedAt;
  const createdAt = completedAt ?? activity?.createdAt;
  return {
    ...(typeof completedAt === "number" ? { completedAt } : {}),
    ...(typeof createdAt === "number" ? { createdAt } : {}),
    ...(typeof startedAt === "number" ? { startedAt } : {}),
  };
}

export function buildLiveThreadUsageLine(params: {
  attributed?: boolean;
  backend: AppServerBackendKind;
  cumulativeTokenUsage?: TaskMonitorTokenUsageBreakdown;
  completedAt?: number;
  createdAt?: number;
  fastMode?: boolean;
  model?: string;
  contextWindow?: LiveThreadContextWindowObservation;
  observedReplays?: ObservedContextReplayTally;
  reasoningEffort?: string;
  requestTokenUsages?: readonly TaskMonitorTokenUsageBreakdown[];
  serviceTier?: string;
  startedAt?: number;
  threadId: string;
  tokenUsage: unknown;
  turnId?: string;
}): ThreadUsageLineRecord | undefined {
  const tokens = normalizeTaskMonitorTokenUsage(params.tokenUsage);
  if (!tokens) {
    return undefined;
  }

  const {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    uncachedInputTokens,
  } = normalizeTaskMonitorPricingTokens(tokens);
  const cumulativeTokens = params.cumulativeTokenUsage
    ? normalizeTaskMonitorPricingTokens(params.cumulativeTokenUsage)
    : undefined;
  const createdAt = params.createdAt ?? params.completedAt ?? Date.now();
  const requestComponentsCost = params.requestTokenUsages
    ? estimateRequestComponentsCost({
        at: createdAt,
        fastMode: params.fastMode,
        model: params.model,
        requests: params.requestTokenUsages,
        serviceTier: params.serviceTier,
        turnTokenUsage: tokens,
      })
    : undefined;
  // Without a request breakdown (a missed snapshot, or a re-emitted total after
  // the per-request fold was dropped), the provider's context window still
  // bounds every request, so a turn-wide sum can select a band whose ceiling
  // no request could have crossed.
  const requestInputTokenCeiling = params.contextWindow?.modelContextWindow;
  const cost = requestComponentsCost ?? estimateTokenUsageCost({
    at: createdAt,
    cacheWriteInputTokens,
    cachedInputTokens,
    fastMode: params.fastMode,
    model: params.model,
    outputTokens,
    reasoningOutputTokens,
    requestInputTokenCeiling,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  });
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost
      ? undefined
      : resolveTokenUsagePriceUnavailableReason({
          cachedInputTokens,
          fastMode: params.fastMode,
          model: params.model,
          requestInputTokenCeiling,
          serviceTier: params.serviceTier,
          uncachedInputTokens,
        });

  return {
    backend: params.backend,
    cacheWriteInputCostMicros: cost?.cacheWriteInputCostMicros ?? 0,
    cacheWriteInputTokens,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens,
    ...(typeof params.completedAt === "number" ? { completedAt: params.completedAt } : {}),
    createdAt,
    currency: cost?.currency ?? "USD",
    ...(cumulativeTokens
      ? {
          cumulativeCachedInputTokens: cumulativeTokens.cachedInputTokens,
          cumulativeCacheWriteInputTokens:
            cumulativeTokens.cacheWriteInputTokens,
          cumulativeInputTokens: cumulativeTokens.inputTokens,
          cumulativeOutputTokens: cumulativeTokens.outputTokens,
          cumulativeReasoningOutputTokens: cumulativeTokens.reasoningOutputTokens,
          cumulativeTotalTokens: cumulativeTokens.totalTokens,
          cumulativeUncachedInputTokens: cumulativeTokens.uncachedInputTokens,
        }
      : {}),
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    ...(params.contextWindow
      ? {
          finalContextTokens: params.contextWindow.finalContextTokens,
          modelContextWindow: params.contextWindow.modelContextWindow,
          peakContextTokens: params.contextWindow.peakContextTokens,
        }
      : {}),
    inputTokens,
    ...(params.model ? { model: params.model } : {}),
    ...(params.observedReplays
      ? {
          observedColdReplayCount: params.observedReplays.coldReplayCount,
          observedColdReplayUncachedTokens:
            params.observedReplays.coldReplayUncachedTokens,
          observedHotReplayCachedTokens:
            params.observedReplays.hotReplayCachedTokens,
          observedHotReplayCount: params.observedReplays.hotReplayCount,
        }
      : {}),
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: cost?.provider ?? fallbackUsageProvider(params.backend),
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(requestComponentsCost ? { pricingBasis: "request-components" as const } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    ...(params.reasoningEffort
      ? { reasoningEffort: params.reasoningEffort }
      : {}),
    reasoningOutputTokens,
    scope: "turn",
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    settingsConfidence: params.model ? "fallback" : "unknown",
    settingsSource: "thread-overlay",
    source: "live",
    sourceItemId: "thread-token-usage",
    ...(typeof params.startedAt === "number" ? { startedAt: params.startedAt } : {}),
    status: "pending",
    threadId: params.threadId,
    totalCostMicros: cost?.totalCostMicros ?? 0,
    totalTokens,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    ...(typeof params.attributed === "boolean"
      ? { turnUsageAttributed: params.attributed }
      : {}),
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens,
    usageLineId: [
      params.backend,
      params.threadId,
      params.turnId ?? "no-turn",
      "live-token-usage",
    ].join(":"),
  };
}

/** Backends other than Codex whose account limits Usage Activity charts. */
export const PROVIDER_LIMIT_BACKENDS: readonly AppServerBackendKind[] = ["claude", "acp:grok"];

/** Codex readings are the ones that carry no provider, or OpenAI's. */
export function isCodexLimitObservation(reading: UsageLimitObservation): boolean {
  return reading.provider === undefined || reading.provider === "openai";
}

export function fallbackUsageProvider(backend: AppServerBackendKind): string {
  return backend === "claude" ? "anthropic" : backend === "acp:qwen" ? "qwen" : backend === "acp:grok" ? "xai" : "openai";
}

/**
 * Build the zero-cost `scope: "fork-baseline"` line representing the context a
 * thread inherited at its fork point. Carries the inherited token counts (so the
 * renderer can show what was copied in and absorb it into accounted tokens,
 * suppressing the invented "Historical usage estimate" gap) but no cost and no
 * `cumulative*` fields — its cost was billed on the parent thread, not here.
 * Returns undefined when there are no inherited tokens to attribute.
 */
export function buildForkBaselineUsageLine(params: {
  backend: AppServerBackendKind;
  fastMode?: boolean;
  inheritedTokenUsage: TaskMonitorTokenUsageBreakdown;
  model?: string;
  serviceTier?: string;
  threadId: string;
  usageTiming: { completedAt?: number; createdAt?: number; startedAt?: number };
}): ThreadUsageLineRecord | undefined {
  const {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    uncachedInputTokens,
  } = normalizeTaskMonitorPricingTokens(params.inheritedTokenUsage);
  if (
    cachedInputTokens <= 0 &&
    uncachedInputTokens <= 0 &&
    outputTokens <= 0 &&
    reasoningOutputTokens <= 0
  ) {
    return undefined;
  }
  // Sort just before the first live turn so the Fork point card renders at the
  // base of the panel and its tokens are accounted before any turn's gap check.
  const anchorAt =
    params.usageTiming.startedAt ??
    params.usageTiming.createdAt ??
    params.usageTiming.completedAt ??
    Date.now();
  return {
    backend: params.backend,
    cacheWriteInputCostMicros: 0,
    cacheWriteInputTokens,
    cachedInputCostMicros: 0,
    cachedInputTokens,
    createdAt: Math.max(0, anchorAt - 1),
    currency: "USD",
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    inputTokens,
    ...(params.model ? { model: params.model } : {}),
    outputCostMicros: 0,
    outputTokens,
    // Known cost: $0 to this thread (billed on the parent). "priced" keeps it
    // out of the unpriced-rows warning.
    priceStatus: "priced",
    provider: "openai",
    reasoningOutputTokens,
    scope: "fork-baseline",
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    settingsConfidence: params.model ? "fallback" : "unknown",
    settingsSource: "thread-overlay",
    source: "backfill",
    sourceItemId: "fork-baseline",
    status: "finalized",
    threadId: params.threadId,
    totalCostMicros: 0,
    totalTokens,
    uncachedInputCostMicros: 0,
    uncachedInputTokens,
    usageLineId: [params.backend, params.threadId, "fork-baseline"].join(":"),
  };
}

/**
 * Weaves overlay-owned usage rows into one already-ordered transcript page.
 *
 * Placement is turn-anchored: a usage row is inserted after the last entry of
 * its own turn *within this page*, and is omitted when that turn is not on
 * this page at all. The transcript therefore drives which usage is sent, and
 * a page never carries usage for turns the reader has not loaded.
 *
 * Scoping is what makes this correct, not just cheap. The overlay retains up
 * to MAX_IMMUTABLE_USAGE_ACTIVITY_ENTRIES finalized rows spanning the whole
 * thread, so merging all of them into the newest page put weeks-old usage
 * under recent messages. Both backends page on turn boundaries — Codex asks
 * the app server for whole turns (thread/turns/list cursors), ACP cuts on
 * findTurnPageStartIndex whenever the page has turn ids — so exactly one page
 * owns any given turn. Where an older replay format forces entry-count paging
 * and splits a turn, prependTranscriptHistoryPage already drops entry ids it
 * has seen, so a row cannot render twice.
 *
 * Omission is sound only where the page's turn ids can prove the row belongs
 * elsewhere. A row with no turn id, and any row on a page that carries no turn
 * metadata at all, keeps the createdAt-then-append placement this merge
 * replaced: dropping those would hide them on every page rather than on one.
 *
 * One forward pass, O(page + usage). The previous per-activity filter and
 * insert rebuilt the whole page array for each of up to 100 rows: 217,000
 * element visits for a 500-entry page where 1,000 suffice.
 */
export function mergeTurnAnchoredUsageActivities(params: {
  replay: AppServerThreadReplay;
  activities?: AppServerThreadActivityEntry[];
}): AppServerThreadReplay {
  const usageActivities = params.activities?.filter((activity) => {
    const scope = usageActivityScope(activity);
    return scope === "turn" || scope === "monitor";
  });
  if (!usageActivities?.length) {
    return params.replay;
  }

  const lastEntryIndexByTurnId = new Map<string, number>();
  for (let index = 0; index < params.replay.entries.length; index += 1) {
    const turnId = params.replay.entries[index]?.turn?.id;
    if (turnId) {
      lastEntryIndexByTurnId.set(turnId, index);
    }
  }

  const anchoredUsageByIndex = new Map<number, AppServerThreadActivityEntry[]>();
  const anchoredUsageIds = new Set<string>();
  const supersededTurnIds = new Set<string>();
  const unanchoredUsage: AppServerThreadActivityEntry[] = [];
  for (const activity of usageActivities) {
    const turnId = activity.turn?.id;
    const anchorIndex = turnId === undefined
      ? undefined
      : lastEntryIndexByTurnId.get(turnId);
    if (anchorIndex === undefined) {
      if (turnId !== undefined && lastEntryIndexByTurnId.size > 0) {
        // The page names its turns and does not name this one, so another
        // page owns the row.
        continue;
      }
      // Nothing here can place the row by turn: it carries no turn id, or the
      // page carries none. Absence proves nothing, and omitting it would hide
      // the row on every page.
      unanchoredUsage.push(activity);
      anchoredUsageIds.add(activity.id);
      continue;
    }
    const anchored = anchoredUsageByIndex.get(anchorIndex);
    if (anchored) {
      anchored.push(activity);
    } else {
      anchoredUsageByIndex.set(anchorIndex, [activity]);
    }
    anchoredUsageIds.add(activity.id);
    // A finalized turn total supersedes the provider's narrower per-request
    // rows for the same turn. Monitor usage annotates a delegated child and
    // supersedes nothing.
    if (turnId && usageActivityScope(activity) === "turn") {
      supersededTurnIds.add(turnId);
    }
  }
  if (anchoredUsageByIndex.size === 0 && unanchoredUsage.length === 0) {
    return params.replay;
  }

  // The unanchored rows keep insertTranscriptEntry's remaining tiers, resolved
  // in this same forward pass: a row lands before the first entry newer than
  // it, and a row with no createdAt has nothing to compare against and goes
  // last. Sorting by createdAt preserves the sequential-insert order, since
  // ties resolve after the row already placed.
  const timedUnanchoredUsage = unanchoredUsage
    .filter((activity) => typeof activity.createdAt === "number")
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  const untimedUnanchoredUsage = unanchoredUsage.filter(
    (activity) => typeof activity.createdAt !== "number",
  );
  let unanchoredIndex = 0;

  const entries: AppServerThreadEntry[] = [];
  for (let index = 0; index < params.replay.entries.length; index += 1) {
    const entry = params.replay.entries[index]!;
    const entryCreatedAt = entry.createdAt;
    if (typeof entryCreatedAt === "number") {
      while (
        unanchoredIndex < timedUnanchoredUsage.length
        && entryCreatedAt > (timedUnanchoredUsage[unanchoredIndex]!.createdAt ?? 0)
      ) {
        entries.push(timedUnanchoredUsage[unanchoredIndex]!);
        unanchoredIndex += 1;
      }
    }
    const entryTurnId = entry.turn?.id;
    const supersededByTurnTotal =
      entryTurnId !== undefined
      && supersededTurnIds.has(entryTurnId)
      && isUsageActivityEntry(entry)
      && (
        usageActivityScope(entry) === "latest-request"
        || usageActivityScope(entry) === "total"
      );
    if (!anchoredUsageIds.has(entry.id) && !supersededByTurnTotal) {
      entries.push(entry);
    }
    const anchored = anchoredUsageByIndex.get(index);
    if (anchored) {
      entries.push(...anchored);
    }
  }
  for (; unanchoredIndex < timedUnanchoredUsage.length; unanchoredIndex += 1) {
    entries.push(timedUnanchoredUsage[unanchoredIndex]!);
  }
  entries.push(...untimedUnanchoredUsage);

  return {
    ...params.replay,
    entries,
  };
}

/**
 * Final ordering rule for a transcript page: each turn total follows the last
 * entry of its own turn. The merges above place rows by turn where they can,
 * but each runs once and a later merge can add rows to a turn. Running the
 * rule after the last merge makes the page's order independent of merge order.
 */
export function anchorReplayTurnUsage(
  replay: AppServerThreadReplay,
): AppServerThreadReplay {
  const entries = anchorTurnUsageEntries(replay.entries);
  return entries === replay.entries ? replay : { ...replay, entries };
}

/**
 * Adds one run's usage to a row's running total. Token counts sum exactly;
 * the list price is re-estimated at the latest run's model, which is the one
 * Helper model setting every run reads.
 */
export function addTaskMonitorUsageSnapshots(
  previous: TaskMonitorUsageSnapshot | undefined,
  run: TaskMonitorUsageSnapshot | undefined,
): TaskMonitorUsageSnapshot | undefined {
  if (!previous) return run;
  if (!run) return previous;
  const sum = (key: keyof TaskMonitorUsageSnapshot["tokenUsage"]) =>
    (previous.tokenUsage[key] ?? 0) + (run.tokenUsage[key] ?? 0);
  return buildTaskMonitorUsageSnapshot({
    model: run.model ?? previous.model,
    serviceTier: run.serviceTier ?? previous.serviceTier,
    tokenUsage: {
      cacheWriteInputTokens: sum("cacheWriteInputTokens"),
      cachedInputTokens: sum("cachedInputTokens"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      reasoningOutputTokens: sum("reasoningOutputTokens"),
      totalTokens: sum("totalTokens"),
    },
  }) ?? run;
}

export function withLiveCodexNativeSubAgentUsage(
  card: ThreadSubAgentSummary,
  live: LiveCodexNativeSubAgentUsage,
): ThreadSubAgentSummary {
  return {
    ...card,
    ...(!card.preferredModel && live.preferredModel
      ? { preferredModel: live.preferredModel }
      : {}),
    ...(!card.preferredReasoningEffort && live.preferredReasoningEffort
      ? { preferredReasoningEffort: live.preferredReasoningEffort }
      : {}),
    monitorUsage: live.monitorUsage,
    updatedAt: Math.max(card.updatedAt, live.updatedAt),
  };
}
