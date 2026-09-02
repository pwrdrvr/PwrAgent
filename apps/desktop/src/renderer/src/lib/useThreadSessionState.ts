import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerNotification,
  AppServerBackendKind,
  AppServerMcpElicitationRequestNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerToolRequestUserInputNotification,
  AppServerThreadCommandDetail,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadMessageOrigin,
  AppServerThreadMessagePart,
  AppServerThreadReviewEntry,
  AppServerTransientThreadMessageEntry,
  AppServerThreadTurnMetadata,
  AppServerThreadImagePart,
  MessagingChannelKind,
  MessagingConversationKind,
  NavigationThreadSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { isAppServerBackendKind, isCelestialIconId } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";
import {
  agentEventThreadIdentityKey,
  threadSummaryIdentityKey,
} from "./federated-thread-events";
import {
  createQuestionnaireState,
  type PendingQuestionnaireState,
} from "../features/thread-detail/questionnaire";
import {
  normalizeReviewDisplayText,
  normalizeReviewOutputRecord,
} from "../../../shared/review-command";
import {
  createMcpElicitationState,
  type PendingMcpInteractionState,
} from "../features/thread-detail/mcp-elicitation";
import {
  appendCommandOutputDelta,
  buildFileChangeOutputEntry,
  buildLiveActivityEntry,
  buildLiveToolDetails,
  buildMcpProgressDetail,
  buildTaskMonitorUsageActivityEntry,
  buildTokenUsageActivityEntry,
  buildTurnUsageActivityEntryFromLine,
  formatChangedFileSummary,
  getNotificationItem,
  mergeActivityDetails,
  parseFileChangeOutput,
  readRendererSequence,
  summarizeActivityStatus,
  summarizeLiveActivity,
  withRendererSequence,
} from "../features/thread-detail/live-transcript-activity";
import { THREAD_HISTORY_PAGE_LIMIT } from "./thread-history-limits";
import {
  combineTranscriptEntries,
  combineTranscriptMessages,
  combineTranscriptResponse,
  createTranscriptHistoryIndex,
  createTranscriptReviewPresentation,
  prependTranscriptHistoryPage,
  type LoadedTranscriptHistory,
  type TranscriptHistoryIndex,
} from "./segmented-transcript";
import { normalizeTranscriptText } from "./transcript-review-presentation";

const MAX_VIEW_ONLY_THREADS = 10;
const EMPTY_EXPANDED_TRANSCRIPT_ACTIVITY_IDS: string[] = [];
const EMPTY_EXPANDED_TRANSCRIPT_WORK_PHASE_GROUP_IDS: string[] = [];
const OWN_UPDATE_IDLE_GRACE_MS = 1_500;
const SUPPORTED_APPROVAL_REQUEST_METHODS = new Set([
  "turn/requestApproval",
  "review/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export function getContextWindowMoonPhase(usedPercent: number): number {
  if (usedPercent < 10) {
    return 0;
  }
  if (usedPercent < 22.5) {
    return 1;
  }
  if (usedPercent < 35) {
    return 2;
  }
  if (usedPercent < 47.5) {
    return 3;
  }
  if (usedPercent < 60) {
    return 4;
  }
  if (usedPercent < 72.5) {
    return 5;
  }
  if (usedPercent < 85) {
    return 6;
  }
  if (usedPercent < 97.5) {
    return 7;
  }
  return 8;
}

export type ThreadViewportState = {
  distanceFromBottom: number;
  isGluedToBottom?: boolean;
  scrollTop: number;
};

export type ThreadContextWindowState = {
  cachedInputTokens?: number;
  cumulativeCachedInputTokens?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeReasoningOutputTokens?: number;
  cumulativeTotalTokens?: number;
  inputTokens?: number;
  modelContextWindow: number;
  outputTokens?: number;
  phase: number;
  reasoningOutputTokens?: number;
  remainingPercent?: number;
  remainingTokens?: number;
  totalTokens: number;
  usedPercent: number;
};

type TokenUsageBreakdown = {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

type TurnUsageAccumulator = {
  baseline?: TokenUsageBreakdown;
  latestUsage?: TokenUsageBreakdown;
  turnId: string;
  usage?: TokenUsageBreakdown;
};

type RecentlyCompletedTurnUsage = {
  accumulator?: TurnUsageAccumulator;
  turn: AppServerThreadTurnMetadata;
};

type ThreadSessionEntry = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  backendReportedActive?: boolean;
  completionHydrationRetries: number;
  contextWindow?: ThreadContextWindowState;
  error?: string;
  expectOwnUpdate: boolean;
  failedHydrationVersion?: string;
  hydratedEnvironmentSetupVersion?: string;
  hydratedInitialHistoryLimit?: number;
  hydratedUpdatedAt?: number;
  initialLoadDurationMs?: number;
  interacted: boolean;
  lastTouchedAt: number;
  loadedHistory?: LoadedTranscriptHistory;
  loading: boolean;
  loadingMore: boolean;
  needsHydrationAfterCompletion: boolean;
  nextLiveEntrySequence: number;
  // ThreadView's completed live aggregates live in a keyed ref store. State
  // keeps only its observable revision/count so one append stays O(1).
  retainedLiveEntryCount: number;
  retainedLiveEntryVersion: number;
  recentlyCompletedTurnUsage?: RecentlyCompletedTurnUsage;
  optimisticEntries: AppServerThreadEntry[];
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingUsageActivityEntry?: AppServerThreadActivityEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  settledTransientMessages: AppServerTransientThreadMessageEntry[];
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  transientMessage?: AppServerTransientThreadMessageEntry;
  pendingTurnUsage?: TurnUsageAccumulator;
  response?: AppServerReadThreadResponse;
  // Lightweight reading state belongs beside the bounded transcript cache.
  // ThreadView is allowed to unmount while thread navigation resolves.
  expandedTranscriptActivityIds?: string[];
  expandedTranscriptWorkPhaseGroupIds?: string[];
  renderedTranscriptEntryLimit?: number;
  staleThinkingRecheckAt?: number;
  thinkingSinceAt?: number;
  viewport?: ThreadViewportState;
};

type ThinkingStateReason = {
  entryId?: string;
  entryStatus?: string;
  entryType?: AppServerThreadEntry["type"];
  kind:
    | "activeTurn"
    | "backendActive"
    | "liveOptimisticEntry"
    | "pendingAssistantMessage"
    | "pendingMcpInteraction"
    | "pendingRequest"
    | "pendingStatus"
    | "transientMessage"
    | "pendingUserInput";
  turnId?: string;
  turnStatus?: string;
};

type ThreadSessionState = Record<string, ThreadSessionEntry>;

function createEmptyThreadSessionEntry(): ThreadSessionEntry {
  return {
    completionHydrationRetries: 0,
    expectOwnUpdate: false,
    interacted: false,
    lastTouchedAt: Date.now(),
    loading: false,
    loadingMore: false,
    needsHydrationAfterCompletion: false,
    nextLiveEntrySequence: 1,
    retainedLiveEntryCount: 0,
    retainedLiveEntryVersion: 0,
    optimisticEntries: [],
    settledTransientMessages: [],
  };
}

function mergeItems<T extends { id: string }>(olderItems: T[], newerItems: T[]): T[] {
  const deduped = new Map<string, T>();

  for (const item of [...olderItems, ...newerItems]) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()];
}

function transcriptMessagesForEntries(
  entries: AppServerThreadEntry[],
  ...messageSources: AppServerThreadMessage[][]
): AppServerThreadMessage[] {
  const messagesById = new Map(
    messageSources.flat().map((message) => [message.id, message] as const)
  );

  return entries.flatMap((entry) => {
    if (entry.type !== "message") {
      return [];
    }

    const message = messagesById.get(entry.id);
    return message
      ? [message]
      : [{
          id: entry.id,
          role: entry.role,
          text: entry.text,
          ...(entry.parts ? { parts: entry.parts } : {}),
          ...(entry.origin ? { origin: entry.origin } : {}),
          ...(entry.createdAt !== undefined
            ? { createdAt: entry.createdAt }
            : {}),
        }];
  });
}

function mergeFinalizedUsageEntry(
  olderItems: AppServerThreadEntry[],
  usageEntry: AppServerThreadActivityEntry,
  options: { replaceCompleted?: boolean } = {},
): AppServerThreadEntry[] {
  const existingEntry = olderItems.find((entry) => entry.id === usageEntry.id);
  if (
    !options.replaceCompleted &&
    existingEntry &&
    existingEntry.type === "activity" &&
    isTokenUsageActivityEntry(existingEntry) &&
    existingEntry.status === "completed"
  ) {
    return olderItems;
  }

  return mergeItems(olderItems, [usageEntry]);
}

function persistFinalizedUsageEntry(params: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  entry?: AppServerThreadActivityEntry;
  threadId: string;
}): void {
  if (
    !params.entry ||
    params.entry.status !== "completed" ||
    (tokenUsageActivityScope(params.entry) !== "turn" &&
      !isDurableMonitorUsageActivity(params.entry))
  ) {
    return;
  }

  void params.desktopApi?.persistThreadUsageActivity?.({
    backend: params.backend,
    threadId: params.threadId,
    activity: params.entry,
  }).catch(() => {
    // Usage display is still correct for the live session; retry on later final updates.
  });
}

function isTerminalTurnEntry(entry: AppServerThreadEntry): boolean {
  if (entry.type === "review") {
    return true;
  }

  return (
    isTokenUsageActivityEntry(entry) ||
    entry.type === "message" &&
    entry.role === "assistant" &&
    entry.phase === "final"
  );
}

function isTokenUsageActivityEntry(entry: AppServerThreadEntry): boolean {
  return (
    entry.type === "activity" &&
    (entry.id.startsWith("live-token-usage-") ||
      entry.id.startsWith("live-turn-usage-") ||
      entry.summary.startsWith("Turn usage:") ||
      entry.summary.startsWith("Usage:") ||
      entry.summary.startsWith("Latest request usage:"))
  );
}

function isMonitorUsageActivityEntry(
  entry: AppServerThreadEntry
): entry is AppServerThreadActivityEntry {
  return (
    entry.type === "activity" &&
    (entry.summary.startsWith("Monitor usage:") ||
      entry.summary.startsWith("Monitor usage so far:"))
  );
}

function isDurableMonitorUsageActivity(
  entry: AppServerThreadEntry
): entry is AppServerThreadActivityEntry {
  return entry.type === "activity" && entry.summary.startsWith("Monitor usage:");
}

function tokenUsageActivityScope(
  entry: AppServerThreadActivityEntry
): "latest-request" | "total" | "turn" | undefined {
  if (entry.id.startsWith("live-turn-usage-") || entry.summary.startsWith("Turn usage:")) {
    return "turn";
  }
  if (entry.summary.startsWith("Latest request usage:")) {
    return "latest-request";
  }
  if (entry.summary.startsWith("Usage:")) {
    return "total";
  }
  if (entry.id.startsWith("live-token-usage-")) {
    return "latest-request";
  }
  return undefined;
}

function isTerminalTurnMetadata(
  turn: AppServerThreadTurnMetadata | undefined,
): boolean {
  return Boolean(
    turn
    && (
      turn.status === "completed"
      || turn.status === "failed"
      || turn.status === "cancelled"
      || turn.status === "interrupted"
      || typeof turn.completedAt === "number"
    )
  );
}

function preferTurnUsageLine(
  current: ThreadUsageLineRecord | undefined,
  candidate: ThreadUsageLineRecord,
): ThreadUsageLineRecord {
  if (!current) {
    return candidate;
  }
  if (candidate.source === "live" && current.source !== "live") {
    return candidate;
  }
  if (candidate.turnUsageAttributed === true && current.turnUsageAttributed !== true) {
    return candidate;
  }
  const currentAt = current.completedAt ?? current.createdAt;
  const candidateAt = candidate.completedAt ?? candidate.createdAt;
  return candidateAt >= currentAt ? candidate : current;
}

/**
 * Treat completed turn usage as one terminal transcript projection.
 *
 * The renderer can briefly own three views of the same accounting: a live
 * per-request row, the turn-total placeholder frozen by turn/completed, and
 * the main-process pricing line after its last async usage observation. Keep
 * the pricing line authoritative, remove the narrower rows it supersedes, and
 * anchor the result after every loaded entry from that turn. This stays
 * linear in the loaded transcript and does not disturb incremental collection.
 */
function reconcileCompletedTurnUsageEntries(params: {
  activeTurnId?: string;
  entries: AppServerThreadEntry[];
  lines?: ThreadUsageLineRecord[];
  requireExistingTurnUsage?: boolean;
}): AppServerThreadEntry[] {
  const contentTurnById = new Map<string, AppServerThreadTurnMetadata>();
  const existingTurnUsageByTurnId = new Map<
    string,
    AppServerThreadActivityEntry
  >();

  for (const entry of params.entries) {
    const turnId =
      entry.turn?.id
      ?? (entry.type === "activity" ? entry.usageLine?.turnId : undefined);
    if (!turnId || turnId === params.activeTurnId) {
      continue;
    }
    if (
      entry.type === "activity"
      && tokenUsageActivityScope(entry) === "turn"
    ) {
      existingTurnUsageByTurnId.set(turnId, entry);
      continue;
    }
    if (
      entry.type === "activity"
      && tokenUsageActivityScope(entry) !== undefined
    ) {
      continue;
    }
    if (entry.turn) {
      contentTurnById.set(turnId, entry.turn);
    }
  }

  const authoritativeLineByTurnId = new Map<string, ThreadUsageLineRecord>();
  for (const line of params.lines ?? []) {
    if (
      !line.turnId
      || line.turnId === params.activeTurnId
      || line.scope !== "turn"
      || line.status === "superseded"
      || line.turnUsageAttributed === false
      || !contentTurnById.has(line.turnId)
    ) {
      continue;
    }
    authoritativeLineByTurnId.set(
      line.turnId,
      preferTurnUsageLine(authoritativeLineByTurnId.get(line.turnId), line),
    );
  }

  const replacementByTurnId = new Map<string, AppServerThreadActivityEntry>();
  for (const [turnId, contentTurn] of contentTurnById) {
    const existingUsage = existingTurnUsageByTurnId.get(turnId);
    if (params.requireExistingTurnUsage && !existingUsage) {
      continue;
    }
    const line = authoritativeLineByTurnId.get(turnId);
    const completedAt =
      line?.completedAt
      ?? contentTurn.completedAt
      ?? existingUsage?.turn?.completedAt;
    const terminal = typeof completedAt === "number"
      || isTerminalTurnMetadata(contentTurn)
      || isTerminalTurnMetadata(existingUsage?.turn);
    if (!terminal) {
      continue;
    }

    const startedAt =
      contentTurn.startedAt
      ?? line?.startedAt
      ?? existingUsage?.turn?.startedAt;
    const interruptedStatus =
      contentTurn.status === "failed"
      || contentTurn.status === "cancelled"
      || contentTurn.status === "interrupted"
        ? contentTurn.status
        : existingUsage?.turn?.status === "failed"
          || existingUsage?.turn?.status === "cancelled"
          || existingUsage?.turn?.status === "interrupted"
          ? existingUsage.turn.status
          : undefined;
    const turn: AppServerThreadTurnMetadata = {
      ...contentTurn,
      id: turnId,
      status: interruptedStatus ?? "completed",
      ...(typeof startedAt === "number" ? { startedAt } : {}),
      ...(typeof completedAt === "number" ? { completedAt } : {}),
      ...(typeof (contentTurn.durationMs ?? existingUsage?.turn?.durationMs) === "number"
        ? {
            durationMs:
              contentTurn.durationMs ?? existingUsage?.turn?.durationMs,
          }
        : typeof startedAt === "number" && typeof completedAt === "number"
          ? { durationMs: Math.max(0, completedAt - startedAt) }
          : {}),
    };
    const authoritativeEntry = line
      ? buildTurnUsageActivityEntryFromLine({ line, turn })
      : undefined;
    if (authoritativeEntry) {
      replacementByTurnId.set(turnId, authoritativeEntry);
      continue;
    }
    if (existingUsage) {
      replacementByTurnId.set(
        turnId,
        typeof completedAt === "number"
          ? { ...existingUsage, createdAt: completedAt, turn }
          : { ...existingUsage, turn },
      );
    }
  }

  if (replacementByTurnId.size === 0) {
    return params.entries;
  }

  const filteredEntries: AppServerThreadEntry[] = [];
  const lastEntryIndexByTurnId = new Map<string, number>();
  for (const entry of params.entries) {
    const usageTurnId = entry.type === "activity"
      ? entry.turn?.id ?? entry.usageLine?.turnId
      : undefined;
    const scope = entry.type === "activity"
      ? tokenUsageActivityScope(entry)
      : undefined;
    if (
      usageTurnId
      && replacementByTurnId.has(usageTurnId)
      && (scope === "latest-request" || scope === "total" || scope === "turn")
    ) {
      continue;
    }

    const index = filteredEntries.length;
    filteredEntries.push(entry);
    if (entry.turn?.id && replacementByTurnId.has(entry.turn.id)) {
      lastEntryIndexByTurnId.set(entry.turn.id, index);
    }
  }

  const replacementAfterIndex = new Map<number, AppServerThreadActivityEntry>();
  for (const [turnId, replacement] of replacementByTurnId) {
    const anchorIndex = lastEntryIndexByTurnId.get(turnId);
    if (anchorIndex !== undefined) {
      replacementAfterIndex.set(anchorIndex, replacement);
    }
  }

  return filteredEntries.flatMap((entry, index) => {
    const replacement = replacementAfterIndex.get(index);
    return replacement ? [entry, replacement] : [entry];
  });
}

function hasTurnUsageForEntry(
  entries: AppServerThreadEntry[],
  usageEntry: AppServerThreadActivityEntry
): boolean {
  const turnId = usageEntry.turn?.id;
  if (!turnId) {
    return false;
  }

  return entries.some(
    (entry) =>
      entry.type === "activity" &&
      entry.turn?.id === turnId &&
      tokenUsageActivityScope(entry) === "turn"
  );
}

function shouldSuppressLiveUsageEntry(
  session: ThreadSessionEntry,
  usageEntry: AppServerThreadActivityEntry
): boolean {
  const scope = tokenUsageActivityScope(usageEntry);
  if (scope !== "latest-request" && scope !== "total") {
    return false;
  }

  return (
    hasTurnUsageForEntry(session.optimisticEntries, usageEntry) ||
    hasTurnUsageForEntry(session.response?.replay.entries ?? [], usageEntry)
  );
}

function runningTurnUsageTextFromEntry(
  entry: AppServerThreadActivityEntry | undefined
): string | undefined {
  if (!entry || tokenUsageActivityScope(entry) !== "turn") {
    return undefined;
  }

  return entry.summary.replace(/^Turn usage:/, "Usage so far:");
}

function hasOptimisticTurnUsageForEntry(
  entry: AppServerThreadEntry,
  optimisticTurnUsageIds: ReadonlySet<string>
): boolean {
  return Boolean(entry.turn?.id && optimisticTurnUsageIds.has(entry.turn.id));
}

function preserveReviewMetadata(
  existingEntry: AppServerThreadEntry | undefined,
  replacementEntry: AppServerThreadEntry,
): AppServerThreadEntry {
  if (
    existingEntry?.type !== "review"
    || replacementEntry.type !== "review"
  ) {
    return replacementEntry;
  }

  return {
    ...replacementEntry,
    ...(replacementEntry.context ?? existingEntry.context
      ? { context: replacementEntry.context ?? existingEntry.context }
      : {}),
    ...(replacementEntry.reviewer ?? existingEntry.reviewer
      ? { reviewer: replacementEntry.reviewer ?? existingEntry.reviewer }
      : {}),
  };
}

function mergeTranscriptEntries(
  responseEntries: AppServerThreadEntry[],
  optimisticEntries: AppServerThreadEntry[]
): AppServerThreadEntry[] {
  const optimisticTurnUsageIds = new Set(
    optimisticEntries
      .filter(
        (entry): entry is AppServerThreadActivityEntry =>
          entry.type === "activity" &&
          tokenUsageActivityScope(entry) === "turn" &&
          Boolean(entry.turn?.id)
      )
      .map((entry) => entry.turn?.id as string)
  );
  const merged = responseEntries.filter(
    (entry) => {
      const usageScope =
        entry.type === "activity" ? tokenUsageActivityScope(entry) : undefined;
      return !(
        (usageScope === "latest-request" || usageScope === "total") &&
        hasOptimisticTurnUsageForEntry(entry, optimisticTurnUsageIds)
      );
    }
  );
  let mergedEntryIndexById = new Map<string, number>();
  let greatestCreatedAt: number | undefined;
  let greatestCreatedAtByTurn = new Map<string, number>();
  let greatestSequenceByTurn = new Map<string, number>();
  let terminalTurnIds = new Set<string>();
  const rebuildAppendIndexes = (): void => {
    mergedEntryIndexById = new Map();
    greatestCreatedAt = undefined;
    greatestCreatedAtByTurn = new Map();
    greatestSequenceByTurn = new Map();
    terminalTurnIds = new Set();
    merged.forEach((entry, index) => {
      mergedEntryIndexById.set(entry.id, index);
      const createdAt = typeof entry.createdAt === "number"
        ? entry.createdAt
        : undefined;
      if (createdAt !== undefined) {
        greatestCreatedAt = Math.max(greatestCreatedAt ?? createdAt, createdAt);
        if (entry.turn?.id) {
          greatestCreatedAtByTurn.set(
            entry.turn.id,
            Math.max(
              greatestCreatedAtByTurn.get(entry.turn.id) ?? createdAt,
              createdAt,
            ),
          );
        }
      }
      if (entry.turn?.id && isTerminalTurnEntry(entry)) {
        terminalTurnIds.add(entry.turn.id);
      }
      const sequence = readRendererSequence(entry);
      if (entry.turn?.id && typeof sequence === "number") {
        greatestSequenceByTurn.set(
          entry.turn.id,
          Math.max(
            greatestSequenceByTurn.get(entry.turn.id) ?? sequence,
            sequence,
          ),
        );
      }
    });
  };
  const appendIndexedEntry = (entry: AppServerThreadEntry): void => {
    mergedEntryIndexById.set(entry.id, merged.length);
    merged.push(entry);
    if (typeof entry.createdAt === "number") {
      greatestCreatedAt = Math.max(
        greatestCreatedAt ?? entry.createdAt,
        entry.createdAt,
      );
      if (entry.turn?.id) {
        greatestCreatedAtByTurn.set(
          entry.turn.id,
          Math.max(
            greatestCreatedAtByTurn.get(entry.turn.id) ?? entry.createdAt,
            entry.createdAt,
          ),
        );
      }
    }
    if (entry.turn?.id && isTerminalTurnEntry(entry)) {
      terminalTurnIds.add(entry.turn.id);
    }
    const sequence = readRendererSequence(entry);
    if (entry.turn?.id && typeof sequence === "number") {
      greatestSequenceByTurn.set(
        entry.turn.id,
        Math.max(greatestSequenceByTurn.get(entry.turn.id) ?? sequence, sequence),
      );
    }
  };
  rebuildAppendIndexes();

  for (const optimisticEntry of optimisticEntries) {
    const existingIndex = mergedEntryIndexById.get(optimisticEntry.id) ?? -1;
    if (existingIndex !== -1) {
      merged[existingIndex] = preserveReviewMetadata(
        merged[existingIndex],
        optimisticEntry,
      );
      if (typeof optimisticEntry.createdAt === "number") {
        greatestCreatedAt = Math.max(
          greatestCreatedAt ?? optimisticEntry.createdAt,
          optimisticEntry.createdAt,
        );
        if (optimisticEntry.turn?.id) {
          greatestCreatedAtByTurn.set(
            optimisticEntry.turn.id,
            Math.max(
              greatestCreatedAtByTurn.get(optimisticEntry.turn.id)
                ?? optimisticEntry.createdAt,
              optimisticEntry.createdAt,
            ),
          );
        }
      }
      if (optimisticEntry.turn?.id && isTerminalTurnEntry(optimisticEntry)) {
        terminalTurnIds.add(optimisticEntry.turn.id);
      }
      const replacementSequence = readRendererSequence(optimisticEntry);
      if (
        optimisticEntry.turn?.id
        && typeof replacementSequence === "number"
      ) {
        greatestSequenceByTurn.set(
          optimisticEntry.turn.id,
          Math.max(
            greatestSequenceByTurn.get(optimisticEntry.turn.id)
              ?? replacementSequence,
            replacementSequence,
          ),
        );
      }
      continue;
    }

    if (optimisticEntry.type === "review") {
      const matchingReviewIndex = merged.findIndex(
        (entry) =>
          entry.type === "review"
          && reviewEntriesMatch(entry, optimisticEntry)
      );
      if (matchingReviewIndex !== -1) {
        merged[matchingReviewIndex] = preserveReviewMetadata(
          merged[matchingReviewIndex],
          optimisticEntry,
        );
        rebuildAppendIndexes();
        continue;
      }
    }

    const optimisticTurnId = optimisticEntry.turn?.id;
    const optimisticCreatedAt =
      typeof optimisticEntry.createdAt === "number"
        ? optimisticEntry.createdAt
        : undefined;
    const optimisticSequence = readRendererSequence(optimisticEntry);
    const canAppendInKnownOrder =
      !isTokenUsageActivityEntry(optimisticEntry)
      && !isMonitorUsageActivityEntry(optimisticEntry)
      && (optimisticTurnId
        ? (
            optimisticCreatedAt === undefined
            || (greatestCreatedAtByTurn.get(optimisticTurnId) ?? -Infinity)
              <= optimisticCreatedAt
          )
          && (
            optimisticSequence === undefined
            || (greatestSequenceByTurn.get(optimisticTurnId) ?? -Infinity)
              <= optimisticSequence
          )
          && (
            isTerminalTurnEntry(optimisticEntry)
            || !terminalTurnIds.has(optimisticTurnId)
          )
        : optimisticCreatedAt === undefined
          || (greatestCreatedAt ?? -Infinity) <= optimisticCreatedAt);
    if (canAppendInKnownOrder) {
      appendIndexedEntry(optimisticEntry);
      continue;
    }
    if (isTokenUsageActivityEntry(optimisticEntry) && optimisticTurnId) {
      const sameTurnIndex = merged.findLastIndex(
        (entry) => entry.turn?.id === optimisticTurnId
      );
      if (sameTurnIndex !== -1) {
        merged.splice(sameTurnIndex + 1, 0, optimisticEntry);
        rebuildAppendIndexes();
        continue;
      }

      const usageTimedIndex =
        typeof optimisticCreatedAt === "number"
          ? merged.findIndex((entry) => {
              const entryCreatedAt =
                typeof entry.createdAt === "number" ? entry.createdAt : undefined;
              return (
                typeof entryCreatedAt === "number" &&
                entryCreatedAt > optimisticCreatedAt
              );
            })
          : -1;
      if (usageTimedIndex !== -1) {
        merged.splice(usageTimedIndex, 0, optimisticEntry);
        rebuildAppendIndexes();
        continue;
      }
    }

    if (isMonitorUsageActivityEntry(optimisticEntry)) {
      const usageTimedIndex =
        typeof optimisticCreatedAt === "number"
          ? merged.findIndex((entry) => {
              const entryCreatedAt =
                typeof entry.createdAt === "number" ? entry.createdAt : undefined;
              return (
                typeof entryCreatedAt === "number" &&
                entryCreatedAt > optimisticCreatedAt
              );
            })
          : -1;
      if (usageTimedIndex !== -1) {
        merged.splice(usageTimedIndex, 0, optimisticEntry);
        rebuildAppendIndexes();
        continue;
      }
    }

    const timedIndex =
      optimisticTurnId &&
      typeof optimisticCreatedAt === "number" &&
      !isTokenUsageActivityEntry(optimisticEntry)
        ? merged.findIndex((entry) => {
            const entryCreatedAt =
              typeof entry.createdAt === "number" ? entry.createdAt : undefined;
            if (
              entry.turn?.id !== optimisticTurnId ||
              typeof entryCreatedAt !== "number"
            ) {
              return false;
            }
            const entrySequence = readRendererSequence(entry);
            if (
              typeof entrySequence === "number" &&
              typeof optimisticSequence === "number"
            ) {
              // Completion can restamp an earlier message. The live sequence
              // is the more precise record of the order the renderer observed.
              return entrySequence > optimisticSequence;
            }
            if (entryCreatedAt > optimisticCreatedAt) {
              return true;
            }
            if (entryCreatedAt < optimisticCreatedAt) {
              return false;
            }
            return false;
          })
        : -1;

    if (timedIndex !== -1) {
      merged.splice(timedIndex, 0, optimisticEntry);
      rebuildAppendIndexes();
      continue;
    }

    const globalTimedIndex =
      !optimisticTurnId && typeof optimisticCreatedAt === "number"
        ? merged.findIndex((entry) => {
            const entryCreatedAt =
              typeof entry.createdAt === "number" ? entry.createdAt : undefined;
            return (
              typeof entryCreatedAt === "number" &&
              entryCreatedAt > optimisticCreatedAt
            );
          })
        : -1;
    if (globalTimedIndex !== -1) {
      merged.splice(globalTimedIndex, 0, optimisticEntry);
      rebuildAppendIndexes();
      continue;
    }

    const terminalIndex =
      optimisticTurnId && !isTerminalTurnEntry(optimisticEntry)
        ? merged.findIndex(
            (entry) => {
              if (entry.turn?.id !== optimisticTurnId || !isTerminalTurnEntry(entry)) {
                return false;
              }

              const entryCreatedAt =
                typeof entry.createdAt === "number" ? entry.createdAt : undefined;
              return (
                typeof optimisticCreatedAt !== "number" ||
                typeof entryCreatedAt !== "number"
              );
            }
          )
        : -1;

    if (terminalIndex !== -1) {
      merged.splice(terminalIndex, 0, optimisticEntry);
      rebuildAppendIndexes();
      continue;
    }

    appendIndexedEntry(optimisticEntry);
  }

  return merged;
}

function mergeTranscriptMessages(
  responseMessages: AppServerThreadMessage[],
  optimisticMessages: AppServerThreadMessage[]
): AppServerThreadMessage[] {
  const merged = [...responseMessages];
  const mergedMessageIndexById = new Map(
    merged.map((message, index) => [message.id, index] as const)
  );
  let greatestCreatedAt = merged.reduce<number | undefined>(
    (greatest, message) => typeof message.createdAt === "number"
      ? Math.max(greatest ?? message.createdAt, message.createdAt)
      : greatest,
    undefined,
  );

  for (const optimisticMessage of optimisticMessages) {
    const existingIndex =
      mergedMessageIndexById.get(optimisticMessage.id) ?? -1;
    if (existingIndex !== -1) {
      merged[existingIndex] = optimisticMessage;
      if (typeof optimisticMessage.createdAt === "number") {
        greatestCreatedAt = Math.max(
          greatestCreatedAt ?? optimisticMessage.createdAt,
          optimisticMessage.createdAt,
        );
      }
      continue;
    }

    const optimisticCreatedAt =
      typeof optimisticMessage.createdAt === "number"
        ? optimisticMessage.createdAt
        : undefined;
    if (
      optimisticCreatedAt === undefined
      || (greatestCreatedAt ?? -Infinity) <= optimisticCreatedAt
    ) {
      mergedMessageIndexById.set(optimisticMessage.id, merged.length);
      merged.push(optimisticMessage);
      if (optimisticCreatedAt !== undefined) {
        greatestCreatedAt = Math.max(
          greatestCreatedAt ?? optimisticCreatedAt,
          optimisticCreatedAt,
        );
      }
      continue;
    }
    const timedIndex =
      typeof optimisticCreatedAt === "number"
        ? merged.findIndex((message) => {
            const messageCreatedAt =
              typeof message.createdAt === "number" ? message.createdAt : undefined;
            return (
              typeof messageCreatedAt === "number" &&
              messageCreatedAt > optimisticCreatedAt
            );
          })
        : -1;
    if (timedIndex !== -1) {
      merged.splice(timedIndex, 0, optimisticMessage);
      for (let index = timedIndex; index < merged.length; index += 1) {
        mergedMessageIndexById.set(merged[index]!.id, index);
      }
      continue;
    }

    mergedMessageIndexById.set(optimisticMessage.id, merged.length);
    merged.push(optimisticMessage);
  }

  return merged;
}

function preserveRetainedTranscriptTail(
  response: AppServerReadThreadResponse,
  retainedResponse: AppServerReadThreadResponse | undefined,
  hasLoadedHistory: boolean,
): AppServerReadThreadResponse {
  if (
    !hasLoadedHistory ||
    !retainedResponse ||
    !response.replay.pagination.supportsPagination
  ) {
    return response;
  }

  // A refresh can lag the live stream. Replace only exact or uniquely
  // equivalent retained entries; keep anything the refresh omitted.
  // Stable IDs take the indexed linear path; only entries whose server IDs
  // changed need the bounded logical-match fallback. Loaded history pages do
  // not participate, so pagination depth cannot amplify either path.
  const matchedRetainedEntries = new Set<AppServerThreadEntry>();
  const retainedEntriesById = new Map<string, AppServerThreadEntry[]>();
  const retainedEntryIndexById = new Map<string, number>();
  for (const retainedEntry of retainedResponse.replay.entries) {
    const retainedEntryId = retainedEntry.id;
    const entriesForId = retainedEntriesById.get(retainedEntryId);
    if (entriesForId) {
      entriesForId.push(retainedEntry);
    } else {
      retainedEntriesById.set(retainedEntryId, [retainedEntry]);
    }
  }
  const retainedLogicalMatchIndex = createLogicalTranscriptMatchIndex(
    retainedResponse.replay.entries,
  );
  const freshEntryByRetainedEntry = new Map<
    AppServerThreadEntry,
    AppServerThreadEntry
  >();
  for (const freshEntry of response.replay.entries) {
    const exactCandidates = retainedEntriesById.get(freshEntry.id);
    let exactCandidateIndex = retainedEntryIndexById.get(freshEntry.id) ?? 0;
    let retainedMatch = exactCandidates?.[exactCandidateIndex];
    while (retainedMatch && matchedRetainedEntries.has(retainedMatch)) {
      exactCandidateIndex += 1;
      retainedMatch = exactCandidates?.[exactCandidateIndex];
    }
    if (retainedMatch) {
      retainedEntryIndexById.set(freshEntry.id, exactCandidateIndex + 1);
    }
    retainedMatch ??= findUniqueLogicalTranscriptRefreshMatch(
      freshEntry,
      retainedLogicalMatchIndex,
      matchedRetainedEntries,
    );
    if (retainedMatch) {
      matchedRetainedEntries.add(retainedMatch);
      freshEntryByRetainedEntry.set(retainedMatch, freshEntry);
    }
  }
  const entries = reconcileRetainedTranscriptTail(
    response.replay.entries,
    retainedResponse.replay.entries,
    freshEntryByRetainedEntry,
  );

  return {
    ...response,
    replay: {
      ...response.replay,
      entries,
      messages: transcriptMessagesForEntries(
        entries,
        retainedResponse.replay.messages,
        response.replay.messages
      ),
    },
  };
}

function reconcileRetainedTranscriptTail(
  freshEntries: AppServerThreadEntry[],
  retainedEntries: AppServerThreadEntry[],
  freshEntryByRetainedEntry: ReadonlyMap<
    AppServerThreadEntry,
    AppServerThreadEntry
  >,
): AppServerThreadEntry[] {
  const retainedEntriesBeforeFresh = new Map<
    AppServerThreadEntry,
    AppServerThreadEntry[]
  >();
  let pendingRetainedEntries: AppServerThreadEntry[] = [];
  let lastMatchedFreshEntry: AppServerThreadEntry | undefined;

  for (const retainedEntry of retainedEntries) {
    const freshEntry = freshEntryByRetainedEntry.get(retainedEntry);
    if (!freshEntry) {
      pendingRetainedEntries.push(retainedEntry);
      continue;
    }

    if (pendingRetainedEntries.length > 0) {
      retainedEntriesBeforeFresh.set(freshEntry, pendingRetainedEntries);
      pendingRetainedEntries = [];
    }
    lastMatchedFreshEntry = freshEntry;
  }

  const entries: AppServerThreadEntry[] = [];
  let trailingInsertionFloor = 0;
  for (const freshEntry of freshEntries) {
    entries.push(...(retainedEntriesBeforeFresh.get(freshEntry) ?? []));
    entries.push(freshEntry);
    if (freshEntry === lastMatchedFreshEntry) {
      trailingInsertionFloor = entries.length;
    }
  }

  if (pendingRetainedEntries.length === 0) {
    return entries;
  }

  // A bounded newest-page refresh advances naturally as later turns arrive.
  // Entries that fell off its front are older history, not missing live tail,
  // and must remain ahead of the newer page. Entries after the last retained
  // anchor can still be genuinely newer live work omitted by a lagging read.
  // Merge the two ordered suffixes in one forward pass; an unknown retained
  // timestamp conservatively keeps that entry and the remainder at the end.
  const mergedSuffix: AppServerThreadEntry[] = [];
  const freshSuffix = entries.slice(trailingInsertionFloor);
  let freshIndex = 0;
  let retainedIndex = 0;
  while (retainedIndex < pendingRetainedEntries.length) {
    const retainedEntry = pendingRetainedEntries[retainedIndex]!;
    const retainedTimestamp = transcriptRefreshOrderTimestamp(retainedEntry);
    if (typeof retainedTimestamp !== "number") {
      mergedSuffix.push(
        ...freshSuffix.slice(freshIndex),
        ...pendingRetainedEntries.slice(retainedIndex),
      );
      return [
        ...entries.slice(0, trailingInsertionFloor),
        ...mergedSuffix,
      ];
    }

    while (freshIndex < freshSuffix.length) {
      const freshEntry = freshSuffix[freshIndex]!;
      const freshTimestamp = transcriptRefreshOrderTimestamp(freshEntry);
      if (
        typeof freshTimestamp === "number"
        && freshTimestamp > retainedTimestamp
      ) {
        break;
      }
      mergedSuffix.push(freshEntry);
      freshIndex += 1;
    }
    mergedSuffix.push(retainedEntry);
    retainedIndex += 1;
  }
  mergedSuffix.push(...freshSuffix.slice(freshIndex));

  return [
    ...entries.slice(0, trailingInsertionFloor),
    ...mergedSuffix,
  ];
}

function transcriptRefreshOrderTimestamp(
  entry: AppServerThreadEntry,
): number | undefined {
  if (typeof entry.createdAt === "number") {
    return entry.createdAt;
  }
  if (typeof entry.turn?.startedAt === "number") {
    return entry.turn.startedAt;
  }
  return typeof entry.turn?.completedAt === "number"
    ? entry.turn.completedAt
    : undefined;
}

function findUniqueLogicalTranscriptRefreshMatch(
  freshEntry: AppServerThreadEntry,
  retainedMatchIndex: LogicalTranscriptMatchIndex,
  matchedRetainedEntries: ReadonlySet<AppServerThreadEntry>,
): AppServerThreadEntry | undefined {
  return findOnlyTranscriptMatch(
    logicalTranscriptMatchCandidates(freshEntry, retainedMatchIndex),
    (retainedEntry) => {
      if (matchedRetainedEntries.has(retainedEntry)) {
        return false;
      }
      if (
        freshEntry.turn?.id &&
        retainedEntry.turn?.id &&
        freshEntry.turn.id !== retainedEntry.turn.id
      ) {
        return false;
      }
      if (
        freshEntry.type === "message" &&
        retainedEntry.type === "message" &&
        freshEntry.phase &&
        retainedEntry.phase &&
        freshEntry.phase !== retainedEntry.phase
      ) {
        return false;
      }

      return transcriptEntriesMatch(freshEntry, retainedEntry);
    },
  );
}

function isCodexImageBoundaryText(value: string): boolean {
  const trimmed = value.trim();
  return /^<image\b[^>]*>$/i.test(trimmed) || /^<\/image>$/i.test(trimmed);
}

function stripCodexImageBoundaryText(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (!lines.some((line) => isCodexImageBoundaryText(line))) {
    return value;
  }

  return lines
    .filter((line) => !isCodexImageBoundaryText(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripPwrAgentPdfContext(value: string): string {
  return value
    .replace(
      /\s*<pwragent-pdf-context>[\s\S]*?<\/pwragent-pdf-context>\s*/giu,
      "\n",
    )
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function normalizeComposerFileReferenceText(value: string): string {
  return stripPwrAgentPdfContext(stripCodexImageBoundaryText(value)).replace(
    /\[@([^\]]+)\]\([^)]*\)/gu,
    (_reference, name: string) => `@${name}`,
  );
}

function shouldPreserveOptimisticMessagePresentation(
  message: AppServerThreadMessage,
  entry: AppServerThreadMessageEntry,
): boolean {
  return (
    stripCodexImageBoundaryText(message.text) !==
      stripCodexImageBoundaryText(entry.text)
    && normalizeComposerFileReferenceText(message.text) ===
      normalizeComposerFileReferenceText(entry.text)
  );
}

function stripCodexImageBoundaryParts(
  parts: AppServerThreadMessagePart[] | undefined
): AppServerThreadMessagePart[] | undefined {
  if (!parts?.length) {
    return parts;
  }

  let changed = false;
  const strippedParts = parts.flatMap((part): AppServerThreadMessagePart[] => {
    if (part.type !== "text") {
      return [part];
    }

    const text = stripCodexImageBoundaryText(part.text);
    changed = changed || text !== part.text;
    return text ? [{ ...part, text }] : [];
  });

  if (!changed) {
    return parts;
  }

  return strippedParts.length > 0 ? strippedParts : undefined;
}

function normalizeMessageImageBoundaryText<
  T extends AppServerThreadMessage | AppServerThreadMessageEntry,
>(message: T): T {
  const text = stripCodexImageBoundaryText(message.text);
  const parts = stripCodexImageBoundaryParts(message.parts);
  if (text === message.text && parts === message.parts) {
    return message;
  }

  const nextMessage = {
    ...message,
    text,
  };
  if (parts) {
    return {
      ...nextMessage,
      parts,
    };
  }

  delete (nextMessage as { parts?: AppServerThreadMessagePart[] }).parts;
  return nextMessage;
}

function normalizeResponseImageBoundaryText(
  response: AppServerReadThreadResponse
): AppServerReadThreadResponse {
  let changed = false;
  const entries = response.replay.entries.map((entry) => {
    if (entry.type !== "message") {
      return entry;
    }

    const normalizedEntry = normalizeMessageImageBoundaryText(entry);
    changed = changed || normalizedEntry !== entry;
    return normalizedEntry;
  });
  const messages = response.replay.messages.map((message) => {
    const normalizedMessage = normalizeMessageImageBoundaryText(message);
    changed = changed || normalizedMessage !== message;
    return normalizedMessage;
  });

  if (!changed) {
    return response;
  }

  return {
    ...response,
    replay: {
      ...response.replay,
      entries,
      messages,
    },
  };
}

function hasImageParts(
  message: Pick<AppServerThreadMessageEntry | AppServerThreadMessage, "parts">
): boolean {
  return Boolean(message.parts?.some((part) => part.type === "image"));
}

function imageMessageSources(
  sources: AppServerThreadEntry[]
): AppServerThreadMessageEntry[] {
  return sources.filter(
    (entry): entry is AppServerThreadMessageEntry =>
      entry.type === "message" && entry.role === "user" && hasImageParts(entry)
  );
}

function mergeImagePartsFromSources<
  T extends AppServerThreadMessage | AppServerThreadMessageEntry,
>(
  message: T,
  sources: AppServerThreadMessageEntry[]
): T {
  if (message.role !== "user" || hasImageParts(message)) {
    return message;
  }

  const source = sources.find((candidate) =>
    messageTextMatchesOptimisticEntry(message, candidate)
  );
  if (!source?.parts) {
    return message;
  }

  return {
    ...message,
    parts: source.parts,
  };
}

function mergeImagePartsIntoResponse(
  response: AppServerReadThreadResponse | undefined,
  sources: AppServerThreadEntry[]
): AppServerReadThreadResponse | undefined {
  if (!response || sources.length === 0) {
    return response;
  }

  const imageSources = imageMessageSources(sources);
  if (imageSources.length === 0) {
    return response;
  }

  let changed = false;
  const entries = response.replay.entries.map((entry) => {
    if (entry.type !== "message") {
      return entry;
    }

    const nextEntry = mergeImagePartsFromSources(entry, imageSources);
    changed = changed || nextEntry !== entry;
    return nextEntry;
  });
  const messages = response.replay.messages.map((message) => {
    const nextMessage = mergeImagePartsFromSources(message, imageSources);
    changed = changed || nextMessage !== message;
    return nextMessage;
  });

  if (!changed) {
    return response;
  }

  return {
    ...response,
    replay: {
      ...response.replay,
      entries,
      messages,
    },
  };
}

function buildEmptyResponse(params: {
  backend: NavigationThreadSummary["source"];
  threadId: NavigationThreadSummary["id"];
}): AppServerReadThreadResponse {
  return {
    backend: params.backend,
    fetchedAt: Date.now(),
    threadId: params.threadId,
    replay: {
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    },
  };
}

function getEnvironmentSetupHydrationVersion(
  thread: Pick<NavigationThreadSummary, "codexEnvironmentRuntime">
): string | undefined {
  const runtime = thread.codexEnvironmentRuntime;
  if (!runtime?.setupStatus || !runtime.setupCommand) {
    return undefined;
  }

  return [
    runtime.environmentId,
    runtime.setupStatus,
    runtime.setupExitCode ?? "",
    runtime.setupDurationMs ?? "",
    runtime.setupOutput?.length ?? "",
  ].join(":");
}

function getThreadHydrationVersion(
  thread: Pick<
    NavigationThreadSummary,
    "codexEnvironmentRuntime" | "updatedAt"
  >
): string {
  return [
    typeof thread.updatedAt === "number" ? thread.updatedAt : "unknown",
    getEnvironmentSetupHydrationVersion(thread) ?? "no-setup",
  ].join(":");
}

function pruneOptimisticEntries(
  optimisticEntries: AppServerThreadEntry[],
  response: AppServerReadThreadResponse | undefined,
  reconciledLaunchpadMessageId?: string,
  launchpadMessageCandidate?: LaunchpadMessageCandidate,
): AppServerThreadEntry[] {
  if (!response) {
    return optimisticEntries;
  }

  const latestResponseTurnId = latestTranscriptTurnId(response.replay.entries);
  const latestResponseCreatedAt = latestTranscriptCreatedAt(response.replay.entries);
  return optimisticEntries.filter((entry) => {
    if (entry.type === "message") {
      const isLaunchpadPlaceholder =
        entry.id === launchpadMessageCandidate?.entry.id;
      if (isLaunchpadPlaceholder && launchpadMessageCandidate) {
        return !response.replay.entries.some(
          (candidate) =>
            candidate.type === "message"
            && candidate.id !== reconciledLaunchpadMessageId
            && matchesAuthoritativeLaunchpadMessage(
              candidate,
              launchpadMessageCandidate,
            )
        );
      }
      return !response.replay.messages.some((message) =>
        message.id !== reconciledLaunchpadMessageId
        && messageMatchesOptimisticEntry(message, entry, {
          allowImageUrlMismatch: true,
        })
      );
    }

    if (entry.type === "review") {
      return !response.replay.entries.some(
        (candidate) =>
          candidate.type === "review" &&
          reviewEntriesMatch(candidate, entry)
      );
    }

    if (entry.type === "activity") {
      if (
        latestResponseTurnId &&
        entry.turn?.id !== latestResponseTurnId &&
        isCompletedTurnMetadata(entry.turn) &&
        !isEntryNewerThanHydratedTranscript(entry, latestResponseCreatedAt)
      ) {
        return false;
      }

      return !response.replay.entries.some(
        (candidate) =>
          candidate.type === "activity" &&
          activityEntriesMatch(candidate, entry)
      );
    }

    return !response.replay.entries.some((candidate) => candidate.id === entry.id);
  });
}

function latestTranscriptCreatedAt(entries: AppServerThreadEntry[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const createdAt = entries[index]?.createdAt;
    if (typeof createdAt === "number") {
      return createdAt;
    }
  }

  return undefined;
}

function isEntryNewerThanHydratedTranscript(
  entry: AppServerThreadEntry,
  latestResponseCreatedAt: number | undefined
): boolean {
  return (
    typeof entry.createdAt === "number" &&
    typeof latestResponseCreatedAt === "number" &&
    entry.createdAt > latestResponseCreatedAt
  );
}

function isCompletedTurnMetadata(
  turn: AppServerThreadTurnMetadata | undefined
): boolean {
  return Boolean(
    turn &&
      (turn.status === "completed" ||
        turn.status === "failed" ||
        turn.status === "cancelled" ||
        turn.status === "interrupted" ||
        typeof turn.durationMs === "number" ||
        typeof turn.completedAt === "number")
  );
}

function activityEntriesMatch(
  candidate: AppServerThreadActivityEntry,
  optimisticEntry: AppServerThreadActivityEntry
): boolean {
  const tokenUsageMatch =
    isTokenUsageActivityEntry(candidate) && isTokenUsageActivityEntry(optimisticEntry);
  if (
    tokenUsageMatch &&
    tokenUsageActivityScope(candidate) !== tokenUsageActivityScope(optimisticEntry)
  ) {
    return false;
  }

  if (tokenUsageMatch && candidate.summary !== optimisticEntry.summary) {
    return false;
  }

  if (candidate.id === optimisticEntry.id) {
    return true;
  }

  if (optimisticEntry.details.length === 0) {
    return false;
  }

  return optimisticEntry.details.every((detail) =>
    candidate.details.some((candidateDetail) => {
      if (candidateDetail.id === detail.id) {
        return true;
      }
      if (tokenUsageMatch && candidateDetail.label === detail.label) {
        return true;
      }
      if (detail.command?.displayCommand) {
        return candidateDetail.command?.displayCommand === detail.command.displayCommand;
      }
      if (detail.fileDiff?.diff) {
        return candidateDetail.fileDiff?.diff === detail.fileDiff.diff;
      }
      return false;
    })
  );
}

function transcriptEntriesMatch(
  candidate: AppServerThreadEntry,
  existingEntry: AppServerThreadEntry
): boolean {
  if (candidate.id === existingEntry.id) {
    return true;
  }

  if (candidate.type !== existingEntry.type) {
    return false;
  }

  if (candidate.type === "message" && existingEntry.type === "message") {
    return messageMatchesOptimisticEntry(
      {
        id: candidate.id,
        role: candidate.role,
        text: candidate.text,
        parts: candidate.parts,
        createdAt: candidate.createdAt,
      },
      existingEntry,
      { allowImageUrlMismatch: true }
    );
  }

  if (candidate.type === "activity" && existingEntry.type === "activity") {
    return activityEntriesMatch(candidate, existingEntry);
  }

  if (candidate.type === "review" && existingEntry.type === "review") {
    return reviewEntriesMatch(candidate, existingEntry);
  }

  return false;
}

type LogicalTranscriptMatchIndex = ReadonlyMap<
  string,
  AppServerThreadEntry[]
>;

function logicalTranscriptMatchKeys(
  entry: AppServerThreadEntry,
): string[] {
  if (entry.type === "message") {
    return [JSON.stringify([
      "message",
      entry.role,
      normalizeComposerFileReferenceText(entry.text),
    ])];
  }

  if (entry.type === "activity") {
    const tokenUsage = isTokenUsageActivityEntry(entry);
    const keys = new Set<string>();
    for (const detail of entry.details) {
      keys.add(JSON.stringify(["activity-detail-id", detail.id]));
      if (tokenUsage) {
        keys.add(JSON.stringify(["activity-detail-label", detail.label]));
      }
      if (detail.command?.displayCommand) {
        keys.add(JSON.stringify([
          "activity-command",
          detail.command.displayCommand,
        ]));
      }
      if (detail.fileDiff?.diff) {
        keys.add(JSON.stringify(["activity-diff", detail.fileDiff.diff]));
      }
    }
    return [...keys];
  }

  if (entry.type === "review") {
    const isStart = isReviewStartEntry(entry);
    const keys = reviewEntryLabels(entry).map((label) =>
      JSON.stringify(["review", isStart, label])
    );
    if (isStart && entry.turn?.id) {
      keys.push(JSON.stringify(["review-start-turn", entry.turn.id]));
    }
    return keys;
  }

  return [];
}

function createLogicalTranscriptMatchIndex(
  entries: AppServerThreadEntry[],
): LogicalTranscriptMatchIndex {
  const index = new Map<string, AppServerThreadEntry[]>();
  for (const entry of entries) {
    for (const key of logicalTranscriptMatchKeys(entry)) {
      const candidates = index.get(key);
      if (candidates) {
        candidates.push(entry);
      } else {
        index.set(key, [entry]);
      }
    }
  }
  return index;
}

function logicalTranscriptMatchCandidates(
  entry: AppServerThreadEntry,
  index: LogicalTranscriptMatchIndex,
): AppServerThreadEntry[] {
  const candidates = new Set<AppServerThreadEntry>();
  for (const key of logicalTranscriptMatchKeys(entry)) {
    for (const candidate of index.get(key) ?? []) {
      candidates.add(candidate);
    }
  }
  return [...candidates];
}

function findOnlyTranscriptMatch(
  candidates: AppServerThreadEntry[],
  matches: (candidate: AppServerThreadEntry) => boolean,
): AppServerThreadEntry | undefined {
  let match: AppServerThreadEntry | undefined;
  for (const candidate of candidates) {
    if (!matches(candidate)) {
      continue;
    }
    if (match) {
      return undefined;
    }
    match = candidate;
  }
  return match;
}

function findUniqueTranscriptOrderSource(
  entry: AppServerThreadEntry,
  exactSourcesById: ReadonlyMap<string, AppServerThreadEntry>,
  logicalSourceIndex: LogicalTranscriptMatchIndex,
): AppServerThreadEntry | undefined {
  const exactMatch = exactSourcesById.get(entry.id);
  if (exactMatch) {
    return exactMatch;
  }

  return findOnlyTranscriptMatch(
    logicalTranscriptMatchCandidates(entry, logicalSourceIndex),
    (source) =>
      typeof source.createdAt === "number" &&
      source.id !== entry.id &&
      transcriptEntriesMatch(entry, source),
  );
}

type HydratedEntryOrderMatch = {
  entry: AppServerThreadEntry;
  hydrationIndex: number;
  sourceIndex?: number;
};

type MatchedHydratedEntry = HydratedEntryOrderMatch & {
  sourceIndex: number;
};

function reorderHydratedEntriesByKnownOrder(
  entries: AppServerThreadEntry[],
  sources: AppServerThreadEntry[],
  sourceByHydratedEntry: ReadonlyMap<
    AppServerThreadEntry,
    AppServerThreadEntry
  >,
): AppServerThreadEntry[] {
  if (entries.length < 2 || sources.length === 0) {
    return entries;
  }

  const sourceIndexes = new Map<AppServerThreadEntry, number>();
  sources.forEach((source, index) => {
    sourceIndexes.set(source, index);
  });
  const hydratedEntries: HydratedEntryOrderMatch[] = entries.map(
    (entry, hydrationIndex) => {
      const source = sourceByHydratedEntry.get(entry);
      const sourceIndex = source ? sourceIndexes.get(source) : undefined;
      return {
        entry,
        hydrationIndex,
        ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      };
    }
  );
  const matchedEntries = hydratedEntries.filter(
    (entry): entry is MatchedHydratedEntry => typeof entry.sourceIndex === "number"
  );
  if (matchedEntries.length < 2) {
    return entries;
  }

  const sourceOrderAlreadyMatches = matchedEntries.every(
    (entry, index) =>
      index === 0
      || matchedEntries[index - 1]!.sourceIndex <= entry.sourceIndex
  );
  if (sourceOrderAlreadyMatches) {
    return entries;
  }

  // Do not invent positions for newly hydrated entries. Refill only the slots
  // for entries the live ledger can identify, preserving their observed order.
  const orderedMatches = [...matchedEntries].sort(
    (left, right) =>
      left.sourceIndex - right.sourceIndex || left.hydrationIndex - right.hydrationIndex
  );
  let orderedMatchIndex = 0;
  return hydratedEntries.map((entry) => {
    if (entry.sourceIndex === undefined) {
      return entry.entry;
    }

    const orderedEntry = orderedMatches[orderedMatchIndex]?.entry;
    orderedMatchIndex += 1;
    return orderedEntry ?? entry.entry;
  });
}

function carryForwardTranscriptEntryOrder(
  response: AppServerReadThreadResponse,
  sources: AppServerThreadEntry[],
  liveSources: AppServerThreadEntry[] = []
): AppServerReadThreadResponse {
  if (sources.length === 0) {
    return response;
  }

  const exactSourcesById = new Map<string, AppServerThreadEntry>();
  const logicalSources: AppServerThreadEntry[] = [];
  for (const source of sources) {
    const sourceId = source.id;
    if (typeof source.createdAt === "number") {
      logicalSources.push(source);
      if (!exactSourcesById.has(sourceId)) {
        exactSourcesById.set(sourceId, source);
      }
    }
  }
  const logicalSourceIndex = createLogicalTranscriptMatchIndex(logicalSources);
  const sourceByHydratedEntry = new Map<
    AppServerThreadEntry,
    AppServerThreadEntry
  >();
  let changed = false;
  let entries = response.replay.entries.map((entry) => {
    const source = findUniqueTranscriptOrderSource(
      entry,
      exactSourcesById,
      logicalSourceIndex,
    );
    if (!source) {
      return entry;
    }

    // A read that began before main persisted an injected-message origin can
    // resolve after the live item/completed event. Keep that richer live
    // provenance instead of letting the stale response downgrade it to User.
    const origin =
      entry.type === "message"
      && source.type === "message"
      && !entry.origin
      && source.origin
        ? source.origin
        : undefined;
    const turn = source.turn && !entry.turn ? source.turn : undefined;
    const createdAt = source.createdAt !== entry.createdAt
      ? source.createdAt
      : undefined;
    if (!origin && !turn && createdAt === undefined) {
      sourceByHydratedEntry.set(entry, source);
      return entry;
    }

    changed = true;
    const hydratedEntry = {
      ...entry,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(turn ? { turn } : {}),
      ...(origin ? { origin } : {}),
    };
    sourceByHydratedEntry.set(hydratedEntry, source);
    return hydratedEntry;
  });
  const reorderedEntries = reorderHydratedEntriesByKnownOrder(
    entries,
    sources,
    sourceByHydratedEntry,
  );
  if (reorderedEntries !== entries) {
    changed = true;
    entries = reorderedEntries;
  }

  const originsByMessageId = new Map(
    entries
      .filter(
        (entry): entry is AppServerThreadMessageEntry =>
          entry.type === "message" && Boolean(entry.origin)
      )
      .map((entry) => [entry.id, entry.origin] as const)
  );
  const messages = response.replay.messages.map((message) => {
    const origin = originsByMessageId.get(message.id);
    if (!origin || message.origin) {
      return message;
    }

    changed = true;
    return { ...message, origin };
  });

  const freshCurrentTurnId = latestTranscriptTurnId(response.replay.entries);
  const durableDiffSources = (
    freshCurrentTurnId ? sources : liveSources
  ).filter(
    (source): source is AppServerThreadActivityEntry =>
      isDurableDiffActivity(source) &&
      (!freshCurrentTurnId || source.turn?.id === freshCurrentTurnId)
  );
  const currentDurableDiffTurnId = durableDiffSources
    .map((source) => source.turn?.id)
    .findLast((turnId): turnId is string => Boolean(turnId));
  const latestDurableDiffSource = durableDiffSources.at(-1);

  for (const source of durableDiffSources) {
    if (currentDurableDiffTurnId) {
      if (source.turn?.id !== currentDurableDiffTurnId) {
        continue;
      }
    } else if (source !== latestDurableDiffSource) {
      continue;
    }

    const alreadyHydrated = entries.some(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" && activityEntriesMatch(entry, source)
    );
    if (alreadyHydrated) {
      continue;
    }

    changed = true;
    entries = mergeTranscriptEntries(entries, [source]);
  }

  const durableMonitorUsageSources = sources.filter(isDurableMonitorUsageActivity);
  for (const source of durableMonitorUsageSources) {
    const alreadyHydrated = entries.some(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" && activityEntriesMatch(entry, source)
    );
    if (alreadyHydrated) {
      continue;
    }

    changed = true;
    entries = mergeTranscriptEntries(entries, [source]);
  }

  const responseWithOrderedEntries = changed
    ? {
        ...response,
        replay: {
          ...response.replay,
          entries,
          messages,
        },
      }
    : response;

  return (
    mergeImagePartsIntoResponse(responseWithOrderedEntries, sources) ??
    responseWithOrderedEntries
  );
}

function latestTranscriptTurnId(entries: AppServerThreadEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turnId = entries[index]?.turn?.id;
    if (turnId) {
      return turnId;
    }
  }

  return undefined;
}

function isDurableDiffActivity(
  entry: AppServerThreadEntry
): entry is AppServerThreadActivityEntry {
  return (
    entry.type === "activity" &&
    entry.details.some((detail) => Boolean(detail.fileDiff?.diff))
  );
}

function reviewEntriesMatch(
  candidate: AppServerThreadReviewEntry,
  optimisticEntry: AppServerThreadReviewEntry
): boolean {
  const candidateIsStart = isReviewStartEntry(candidate);
  const optimisticIsStart = isReviewStartEntry(optimisticEntry);
  if (candidateIsStart !== optimisticIsStart) {
    return false;
  }

  const candidateTurnId = candidate.turn?.id;
  const optimisticTurnId = optimisticEntry.turn?.id;
  if (candidateTurnId && optimisticTurnId) {
    if (candidateTurnId !== optimisticTurnId) {
      return false;
    }
    if (candidateIsStart) {
      return true;
    }
  }

  if (candidateIsStart && (candidateTurnId || optimisticTurnId)) {
    const authoritativeEntry = candidateTurnId ? candidate : optimisticEntry;
    if (authoritativeEntry.turn?.status !== "in_progress") {
      return false;
    }
  }

  const candidateLabels = reviewEntryLabels(candidate);
  const optimisticLabels = reviewEntryLabels(optimisticEntry);
  return optimisticLabels.some((label) => candidateLabels.includes(label));
}

function isReviewStartEntry(entry: AppServerThreadReviewEntry): boolean {
  const displayText = entry.displayText?.trim();
  if (!displayText || entry.output) {
    return false;
  }

  if (entry.turn?.status === "in_progress") {
    return true;
  }

  const normalizedDisplayText = normalizeReviewDisplayText(displayText).toLocaleLowerCase();
  const normalizedReview = normalizeReviewDisplayText(entry.review).toLocaleLowerCase();
  return (
    normalizedDisplayText === normalizedReview ||
    normalizedDisplayText === "code review started" ||
    normalizedDisplayText.startsWith("review changes") ||
    normalizedDisplayText.startsWith("review current") ||
    normalizedDisplayText.startsWith("review commit")
  );
}

function reviewEntryLabels(entry: AppServerThreadReviewEntry): string[] {
  return [entry.displayText, entry.review]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeReviewDisplayText(value).toLocaleLowerCase());
}

function optimisticMessageEntries(
  optimisticEntries: AppServerThreadEntry[]
): AppServerThreadMessageEntry[] {
  return optimisticEntries.filter(
    (entry): entry is AppServerThreadMessageEntry => entry.type === "message"
  );
}

function hasHydratedTranscriptContent(session: ThreadSessionEntry): boolean {
  return Boolean(
    session.response?.replay.entries.length ||
      session.optimisticEntries.length ||
      session.retainedLiveEntryCount ||
      session.pendingAssistantMessage ||
      session.pendingMcpInteraction ||
      session.pendingRequest ||
      session.pendingUserInput
  );
}

function isLiveOptimisticEntry(entry: AppServerThreadEntry): boolean {
  if (entry.type === "message") {
    return true;
  }

  if (entry.type === "activity" && entry.status !== "in_progress") {
    return false;
  }

  if (entry.turn?.status) {
    return entry.turn.status === "in_progress";
  }

  if (entry.type === "activity") {
    return entry.status === "in_progress";
  }

  if (entry.type === "review") {
    return true;
  }

  return false;
}

function summarizeOptimisticEntryReason(
  entry: AppServerThreadEntry
): ThinkingStateReason {
  return {
    entryId: entry.id,
    entryStatus: "status" in entry ? entry.status : undefined,
    entryType: entry.type,
    kind: "liveOptimisticEntry",
    turnId: entry.turn?.id,
    turnStatus: entry.turn?.status,
  };
}

function describeThinkingState(session: ThreadSessionEntry): ThinkingStateReason[] {
  const reasons: ThinkingStateReason[] = [];

  if (session.backendReportedActive) {
    reasons.push({ kind: "backendActive" });
  }

  if (session.activeTurnId) {
    reasons.push({
      kind: "activeTurn",
      turnId: session.activeTurnId,
    });
  }

  if (session.pendingStatusText) {
    reasons.push({ kind: "pendingStatus" });
  }

  if (session.pendingAssistantMessage) {
    reasons.push({
      entryId: session.pendingAssistantMessage.id,
      kind: "pendingAssistantMessage",
      turnId: session.pendingAssistantMessage.turn?.id,
      turnStatus: session.pendingAssistantMessage.turn?.status,
    });
  }

  if (session.transientMessage) {
    reasons.push({
      entryId: session.transientMessage.id,
      kind: "transientMessage",
      turnId: session.transientMessage.turn?.id,
      turnStatus: session.transientMessage.turn?.status,
    });
  }

  if (session.pendingMcpInteraction) {
    reasons.push({ kind: "pendingMcpInteraction" });
  }

  if (session.pendingRequest) {
    reasons.push({
      kind: "pendingRequest",
      turnId: session.pendingRequest.params.turnId ?? undefined,
    });
  }

  if (session.pendingUserInput) {
    reasons.push({ kind: "pendingUserInput" });
  }

  if (session.expectOwnUpdate) {
    reasons.push(
      ...session.optimisticEntries
        .filter(isLiveOptimisticEntry)
        .map(summarizeOptimisticEntryReason)
    );
  }

  return reasons;
}

function hasThinkingState(session: ThreadSessionEntry): boolean {
  return describeThinkingState(session).length > 0;
}

function hasPendingInteraction(session: ThreadSessionEntry): boolean {
  return Boolean(
    session.pendingMcpInteraction ||
      session.pendingRequest ||
      session.pendingUserInput
  );
}

function summarizeOptimisticEntries(
  entries: AppServerThreadEntry[]
): Array<{
  entryStatus?: string;
  id: string;
  turnId?: string;
  turnStatus?: string;
  type: AppServerThreadEntry["type"];
}> {
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    entryStatus: "status" in entry ? entry.status : undefined,
    turnId: entry.turn?.id,
    turnStatus: entry.turn?.status,
  }));
}

function readResponseThreadStatus(
  response: AppServerReadThreadResponse
): AppServerReadThreadResponse["threadStatus"] {
  return response.threadStatus ?? response.replay.threadStatus;
}

function responseHasInProgressTurn(
  response: AppServerReadThreadResponse,
  turnId: string | undefined
): boolean {
  if (!turnId) {
    return false;
  }

  const turnEntries = response.replay.entries.filter(
    (entry) => entry.turn?.id === turnId
  );
  if (turnEntries.some((entry) => isCompletedTurnMetadata(entry.turn))) {
    return false;
  }

  return turnEntries.some((entry) => entry.turn?.status === "in_progress");
}

function readTrailingInProgressTurn(
  response: AppServerReadThreadResponse
): { id: string; startedAt?: number } | undefined {
  const entries = response.replay.entries;
  let trailingTurnId: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turn = entries[index]?.turn;
    if (turn) {
      trailingTurnId = turn.id;
      break;
    }
  }
  if (!trailingTurnId) {
    return undefined;
  }

  const turnEntries = entries.filter(
    (entry) => entry.turn?.id === trailingTurnId
  );
  if (turnEntries.some((entry) => isCompletedTurnMetadata(entry.turn))) {
    return undefined;
  }
  if (!turnEntries.some((entry) => entry.turn?.status === "in_progress")) {
    return undefined;
  }

  const startedAtCandidates = turnEntries
    .map((entry) => entry.turn?.startedAt)
    .filter((value): value is number => typeof value === "number");
  return {
    id: trailingTurnId,
    ...(startedAtCandidates.length > 0
      ? { startedAt: Math.min(...startedAtCandidates) }
      : {}),
  };
}

function responseHasCompletedTurn(
  response: AppServerReadThreadResponse,
  turnId: string | undefined
): boolean {
  if (!turnId) {
    return false;
  }

  return response.replay.entries.some(
    (entry) =>
      entry.turn?.id === turnId
      && isCompletedTurnMetadata(entry.turn)
  );
}

function sessionHasInProgressReviewTurn(
  session: ThreadSessionEntry,
  turnId: string | undefined
): boolean {
  if (!turnId) {
    return false;
  }

  const reviewEntries = [
    ...(session.response?.replay.entries ?? []),
    ...session.optimisticEntries,
  ].filter(
    (entry) =>
      entry.type === "review"
      && entry.turn?.id === turnId
  );
  if (reviewEntries.some((entry) => isCompletedTurnMetadata(entry.turn))) {
    return false;
  }

  return reviewEntries.some((entry) => entry.turn?.status === "in_progress");
}

function normalizeNotificationTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function normalizeNotificationDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNotificationTurnId(notification: {
  params: Record<string, unknown>;
}): string | undefined {
  return typeof notification.params.turnId === "string"
    ? notification.params.turnId
    : undefined;
}

function readFiniteNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findFirstNestedValue(value: unknown, keys: string[]): unknown {
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
    const nested = findFirstNestedValue(child, keys);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveTokenUsageModel(params: {
  backend: AppServerBackendKind;
  notificationParams: Extract<
    AppServerNotification,
    { method: "thread/tokenUsage/updated" }
  >["params"];
  thread?: NavigationThreadSummary;
  threadId: string;
}): string | undefined {
  return (
    readStringValue(params.notificationParams.model) ??
    readStringValue(
      findFirstNestedValue(params.notificationParams.tokenUsage, [
        "model",
        "modelId",
        "model_id",
      ])
    ) ??
    (params.thread?.source === params.backend && params.thread.id === params.threadId
      ? params.thread.model
      : undefined)
  );
}

function resolveTokenUsageServiceTier(params: {
  backend: AppServerBackendKind;
  notificationParams: Extract<
    AppServerNotification,
    { method: "thread/tokenUsage/updated" }
  >["params"];
  thread?: NavigationThreadSummary;
  threadId: string;
}): string | undefined {
  return (
    readStringValue(
      findFirstNestedValue(params.notificationParams.tokenUsage, [
        "serviceTier",
        "service_tier",
      ])
    ) ??
    (params.thread?.source === params.backend && params.thread.id === params.threadId
      ? params.thread.serviceTier
      : undefined)
  );
}

function resolveTokenUsageFastMode(params: {
  backend: AppServerBackendKind;
  notificationParams: Extract<
    AppServerNotification,
    { method: "thread/tokenUsage/updated" }
  >["params"];
  thread?: NavigationThreadSummary;
  threadId: string;
}): boolean | undefined {
  const tokenUsageFastMode = findFirstNestedValue(params.notificationParams.tokenUsage, [
    "fastMode",
    "fast_mode",
  ]);
  if (typeof tokenUsageFastMode === "boolean") {
    return tokenUsageFastMode;
  }

  return params.thread?.source === params.backend && params.thread.id === params.threadId
    ? params.thread.fastMode
    : undefined;
}

function readTokenBreakdown(record: Record<string, unknown>): TokenUsageBreakdown | undefined {
  const explicitTotal = readFiniteNumber(record, ["totalTokens", "total_tokens"]);
  const inputTokens = readFiniteNumber(record, ["inputTokens", "input_tokens"]);
  const cachedInputTokens = readFiniteNumber(record, [
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const outputTokens = readFiniteNumber(record, ["outputTokens", "output_tokens"]);
  const reasoningOutputTokens = readFiniteNumber(record, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);
  const derivedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0);
  const totalTokens = explicitTotal ?? (derivedTotal > 0 ? derivedTotal : undefined);

  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

type TokenUsageRecords = {
  currentUsage?: TokenUsageBreakdown;
  latestUsage?: TokenUsageBreakdown;
  totalUsage?: TokenUsageBreakdown;
};

function readTokenUsageRecords(tokenUsage: unknown): TokenUsageRecords | undefined {
  const root =
    readRecord(findFirstNestedValue(tokenUsage, ["tokenUsage", "token_usage", "info"])) ??
    readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const latestUsageRecord =
    readRecord(findFirstNestedValue(root, ["last", "last_token_usage"])) ??
    readRecord(root.last) ??
    readRecord(root.last_token_usage);
  const totalUsageRecord =
    readRecord(findFirstNestedValue(root, ["total", "total_token_usage"])) ??
    readRecord(root.total) ??
    readRecord(root.total_token_usage);
  const latestUsage = latestUsageRecord ? readTokenBreakdown(latestUsageRecord) : undefined;
  const totalUsage = totalUsageRecord ? readTokenBreakdown(totalUsageRecord) : undefined;
  const currentUsage = latestUsage ?? totalUsage;

  if (!currentUsage && !latestUsage && !totalUsage) {
    return undefined;
  }

  return {
    currentUsage,
    latestUsage,
    totalUsage,
  };
}

function tokenBreakdownFromContextCumulative(
  contextWindow: ThreadContextWindowState | undefined
): TokenUsageBreakdown | undefined {
  if (typeof contextWindow?.cumulativeTotalTokens !== "number") {
    return undefined;
  }

  return {
    cachedInputTokens: contextWindow.cumulativeCachedInputTokens,
    inputTokens: contextWindow.cumulativeInputTokens,
    outputTokens: contextWindow.cumulativeOutputTokens,
    reasoningOutputTokens: contextWindow.cumulativeReasoningOutputTokens,
    totalTokens: contextWindow.cumulativeTotalTokens,
  };
}

function subtractTokenBreakdowns(
  total: TokenUsageBreakdown,
  baseline: TokenUsageBreakdown
): TokenUsageBreakdown | undefined {
  const result: TokenUsageBreakdown = {
    cachedInputTokens: subtractTokenField(total.cachedInputTokens, baseline.cachedInputTokens),
    inputTokens: subtractTokenField(total.inputTokens, baseline.inputTokens),
    outputTokens: subtractTokenField(total.outputTokens, baseline.outputTokens),
    reasoningOutputTokens: subtractTokenField(
      total.reasoningOutputTokens,
      baseline.reasoningOutputTokens
    ),
    totalTokens: subtractTokenField(total.totalTokens, baseline.totalTokens),
  };

  return hasTokenBreakdownValue(result) ? result : undefined;
}

function subtractTokenField(
  total: number | undefined,
  baseline: number | undefined
): number | undefined {
  if (typeof total !== "number" || typeof baseline !== "number") {
    return undefined;
  }
  return Math.max(0, total - baseline);
}

function addTokenBreakdowns(
  first: TokenUsageBreakdown,
  second: TokenUsageBreakdown,
): TokenUsageBreakdown | undefined {
  const addField = (
    firstValue: number | undefined,
    secondValue: number | undefined,
  ): number | undefined => {
    if (typeof firstValue !== "number" && typeof secondValue !== "number") {
      return undefined;
    }
    return (firstValue ?? 0) + (secondValue ?? 0);
  };
  const result: TokenUsageBreakdown = {
    cachedInputTokens: addField(
      first.cachedInputTokens,
      second.cachedInputTokens,
    ),
    inputTokens: addField(first.inputTokens, second.inputTokens),
    outputTokens: addField(first.outputTokens, second.outputTokens),
    reasoningOutputTokens: addField(
      first.reasoningOutputTokens,
      second.reasoningOutputTokens,
    ),
    totalTokens: addField(first.totalTokens, second.totalTokens),
  };
  return hasTokenBreakdownValue(result) ? result : undefined;
}

function tokenBreakdownsEqual(
  first: TokenUsageBreakdown | undefined,
  second: TokenUsageBreakdown | undefined,
): boolean {
  if (!first || !second) {
    return false;
  }
  return (
    first.cachedInputTokens === second.cachedInputTokens
    && first.inputTokens === second.inputTokens
    && first.outputTokens === second.outputTokens
    && first.reasoningOutputTokens === second.reasoningOutputTokens
    && first.totalTokens === second.totalTokens
  );
}

function hasTokenBreakdownValue(tokens: TokenUsageBreakdown): boolean {
  return (
    typeof tokens.cachedInputTokens === "number" ||
    typeof tokens.inputTokens === "number" ||
    typeof tokens.outputTokens === "number" ||
    typeof tokens.reasoningOutputTokens === "number" ||
    typeof tokens.totalTokens === "number"
  );
}

function tokenUsagePayloadFromBreakdown(tokens: TokenUsageBreakdown): {
  total: Record<string, number>;
} {
  const total: Record<string, number> = {};
  if (typeof tokens.inputTokens === "number") total.inputTokens = tokens.inputTokens;
  if (typeof tokens.cachedInputTokens === "number") {
    total.cachedInputTokens = tokens.cachedInputTokens;
  }
  if (typeof tokens.outputTokens === "number") total.outputTokens = tokens.outputTokens;
  if (typeof tokens.reasoningOutputTokens === "number") {
    total.reasoningOutputTokens = tokens.reasoningOutputTokens;
  }
  if (typeof tokens.totalTokens === "number") total.totalTokens = tokens.totalTokens;

  return { total };
}

function deriveTurnUsageBaseline(params: {
  contextWindow?: ThreadContextWindowState;
  latestUsage?: TokenUsageBreakdown;
  totalUsage: TokenUsageBreakdown;
}): TokenUsageBreakdown | undefined {
  const previousCumulative = tokenBreakdownFromContextCumulative(params.contextWindow);
  if (previousCumulative) {
    return previousCumulative;
  }

  return params.latestUsage
    ? subtractTokenBreakdowns(params.totalUsage, params.latestUsage)
    : undefined;
}

function buildPendingTurnUsage(params: {
  appendLatestUsage?: boolean;
  contextWindow?: ThreadContextWindowState;
  existing?: TurnUsageAccumulator;
  fastMode?: boolean;
  model?: string;
  serviceTier?: string;
  tokenUsage: unknown;
  turn?: AppServerThreadTurnMetadata;
}): {
  accumulator?: TurnUsageAccumulator;
  entry?: AppServerThreadActivityEntry;
} {
  const turnId = params.turn?.id;
  const usageRecords = readTokenUsageRecords(params.tokenUsage);
  const totalUsage = usageRecords?.totalUsage;
  if (!turnId || !usageRecords) {
    return {};
  }
  if (!totalUsage && !params.appendLatestUsage) {
    return {};
  }

  const existing = params.existing?.turnId === turnId ? params.existing : undefined;
  const baseline =
    existing?.baseline ??
    (totalUsage
      ? deriveTurnUsageBaseline({
          contextWindow: params.contextWindow,
          latestUsage: usageRecords.latestUsage,
          totalUsage,
        })
      : undefined);
  const turnUsage = totalUsage
    ? baseline
      ? subtractTokenBreakdowns(totalUsage, baseline)
      : usageRecords.latestUsage ?? totalUsage
    : params.appendLatestUsage && existing?.usage && usageRecords.latestUsage
      ? tokenBreakdownsEqual(existing.latestUsage, usageRecords.latestUsage)
        ? existing.usage
        : addTokenBreakdowns(existing.usage, usageRecords.latestUsage)
      : usageRecords.latestUsage ?? usageRecords.currentUsage;
  const accumulator: TurnUsageAccumulator = {
    turnId,
    ...(baseline ? { baseline } : {}),
    ...(usageRecords.latestUsage ? { latestUsage: usageRecords.latestUsage } : {}),
    ...(turnUsage ? { usage: turnUsage } : existing?.usage ? { usage: existing.usage } : {}),
  };
  const entry = turnUsage
    ? buildTokenUsageActivityEntry({
        fastMode: params.fastMode,
        id: `live-turn-usage-${turnId}`,
        model: params.model,
        serviceTier: params.serviceTier,
        summaryPrefix: "Turn usage",
        tokenUsage: tokenUsagePayloadFromBreakdown(turnUsage),
        turn: params.turn,
      })
    : undefined;

  return {
    accumulator,
    ...(entry ? { entry } : {}),
  };
}

function normalizeThreadContextWindowState(
  tokenUsage: unknown
): ThreadContextWindowState | undefined {
  const usageRecords = readTokenUsageRecords(tokenUsage);
  const currentUsage = usageRecords?.currentUsage;
  const totalUsage = usageRecords?.totalUsage;
  const root =
    readRecord(findFirstNestedValue(tokenUsage, ["tokenUsage", "token_usage", "info"])) ??
    readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }
  const nestedModelContextWindow = findFirstNestedValue(root, [
    "modelContextWindow",
    "model_context_window",
  ]);
  const modelContextWindow =
    readFiniteNumber(root, ["modelContextWindow", "model_context_window"]) ??
    (typeof nestedModelContextWindow === "number" && Number.isFinite(nestedModelContextWindow)
      ? nestedModelContextWindow
      : undefined);
  const totalTokens = currentUsage?.totalTokens;

  if (!currentUsage || !modelContextWindow || modelContextWindow <= 0 || totalTokens === undefined) {
    return undefined;
  }

  const rawUsedPercent = (totalTokens / modelContextWindow) * 100;
  const usedPercent = Math.max(0, Math.min(100, rawUsedPercent));
  const remainingTokens = Math.max(0, modelContextWindow - totalTokens);
  const remainingPercent = Math.max(
    0,
    Math.min(100, (remainingTokens / modelContextWindow) * 100)
  );
  const hasDistinctCumulativeUsage =
    totalUsage?.totalTokens !== undefined && totalUsage.totalTokens !== totalTokens;

  return {
    cachedInputTokens: currentUsage.cachedInputTokens,
    cumulativeCachedInputTokens: hasDistinctCumulativeUsage
      ? totalUsage.cachedInputTokens
      : undefined,
    cumulativeInputTokens: hasDistinctCumulativeUsage ? totalUsage.inputTokens : undefined,
    cumulativeOutputTokens: hasDistinctCumulativeUsage
      ? totalUsage.outputTokens
      : undefined,
    cumulativeReasoningOutputTokens: hasDistinctCumulativeUsage
      ? totalUsage.reasoningOutputTokens
      : undefined,
    cumulativeTotalTokens: hasDistinctCumulativeUsage ? totalUsage.totalTokens : undefined,
    inputTokens: currentUsage.inputTokens,
    modelContextWindow,
    outputTokens: currentUsage.outputTokens,
    phase: getContextWindowMoonPhase(rawUsedPercent),
    reasoningOutputTokens: currentUsage.reasoningOutputTokens,
    remainingPercent,
    remainingTokens,
    totalTokens,
    usedPercent,
  };
}

function isContextCompactionItemNotification(
  notification: AppServerNotification
): boolean {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return false;
  }
  const item =
    typeof notification.params.item === "object" &&
    notification.params.item !== null &&
    !Array.isArray(notification.params.item)
      ? notification.params.item as Record<string, unknown>
      : undefined;
  const itemType = typeof item?.type === "string" ? item.type : undefined;
  return itemType?.replace(/[-_\s]/g, "").toLowerCase() === "contextcompaction";
}

function buildTurnMetadata(params: {
  fallbackId?: string;
  fallbackStartedAt?: number;
  fallbackStatus?: AppServerThreadTurnMetadata["status"];
  turn?: {
    id?: unknown;
    status?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    durationMs?: unknown;
  };
}): AppServerThreadTurnMetadata | undefined {
  const id =
    typeof params.turn?.id === "string" && params.turn.id.trim()
      ? params.turn.id
      : params.fallbackId;
  if (!id) {
    return undefined;
  }

  const status =
    params.turn?.status === "in_progress" ||
    params.turn?.status === "inProgress" ||
    params.turn?.status === "completed" ||
    params.turn?.status === "failed" ||
    params.turn?.status === "cancelled" ||
    params.turn?.status === "interrupted"
      ? params.turn.status === "inProgress"
        ? "in_progress"
        : params.turn.status
      : params.fallbackStatus;
  const startedAt =
    normalizeNotificationTimestamp(params.turn?.startedAt) ?? params.fallbackStartedAt;
  const completedAt = normalizeNotificationTimestamp(params.turn?.completedAt);
  const durationMs = normalizeNotificationDuration(params.turn?.durationMs);

  return {
    id,
    ...(status ? { status } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(typeof durationMs === "number" ? { durationMs } : {}),
  };
}

function readUuidV7Timestamp(id: string | undefined): number | undefined {
  if (!id) {
    return undefined;
  }
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
    return undefined;
  }
  const timestamp = Number.parseInt(hex, 16);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function mergeKnownTurnMetadata(params: {
  knownTurn?: AppServerThreadTurnMetadata;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadTurnMetadata | undefined {
  const id = params.turn?.id ?? params.knownTurn?.id;
  if (!id) {
    return undefined;
  }

  return {
    id,
    ...(params.turn?.status ?? params.knownTurn?.status
      ? { status: params.turn?.status ?? params.knownTurn?.status }
      : {}),
    ...(typeof (params.turn?.startedAt ?? params.knownTurn?.startedAt) === "number"
      ? { startedAt: params.turn?.startedAt ?? params.knownTurn?.startedAt }
      : {}),
    ...(typeof (params.turn?.completedAt ?? params.knownTurn?.completedAt) === "number"
      ? { completedAt: params.turn?.completedAt ?? params.knownTurn?.completedAt }
      : {}),
    ...(typeof (params.turn?.durationMs ?? params.knownTurn?.durationMs) === "number"
      ? { durationMs: params.turn?.durationMs ?? params.knownTurn?.durationMs }
      : {}),
  };
}

function findKnownTurnUsageMetadata(
  session: ThreadSessionEntry,
  turnId: string | undefined,
): {
  createdAt?: number;
  isTurnUsage?: boolean;
  turn?: AppServerThreadTurnMetadata;
} {
  if (!turnId) {
    return {};
  }
  const entries = [
    ...(session.response?.replay.entries ?? []),
    ...session.optimisticEntries,
  ];
  const turnUsageEntry = entries.find(
    (candidate) =>
      candidate.turn?.id === turnId &&
      candidate.type === "activity" &&
      isTokenUsageActivityEntry(candidate) &&
      tokenUsageActivityScope(candidate) === "turn"
  );
  const entry = turnUsageEntry ?? entries.find((candidate) => candidate.turn?.id === turnId);
  const entryIsTurnUsage =
    entry?.type === "activity" &&
    isTokenUsageActivityEntry(entry) &&
    tokenUsageActivityScope(entry) === "turn";
  const startedAt = entry?.turn?.startedAt ?? readUuidV7Timestamp(turnId);
  const turn = entry?.turn
    ? {
        ...entry.turn,
        ...(typeof startedAt === "number" ? { startedAt } : {}),
      }
    : typeof startedAt === "number"
      ? { id: turnId, startedAt }
      : undefined;
  const createdAt = entry?.turn?.completedAt ?? entry?.createdAt;
  return {
    ...(typeof createdAt === "number" ? { createdAt } : {}),
    ...(entryIsTurnUsage ? { isTurnUsage: true } : {}),
    ...(turn ? { turn } : {}),
  };
}

function terminalTurnMatchesActiveTurn(
  session: ThreadSessionEntry,
  terminalTurnId: string | undefined,
): boolean {
  return Boolean(
    !session.activeTurnId ||
      !terminalTurnId ||
      terminalTurnId === session.activeTurnId
  );
}

function shouldAdoptStartedTurn(
  session: ThreadSessionEntry,
  startedTurnId: string | undefined,
): boolean {
  if (!startedTurnId) {
    return false;
  }

  if (!session.activeTurnId) {
    return true;
  }

  if (startedTurnId === session.activeTurnId) {
    return true;
  }

  // Review turns are claimed from review/start and review-mode items before
  // Codex may emit a lone, mismatched turn/started. Do not let that stray
  // lifecycle notification replace the review turn; it has no matching items
  // or terminal event, so adopting it leaves the thread stuck as thinking.
  return session.activeTurnId.startsWith("pending:");
}

function withTurnMetadata<T extends AppServerThreadMessageEntry>(
  entry: T,
  turn: AppServerThreadTurnMetadata | undefined
): T {
  if (!turn) {
    return entry;
  }

  return {
    ...entry,
    turn,
  };
}

function withTurnMetadataAndPhase(
  entry: AppServerThreadMessageEntry,
  turn: AppServerThreadTurnMetadata | undefined,
  phase: AppServerThreadMessageEntry["phase"] | undefined
): AppServerThreadMessageEntry {
  const nextEntry = withTurnMetadata(entry, turn);
  if (!phase || nextEntry.phase || nextEntry.role !== "assistant") {
    return nextEntry;
  }

  return {
    ...nextEntry,
    phase,
  };
}

function withCompletedAssistantTimestamp(
  entry: AppServerThreadMessageEntry,
  params: {
    completedAt: number;
    phase: AppServerThreadMessageEntry["phase"] | undefined;
  }
): AppServerThreadMessageEntry {
  if (
    entry.role !== "assistant" ||
    (params.phase && params.phase !== "final")
  ) {
    return entry;
  }

  return {
    ...entry,
    createdAt: params.completedAt,
  };
}

function withCompletedResponseTurnMetadata(
  response: AppServerReadThreadResponse | undefined,
  turn: AppServerThreadTurnMetadata | undefined,
  unphasedAssistantPhase?: AppServerThreadMessageEntry["phase"]
): AppServerReadThreadResponse | undefined {
  if (!response || !turn) {
    return response;
  }

  return {
    ...response,
    replay: {
      ...response.replay,
      entries: response.replay.entries.map((entry) =>
        entry.turn?.id === turn.id
          ? entry.type === "message"
            ? withTurnMetadataAndPhase(entry, turn, unphasedAssistantPhase)
            : { ...entry, turn }
          : entry
      ),
    },
  };
}

function normalizeLiveAssistantMessagePhase(
  value: unknown
): AppServerThreadMessageEntry["phase"] | undefined {
  if (value === "commentary") {
    return "commentary";
  }
  if (value === "final" || value === "final_answer") {
    return "final";
  }
  return undefined;
}

function flushPendingAssistantToOptimistic(
  current: ThreadSessionEntry
): ThreadSessionEntry {
  if (!current.pendingAssistantMessage) {
    return current;
  }

  return {
    ...current,
    optimisticEntries: mergeItems(current.optimisticEntries, [
      current.pendingAssistantMessage,
    ]),
    pendingAssistantMessage: undefined,
  };
}

function updateActivityEntry(
  entry: AppServerThreadActivityEntry,
  details: AppServerThreadActivityDetail[],
  turn: AppServerThreadTurnMetadata | undefined,
  options: { suppressNoop?: boolean } = {}
): AppServerThreadActivityEntry {
  const mergedDetails = mergeActivityDetails(entry.details, details);
  if (
    options.suppressNoop &&
    activityDetailsEqual(entry.details, mergedDetails) &&
    turnMetadataEqual(entry.turn, entry.turn ?? turn)
  ) {
    return entry;
  }

  return {
    ...entry,
    summary: summarizeLiveActivity(mergedDetails),
    status: summarizeActivityStatus(mergedDetails),
    details: mergedDetails,
    ...(entry.turn ?? turn ? { turn: entry.turn ?? turn } : {}),
  };
}

function activityCommandDetailsEqual(
  left: AppServerThreadCommandDetail | undefined,
  right: AppServerThreadCommandDetail | undefined
): boolean {
  return (
    left?.displayCommand === right?.displayCommand &&
    left?.rawCommand === right?.rawCommand &&
    left?.cwd === right?.cwd &&
    left?.output === right?.output &&
    left?.exitCode === right?.exitCode &&
    left?.durationMs === right?.durationMs &&
    JSON.stringify(left?.subAgent) === JSON.stringify(right?.subAgent)
  );
}

function activityImagesEqual(
  left: AppServerThreadActivityDetail["images"],
  right: AppServerThreadActivityDetail["images"],
): boolean {
  if (left?.length !== right?.length) {
    return false;
  }
  return (left ?? []).every((leftImage, index) => {
    const rightImage = right?.[index];
    return (
      leftImage.type === rightImage?.type &&
      leftImage.url === rightImage.url &&
      leftImage.alt === rightImage.alt
    );
  });
}

function activityDetailsEqual(
  left: AppServerThreadActivityDetail[],
  right: AppServerThreadActivityDetail[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftDetail, index) => {
    const rightDetail = right[index];
    return (
      leftDetail.id === rightDetail?.id &&
      leftDetail.kind === rightDetail.kind &&
      leftDetail.label === rightDetail.label &&
      leftDetail.markdown === rightDetail.markdown &&
      leftDetail.path === rightDetail.path &&
      leftDetail.status === rightDetail.status &&
      leftDetail.url === rightDetail.url &&
      leftDetail.fileDiff === rightDetail.fileDiff &&
      activityImagesEqual(leftDetail.images, rightDetail.images) &&
      activityCommandDetailsEqual(leftDetail.command, rightDetail.command)
    );
  });
}

function turnMetadataEqual(
  left: AppServerThreadTurnMetadata | undefined,
  right: AppServerThreadTurnMetadata | undefined
): boolean {
  return (
    left?.id === right?.id &&
    left?.status === right?.status &&
    left?.startedAt === right?.startedAt &&
    left?.completedAt === right?.completedAt &&
    left?.durationMs === right?.durationMs
  );
}

function isThreadLocalTranscriptNotification(
  notification: AppServerNotification
): boolean {
  return (
    notification.method === "item/started" ||
    notification.method === "item/completed" ||
    notification.method === "item/agentMessage/delta" ||
    notification.method === "item/transientMessage/updated" ||
    notification.method === "item/mcpToolCall/progress" ||
    notification.method === "item/commandExecution/outputDelta" ||
    notification.method === "item/fileChange/outputDelta" ||
    notification.method === "thread/tokenUsage/updated"
  );
}

function liveActivityNotificationSignature(params: {
  backend: string;
  notification: AppServerNotification;
  threadId: string;
}): string | undefined {
  if (
    params.notification.method !== "item/started" &&
    params.notification.method !== "item/completed"
  ) {
    return undefined;
  }

  const item = getNotificationItem(params.notification.params);
  const details = item ? buildLiveToolDetails(item) : [];
  if (details.length === 0) {
    return undefined;
  }

  const turnId =
    typeof params.notification.params.turnId === "string"
      ? params.notification.params.turnId
      : "";
  const signatureParts = [
    params.backend,
    params.threadId,
    params.notification.method,
    turnId,
    ...details.flatMap((detail) => [
      detail.id,
      detail.kind,
      detail.label,
      detail.markdown ?? "",
      detail.path ?? "",
      detail.status ?? "",
      detail.url ?? "",
      detail.command?.displayCommand ?? "",
      detail.command?.rawCommand ?? "",
      detail.command?.cwd ?? "",
      detail.command?.output ?? "",
      typeof detail.command?.exitCode === "number" ? String(detail.command.exitCode) : "",
      typeof detail.command?.durationMs === "number" ? String(detail.command.durationMs) : "",
    ]),
  ];

  return signatureParts.join("\u0000");
}

function upsertLiveActivityEntry(
  current: ThreadSessionEntry,
  params: {
    details: AppServerThreadActivityDetail[];
    now: number;
    suppressDuplicateLiveActivityUpdates?: boolean;
    threadId: string;
    turn?: AppServerThreadTurnMetadata;
  }
): ThreadSessionEntry {
  if (params.details.length === 0) {
    return current;
  }

  const flushed = flushPendingAssistantToOptimistic(current);
  const incomingIds = new Set(params.details.map((detail) => detail.id));
  const matchingIndex = flushed.optimisticEntries.findIndex(
    (entry): entry is AppServerThreadActivityEntry =>
      entry.type === "activity" &&
      entry.details.some((detail) => incomingIds.has(detail.id))
  );

  if (matchingIndex !== -1) {
    const optimisticEntries = [...flushed.optimisticEntries];
    const existing = optimisticEntries[matchingIndex] as AppServerThreadActivityEntry;
    const updated = updateActivityEntry(
      existing,
      params.details,
      params.turn,
      { suppressNoop: params.suppressDuplicateLiveActivityUpdates }
    );
    if (updated === existing) {
      return flushed;
    }
    optimisticEntries[matchingIndex] = updated;
    return {
      ...flushed,
      expectOwnUpdate: true,
      interacted: true,
      lastTouchedAt: params.now,
      optimisticEntries,
    };
  }

  const lastOptimisticEntry = flushed.optimisticEntries[flushed.optimisticEntries.length - 1];
  const latestMergedEntry = mergeTranscriptEntries(
    flushed.response?.replay.entries ?? [],
    flushed.optimisticEntries
  ).at(-1);
  const canMergeWithLastActivity =
    lastOptimisticEntry?.type === "activity" &&
    lastOptimisticEntry.turn?.id === params.turn?.id &&
    latestMergedEntry?.id === lastOptimisticEntry.id;

  if (canMergeWithLastActivity) {
    const updated = updateActivityEntry(
      lastOptimisticEntry as AppServerThreadActivityEntry,
      params.details,
      params.turn,
      { suppressNoop: params.suppressDuplicateLiveActivityUpdates }
    );
    if (updated === lastOptimisticEntry) {
      return flushed;
    }

    return {
      ...flushed,
      expectOwnUpdate: true,
      interacted: true,
      lastTouchedAt: params.now,
      optimisticEntries: [
        ...flushed.optimisticEntries.slice(0, -1),
        updated,
      ],
    };
  }

  const id = `live-tools-${params.turn?.id ?? params.threadId}-${flushed.nextLiveEntrySequence}`;
  return {
    ...flushed,
    expectOwnUpdate: true,
    interacted: true,
    lastTouchedAt: params.now,
    nextLiveEntrySequence: flushed.nextLiveEntrySequence + 1,
    optimisticEntries: [
      ...flushed.optimisticEntries,
      buildLiveActivityEntry({
        id,
        createdAt: params.now,
        details: params.details,
        rendererSequence: flushed.nextLiveEntrySequence,
        turn: params.turn,
      }),
    ],
  };
}

function upsertLiveFileChangeEntry(
  current: ThreadSessionEntry,
  params: {
    delta: string;
    entryId: string;
    now: number;
    turn?: AppServerThreadTurnMetadata;
  }
): ThreadSessionEntry {
  const incomingDetails = parseFileChangeOutput(params.delta, params.entryId);
  if (incomingDetails.length === 0) {
    return current;
  }

  const flushed = flushPendingAssistantToOptimistic(current);
  const matchingIndex = flushed.optimisticEntries.findIndex(
    (entry): entry is AppServerThreadActivityEntry =>
      entry.type === "activity" && entry.id === params.entryId
  );

  if (matchingIndex !== -1) {
    const optimisticEntries = [...flushed.optimisticEntries];
    const existing = optimisticEntries[matchingIndex] as AppServerThreadActivityEntry;
    const mergedDetails = mergeActivityDetails(existing.details, incomingDetails);
    optimisticEntries[matchingIndex] = {
      ...existing,
      summary: formatChangedFileSummary({
        count: mergedDetails.length,
        prefix: "Changed",
        additions: 0,
        removals: 0,
      }),
      details: mergedDetails,
      ...(existing.turn ?? params.turn ? { turn: existing.turn ?? params.turn } : {}),
    };
    return {
      ...flushed,
      expectOwnUpdate: true,
      interacted: true,
      lastTouchedAt: params.now,
      optimisticEntries,
    };
  }

  const entry = buildFileChangeOutputEntry({
    delta: params.delta,
    id: params.entryId,
    createdAt: params.now,
    rendererSequence: flushed.nextLiveEntrySequence,
    turn: params.turn,
  });
  if (!entry) {
    return current;
  }

  return {
    ...flushed,
    expectOwnUpdate: true,
    interacted: true,
    lastTouchedAt: params.now,
    nextLiveEntrySequence: flushed.nextLiveEntrySequence + 1,
    optimisticEntries: [...flushed.optimisticEntries, entry],
  };
}

function appendLiveCommandOutputDelta(
  current: ThreadSessionEntry,
  params: {
    delta: string;
    itemId: string;
    now: number;
  }
): ThreadSessionEntry {
  const matchingIndex = current.optimisticEntries.findIndex(
    (entry): entry is AppServerThreadActivityEntry =>
      entry.type === "activity" &&
      entry.details.some((detail) => detail.id === params.itemId)
  );
  if (matchingIndex === -1) {
    return current;
  }

  const optimisticEntries = [...current.optimisticEntries];
  optimisticEntries[matchingIndex] = appendCommandOutputDelta(
    optimisticEntries[matchingIndex] as AppServerThreadActivityEntry,
    {
      delta: params.delta,
      itemId: params.itemId,
    }
  );

  return {
    ...current,
    expectOwnUpdate: true,
    interacted: true,
    lastTouchedAt: params.now,
    optimisticEntries,
  };
}

function messageMatchesOptimisticEntry(
  message: AppServerThreadMessage,
  entry: AppServerThreadMessageEntry,
  options: { allowImageUrlMismatch?: boolean } = {}
): boolean {
  if (!messageTextMatchesOptimisticEntry(message, entry)) {
    return false;
  }

  const entryImages = (entry.parts ?? []).filter((part) => part.type === "image");
  if (entryImages.length === 0) {
    return true;
  }

  const messageImages = (message.parts ?? []).filter((part) => part.type === "image");
  if (
    options.allowImageUrlMismatch &&
    messageImages.length === entryImages.length
  ) {
    return true;
  }

  return (
    messageImages.length === entryImages.length &&
    entryImages.every((image, index) => messageImages[index]?.url === image.url)
  );
}

function messageTextMatchesOptimisticEntry(
  message: AppServerThreadMessage,
  entry: AppServerThreadMessageEntry
): boolean {
  if (
    message.role !== entry.role ||
    normalizeComposerFileReferenceText(message.text) !==
      normalizeComposerFileReferenceText(entry.text)
  ) {
    return false;
  }

  return true;
}

type LaunchpadMessageCandidate = {
  entry: AppServerThreadMessageEntry;
  turnId?: string;
};

function buildLaunchpadMessageCandidate(params: {
  optimisticActiveTurnId?: string;
  optimisticUserMessage: NonNullable<
    NavigationThreadSummary["optimisticUserMessage"]
  >;
  threadKey: string;
}): LaunchpadMessageCandidate {
  return {
    entry: {
      type: "message",
      id: `optimistic-launchpad-${params.threadKey}`,
      role: "user",
      text: params.optimisticUserMessage.text,
      parts: [
        ...(params.optimisticUserMessage.text
          ? [{ type: "text" as const, text: params.optimisticUserMessage.text }]
          : []),
        ...(params.optimisticUserMessage.imageParts ?? []),
      ],
      createdAt: params.optimisticUserMessage.createdAt ?? Date.now(),
    },
    turnId: params.optimisticActiveTurnId,
  };
}

function matchesAuthoritativeLaunchpadMessage(
  message: AppServerThreadMessageEntry,
  candidate: LaunchpadMessageCandidate
): boolean {
  if (
    candidate.turnId
    && message.turn?.id
    && message.turn.id !== candidate.turnId
  ) {
    return false;
  }

  return messageMatchesOptimisticEntry(message, candidate.entry, {
    allowImageUrlMismatch: true,
  });
}

function hasAuthoritativeLaunchpadMessageProjection(params: {
  candidate: LaunchpadMessageCandidate;
  entries: AppServerThreadEntry[];
  messages: AppServerThreadMessage[];
  reconciledMessageId?: string;
}): boolean {
  if (params.reconciledMessageId) {
    return params.messages.some(
      (message) => message.id === params.reconciledMessageId
    );
  }

  const messageEntriesById = new Map<string, AppServerThreadMessageEntry>();
  for (const entry of params.entries) {
    if (entry.type === "message") {
      messageEntriesById.set(entry.id, entry);
    }
  }

  return params.messages.some((message) => {
    if (
      !messageMatchesOptimisticEntry(message, params.candidate.entry, {
        allowImageUrlMismatch: true,
      })
    ) {
      return false;
    }

    const matchingEntry = messageEntriesById.get(message.id);
    if (!matchingEntry) {
      // A message without its renderable entry is the split-hydration case
      // this placeholder bridges. Once an entry exists, its turn disambiguates
      // identical text submitted by a different turn.
      return true;
    }
    if (
      params.candidate.turnId
      && matchingEntry.turn?.id !== params.candidate.turnId
    ) {
      return false;
    }

    return matchesAuthoritativeLaunchpadMessage(
      matchingEntry,
      params.candidate,
    );
  });
}

function mergeCompletedUserMessageWithOptimisticEntry(
  message: AppServerThreadMessageEntry,
  optimisticEntries: AppServerThreadEntry[]
): AppServerThreadMessageEntry {
  const optimisticEntry = optimisticEntries.find(
    (entry): entry is AppServerThreadMessageEntry =>
      entry.type === "message" &&
      message.role === "user" &&
      messageTextMatchesOptimisticEntry(message, entry)
  );
  if (!optimisticEntry) {
    return message;
  }

  const preservePresentation = shouldPreserveOptimisticMessagePresentation(
    message,
    optimisticEntry,
  );
  const optimisticImageParts = optimisticEntry.parts?.some(
    (part) => part.type === "image",
  );
  if (!preservePresentation && !optimisticImageParts) {
    return message;
  }

  return {
    ...message,
    ...(preservePresentation ? { text: optimisticEntry.text } : {}),
    ...(optimisticEntry.parts ? { parts: optimisticEntry.parts } : {}),
    createdAt: optimisticEntry.createdAt ?? message.createdAt,
  };
}

function isOptimisticUserMessageEntry(
  entry: AppServerThreadEntry
): entry is AppServerThreadMessageEntry {
  return (
    entry.type === "message" &&
    entry.role === "user" &&
    entry.id.startsWith("optimistic-")
  );
}

function findPromotedOptimisticUserMessageEntry(
  response: AppServerReadThreadResponse | undefined,
  message: AppServerThreadMessageEntry
): AppServerThreadMessageEntry | undefined {
  return response?.replay.entries.find(
    (entry): entry is AppServerThreadMessageEntry =>
      isOptimisticUserMessageEntry(entry) &&
      messageTextMatchesOptimisticEntry(message, entry)
  );
}

function mergeCompletedUserMessageWithPromotedOptimisticEntry(
  message: AppServerThreadMessageEntry,
  response: AppServerReadThreadResponse | undefined
): AppServerThreadMessageEntry {
  const optimisticEntry = findPromotedOptimisticUserMessageEntry(response, message);
  if (!optimisticEntry) {
    return message;
  }

  const preservePresentation = shouldPreserveOptimisticMessagePresentation(
    message,
    optimisticEntry,
  );
  const optimisticImageParts = optimisticEntry.parts?.some(
    (part) => part.type === "image"
  )
    ? optimisticEntry.parts
    : undefined;

  return {
    ...message,
    ...(preservePresentation ? { text: optimisticEntry.text } : {}),
    ...(optimisticImageParts ? { parts: optimisticImageParts } : {}),
    createdAt: optimisticEntry.createdAt ?? message.createdAt,
  };
}

function removePromotedOptimisticUserMessage(
  response: AppServerReadThreadResponse | undefined,
  completedUserMessage: AppServerThreadMessageEntry
): AppServerReadThreadResponse | undefined {
  if (!response) {
    return response;
  }

  const optimisticEntry = findPromotedOptimisticUserMessageEntry(
    response,
    completedUserMessage
  );
  if (!optimisticEntry) {
    return response;
  }

  const entries = response.replay.entries.filter(
    (entry) => entry.id !== optimisticEntry.id
  );
  const messages = response.replay.messages.filter(
    (message) => message.id !== optimisticEntry.id
  );

  if (
    entries.length === response.replay.entries.length &&
    messages.length === response.replay.messages.length
  ) {
    return response;
  }

  return {
    ...response,
    replay: {
      ...response.replay,
      entries,
      messages,
    },
  };
}

function findAuthoritativeUserMessageForOptimisticEntry(params: {
  entry: AppServerThreadMessageEntry;
  response: AppServerReadThreadResponse | undefined;
  turnId: string | undefined;
}): AppServerThreadMessageEntry | undefined {
  if (!params.turnId) {
    return undefined;
  }

  return params.response?.replay.entries.find(
    (entry): entry is AppServerThreadMessageEntry =>
      entry.type === "message"
      && entry.role === "user"
      && !entry.id.startsWith("optimistic-")
      && entry.turn?.id === params.turnId
      && messageMatchesOptimisticEntry(entry, params.entry, {
        allowImageUrlMismatch: true,
      })
  );
}

function appendMessageEntries(
  response: AppServerReadThreadResponse | undefined,
  params: {
    backend: NavigationThreadSummary["source"];
    threadId: NavigationThreadSummary["id"];
  },
  entries: AppServerThreadMessageEntry[]
): AppServerReadThreadResponse {
  const baseResponse = response ?? buildEmptyResponse(params);
  const nextMessages: AppServerThreadMessage[] = entries.map(
    ({ type: _type, ...message }) => message
  );
  let lastUserMessage = baseResponse.replay.lastUserMessage;
  let lastAssistantMessage = baseResponse.replay.lastAssistantMessage;

  for (const message of nextMessages) {
    if (message.role === "user") {
      lastUserMessage = message.text;
      continue;
    }

    lastAssistantMessage = message.text;
  }

  return {
    ...baseResponse,
    fetchedAt: Date.now(),
    replay: {
      ...baseResponse.replay,
      entries: mergeTranscriptEntries(baseResponse.replay.entries, entries),
      messages: mergeTranscriptMessages(baseResponse.replay.messages, nextMessages),
      lastUserMessage,
      lastAssistantMessage,
    },
  };
}

function appendThreadEntries(
  response: AppServerReadThreadResponse | undefined,
  params: {
    backend: NavigationThreadSummary["source"];
    threadId: NavigationThreadSummary["id"];
  },
  entries: AppServerThreadEntry[]
): AppServerReadThreadResponse {
  const baseResponse = response ?? buildEmptyResponse(params);
  return {
    ...baseResponse,
    fetchedAt: Date.now(),
    replay: {
      ...baseResponse.replay,
      entries: mergeTranscriptEntries(baseResponse.replay.entries, entries),
    },
  };
}

function appendPendingAssistantMessage(
  response: AppServerReadThreadResponse | undefined,
  params: {
    backend: NavigationThreadSummary["source"];
    threadId: NavigationThreadSummary["id"];
  },
  optimisticEntries: AppServerThreadMessageEntry[],
  pendingAssistantMessage: AppServerThreadMessageEntry | undefined
): AppServerReadThreadResponse | undefined {
  if (!pendingAssistantMessage) {
    return response;
  }

  return appendMessageEntries(response, params, [
    ...optimisticEntries,
    pendingAssistantMessage,
  ]);
}

function reviewEntryFromCompletedItem(params: {
  turnId?: string;
  item?: {
    createdAt?: number;
    created_at?: number;
    id: string;
    type: string;
    review?: string;
    text?: string;
    data?: Record<string, unknown>;
  };
}): AppServerThreadReviewEntry | undefined {
  const item = params.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }

  const record = item as {
    id?: unknown;
    createdAt?: unknown;
    created_at?: unknown;
    type?: unknown;
    review?: unknown;
    text?: unknown;
    data?: Record<string, unknown>;
  };
  if (record.type !== "enteredReviewMode" && record.type !== "exitedReviewMode") {
    return undefined;
  }

  const review =
    typeof record.review === "string"
      ? record.review
      : typeof record.text === "string"
        ? record.text
        : "";
  const displayText =
    record.type === "enteredReviewMode"
      ? review
        ? normalizeReviewDisplayText(review)
        : "Code review started"
      : undefined;
  const output = normalizeReviewOutputRecord(record.data?.reviewOutput);
  const reviewer = normalizeReviewer(record.data?.reviewer);
  const context = normalizeReviewContext(record.data?.context);
  const turn = buildTurnMetadata({
    fallbackId: typeof params.turnId === "string" ? params.turnId : undefined,
    fallbackStatus:
      record.type === "enteredReviewMode" ? "in_progress" : "completed",
  });

  return {
    type: "review",
    id: typeof record.id === "string" ? record.id : `review-${record.type}`,
    review: displayText ?? review,
    ...(displayText ? { displayText } : {}),
    ...(output ? { output } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(context ? { context } : {}),
    ...(turn ? { turn } : {}),
    createdAt:
      normalizeNotificationTimestamp(record.createdAt) ??
      normalizeNotificationTimestamp(record.created_at) ??
      Date.now(),
  };
}

function normalizeReviewer(
  value: unknown,
): AppServerThreadReviewEntry["reviewer"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const backend = record.backend;
  if (typeof backend !== "string" || !isAppServerBackendKind(backend)) {
    return undefined;
  }
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : undefined;
  const reasoningEffort =
    typeof record.reasoningEffort === "string" && record.reasoningEffort.trim()
      ? record.reasoningEffort.trim()
      : undefined;
  return {
    backend,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * The registry freezes a review's workspace, branch, and pull request onto the
 * live `item/completed` notification the same way it freezes `reviewer`, so
 * this has to read it back the same way. Without it the provenance row is
 * dropped on the native review path even though the main process put it on the
 * wire.
 *
 * `pullRequest: null` is load-bearing and survives: it means the branch was
 * checked and carried no pull request, which the card renders differently from
 * an absent field.
 */
function normalizeReviewContext(
  value: unknown,
): AppServerThreadReviewEntry["context"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const workspacePath = readTrimmedString(record.workspacePath);
  if (!workspacePath) {
    return undefined;
  }
  const projectLabel = readTrimmedString(record.projectLabel);
  const repositoryPath = readTrimmedString(record.repositoryPath);
  const gitBranch = readTrimmedString(record.gitBranch);
  const baseBranch = readTrimmedString(record.baseBranch);
  const pullRequest = normalizeReviewPullRequest(record.pullRequest);
  return {
    workspacePath,
    ...(projectLabel ? { projectLabel } : {}),
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(record.pullRequest === null || pullRequest
      ? { pullRequest: pullRequest ?? null }
      : {}),
  };
}

function normalizeReviewPullRequest(
  value: unknown,
): NonNullable<AppServerThreadReviewEntry["context"]>["pullRequest"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = readTrimmedString(record.provider);
  const org = readTrimmedString(record.org);
  const repo = readTrimmedString(record.repo);
  const url = readTrimmedString(record.url);
  const number = record.number;
  if (
    !provider
    || !org
    || !repo
    || !url
    || typeof number !== "number"
    || !Number.isFinite(number)
  ) {
    return undefined;
  }
  const title = readTrimmedString(record.title);
  const headRefName = readTrimmedString(record.headRefName);
  const baseRefName = readTrimmedString(record.baseRefName);
  return {
    provider,
    org,
    repo,
    number,
    url,
    ...(title ? { title } : {}),
    ...(headRefName ? { headRefName } : {}),
    ...(baseRefName ? { baseRefName } : {}),
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function messageContentFromUserItem(item: Record<string, unknown>): {
  parts?: AppServerThreadMessageEntry["parts"];
  text: string;
} {
  type MessagePart = NonNullable<AppServerThreadMessageEntry["parts"]>[number];
  const content = Array.isArray(item.content) ? item.content : [];
  const parts: MessagePart[] = content
    .map((part): MessagePart | undefined => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return undefined;
      }

      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return { type: "text", text: record.text };
      }

      const imageUrl =
        typeof record.url === "string"
          ? record.url
          : typeof record.image_url === "string"
            ? record.image_url
            : undefined;
      if (
        imageUrl &&
        (record.type === "image" ||
          record.type === "input_image" ||
          record.type === "image_url")
      ) {
        const alt =
          typeof record.alt === "string"
            ? record.alt
            : typeof record.name === "string"
              ? record.name
              : undefined;
        return {
          type: "image",
          url: imageUrl,
          ...(alt ? { alt } : {}),
        };
      }

      return undefined;
    })
    .filter((part): part is MessagePart => Boolean(part));
  const text =
    parts
      .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n") ||
    (typeof item.text === "string" ? item.text.trim() : "");

  return {
    ...(parts.length > 0 ? { parts } : {}),
    text,
  };
}

function userMessageEntryFromItem(params: {
  turnId?: string;
  item?: {
    id?: string;
    type?: string;
    content?: unknown;
    text?: unknown;
  };
}): AppServerThreadMessageEntry | undefined {
  const item = params.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  if (record.type !== "userMessage") {
    return undefined;
  }

  const content = messageContentFromUserItem(record);
  if (!content.text && !content.parts?.length) {
    return undefined;
  }

  const turn = buildTurnMetadata({
    fallbackId: typeof params.turnId === "string" ? params.turnId : undefined,
    fallbackStatus: "in_progress",
  });
  const origin = threadMessageOriginFromUnknown(record.origin);

  return {
    type: "message",
    id: typeof record.id === "string" ? record.id : `user-${Date.now()}`,
    role: "user",
    text: content.text,
    ...(content.parts ? { parts: content.parts } : {}),
    ...(origin ? { origin } : {}),
    ...(turn ? { turn } : {}),
    createdAt: Date.now(),
  };
}

function threadMessageOriginFromUnknown(
  value: unknown,
): AppServerThreadMessageOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "agent"
    && record.kind !== "automation"
    && record.kind !== "messaging"
    && record.kind !== "pwragent"
    && record.kind !== "sub-agent"
  ) {
    return undefined;
  }
  const messaging = threadMessageMessagingOriginFromUnknown(record.messaging);
  const subAgent =
    record.kind === "sub-agent"
      ? threadMessageSubAgentOriginFromUnknown(record.subAgent)
      : undefined;
  const source = record.sourceThread;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {
      kind: record.kind,
      ...(messaging ? { messaging } : {}),
      ...(subAgent ? { subAgent } : {}),
    };
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    typeof sourceRecord.backend !== "string"
    || typeof sourceRecord.threadId !== "string"
  ) {
    return {
      kind: record.kind,
      ...(messaging ? { messaging } : {}),
    };
  }
  return {
    kind: record.kind,
    sourceThread: {
      backend: sourceRecord.backend as AppServerBackendKind,
      ...(typeof sourceRecord.instanceId === "string"
        ? { instanceId: sourceRecord.instanceId }
        : {}),
      ...(typeof sourceRecord.instanceLabel === "string"
        ? { instanceLabel: sourceRecord.instanceLabel }
        : {}),
      ...(isCelestialIconId(sourceRecord.celestialIcon)
        ? { celestialIcon: sourceRecord.celestialIcon }
        : {}),
      threadId: sourceRecord.threadId,
      ...(typeof sourceRecord.title === "string"
        ? { title: sourceRecord.title }
        : {}),
    },
    ...(messaging ? { messaging } : {}),
    ...(subAgent ? { subAgent } : {}),
  };
}

function threadMessageSubAgentOriginFromUnknown(
  value: unknown,
): AppServerThreadMessageOrigin["subAgent"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "monitor"
    || typeof record.monitorId !== "string"
    || typeof record.task !== "string"
    || typeof record.summary !== "string"
    || (
      record.outcome !== "success"
      && record.outcome !== "failure"
      && record.outcome !== "cancelled"
    )
  ) {
    return undefined;
  }
  return {
    kind: "monitor",
    monitorId: record.monitorId,
    task: record.task,
    outcome: record.outcome,
    summary: record.summary,
  };
}

function threadMessageMessagingOriginFromUnknown(
  value: unknown,
): AppServerThreadMessageOrigin["messaging"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const surface = record.surface;
  const actor = record.actor;
  if (
    typeof record.platform !== "string"
    || !isMessagingChannelKind(record.platform)
    || !surface
    || typeof surface !== "object"
    || Array.isArray(surface)
    || !actor
    || typeof actor !== "object"
    || Array.isArray(actor)
  ) {
    return undefined;
  }
  const surfaceRecord = surface as Record<string, unknown>;
  const actorRecord = actor as Record<string, unknown>;
  if (
    typeof surfaceRecord.id !== "string"
    || typeof surfaceRecord.kind !== "string"
    || !isMessagingConversationKind(surfaceRecord.kind)
    || typeof actorRecord.platformUserId !== "string"
  ) {
    return undefined;
  }
  return {
    platform: record.platform,
    ...(typeof record.sourceUrl === "string"
      ? { sourceUrl: record.sourceUrl }
      : {}),
    surface: {
      id: surfaceRecord.id,
      kind: surfaceRecord.kind,
      ...(typeof surfaceRecord.title === "string"
        ? { title: surfaceRecord.title }
        : {}),
      ...(typeof surfaceRecord.parentTitle === "string"
        ? { parentTitle: surfaceRecord.parentTitle }
        : {}),
      ...(typeof surfaceRecord.ancestorTitle === "string"
        ? { ancestorTitle: surfaceRecord.ancestorTitle }
        : {}),
    },
    actor: {
      platformUserId: actorRecord.platformUserId,
      ...(typeof actorRecord.displayName === "string"
        ? { displayName: actorRecord.displayName }
        : {}),
      ...(typeof actorRecord.phoneNumber === "string"
        ? { phoneNumber: actorRecord.phoneNumber }
        : {}),
      ...(typeof actorRecord.username === "string"
        ? { username: actorRecord.username }
        : {}),
    },
  };
}

function isMessagingChannelKind(value: string): value is MessagingChannelKind {
  return [
    "telegram",
    "discord",
    "slack",
    "mattermost",
    "feishu",
    "googlechat",
    "msteams",
    "matrix",
    "irc",
    "imessage",
    "signal",
    "whatsapp",
    "line",
    "zalo",
    "nextcloud-talk",
    "synology-chat",
    "twitch",
    "nostr",
    "qqbot",
    "bluebubbles",
    "tlon",
    "voice-call",
    "custom",
  ].includes(value);
}

function isMessagingConversationKind(
  value: string,
): value is MessagingConversationKind {
  return ["dm", "channel", "thread", "topic"].includes(value);
}

function assistantMessageEntryFromCompletedItem(params: {
  itemParams: AppServerNotification["params"];
  turn: AppServerThreadTurnMetadata | undefined;
}): AppServerThreadMessageEntry | undefined {
  const itemParams = params.itemParams as Record<string, unknown>;
  const item = itemParams.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  const itemType =
    typeof record.type === "string"
      ? record.type.replace(/[-_\s]/g, "").toLowerCase()
      : undefined;
  if (
    itemType !== "agentmessage" &&
    itemType !== "assistantmessage" &&
    itemType !== "assistant"
  ) {
    return undefined;
  }

  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    return undefined;
  }

  const id =
    typeof record.id === "string" && record.id.trim()
      ? record.id
      : typeof record.itemId === "string" && record.itemId.trim()
        ? record.itemId
        : typeof record.item_id === "string" && record.item_id.trim()
          ? record.item_id
          : typeof itemParams.turnId === "string"
            ? `${itemParams.turnId}:assistant`
            : `assistant-${Date.now()}`;
  const phase = normalizeLiveAssistantMessagePhase(record.phase);

  return {
    type: "message",
    id,
    role: "assistant",
    text,
    createdAt: Date.now(),
    ...(params.turn ? { turn: params.turn } : {}),
    ...(phase ? { phase } : {}),
  };
}

function isTransientTaskMonitorItem(
  item: Record<string, unknown> | undefined,
): boolean {
  if (!item) {
    return false;
  }

  const data = readRecord(item.data);
  return (
    (data?.source === "pwragent_task_monitor"
      || item.source === "pwragent_task_monitor")
    && (data?.transient === true || item.transient === true)
  );
}

function hasReviewEntryForTurn(
  response: AppServerReadThreadResponse | undefined,
  turnId: string | undefined
): boolean {
  if (!response || !turnId) {
    return false;
  }

  return response.replay.entries.some(
    (entry) => entry.type === "review" && entry.turn?.id === turnId
  );
}

function hasCompletedAssistantMessageForTurn(
  response: AppServerReadThreadResponse | undefined,
  turnId: string | undefined,
  text: string | undefined
): boolean {
  if (!response || !turnId || !text) {
    return false;
  }

  const normalizedText = normalizeTranscriptText(text);
  return response.replay.entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.role === "assistant" &&
      entry.phase !== "commentary" &&
      entry.turn?.id === turnId &&
      normalizeTranscriptText(entry.text) === normalizedText
  );
}

function retainSessionCache(
  sessions: ThreadSessionState,
  selectedThreadKey?: string
): ThreadSessionState {
  const interactedEntries: Array<[string, ThreadSessionEntry]> = [];
  const viewOnlyEntries: Array<[string, ThreadSessionEntry]> = [];

  for (const entry of Object.entries(sessions)) {
    const [threadKey, session] = entry;
    if (threadKey === selectedThreadKey || session.interacted) {
      interactedEntries.push(entry);
    } else {
      viewOnlyEntries.push(entry);
    }
  }

  viewOnlyEntries.sort((left, right) => right[1].lastTouchedAt - left[1].lastTouchedAt);

  return Object.fromEntries([
    ...interactedEntries,
    ...viewOnlyEntries.slice(0, MAX_VIEW_ONLY_THREADS),
  ]);
}

function isApprovalRequestNotification(
  notification: { method: string; params: Record<string, unknown> }
): notification is AppServerPendingRequestNotification {
  return (
    SUPPORTED_APPROVAL_REQUEST_METHODS.has(notification.method) &&
    typeof notification.params.requestId === "string"
  );
}

function isRequestUserInputNotification(
  notification: { method: string; params: Record<string, unknown> }
): notification is AppServerToolRequestUserInputNotification {
  return (
    notification.method === "item/tool/requestUserInput" &&
    typeof notification.params.threadId === "string" &&
    typeof notification.params.requestId === "string" &&
    Array.isArray(notification.params.questions)
  );
}

function isMcpElicitationNotification(
  notification: { method: string; params: Record<string, unknown> }
): notification is AppServerMcpElicitationRequestNotification {
  return (
    notification.method === "mcpServer/elicitation/request" &&
    typeof notification.params.threadId === "string" &&
    typeof notification.params.requestId === "string" &&
    typeof notification.params.serverName === "string" &&
    typeof notification.params.message === "string" &&
    (notification.params.mode === "form" || notification.params.mode === "url")
  );
}

const TRANSIENT_MESSAGE_SETTLEMENT_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/started",
  "thread/compacted",
  "thread/rewound",
  "turn/cancelled",
  "turn/completed",
  "turn/failed",
  "turn/started",
]);

const MAX_SETTLED_TRANSIENT_MESSAGES = 50;

function settleTransientMessage(
  current: ThreadSessionEntry,
): ThreadSessionEntry {
  if (!current.transientMessage) {
    return current;
  }
  const sequence =
    readRendererSequence(current.transientMessage)
    ?? current.nextLiveEntrySequence;
  const settledTransientMessage = {
    ...current.transientMessage,
    id: `${current.transientMessage.id}:settled:${sequence}`,
  };
  return {
    ...current,
    settledTransientMessages: [
      ...current.settledTransientMessages,
      settledTransientMessage,
    ].slice(-MAX_SETTLED_TRANSIENT_MESSAGES),
    transientMessage: undefined,
  };
}

function transitionTransientMessagesAtBoundary(
  current: ThreadSessionEntry,
  notification: AppServerNotification
): ThreadSessionEntry {
  if (
    notification.method === "thread/compacted"
    || notification.method === "thread/rewound"
  ) {
    if (
      !current.transientMessage &&
      current.settledTransientMessages.length === 0
    ) {
      return current;
    }
    return {
      ...current,
      settledTransientMessages: [],
      transientMessage: undefined,
    };
  }

  if (
    !current.transientMessage ||
    notification.method === "item/transientMessage/updated"
  ) {
    return current;
  }

  const statusType =
    notification.method === "thread/status/changed" &&
    typeof notification.params.status === "object" &&
    notification.params.status !== null &&
    "type" in notification.params.status
      ? notification.params.status.type
      : undefined;
  const isBoundary =
    TRANSIENT_MESSAGE_SETTLEMENT_METHODS.has(notification.method) ||
    isApprovalRequestNotification(notification) ||
    isRequestUserInputNotification(notification) ||
    isMcpElicitationNotification(notification) ||
    statusType === "idle";
  if (!isBoundary) {
    return current;
  }

  const notificationTurnId = readNotificationTurnId(notification);
  const transientTurnId = current.transientMessage.turn?.id;
  if (
    notification.method !== "turn/started" &&
    notification.method !== "thread/compacted" &&
    notification.method !== "thread/rewound" &&
    statusType !== "idle" &&
    notificationTurnId &&
    transientTurnId &&
    notificationTurnId !== transientTurnId
  ) {
    return current;
  }

  return settleTransientMessage(current);
}

function readCompletedTurnText(
  notification: AppServerPendingRequestNotification | AppServerReadThreadResponse["backend"] | unknown
): string | undefined {
  if (
    typeof notification !== "object" ||
    notification === null ||
    !("turn" in notification)
  ) {
    return undefined;
  }

  const turnRecord = (notification as { turn?: { output?: Array<{ type: string; text?: string }> } })
    .turn;
  const text = turnRecord?.output
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n");

  return text || undefined;
}

function didHydrateCompletedTurn(
  previousResponse: AppServerReadThreadResponse | undefined,
  nextResponse: AppServerReadThreadResponse
): boolean {
  const previousMessages = previousResponse?.replay.messages.length ?? 0;
  const previousEntries = previousResponse?.replay.entries.length ?? 0;

  return (
    nextResponse.replay.messages.length > previousMessages ||
    nextResponse.replay.entries.length > previousEntries ||
    nextResponse.replay.lastAssistantMessage !==
      previousResponse?.replay.lastAssistantMessage
  );
}

export function useThreadSessionState(params: {
  desktopApi?: DesktopApi;
  initialHistoryLimit?: number;
  liveTranscriptEventFiltering?: boolean;
  suspended?: boolean;
  thread?: NavigationThreadSummary;
}): {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  addOptimisticUserMessage: (
    text: string,
    imageParts?: AppServerThreadImagePart[],
    turnId?: string,
  ) => string;
  addOptimisticReviewEntry: (displayText: string) => string;
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  entries: AppServerThreadEntry[];
  error?: string;
  expandedTranscriptActivityIds: string[];
  expandedTranscriptWorkPhaseGroupIds: string[];
  initialLoadDurationMs?: number;
  loading: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;
  reload: () => Promise<void>;
  messages: AppServerThreadMessage[];
  contextWindow?: ThreadContextWindowState;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  transientMessage?: AppServerTransientThreadMessageEntry;
  transientMessages: AppServerTransientThreadMessageEntry[];
  runningTurnUsageText?: string;
  approvalRequestThreadKeys: Record<string, boolean>;
  inputRequestThreadKeys: Record<string, boolean>;
  removeOptimisticMessage: (id: string) => void;
  renderedTranscriptEntryLimit?: number;
  response?: AppServerReadThreadResponse;
  setActiveTurnId: (turnId?: string) => void;
  upsertLiveTranscriptEntry: (entry: AppServerThreadEntry) => void;
  updatePendingUserInput: (
    requestId: string,
    updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState
  ) => void;
  updatePendingMcpInteraction: (
    requestId: string,
    updater: (state: PendingMcpInteractionState) => PendingMcpInteractionState
  ) => void;
  setPendingStatusText: (status?: string) => void;
  setExpandedTranscriptActivityIds: (activityIds: string[]) => void;
  setExpandedTranscriptWorkPhaseGroupIds: (groupIds: string[]) => void;
  setRenderedTranscriptEntryLimit: (limit: number) => void;
  threadBusy: boolean;
  thinkingThreadKeys: Record<string, boolean>;
  setViewport: (viewport?: ThreadViewportState) => void;
  viewport?: ThreadViewportState;
} {
  const {
    desktopApi,
    liveTranscriptEventFiltering = false,
    suspended = false,
    thread,
  } = params;
  const threadKey = thread
    ? threadSummaryIdentityKey(thread)
    : undefined;
  const launchpadMessageCandidate = useMemo(() => {
    if (!threadKey || !thread?.optimisticUserMessage) {
      return undefined;
    }
    return buildLaunchpadMessageCandidate({
      optimisticActiveTurnId: thread.optimisticActiveTurn?.id,
      optimisticUserMessage: thread.optimisticUserMessage,
      threadKey,
    });
  }, [
    thread?.optimisticActiveTurn?.id,
    thread?.optimisticUserMessage,
    threadKey,
  ]);
  const selectedThreadKeyRef = useRef<string | undefined>(undefined);
  const consumedOptimisticActiveTurnKeysRef = useRef<Set<string>>(new Set());
  const launchpadMessageCandidateRef = useRef<{
    candidate: LaunchpadMessageCandidate;
    threadKey: string;
  } | undefined>(undefined);
  const reconciledLaunchpadMessageIdsRef = useRef<Record<string, string>>({});
  const lastLiveActivitySignatureRef = useRef<Record<string, string>>({});
  const loadedHistoryIndexesRef = useRef<Record<string, TranscriptHistoryIndex>>({});
  // Avoid copying and rescanning every previously retained live aggregate on
  // each ThreadView callback. Map insertion order preserves same-id upserts.
  const retainedLiveEntriesRef = useRef<
    Record<string, Map<string, AppServerThreadEntry>>
  >({});
  const requestVersionsRef = useRef<Record<string, number>>({});
  const staleThinkingLogKeysRef = useRef<Set<string>>(new Set());
  const threadStatusSummarySeedRef = useRef<Record<string, string>>({});
  const [sessions, setSessions] = useState<ThreadSessionState>({});

  selectedThreadKeyRef.current = threadKey;
  if (launchpadMessageCandidateRef.current?.threadKey !== threadKey) {
    launchpadMessageCandidateRef.current = undefined;
  }
  if (
    threadKey
    && launchpadMessageCandidate
    && reconciledLaunchpadMessageIdsRef.current[threadKey] === undefined
  ) {
    launchpadMessageCandidateRef.current = {
      candidate: launchpadMessageCandidate,
      threadKey,
    };
  }

  useEffect(() => {
    const retainedThreadKeys = new Set(Object.keys(sessions));
    for (const indexedThreadKey of Object.keys(loadedHistoryIndexesRef.current)) {
      if (!retainedThreadKeys.has(indexedThreadKey)) {
        delete loadedHistoryIndexesRef.current[indexedThreadKey];
      }
    }
    for (const retainedThreadKey of Object.keys(retainedLiveEntriesRef.current)) {
      if (!retainedThreadKeys.has(retainedThreadKey)) {
        delete retainedLiveEntriesRef.current[retainedThreadKey];
      }
    }
    for (
      const reconciledThreadKey of Object.keys(
        reconciledLaunchpadMessageIdsRef.current,
      )
    ) {
      if (!retainedThreadKeys.has(reconciledThreadKey)) {
        delete reconciledLaunchpadMessageIdsRef.current[reconciledThreadKey];
      }
    }
  }, [sessions]);

  const updateSession = useCallback(
    (
      targetThreadKey: string,
      updater: (current: ThreadSessionEntry) => ThreadSessionEntry
    ): void => {
      setSessions((current) => {
        const previous = current[targetThreadKey] ?? createEmptyThreadSessionEntry();
        const previousThinking = hasThinkingState(previous);
        let next = updater(previous);
        const nextThinking = hasThinkingState(next);
        if (next !== previous && previousThinking !== nextThinking) {
          next = {
            ...next,
            thinkingSinceAt: nextThinking
              ? previous.thinkingSinceAt ?? Date.now()
              : undefined,
          };
        }
        if (next === previous) {
          return current;
        }

        return retainSessionCache(
          {
            ...current,
            [targetThreadKey]: next,
          },
          selectedThreadKeyRef.current
        );
      });
    },
    []
  );

  const logStaleThinkingState = useCallback(
    (params: {
      current: ThreadSessionEntry;
      reasons: ThinkingStateReason[];
      response: AppServerReadThreadResponse;
      targetThreadKey: string;
    }): void => {
      const logRendererDiagnostic = desktopApi?.logRendererDiagnostic;
      if (!logRendererDiagnostic) {
        return;
      }

      const reasonSignature = params.reasons
        .map((reason) =>
          [
            reason.kind,
            reason.entryType,
            reason.entryId,
            reason.entryStatus,
            reason.turnId,
            reason.turnStatus,
          ].filter(Boolean).join(":")
        )
        .join("|");
      const logKey = `${params.targetThreadKey}:${params.response.fetchedAt}:${reasonSignature}`;
      if (staleThinkingLogKeysRef.current.has(logKey)) {
        return;
      }
      staleThinkingLogKeysRef.current.add(logKey);

      void logRendererDiagnostic({
        details: {
          activeTurnId: params.current.activeTurnId,
          expectOwnUpdate: params.current.expectOwnUpdate,
          lastTouchedAt: params.current.lastTouchedAt,
          optimisticEntries: summarizeOptimisticEntries(
            params.current.optimisticEntries
          ),
          pendingAssistantMessageId: params.current.pendingAssistantMessage?.id,
          pendingMcpInteraction: Boolean(params.current.pendingMcpInteraction),
          pendingRequestId: params.current.pendingRequest?.params.requestId,
          pendingStatusText: params.current.pendingStatusText,
          pendingUserInput: Boolean(params.current.pendingUserInput),
          reasons: params.reasons,
          staleAgeMs: params.current.thinkingSinceAt
            ? Date.now() - params.current.thinkingSinceAt
            : undefined,
          threadKey: params.targetThreadKey,
          threadStatus: readResponseThreadStatus(params.response),
        },
        level: "warn",
        message: "stale thinking state cleared after idle thread read",
      }).catch(() => undefined);
    },
    [desktopApi?.logRendererDiagnostic]
  );

  const initialHistoryLimit = params.initialHistoryLimit;

  const loadLatest = useCallback(
    async (targetThread: NavigationThreadSummary): Promise<void> => {
      if (suspended) {
        return;
      }
      const readThread = desktopApi?.readThread;
      const targetThreadKey = threadSummaryIdentityKey(targetThread);
      const hydrationVersion = getThreadHydrationVersion(targetThread);

      if (!readThread) {
        updateSession(targetThreadKey, (current) => ({
          ...current,
          error: "Desktop bridge is missing readThread().",
          failedHydrationVersion: hydrationVersion,
          lastTouchedAt: Date.now(),
          loading: false,
          loadingMore: false,
        }));
        return;
      }

      const requestVersion = (requestVersionsRef.current[targetThreadKey] ?? 0) + 1;
      requestVersionsRef.current[targetThreadKey] = requestVersion;

      updateSession(targetThreadKey, (current) => ({
        ...current,
        error: undefined,
        failedHydrationVersion: undefined,
        lastTouchedAt: Date.now(),
        loading: true,
        // A latest hydration supersedes any older-page read for the same
        // thread. Its request-version bump makes that page response stale, so
        // release the loading state here instead of waiting for a response
        // that will intentionally be discarded (or may never arrive).
        loadingMore: false,
      }));

      try {
        desktopApi?.recordStartupProfileEvent?.("thread-hydration:start", {
          backend: targetThread.source,
          threadId: targetThread.id,
        });
        const response = normalizeResponseImageBoundaryText(await readThread({
          backend: targetThread.source,
          ...(initialHistoryLimit !== undefined
            ? { limit: initialHistoryLimit }
            : {}),
          federationTarget: targetThread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: targetThread.id,
        }));
        desktopApi?.recordStartupProfileEvent?.("thread-hydration:response", {
          backend: targetThread.source,
          entryCount: response.replay.entries.length,
          threadId: targetThread.id,
        });

        if (requestVersionsRef.current[targetThreadKey] !== requestVersion) {
          return;
        }
        if (
          !response.replay.pagination.supportsPagination
          || !response.replay.pagination.hasPreviousPage
        ) {
          delete loadedHistoryIndexesRef.current[targetThreadKey];
        }

        updateSession(targetThreadKey, (current) => {
          const retainedLiveEntryStore =
            retainedLiveEntriesRef.current[targetThreadKey];
          const retainedLiveEntries = retainedLiveEntryStore
            ? [...retainedLiveEntryStore.values()]
            : [];
          const liveTranscriptSources = [
            ...current.optimisticEntries,
            ...retainedLiveEntries,
            ...(current.pendingAssistantMessage ? [current.pendingAssistantMessage] : []),
          ];
          const transcriptOrderSources = mergeTranscriptEntries(
            current.response?.replay.entries ?? [],
            liveTranscriptSources
          );
          const orderedResponse = carryForwardTranscriptEntryOrder(
            response,
            transcriptOrderSources,
            liveTranscriptSources
          );
          const responseWithRetainedTail = preserveRetainedTranscriptTail(
            orderedResponse,
            current.response,
            Boolean(current.loadedHistory),
          );
          const hydratedPendingRequest = response.pendingRequest;
          const hydratedPendingUserInput =
            hydratedPendingRequest && isRequestUserInputNotification(hydratedPendingRequest)
              ? createQuestionnaireState(hydratedPendingRequest)
              : undefined;
          const hydratedPendingMcpInteraction =
            hydratedPendingRequest && isMcpElicitationNotification(hydratedPendingRequest)
              ? createMcpElicitationState(hydratedPendingRequest)
              : undefined;
          const hydratedApprovalRequest =
            hydratedPendingRequest && isApprovalRequestNotification(hydratedPendingRequest)
              ? hydratedPendingRequest
              : undefined;
          const hydratedPendingInteraction = Boolean(
            hydratedPendingUserInput
            || hydratedPendingMcpInteraction
            || hydratedApprovalRequest
          );
          const hydratedPendingTurnId = hydratedPendingRequest
            ? readNotificationTurnId(hydratedPendingRequest)
            : undefined;
          const hydratedCompletedTurn = didHydrateCompletedTurn(
            current.response,
            responseWithRetainedTail
          );
          const needsHydrationAfterCompletion =
            current.needsHydrationAfterCompletion && !hydratedCompletedTurn;
          const completionHydrationRetries = needsHydrationAfterCompletion
            ? current.completionHydrationRetries + 1
            : 0;
          const thinkingReasons = describeThinkingState(current);
          const responseThreadStatus = readResponseThreadStatus(response);
          const backendReportedActive =
            responseThreadStatus === "active"
              ? true
              : responseThreadStatus === "idle"
                ? false
                : current.backendReportedActive;
          const now = Date.now();
          const ownUpdateSettlesAt =
            current.lastTouchedAt + OWN_UPDATE_IDLE_GRACE_MS;
          const ownUpdateStillSettling =
            current.expectOwnUpdate
            && !targetThread.optimisticActiveTurn
            && responseHasInProgressTurn(current.response ?? response, current.activeTurnId)
            && !response.replay.entries.some(
              (entry) =>
                entry.turn?.id === current.activeTurnId
                && isCompletedTurnMetadata(entry.turn)
            )
            && now < ownUpdateSettlesAt;
          const reviewUpdateStillSettling =
            current.expectOwnUpdate
            && sessionHasInProgressReviewTurn(current, current.activeTurnId)
            && !responseHasCompletedTurn(
              responseWithRetainedTail,
              current.activeTurnId
            )
            && now < ownUpdateSettlesAt;
          const shouldClearStaleThinking =
            responseThreadStatus === "idle"
            && thinkingReasons.length > 0
            && !hasPendingInteraction(current)
            && !hydratedPendingInteraction
            && !ownUpdateStillSettling
            && !reviewUpdateStillSettling
            && !responseHasInProgressTurn(
              responseWithRetainedTail,
              current.activeTurnId
            );

          if (shouldClearStaleThinking) {
            if (targetThread.optimisticActiveTurn) {
              consumedOptimisticActiveTurnKeysRef.current.add(
                `${targetThreadKey}:${targetThread.optimisticActiveTurn.id}`
              );
            }
            logStaleThinkingState({
              current,
              reasons: thinkingReasons,
              response: responseWithRetainedTail,
              targetThreadKey,
            });
          }
          const currentAfterStaleThinking =
            shouldClearStaleThinking
              ? settleTransientMessage(current)
              : current;

          // A window that opens a thread mid-turn (a fresh local window, or a
          // federation remote viewer) never saw turn/started, so the hydrated
          // snapshot is its only signal that a turn is running. Without an
          // active turn id the transcript collapses live commentary into
          // "previous messages" groups while the turn is still writing them.
          const trailingInProgressTurn =
            !shouldClearStaleThinking && responseThreadStatus === "active"
              ? readTrailingInProgressTurn(responseWithRetainedTail)
              : undefined;
          const shouldAdoptHydratedTurn =
            trailingInProgressTurn !== undefined
            && shouldAdoptStartedTurn(current, trailingInProgressTurn.id);
          const nextRetainedLiveEntries = pruneOptimisticEntries(
            retainedLiveEntries,
            responseWithRetainedTail,
          );
          const didPruneRetainedLiveEntries =
            nextRetainedLiveEntries.length !== retainedLiveEntries.length;
          if (didPruneRetainedLiveEntries && retainedLiveEntryStore) {
            if (nextRetainedLiveEntries.length === 0) {
              delete retainedLiveEntriesRef.current[targetThreadKey];
            } else {
              retainedLiveEntryStore.clear();
              for (const entry of nextRetainedLiveEntries) {
                retainedLiveEntryStore.set(entry.id, entry);
              }
            }
          }

          return {
            ...currentAfterStaleThinking,
            activeTurnId: hydratedPendingTurnId ?? (shouldClearStaleThinking
              ? undefined
              : shouldAdoptHydratedTurn
                ? trailingInProgressTurn.id
                : current.activeTurnId),
            activeTurnStartedAt: hydratedPendingTurnId
              ? current.activeTurnId === hydratedPendingTurnId
                ? current.activeTurnStartedAt
                : undefined
              : shouldClearStaleThinking
              ? undefined
              : shouldAdoptHydratedTurn
                ? trailingInProgressTurn.startedAt
                  ?? (current.activeTurnId === trailingInProgressTurn.id
                    ? current.activeTurnStartedAt
                    : undefined)
                : current.activeTurnStartedAt,
            backendReportedActive: hydratedPendingInteraction || backendReportedActive,
            error: undefined,
            expectOwnUpdate: false,
            failedHydrationVersion: undefined,
            hydratedEnvironmentSetupVersion:
              getEnvironmentSetupHydrationVersion(targetThread),
            hydratedInitialHistoryLimit: initialHistoryLimit,
            hydratedUpdatedAt:
              needsHydrationAfterCompletion && completionHydrationRetries < 2
                ? undefined
                : targetThread.updatedAt,
            initialLoadDurationMs:
              current.initialLoadDurationMs ?? response.readDurationMs,
            lastTouchedAt: Date.now(),
            loadedHistory:
              response.replay.pagination.supportsPagination
              && response.replay.pagination.hasPreviousPage
                ? current.loadedHistory
                : undefined,
            loading: false,
            completionHydrationRetries,
            needsHydrationAfterCompletion,
            retainedLiveEntryCount: nextRetainedLiveEntries.length,
            retainedLiveEntryVersion:
              current.retainedLiveEntryVersion
              + (didPruneRetainedLiveEntries ? 1 : 0),
            optimisticEntries: pruneOptimisticEntries(
              current.optimisticEntries,
              responseWithRetainedTail,
              reconciledLaunchpadMessageIdsRef.current[targetThreadKey],
              launchpadMessageCandidateRef.current?.threadKey === targetThreadKey
                ? launchpadMessageCandidateRef.current.candidate
                : undefined,
            ),
            pendingAssistantMessage: shouldClearStaleThinking
              ? undefined
              : current.pendingAssistantMessage,
            pendingMcpInteraction: hydratedPendingInteraction
              ? hydratedPendingMcpInteraction
              : current.pendingMcpInteraction,
            pendingRequest: hydratedPendingInteraction
              ? hydratedApprovalRequest
              : current.pendingRequest,
            pendingStatusText: hydratedPendingUserInput
              ? "Waiting for input"
              : hydratedPendingMcpInteraction
                ? "Waiting for MCP approval"
                : hydratedApprovalRequest
                  ? "Waiting for approval"
                  : shouldClearStaleThinking
                    ? undefined
                    : current.pendingStatusText,
            pendingUserInput: hydratedPendingInteraction
              ? hydratedPendingUserInput
              : current.pendingUserInput,
            response: responseWithRetainedTail,
            staleThinkingRecheckAt:
              ownUpdateStillSettling || reviewUpdateStillSettling
              ? ownUpdateSettlesAt
              : undefined,
            transientMessage: shouldClearStaleThinking
              ? undefined
              : current.transientMessage,
          };
        });
      } catch (error) {
        desktopApi?.recordStartupProfileEvent?.("thread-hydration:error", {
          backend: targetThread.source,
          error: error instanceof Error ? error.message : String(error),
          threadId: targetThread.id,
        });
        if (requestVersionsRef.current[targetThreadKey] !== requestVersion) {
          return;
        }

        updateSession(targetThreadKey, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
          failedHydrationVersion: hydrationVersion,
          lastTouchedAt: Date.now(),
          loading: false,
        }));
      }
    },
    [
      desktopApi?.readThread,
      desktopApi?.recordStartupProfileEvent,
      initialHistoryLimit,
      logStaleThinkingState,
      suspended,
      updateSession,
    ]
  );

  const reload = useCallback(async (): Promise<void> => {
    if (thread) {
      await loadLatest(thread);
    }
  }, [loadLatest, thread]);

  useEffect(() => {
    if (!threadKey) {
      return;
    }

    updateSession(threadKey, (current) => ({
      ...current,
      // A failed hydration is suppressed while the operator remains on the
      // same thread/version so a dead backend cannot create a retry loop.
      // Selecting the thread again is an explicit retry after conditions may
      // have changed, such as a Federation peer reconnecting.
      failedHydrationVersion: undefined,
      lastTouchedAt: Date.now(),
    }));
  }, [threadKey, updateSession]);

  useEffect(() => {
    if (!thread || !threadKey) {
      return;
    }

    if (thread.threadStatus === "active" || thread.threadStatus === "idle") {
      const summarySeed = `${thread.threadStatus}:${thread.updatedAt ?? "unknown"}`;
      if (threadStatusSummarySeedRef.current[threadKey] !== summarySeed) {
        threadStatusSummarySeedRef.current[threadKey] = summarySeed;
        const backendReportedActive = thread.threadStatus === "active";
        updateSession(threadKey, (current) => {
          const shouldRecheckStaleThinking =
            !backendReportedActive && hasThinkingState(current);
          if (
            current.backendReportedActive === backendReportedActive
            && !shouldRecheckStaleThinking
          ) {
            return current;
          }

          const now = Date.now();
          return {
            ...current,
            backendReportedActive,
            lastTouchedAt: now,
            // Federation backend events are live-only. If a remote viewer
            // misses the terminal notifications during a transport gap, its
            // next navigation snapshot still carries the authoritative idle
            // status. Re-read after the normal completion grace so that the
            // transcript snapshot can clear the stale active turn without
            // racing an idle-before-turn/completed notification pair.
            staleThinkingRecheckAt: backendReportedActive
              ? undefined
              : shouldRecheckStaleThinking
                ? now + OWN_UPDATE_IDLE_GRACE_MS
                : current.staleThinkingRecheckAt,
          };
        });
      }
    }

    if (
      launchpadMessageCandidate
      && reconciledLaunchpadMessageIdsRef.current[threadKey] === undefined
    ) {
      const optimisticEntry = launchpadMessageCandidate.entry;
      updateSession(threadKey, (current) => {
        const persistedMessage = current.response?.replay.entries.find(
          (entry): entry is AppServerThreadMessageEntry =>
            entry.type === "message"
            && matchesAuthoritativeLaunchpadMessage(
              entry,
              launchpadMessageCandidate,
            )
        );
        const persistedMessageExists = persistedMessage !== undefined;
        if (persistedMessage) {
          reconciledLaunchpadMessageIdsRef.current[threadKey] =
            persistedMessage.id;
        }
        const persistedTextMessageExists = current.response?.replay.messages.some(
          (message) => messageTextMatchesOptimisticEntry(message, optimisticEntry)
        );
        const optimisticMessageExists = optimisticMessageEntries(
          current.optimisticEntries
        ).some((entry) =>
          messageMatchesOptimisticEntry(
            {
              id: entry.id,
              role: entry.role,
              text: entry.text,
              parts: entry.parts,
              createdAt: entry.createdAt,
            },
            optimisticEntry,
            { allowImageUrlMismatch: true }
          )
        );

        if (persistedMessageExists || optimisticMessageExists || persistedTextMessageExists) {
          const response = mergeImagePartsIntoResponse(current.response, [optimisticEntry]);
          return response && response !== current.response
            ? {
                ...current,
                lastTouchedAt: Date.now(),
                response,
              }
            : current;
        }

        return {
          ...current,
          expectOwnUpdate: true,
          interacted: true,
          lastTouchedAt: Date.now(),
          optimisticEntries: [
            ...current.optimisticEntries,
            optimisticEntry,
          ],
        };
      });
    }

    const optimisticActiveTurn = thread.optimisticActiveTurn;
    if (optimisticActiveTurn) {
      updateSession(threadKey, (current) => {
        const optimisticActiveTurnKey = `${threadKey}:${optimisticActiveTurn.id}`;
        if (consumedOptimisticActiveTurnKeysRef.current.has(optimisticActiveTurnKey)) {
          return current;
        }

        const activeTurnStartedAt =
          optimisticActiveTurn.startedAt ?? current.activeTurnStartedAt ?? Date.now();
        const optimisticReviewEntry: AppServerThreadReviewEntry | undefined =
          optimisticActiveTurn.reviewDisplayText
            ? {
                type: "review",
                id: `optimistic-launchpad-review-${threadKey}`,
                review: optimisticActiveTurn.reviewDisplayText,
                displayText: optimisticActiveTurn.reviewDisplayText,
                createdAt: activeTurnStartedAt,
                turn: {
                  id: optimisticActiveTurn.id,
                  status: "in_progress",
                  startedAt: activeTurnStartedAt,
                },
              }
            : undefined;
        const responseReviewExists =
          optimisticReviewEntry &&
          current.response?.replay.entries.some(
            (entry) =>
              entry.type === "review" &&
              reviewEntriesMatch(entry, optimisticReviewEntry)
          );
        const optimisticReviewExists =
          optimisticReviewEntry &&
          current.optimisticEntries.some(
            (entry) =>
              entry.type === "review" &&
              reviewEntriesMatch(entry, optimisticReviewEntry)
          );
        const nextOptimisticEntries =
          optimisticReviewEntry &&
          !responseReviewExists &&
          !optimisticReviewExists
            ? [...current.optimisticEntries, optimisticReviewEntry]
            : current.optimisticEntries;
        const nextPendingStatusText =
          current.pendingStatusText ?? optimisticActiveTurn.statusText;

        if (
          current.activeTurnId === optimisticActiveTurn.id &&
          current.pendingStatusText === nextPendingStatusText &&
          nextOptimisticEntries === current.optimisticEntries
        ) {
          return current;
        }

        return {
          ...current,
          activeTurnId: optimisticActiveTurn.id,
          activeTurnStartedAt,
          expectOwnUpdate: true,
          interacted: true,
          lastTouchedAt: Date.now(),
          optimisticEntries: nextOptimisticEntries,
          pendingStatusText: nextPendingStatusText,
          pendingTurnUsage: undefined,
        };
      });
    }

    const session = sessions[threadKey];
    const hydrationVersion = getThreadHydrationVersion(thread);
    if (!session?.response) {
      if (
        !session?.loading &&
        session?.failedHydrationVersion !== hydrationVersion
      ) {
        void loadLatest(thread);
      }
      return;
    }

    if (session.loading) {
      return;
    }

    if (
      session.hydratedEnvironmentSetupVersion
      !== getEnvironmentSetupHydrationVersion(thread)
    ) {
      if (session.failedHydrationVersion !== hydrationVersion) {
        void loadLatest(thread);
      }
      return;
    }

    if (session.activeTurnId) {
      const remoteSummaryAdvanced =
        thread.federation?.ref.target.scope === "remote"
        && thread.updatedAt != null
        && session.hydratedUpdatedAt !== thread.updatedAt
        && session.failedHydrationVersion !== hydrationVersion;
      if (remoteSummaryAdvanced) {
        // Federation events are live-only. A selected mounted thread can miss
        // commentary or a request-user-input notification during a transport
        // gap, then remain active indefinitely because the missing prompt is
        // the only way to finish its turn. The owner's navigation snapshot is
        // the durable catch-up signal: when its updatedAt advances beyond the
        // detail snapshot we hydrated, re-read even while the turn is active.
        void loadLatest(thread);
      }
      return;
    }

    if (
      session.needsHydrationAfterCompletion &&
      session.completionHydrationRetries < 2
    ) {
      void loadLatest(thread);
      return;
    }

    if (thread.updatedAt == null || session.hydratedUpdatedAt === thread.updatedAt) {
      if (session.hydratedInitialHistoryLimit !== initialHistoryLimit) {
        void loadLatest(thread);
      }
      return;
    }

    if (session.needsHydrationAfterCompletion) {
      void loadLatest(thread);
      return;
    }

    if (session.expectOwnUpdate) {
      if (!hasThinkingState(session) || !hasHydratedTranscriptContent(session)) {
        void loadLatest(thread);
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        expectOwnUpdate: false,
        hydratedUpdatedAt: thread.updatedAt,
        lastTouchedAt: Date.now(),
      }));
      return;
    }

    if (session.interacted) {
      if (!hasHydratedTranscriptContent(session)) {
        void loadLatest(thread);
        return;
      }

      void loadLatest(thread);
      return;
    }

    void loadLatest(thread);
  }, [
    initialHistoryLimit,
    launchpadMessageCandidate,
    loadLatest,
    sessions,
    thread,
    threadKey,
    updateSession,
  ]);

  useEffect(() => {
    if (!thread || !threadKey) {
      return;
    }
    const recheckAt = sessions[threadKey]?.staleThinkingRecheckAt;
    if (typeof recheckAt !== "number") {
      return;
    }
    const timer = setTimeout(() => {
      updateSession(threadKey, (current) => ({
        ...current,
        hydratedUpdatedAt: undefined,
        lastTouchedAt: Date.now(),
        staleThinkingRecheckAt: undefined,
      }));
      void loadLatest(thread);
    }, Math.max(0, recheckAt - Date.now()) + 1);
    return () => {
      clearTimeout(timer);
    };
  }, [loadLatest, sessions, thread, threadKey, updateSession]);

  useEffect(() => {
    const timers = Object.entries(sessions).flatMap(
      ([sessionThreadKey, session]) => {
        if (
          sessionThreadKey === threadKey
          || typeof session.staleThinkingRecheckAt !== "number"
        ) {
          return [];
        }

        const recheckAt = session.staleThinkingRecheckAt;
        return [
          setTimeout(() => {
            updateSession(sessionThreadKey, (current) => {
              if (
                current.staleThinkingRecheckAt !== recheckAt
                || current.backendReportedActive
                || hasPendingInteraction(current)
              ) {
                return current;
              }

              // Unfocused threads do not have a NavigationThreadSummary to
              // feed through loadLatest(). Once the backend has remained idle
              // for the completion grace, clear only renderer-owned live
              // state. Durable transcript entries hydrate when the thread is
              // next selected.
              const settled = settleTransientMessage(current);
              return {
                ...settled,
                activeTurnId: undefined,
                activeTurnStartedAt: undefined,
                backendReportedActive: false,
                completionHydrationRetries: 0,
                expectOwnUpdate: false,
                hydratedUpdatedAt: undefined,
                needsHydrationAfterCompletion: true,
                optimisticEntries: settled.optimisticEntries.filter(
                  (entry) => !isLiveOptimisticEntry(entry)
                ),
                pendingAssistantMessage: undefined,
                pendingStatusText: undefined,
                staleThinkingRecheckAt: undefined,
              };
            });
          }, Math.max(0, recheckAt - Date.now()) + 1),
        ];
      }
    );

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [sessions, threadKey, updateSession]);

  useEffect(() => {
    if (!desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      const notificationThreadId =
        "threadId" in event.notification.params &&
        typeof event.notification.params.threadId === "string"
          ? event.notification.params.threadId
          : undefined;

      if (!notificationThreadId) {
        return;
      }

      const targetThreadKey = agentEventThreadIdentityKey(event, notificationThreadId);
      const isUnfocusedThread = targetThreadKey !== selectedThreadKeyRef.current;
      if (
        liveTranscriptEventFiltering &&
        isUnfocusedThread &&
        isThreadLocalTranscriptNotification(event.notification)
      ) {
        return;
      }

      if (liveTranscriptEventFiltering) {
        const liveActivitySignature = liveActivityNotificationSignature({
          backend: event.backend,
          notification: event.notification,
          threadId: notificationThreadId,
        });
        if (liveActivitySignature) {
          if (lastLiveActivitySignatureRef.current[targetThreadKey] === liveActivitySignature) {
            return;
          }
          lastLiveActivitySignatureRef.current[targetThreadKey] = liveActivitySignature;
        }
      }

      updateSession(targetThreadKey, (session) => {
        const current = transitionTransientMessagesAtBoundary(
          session,
          event.notification
        );
        const nextLastTouchedAt = Date.now();

        if (isApprovalRequestNotification(event.notification)) {
          const notificationTurnId = readNotificationTurnId(event.notification);
          return {
            ...current,
            activeTurnId: notificationTurnId ?? current.activeTurnId,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingRequest: event.notification,
            pendingStatusText: "Waiting for approval",
          };
        }

        if (isRequestUserInputNotification(event.notification)) {
          const pendingUserInput = createQuestionnaireState(event.notification);
          if (!pendingUserInput) {
            return current;
          }
          const notificationTurnId = readNotificationTurnId(event.notification);

          return {
            ...current,
            activeTurnId: notificationTurnId ?? current.activeTurnId,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingStatusText: "Waiting for input",
            pendingUserInput,
          };
        }

        if (isMcpElicitationNotification(event.notification)) {
          const pendingMcpInteraction = createMcpElicitationState(event.notification);
          if (!pendingMcpInteraction) {
            return current;
          }
          const notificationTurnId = readNotificationTurnId(event.notification);

          return {
            ...current,
            activeTurnId: notificationTurnId ?? current.activeTurnId,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingMcpInteraction,
            pendingStatusText: "Waiting for MCP approval",
          };
        }

        if (
          event.notification.method === "item/started" &&
          isContextCompactionItemNotification(event.notification)
        ) {
          return {
            ...current,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingStatusText: "Compacting context",
          };
        }

        // Queue admission can publish the authoritative user item before the
        // Composer's startTurn promise adds its optimistic row. Materialize
        // the started item; a later completion reconciles by the same id.
        if (
          event.notification.method === "item/started"
          || event.notification.method === "item/completed"
        ) {
          const userMessageEntry = userMessageEntryFromItem(
            event.notification.params
          );
          if (userMessageEntry) {
            const launchpadMessageCandidate =
              launchpadMessageCandidateRef.current?.threadKey === targetThreadKey
                ? launchpadMessageCandidateRef.current.candidate
                : undefined;
            const unreconciledLaunchpadMessageCandidate =
              reconciledLaunchpadMessageIdsRef.current[targetThreadKey]
                === undefined
                ? launchpadMessageCandidate
                : undefined;
            const reconcilesLaunchpadMessage = Boolean(
              unreconciledLaunchpadMessageCandidate
              && matchesAuthoritativeLaunchpadMessage(
                userMessageEntry,
                unreconciledLaunchpadMessageCandidate,
              )
            );
            const authoritativeUserMessageEntry =
              mergeCompletedUserMessageWithPromotedOptimisticEntry(
                mergeCompletedUserMessageWithOptimisticEntry(
                  userMessageEntry,
                  reconcilesLaunchpadMessage
                    && unreconciledLaunchpadMessageCandidate
                    ? [unreconciledLaunchpadMessageCandidate.entry]
                    : current.optimisticEntries
                ),
                current.response
              );
            if (reconcilesLaunchpadMessage) {
              reconciledLaunchpadMessageIdsRef.current[targetThreadKey] =
                authoritativeUserMessageEntry.id;
            }
            const nextResponse = appendMessageEntries(
              removePromotedOptimisticUserMessage(
                current.response,
                authoritativeUserMessageEntry
              ),
              {
                backend: event.backend,
                threadId: notificationThreadId,
              },
              [authoritativeUserMessageEntry]
            );

            return {
              ...current,
              expectOwnUpdate: true,
              interacted: true,
              lastTouchedAt: nextLastTouchedAt,
              optimisticEntries:
                reconcilesLaunchpadMessage
                  && unreconciledLaunchpadMessageCandidate
                  ? current.optimisticEntries.filter(
                      (entry) =>
                        entry.id !== unreconciledLaunchpadMessageCandidate.entry.id
                    )
                  : current.optimisticEntries.filter(
                      (entry) =>
                        entry.id === unreconciledLaunchpadMessageCandidate?.entry.id
                        || entry.type !== "message"
                        || !messageTextMatchesOptimisticEntry(
                          authoritativeUserMessageEntry,
                          entry,
                        )
                    ),
              response: nextResponse,
            };
          }
        }

        if (event.notification.method === "item/started") {
          const item = getNotificationItem(event.notification.params);
          const details = item ? buildLiveToolDetails(item) : [];
          if (details.length === 0) {
            return current;
          }

          const turn = buildTurnMetadata({
            fallbackId:
              typeof event.notification.params.turnId === "string"
                ? event.notification.params.turnId
                : current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "in_progress",
          });
          return upsertLiveActivityEntry(current, {
            details,
            now: nextLastTouchedAt,
            suppressDuplicateLiveActivityUpdates: liveTranscriptEventFiltering,
            threadId: notificationThreadId,
            turn,
          });
        }

        if (event.notification.method === "item/transientMessage/updated") {
          if (
            current.activeTurnId &&
            event.notification.params.turnId &&
            current.activeTurnId !== event.notification.params.turnId
          ) {
            return current;
          }
          const text = event.notification.params.text.trim();
          if (!text) {
            return current.transientMessage
              ? {
                  ...current,
                  lastTouchedAt: nextLastTouchedAt,
                  transientMessage: undefined,
                }
              : current;
          }
          const isSameTransientMessage =
            current.transientMessage?.id === event.notification.params.itemId;
          const turn = buildTurnMetadata({
            fallbackId:
              event.notification.params.turnId ?? current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "in_progress",
          });
          const sequence = isSameTransientMessage
            ? readRendererSequence(current.transientMessage)
            : current.nextLiveEntrySequence;
          const transientMessage: AppServerTransientThreadMessageEntry =
            withRendererSequence(
              {
                type: "transientMessage",
                id: event.notification.params.itemId,
                role: event.notification.params.role,
                phase: event.notification.params.phase,
                createdAt: isSameTransientMessage
                  ? current.transientMessage?.createdAt
                  : nextLastTouchedAt,
                ...(turn ? { turn } : {}),
                text,
              },
              sequence ?? current.nextLiveEntrySequence
            );
          return {
            ...current,
            activeTurnId:
              event.notification.params.turnId ?? current.activeTurnId,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            nextLiveEntrySequence: isSameTransientMessage
              ? current.nextLiveEntrySequence
              : current.nextLiveEntrySequence + 1,
            transientMessage,
          };
        }

        if (
          event.notification.method === "item/agentMessage/delta" &&
          typeof event.notification.params.itemId === "string" &&
          typeof event.notification.params.delta === "string"
        ) {
          const { itemId, delta } = event.notification.params;
          const isSamePendingMessage = current.pendingAssistantMessage?.id === itemId;
          const turn = buildTurnMetadata({
            fallbackId: event.notification.params.turnId ?? current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "in_progress",
          });
          const phase =
            event.notification.params.phase ??
            (isSamePendingMessage ? current.pendingAssistantMessage?.phase : undefined);
          const pendingText = current.pendingAssistantMessage?.text ?? "";
          const flushedResponse = isSamePendingMessage
            ? current.response
              : appendPendingAssistantMessage(
                current.response,
                {
                  backend: event.backend,
                  threadId: notificationThreadId,
                },
                optimisticMessageEntries(current.optimisticEntries),
                current.pendingAssistantMessage
              );
          const carriedSequence = isSamePendingMessage
            ? readRendererSequence(current.pendingAssistantMessage)
            : undefined;
          const allocatedSequence =
            carriedSequence ?? current.nextLiveEntrySequence;
          const nextEntrySequence = isSamePendingMessage
            ? current.nextLiveEntrySequence
            : current.nextLiveEntrySequence + 1;

          const nextPendingAssistantMessage: AppServerThreadMessageEntry = {
            type: "message",
            id: itemId,
            role: "assistant",
            phase,
            createdAt: isSamePendingMessage
              ? current.pendingAssistantMessage?.createdAt
              : Date.now(),
            ...(turn ? { turn } : {}),
            text:
              isSamePendingMessage
                ? `${pendingText}${delta}`
                : delta,
          };

          return {
            ...current,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            nextLiveEntrySequence: nextEntrySequence,
            pendingAssistantMessage: withRendererSequence(
              nextPendingAssistantMessage,
              allocatedSequence
            ),
            response: flushedResponse,
          };
        }

        if (event.notification.method === "item/mcpToolCall/progress") {
          const detail = buildMcpProgressDetail(event.notification.params);
          if (!detail) {
            return current;
          }

          const turn = buildTurnMetadata({
            fallbackId:
              typeof event.notification.params.turnId === "string"
                ? event.notification.params.turnId
                : current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "in_progress",
          });
          return upsertLiveActivityEntry(current, {
            details: [detail],
            now: nextLastTouchedAt,
            suppressDuplicateLiveActivityUpdates: liveTranscriptEventFiltering,
            threadId: notificationThreadId,
            turn,
          });
        }

        if (event.notification.method === "item/commandExecution/outputDelta") {
          const notifParams = event.notification.params as Record<string, unknown>;
          const delta =
            typeof notifParams.delta === "string"
              ? notifParams.delta
              : "";
          const itemId =
            typeof notifParams.itemId === "string"
              ? notifParams.itemId
              : typeof notifParams.item_id === "string"
                ? notifParams.item_id
                : undefined;
          if (!delta || !itemId) {
            return current;
          }

          return appendLiveCommandOutputDelta(current, {
            delta,
            itemId,
            now: nextLastTouchedAt,
          });
        }

        if (event.notification.method === "item/fileChange/outputDelta") {
          const notifParams = event.notification.params as Record<string, unknown>;
          const delta = typeof notifParams.delta === "string" ? notifParams.delta : "";
          if (!delta) {
            return current;
          }
          const itemId =
            typeof notifParams.itemId === "string"
              ? notifParams.itemId
              : typeof notifParams.item_id === "string"
                ? notifParams.item_id
                : undefined;
          const turn = buildTurnMetadata({
            fallbackId:
              typeof notifParams.turnId === "string"
                ? notifParams.turnId
                : current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "in_progress",
          });
          const entryId = `live-file-change-${
            itemId ?? turn?.id ?? notificationThreadId
          }`;
          return upsertLiveFileChangeEntry(current, {
            delta,
            entryId,
            now: nextLastTouchedAt,
            turn,
          });
        }

        if (event.notification.method === "turn/started") {
          const startedTurnRecord =
            typeof event.notification.params.turn === "object" &&
            event.notification.params.turn !== null
              ? (event.notification.params.turn as {
                  id?: unknown;
                  status?: unknown;
                  startedAt?: unknown;
                  completedAt?: unknown;
                  durationMs?: unknown;
                })
              : undefined;
          const turnId =
            typeof startedTurnRecord?.id === "string"
              ? startedTurnRecord.id
              : event.notification.params.turnId;
          const startedAt =
            normalizeNotificationTimestamp(startedTurnRecord?.startedAt) ?? Date.now();

          const transientTurnYieldedToStartedTurn = Boolean(
            session.transientMessage?.turn?.id
            && session.transientMessage.turn.id === session.activeTurnId
            && turnId !== session.activeTurnId
          );
          if (
            !shouldAdoptStartedTurn(current, turnId) &&
            !transientTurnYieldedToStartedTurn
          ) {
            return current;
          }

          return {
            ...current,
            activeTurnId: turnId,
            activeTurnStartedAt: startedAt,
            backendReportedActive: true,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingTurnUsage: undefined,
          };
        }

        if (
          event.notification.method === "serverRequest/resolved" &&
          "requestId" in event.notification.params
        ) {
          const pendingRequestResolved =
            current.pendingRequest?.params.requestId === event.notification.params.requestId;
          const pendingMcpResolved =
            current.pendingMcpInteraction?.requestId === event.notification.params.requestId;
          const pendingUserInputResolved =
            current.pendingUserInput?.requestId === event.notification.params.requestId;
          const hasActiveTurnAfterResolve = Boolean(current.activeTurnId);
          const resolvedKnownRequest =
            pendingRequestResolved || pendingMcpResolved || pendingUserInputResolved;

          return {
            ...current,
            lastTouchedAt: nextLastTouchedAt,
            pendingRequest:
              pendingRequestResolved ? undefined : current.pendingRequest,
            pendingMcpInteraction:
              pendingMcpResolved ? undefined : current.pendingMcpInteraction,
            pendingUserInput:
              pendingUserInputResolved ? undefined : current.pendingUserInput,
            pendingStatusText:
              hasActiveTurnAfterResolve && resolvedKnownRequest
                ? "Thinking"
                : resolvedKnownRequest
                  ? undefined
                  : current.pendingStatusText,
          };
        }

        if (event.notification.method === "item/completed") {
          const assistantTurn = buildTurnMetadata({
            fallbackId:
              typeof event.notification.params.turnId === "string"
                ? event.notification.params.turnId
                : current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "in_progress",
          });
          const item = getNotificationItem(event.notification.params);
          const transientTaskMonitorItem = isTransientTaskMonitorItem(item);
          const assistantMessageEntry = transientTaskMonitorItem
            ? undefined
            : assistantMessageEntryFromCompletedItem({
                itemParams: event.notification.params,
                turn: assistantTurn,
              });
          const taskMonitorUsageEntry = item && !transientTaskMonitorItem
            ? buildTaskMonitorUsageActivityEntry({
                id: `${item.id ?? event.notification.params.turnId ?? "monitor"}:usage`,
                item,
                turn: assistantTurn,
              })
            : undefined;
          if (assistantMessageEntry) {
            const responseWithUsage = taskMonitorUsageEntry
              ? appendThreadEntries(
                  current.response,
                  {
                    backend: event.backend,
                    threadId: notificationThreadId,
                  },
                  [taskMonitorUsageEntry]
                )
              : current.response;
            const nextResponse = appendMessageEntries(
              responseWithUsage,
              {
                backend: event.backend,
                threadId: notificationThreadId,
              },
              [
                ...current.optimisticEntries.filter(
                  (entry): entry is AppServerThreadMessageEntry => entry.type === "message"
                ),
                assistantMessageEntry,
              ]
            );

            return {
              ...current,
              expectOwnUpdate: true,
              interacted: true,
              lastTouchedAt: nextLastTouchedAt,
              optimisticEntries: current.optimisticEntries.filter(
                (entry) => entry.type !== "message"
              ),
              pendingAssistantMessage:
                current.pendingAssistantMessage?.id === assistantMessageEntry.id
                  ? undefined
                  : current.pendingAssistantMessage,
              response: nextResponse,
            };
          }

          if (taskMonitorUsageEntry) {
            persistFinalizedUsageEntry({
              backend: event.backend,
              desktopApi,
              entry: taskMonitorUsageEntry,
              threadId: notificationThreadId,
            });
            const nextResponse = appendThreadEntries(
              current.response,
              {
                backend: event.backend,
                threadId: notificationThreadId,
              },
              [taskMonitorUsageEntry]
            );

            return {
              ...current,
              expectOwnUpdate: true,
              interacted: true,
              lastTouchedAt: nextLastTouchedAt,
              response: nextResponse,
            };
          }

          if (isContextCompactionItemNotification(event.notification)) {
            return {
              ...current,
              activeTurnId: current.activeTurnId ?? event.notification.params.turnId,
              expectOwnUpdate: true,
              interacted: true,
              lastTouchedAt: nextLastTouchedAt,
              pendingStatusText:
                current.activeTurnId || event.notification.params.turnId
                  ? "Thinking"
                  : undefined,
            };
          }

          const reviewEntry = reviewEntryFromCompletedItem(event.notification.params);
          if (reviewEntry) {
            const nextResponse = appendThreadEntries(
              current.response,
              {
                backend: event.backend,
                threadId: notificationThreadId,
              },
              [reviewEntry]
            );

            return {
              ...current,
              activeTurnId:
                reviewEntry.turn?.status === "in_progress" && reviewEntry.turn.id
                  ? reviewEntry.turn.id
                  : current.activeTurnId,
              activeTurnStartedAt:
                reviewEntry.turn?.status === "in_progress" && reviewEntry.turn.id
                  ? current.activeTurnStartedAt ?? Date.now()
                  : current.activeTurnStartedAt,
              expectOwnUpdate: true,
              interacted: true,
              lastTouchedAt: nextLastTouchedAt,
              optimisticEntries: current.optimisticEntries.filter(
                (entry) =>
                  entry.type !== "review" ||
                  !reviewEntriesMatch(reviewEntry, entry)
              ),
              response: nextResponse,
            };
          }

          const details = item ? buildLiveToolDetails(item) : [];
          if (details.length > 0) {
            const turn = buildTurnMetadata({
              fallbackId:
                typeof event.notification.params.turnId === "string"
                  ? event.notification.params.turnId
                  : current.activeTurnId,
              fallbackStartedAt: current.activeTurnStartedAt,
              fallbackStatus: "completed",
            });
            return upsertLiveActivityEntry(current, {
              details,
              now: nextLastTouchedAt,
              suppressDuplicateLiveActivityUpdates: liveTranscriptEventFiltering,
              threadId: notificationThreadId,
              turn,
            });
          }
        }

        if (event.notification.method === "turn/completed") {
          const completedTurn = buildTurnMetadata({
            fallbackId: event.notification.params.turnId ?? current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "completed",
            turn: event.notification.params.turn,
          });
          const completedTurnMatchesActive = terminalTurnMatchesActiveTurn(
            current,
            completedTurn?.id,
          );
          if (completedTurnMatchesActive && completedTurn?.id) {
            consumedOptimisticActiveTurnKeysRef.current.add(
              `${targetThreadKey}:${completedTurn.id}`
            );
          }
          if (liveTranscriptEventFiltering && isUnfocusedThread) {
            return {
              ...current,
              activeTurnId: completedTurnMatchesActive
                ? undefined
                : current.activeTurnId,
              activeTurnStartedAt: completedTurnMatchesActive
                ? undefined
                : current.activeTurnStartedAt,
              backendReportedActive: completedTurnMatchesActive
                ? false
                : current.backendReportedActive,
              error: undefined,
              lastTouchedAt: nextLastTouchedAt,
              pendingAssistantMessage: completedTurnMatchesActive
                ? undefined
                : current.pendingAssistantMessage,
              pendingMcpInteraction: completedTurnMatchesActive
                ? undefined
                : current.pendingMcpInteraction,
              pendingRequest: completedTurnMatchesActive
                ? undefined
                : current.pendingRequest,
              pendingTurnUsage: completedTurnMatchesActive
                ? undefined
                : current.pendingTurnUsage,
              recentlyCompletedTurnUsage:
                completedTurnMatchesActive && completedTurn
                  ? {
                      accumulator: current.pendingTurnUsage,
                      turn: completedTurn,
                    }
                  : current.recentlyCompletedTurnUsage,
              pendingUserInput: completedTurnMatchesActive
                ? undefined
                : current.pendingUserInput,
              pendingStatusText: completedTurnMatchesActive
                ? undefined
                : current.pendingStatusText,
              transientMessage: completedTurnMatchesActive
                ? undefined
                : current.transientMessage,
            };
          }

          const completedTurnHasReview = hasReviewEntryForTurn(
            current.response,
            completedTurn?.id
          );
          const completedTurnText = readCompletedTurnText(event.notification.params);
          const completedText =
            completedTurnHasReview
              ? undefined
              : completedTurnText ?? current.pendingAssistantMessage?.text;
          const shouldAppendFinalMessage = Boolean(
            completedText &&
              current.pendingAssistantMessage?.text !== completedText &&
              !hasCompletedAssistantMessageForTurn(
                current.response,
                completedTurn?.id,
                completedText
              )
          );
          const unphasedAssistantCompletionPhase =
            shouldAppendFinalMessage ? "commentary" : undefined;
          const shouldHydrateUnknownPhaseAssistant =
            !completedTurnText &&
            Boolean(
              !completedTurnHasReview &&
              current.pendingAssistantMessage &&
                current.pendingAssistantMessage.phase === undefined
            );
          const nextEntries = [
            ...current.optimisticEntries
              .filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message")
              .map((entry) => {
                if (entry.turn?.id !== completedTurn?.id) {
                  return entry;
                }

                const phase = unphasedAssistantCompletionPhase ?? entry.phase;
                return withCompletedAssistantTimestamp(
                  withTurnMetadataAndPhase(
                    entry,
                    completedTurn,
                    unphasedAssistantCompletionPhase
                  ),
                  {
                    completedAt: completedTurn?.completedAt ?? nextLastTouchedAt,
                    phase,
                  }
                );
              }),
            ...(current.pendingAssistantMessage && completedTurnMatchesActive
              ? completedTurnHasReview
                ? []
                : [
                  withCompletedAssistantTimestamp(
                    withTurnMetadataAndPhase(
                      current.pendingAssistantMessage,
                      completedTurn,
                      unphasedAssistantCompletionPhase
                    ),
                    {
                      completedAt: completedTurn?.completedAt ?? nextLastTouchedAt,
                      phase:
                        unphasedAssistantCompletionPhase ??
                        current.pendingAssistantMessage.phase,
                    }
                  ),
                ]
              : []),
          ];

          const syntheticFinalSequence = current.nextLiveEntrySequence;
          if (shouldAppendFinalMessage && completedText) {
            nextEntries.push(
              withRendererSequence(
                {
                  type: "message",
                  id: `${event.notification.params.turnId}:assistant`,
                  role: "assistant",
                  phase: "final",
                  ...(completedTurn ? { turn: completedTurn } : {}),
                  text: completedText,
                  createdAt: completedTurn?.completedAt ?? nextLastTouchedAt,
                },
                syntheticFinalSequence
              )
            );
          }

          const responseWithCompletedTurn = withCompletedResponseTurnMetadata(
            current.response,
            completedTurn,
            unphasedAssistantCompletionPhase
          );
          const nextResponse =
            nextEntries.length > 0
              ? appendMessageEntries(
                  responseWithCompletedTurn,
                  {
                    backend: event.backend,
                    threadId: notificationThreadId,
                  },
                  nextEntries
                )
              : responseWithCompletedTurn ?? current.response;
          const shouldInvalidateHydration =
            (!completedText || shouldHydrateUnknownPhaseAssistant) &&
            !hasHydratedTranscriptContent({
              ...current,
              optimisticEntries: [],
              pendingAssistantMessage: undefined,
              pendingMcpInteraction: undefined,
              pendingRequest: undefined,
              pendingUserInput: undefined,
              response: nextResponse,
            });
          const remainingOptimisticEntries = current.optimisticEntries
            .filter((entry) => entry.type !== "message")
            .map((entry) =>
              entry.turn?.id === completedTurn?.id && completedTurn
                ? { ...entry, turn: completedTurn }
                : entry
            );
          const retainedLiveEntryStore =
            retainedLiveEntriesRef.current[targetThreadKey];
          let didCompleteRetainedLiveEntry = false;
          if (completedTurn && retainedLiveEntryStore) {
            for (const [entryId, entry] of retainedLiveEntryStore) {
              if (entry.turn?.id !== completedTurn.id) {
                continue;
              }
              const completedEntry = entry.type === "message"
                ? withCompletedAssistantTimestamp(
                    withTurnMetadataAndPhase(
                      entry,
                      completedTurn,
                      unphasedAssistantCompletionPhase,
                    ),
                    {
                      completedAt:
                        completedTurn.completedAt ?? nextLastTouchedAt,
                      phase:
                        unphasedAssistantCompletionPhase ?? entry.phase,
                    },
                  )
                : { ...entry, turn: completedTurn };
              retainedLiveEntryStore.set(entryId, completedEntry);
              didCompleteRetainedLiveEntry = true;
            }
          }
          const completedUsageActivity =
            current.pendingUsageActivityEntry &&
            completedTurn &&
            completedTurnMatchesActive
              ? { ...current.pendingUsageActivityEntry, turn: completedTurn }
              : undefined;
          persistFinalizedUsageEntry({
            backend: event.backend,
            desktopApi,
            entry: completedUsageActivity,
            threadId: notificationThreadId,
          });

          return {
            ...current,
            activeTurnId: completedTurnMatchesActive
              ? undefined
              : current.activeTurnId,
            activeTurnStartedAt: completedTurnMatchesActive
              ? undefined
              : current.activeTurnStartedAt,
            backendReportedActive: completedTurnMatchesActive
              ? false
              : current.backendReportedActive,
            completionHydrationRetries: completedTurnMatchesActive
              ? 0
              : current.completionHydrationRetries,
            error: undefined,
            expectOwnUpdate: true,
            hydratedUpdatedAt:
              !completedText ||
              shouldInvalidateHydration ||
              shouldHydrateUnknownPhaseAssistant
                ? undefined
                : current.hydratedUpdatedAt,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            needsHydrationAfterCompletion:
              completedTurnMatchesActive
                ? !completedText || shouldHydrateUnknownPhaseAssistant
                : current.needsHydrationAfterCompletion ||
                  !completedText ||
                  shouldHydrateUnknownPhaseAssistant,
            nextLiveEntrySequence:
              shouldAppendFinalMessage && completedText
                ? current.nextLiveEntrySequence + 1
                : current.nextLiveEntrySequence,
            retainedLiveEntryVersion:
              current.retainedLiveEntryVersion
              + (didCompleteRetainedLiveEntry ? 1 : 0),
            optimisticEntries:
              completedTurnMatchesActive && completedUsageActivity
                ? mergeFinalizedUsageEntry(
                    remainingOptimisticEntries,
                    completedUsageActivity
                  )
                : remainingOptimisticEntries,
            pendingAssistantMessage: completedTurnMatchesActive
              ? undefined
              : current.pendingAssistantMessage,
            pendingMcpInteraction: completedTurnMatchesActive
              ? undefined
              : current.pendingMcpInteraction,
            pendingRequest: completedTurnMatchesActive
              ? undefined
              : current.pendingRequest,
            pendingUsageActivityEntry: completedTurnMatchesActive
              ? undefined
              : current.pendingUsageActivityEntry,
            pendingTurnUsage: completedTurnMatchesActive
              ? undefined
              : current.pendingTurnUsage,
            recentlyCompletedTurnUsage:
              completedTurnMatchesActive && completedTurn
                ? {
                    accumulator: current.pendingTurnUsage,
                    turn: completedTurn,
                  }
                : current.recentlyCompletedTurnUsage,
            pendingUserInput: completedTurnMatchesActive
              ? undefined
              : current.pendingUserInput,
            pendingStatusText: completedTurnMatchesActive
              ? undefined
              : current.pendingStatusText,
            response: nextResponse,
            transientMessage: completedTurnMatchesActive
              ? undefined
              : current.transientMessage,
          };
        }

        if (event.notification.method === "turn/failed") {
          if (
            !terminalTurnMatchesActiveTurn(
              current,
              event.notification.params.turnId,
            )
          ) {
            return current;
          }
          if (event.notification.params.turnId) {
            consumedOptimisticActiveTurnKeysRef.current.add(
              `${targetThreadKey}:${event.notification.params.turnId}`
            );
          }

          // The failure is now surfaced durably: the backend registry
          // records it on the thread overlay (rendered as a persistent
          // `turn-failed:` transcript entry) and App raises a sticky toast.
          // Do NOT set the transient `error` here — it rendered a red line
          // that the very next `readThread` reconciliation wiped, which is
          // exactly the "appears then vanishes" flash we're fixing.
          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            backendReportedActive: false,
            completionHydrationRetries: 0,
            error: undefined,
            expectOwnUpdate: false,
            lastTouchedAt: nextLastTouchedAt,
            needsHydrationAfterCompletion: false,
            pendingAssistantMessage: undefined,
            pendingMcpInteraction: undefined,
            pendingRequest: undefined,
            pendingUsageActivityEntry: undefined,
            pendingTurnUsage: undefined,
            recentlyCompletedTurnUsage: undefined,
            pendingUserInput: undefined,
            pendingStatusText: undefined,
          };
        }

        if (event.notification.method === "turn/cancelled") {
          if (
            !terminalTurnMatchesActiveTurn(
              current,
              event.notification.params.turnId,
            )
          ) {
            return current;
          }
          if (event.notification.params.turnId) {
            consumedOptimisticActiveTurnKeysRef.current.add(
              `${targetThreadKey}:${event.notification.params.turnId}`
            );
          }

          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            backendReportedActive: false,
            completionHydrationRetries: 0,
            error: undefined,
            expectOwnUpdate: false,
            lastTouchedAt: nextLastTouchedAt,
            needsHydrationAfterCompletion: false,
            pendingAssistantMessage: undefined,
            pendingMcpInteraction: undefined,
            pendingRequest: undefined,
            pendingUsageActivityEntry: undefined,
            pendingTurnUsage: undefined,
            recentlyCompletedTurnUsage: undefined,
            pendingUserInput: undefined,
            pendingStatusText: undefined,
          };
        }

        if (event.notification.method === "thread/status/changed") {
          const statusType =
            typeof event.notification.params.status === "object" &&
            event.notification.params.status !== null &&
            "type" in event.notification.params.status
              ? event.notification.params.status.type
              : undefined;

          if (statusType === "active") {
            return {
              ...current,
              backendReportedActive: true,
              lastTouchedAt: nextLastTouchedAt,
            };
          }

          if (statusType === "idle") {
            const shouldRecheckStaleThinking =
              hasThinkingState(current) && !hasPendingInteraction(current);
            if (shouldRecheckStaleThinking) {
              return {
                ...current,
                backendReportedActive: false,
                lastTouchedAt: nextLastTouchedAt,
                staleThinkingRecheckAt:
                  nextLastTouchedAt + OWN_UPDATE_IDLE_GRACE_MS,
              };
            }

            return {
              ...current,
              activeTurnId: undefined,
              activeTurnStartedAt: undefined,
              backendReportedActive: false,
              lastTouchedAt: nextLastTouchedAt,
              pendingAssistantMessage: undefined,
              pendingStatusText: undefined,
            };
          }
        }

        if (
          event.notification.method === "thread/compacted"
          || event.notification.method === "thread/rewound"
        ) {
          delete loadedHistoryIndexesRef.current[targetThreadKey];
          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            contextWindow: undefined,
            failedHydrationVersion: undefined,
            hydratedUpdatedAt: undefined,
            lastTouchedAt: nextLastTouchedAt,
            loadedHistory: undefined,
            pendingUsageActivityEntry: undefined,
            pendingTurnUsage: undefined,
            pendingStatusText: undefined,
            response: undefined,
          };
        }

        if (event.notification.method === "thread/pricing/updated") {
          return {
            ...current,
            lastTouchedAt: nextLastTouchedAt,
            response: current.response
              ? {
                  ...current.response,
                  pricing: event.notification.params.pricing,
                }
              : current.response,
          };
        }

        if (event.notification.method === "thread/toolAccounting/updated") {
          return {
            ...current,
            lastTouchedAt: nextLastTouchedAt,
            response: current.response
              ? {
                  ...current.response,
                  toolAccounting: event.notification.params.toolAccounting,
                }
              : current.response,
          };
        }

        if (event.notification.method === "thread/tokenUsage/updated") {
          const contextWindow = normalizeThreadContextWindowState(
            event.notification.params.tokenUsage
          );
          const notificationTurnId =
            typeof event.notification.params.turnId === "string"
              ? event.notification.params.turnId
              : undefined;
          const recentlyCompletedTurnUsage =
            !notificationTurnId && !current.activeTurnId
              ? current.recentlyCompletedTurnUsage
              : undefined;
          const resolvedTurnId =
            notificationTurnId
            ?? current.activeTurnId
            ?? recentlyCompletedTurnUsage?.turn.id;
          const knownTurnUsage = findKnownTurnUsageMetadata(current, resolvedTurnId);
          const usageBelongsToActiveTurn = Boolean(
            current.activeTurnId &&
              (!notificationTurnId || notificationTurnId === current.activeTurnId)
          );
          const turn = buildTurnMetadata({
            fallbackId: resolvedTurnId,
            fallbackStartedAt:
              resolvedTurnId && resolvedTurnId !== current.activeTurnId
                ? knownTurnUsage.turn?.startedAt
                  ?? recentlyCompletedTurnUsage?.turn.startedAt
                : current.activeTurnStartedAt,
            fallbackStatus:
              knownTurnUsage.turn?.status ??
              recentlyCompletedTurnUsage?.turn.status ??
              (usageBelongsToActiveTurn ? "in_progress" : "completed"),
            turn: knownTurnUsage.turn ?? recentlyCompletedTurnUsage?.turn,
          });
          const model = resolveTokenUsageModel({
            backend: event.backend,
            notificationParams: event.notification.params,
            thread,
            threadId: notificationThreadId,
          });
          const serviceTier = resolveTokenUsageServiceTier({
            backend: event.backend,
            notificationParams: event.notification.params,
            thread,
            threadId: notificationThreadId,
          });
          const fastMode = resolveTokenUsageFastMode({
            backend: event.backend,
            notificationParams: event.notification.params,
            thread,
            threadId: notificationThreadId,
          });
          const knownCompletedTurnUsage = Boolean(
            resolvedTurnId &&
              resolvedTurnId !== current.activeTurnId &&
              (knownTurnUsage.isTurnUsage || recentlyCompletedTurnUsage) &&
              isTerminalTurnMetadata(
                knownTurnUsage.turn ?? recentlyCompletedTurnUsage?.turn,
              )
          );
          const usageEntryId = knownCompletedTurnUsage
            ? `live-turn-usage-${turn?.id ?? notificationThreadId}`
            : `live-token-usage-${turn?.id ?? notificationThreadId}`;
          let usageEntry = buildTokenUsageActivityEntry({
            fastMode,
            id: usageEntryId,
            model,
            serviceTier,
            ...(knownCompletedTurnUsage ? { summaryPrefix: "Turn usage" } : {}),
            tokenUsage: event.notification.params.tokenUsage,
            turn: mergeKnownTurnMetadata({
              knownTurn: knownTurnUsage.turn,
              turn,
            }),
          });
          if (usageEntry && typeof knownTurnUsage.createdAt === "number") {
            usageEntry = {
              ...usageEntry,
              createdAt: knownTurnUsage.createdAt,
            };
          }
          let pendingTurnUsage = current.pendingTurnUsage;
          const activeTurnUsage = Boolean(
            usageEntry &&
              current.activeTurnId &&
              turn?.id === current.activeTurnId &&
              turn.status !== "completed"
          );
          if (activeTurnUsage) {
            const turnUsage = buildPendingTurnUsage({
              contextWindow: current.contextWindow,
              existing: current.pendingTurnUsage,
              fastMode,
              model,
              serviceTier,
              tokenUsage: event.notification.params.tokenUsage,
              turn,
            });
            pendingTurnUsage = turnUsage.accumulator ?? current.pendingTurnUsage;
            usageEntry = turnUsage.entry ?? usageEntry;
          }
          let nextRecentlyCompletedTurnUsage = current.recentlyCompletedTurnUsage;
          const trailingCompletedTurnUsage = Boolean(
            usageEntry && recentlyCompletedTurnUsage && turn?.id,
          );
          if (trailingCompletedTurnUsage && recentlyCompletedTurnUsage && turn) {
            const completedUsage = buildPendingTurnUsage({
              appendLatestUsage: true,
              contextWindow: current.contextWindow,
              existing: recentlyCompletedTurnUsage.accumulator,
              fastMode,
              model,
              serviceTier,
              tokenUsage: event.notification.params.tokenUsage,
              turn,
            });
            usageEntry = completedUsage.entry ?? usageEntry;
            nextRecentlyCompletedTurnUsage = {
              accumulator:
                completedUsage.accumulator
                ?? recentlyCompletedTurnUsage.accumulator,
              turn: recentlyCompletedTurnUsage.turn,
            };
          }
          if (!contextWindow && !usageEntry) {
            return current;
          }

          const holdUsageUntilTurnCompletes = Boolean(
            usageEntry &&
              current.activeTurnId &&
              turn?.id === current.activeTurnId &&
              turn.status !== "completed"
          );
          const suppressUsageEntry =
            usageEntry && shouldSuppressLiveUsageEntry(current, usageEntry);
          if (usageEntry && !holdUsageUntilTurnCompletes) {
            persistFinalizedUsageEntry({
              backend: event.backend,
              desktopApi,
              entry: suppressUsageEntry ? undefined : usageEntry,
              threadId: notificationThreadId,
            });
          }

          return {
            ...current,
            ...(contextWindow ? { contextWindow } : {}),
            expectOwnUpdate:
              usageEntry && !holdUsageUntilTurnCompletes
                ? true
                : current.expectOwnUpdate,
            interacted:
              usageEntry && !holdUsageUntilTurnCompletes
                ? true
                : current.interacted,
            lastTouchedAt: nextLastTouchedAt,
            optimisticEntries: usageEntry && !holdUsageUntilTurnCompletes
              ? suppressUsageEntry
                ? current.optimisticEntries
                : mergeFinalizedUsageEntry(
                    current.optimisticEntries,
                    usageEntry,
                    { replaceCompleted: trailingCompletedTurnUsage },
                  )
              : current.optimisticEntries,
            pendingUsageActivityEntry: holdUsageUntilTurnCompletes
              ? usageEntry
              : current.pendingUsageActivityEntry,
            pendingTurnUsage: holdUsageUntilTurnCompletes
              ? pendingTurnUsage
              : current.pendingTurnUsage,
            recentlyCompletedTurnUsage: nextRecentlyCompletedTurnUsage,
          };
        }

        return current;
      });
    });
  }, [
    desktopApi,
    liveTranscriptEventFiltering,
    thread,
    threadKey,
    updateSession,
  ]);

  const selectedSession = threadKey ? sessions[threadKey] : undefined;
  const selectedPagination =
    selectedSession?.loadedHistory?.pagination
    ?? selectedSession?.response?.replay.pagination;

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      !thread ||
      !threadKey ||
      !desktopApi?.readThread ||
      selectedSession?.loadingMore ||
      !selectedPagination?.supportsPagination ||
      !selectedPagination.hasPreviousPage ||
      !selectedPagination.previousCursor
    ) {
      return;
    }

    const requestVersion = requestVersionsRef.current[threadKey] ?? 0;
    updateSession(threadKey, (current) => ({
      ...current,
      error: undefined,
      lastTouchedAt: Date.now(),
      loadingMore: true,
    }));

    try {
      const olderResponse = await desktopApi.readThread({
        backend: thread.source,
        federationTarget: thread.federation?.ref.target ??
          readRendererFederationTarget(),
        threadId: thread.id,
        before: selectedPagination.previousCursor,
        limit: THREAD_HISTORY_PAGE_LIMIT,
      });
      const hasAuthoritativeTurnUsage = olderResponse.pricing?.lines.some(
        (line) =>
          Boolean(line.turnId)
          && line.scope === "turn"
          && line.status !== "superseded"
          && line.turnUsageAttributed !== false,
      );
      const reconciledOlderResponse = hasAuthoritativeTurnUsage
        ? {
            ...olderResponse,
            replay: {
              ...olderResponse.replay,
              entries: reconcileCompletedTurnUsageEntries({
                activeTurnId: selectedSession?.activeTurnId,
                entries: olderResponse.replay.entries,
                lines: olderResponse.pricing?.lines,
                requireExistingTurnUsage: true,
              }),
            },
          }
        : olderResponse;

      if ((requestVersionsRef.current[threadKey] ?? 0) !== requestVersion) {
        return;
      }

      const historyIndex =
        loadedHistoryIndexesRef.current[threadKey]
        ?? createTranscriptHistoryIndex();
      loadedHistoryIndexesRef.current[threadKey] = historyIndex;
      let didAppendHistory = false;
      let appendedHistorySource: LoadedTranscriptHistory | undefined;
      let appendedHistory: LoadedTranscriptHistory | undefined;
      updateSession(threadKey, (current) => {
        if (!current.response) {
          delete loadedHistoryIndexesRef.current[threadKey];
          return {
            ...current,
            lastTouchedAt: Date.now(),
            loadingMore: false,
            response: reconciledOlderResponse,
          };
        }

        if (!didAppendHistory || appendedHistorySource !== current.loadedHistory) {
          didAppendHistory = true;
          appendedHistorySource = current.loadedHistory;
          appendedHistory = prependTranscriptHistoryPage({
            history: current.loadedHistory,
            index: historyIndex,
            page: reconciledOlderResponse,
            tailEntries: current.response.replay.entries,
          });
        }
        return {
          ...current,
          lastTouchedAt: Date.now(),
          loadedHistory: appendedHistory,
          loadingMore: false,
        };
      });
    } catch (error) {
      if ((requestVersionsRef.current[threadKey] ?? 0) !== requestVersion) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
        lastTouchedAt: Date.now(),
        loadingMore: false,
      }));
    }
  }, [
    desktopApi,
    selectedPagination,
    selectedSession?.activeTurnId,
    selectedSession?.loadingMore,
    thread,
    threadKey,
    updateSession,
  ]);

  const addOptimisticUserMessage = useCallback(
    (
      text: string,
      imageParts: AppServerThreadImagePart[] = [],
      turnId?: string,
    ): string => {
      if (!thread || !threadKey) {
        return `optimistic-${Date.now()}`;
      }

      const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = Date.now();
      const parts: AppServerThreadMessageEntry["parts"] = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...imageParts,
      ];
      const optimisticEntry: AppServerThreadMessageEntry = {
        type: "message",
        id,
        role: "user",
        text,
        parts,
        createdAt,
      };
      updateSession(threadKey, (current) => {
        const authoritativeEntry =
          findAuthoritativeUserMessageForOptimisticEntry({
            entry: optimisticEntry,
            response: current.response,
            turnId: turnId ?? current.activeTurnId,
          });
        const nextResponse = authoritativeEntry
          ? appendMessageEntries(
              current.response,
              {
                backend: thread.source,
                threadId: thread.id,
              },
              [
                mergeCompletedUserMessageWithOptimisticEntry(
                  authoritativeEntry,
                  [optimisticEntry],
                ),
              ],
            )
          : current.response;

        return {
          ...current,
          expectOwnUpdate: true,
          interacted: true,
          lastTouchedAt: Date.now(),
          optimisticEntries: authoritativeEntry
            ? current.optimisticEntries
            : [...current.optimisticEntries, optimisticEntry],
          response: nextResponse,
        };
      });
      return id;
    },
    [thread, threadKey, updateSession]
  );

  const removeOptimisticMessage = useCallback(
    (id: string): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        lastTouchedAt: Date.now(),
        optimisticEntries: current.optimisticEntries.filter((entry) => entry.id !== id),
      }));
    },
    [threadKey, updateSession]
  );

  const addOptimisticReviewEntry = useCallback(
    (displayText: string): string => {
      if (!thread || !threadKey) {
        return `optimistic-review-${Date.now()}`;
      }

      const id = `optimistic-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      updateSession(threadKey, (current) => ({
        ...current,
        expectOwnUpdate: true,
        interacted: true,
        lastTouchedAt: Date.now(),
        optimisticEntries: [
          ...current.optimisticEntries,
          {
            type: "review",
            id,
            review: displayText,
            displayText,
            createdAt: Date.now(),
          },
        ],
      }));
      return id;
    },
    [thread, threadKey, updateSession]
  );

  const upsertLiveTranscriptEntry = useCallback(
    (entry: AppServerThreadEntry): void => {
      if (!threadKey) {
        return;
      }

      const retainedLiveEntryStore =
        retainedLiveEntriesRef.current[threadKey]
        ?? new Map<string, AppServerThreadEntry>();
      retainedLiveEntriesRef.current[threadKey] = retainedLiveEntryStore;
      const entryId = entry.id;
      if (retainedLiveEntryStore.get(entryId) === entry) {
        return;
      }
      retainedLiveEntryStore.set(entryId, entry);

      updateSession(threadKey, (current) => ({
        ...current,
        expectOwnUpdate: true,
        interacted: true,
        lastTouchedAt: Date.now(),
        retainedLiveEntryCount: retainedLiveEntryStore.size,
        retainedLiveEntryVersion: current.retainedLiveEntryVersion + 1,
      }));
    },
    [threadKey, updateSession]
  );

  const setPendingStatusText = useCallback(
    (status?: string): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        lastTouchedAt: Date.now(),
        pendingStatusText: status,
      }));
    },
    [threadKey, updateSession]
  );

  const setActiveTurnId = useCallback(
    (turnId?: string): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        activeTurnId: turnId,
        activeTurnStartedAt: turnId ? Date.now() : undefined,
        expectOwnUpdate: Boolean(turnId) || current.expectOwnUpdate,
        interacted: Boolean(turnId) || current.interacted,
        lastTouchedAt: Date.now(),
        pendingTurnUsage: undefined,
        recentlyCompletedTurnUsage: undefined,
      }));
    },
    [threadKey, updateSession]
  );

  const clearPendingRequest = useCallback(
    (requestId: string, nextStatus?: string): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        lastTouchedAt: Date.now(),
        pendingRequest:
          current.pendingRequest?.params.requestId === requestId
            ? undefined
            : current.pendingRequest,
        pendingMcpInteraction:
          current.pendingMcpInteraction?.requestId === requestId
            ? undefined
            : current.pendingMcpInteraction,
        pendingUserInput:
          current.pendingUserInput?.requestId === requestId
            ? undefined
            : current.pendingUserInput,
        pendingStatusText: nextStatus,
      }));
    },
    [threadKey, updateSession]
  );

  const updatePendingUserInput = useCallback(
    (
      requestId: string,
      updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState
    ): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => {
        if (current.pendingUserInput?.requestId !== requestId) {
          return current;
        }

        return {
          ...current,
          lastTouchedAt: Date.now(),
          pendingUserInput: updater(current.pendingUserInput),
        };
      });
    },
    [threadKey, updateSession]
  );

  const updatePendingMcpInteraction = useCallback(
    (
      requestId: string,
      updater: (state: PendingMcpInteractionState) => PendingMcpInteractionState
    ): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => {
        if (current.pendingMcpInteraction?.requestId !== requestId) {
          return current;
        }

        return {
          ...current,
          lastTouchedAt: Date.now(),
          pendingMcpInteraction: updater(current.pendingMcpInteraction),
        };
      });
    },
    [threadKey, updateSession]
  );

  const setViewport = useCallback(
    (viewport?: ThreadViewportState): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => {
        const nextViewport =
          viewport &&
          Number.isFinite(viewport.scrollTop) &&
          Number.isFinite(viewport.distanceFromBottom)
            ? {
                distanceFromBottom: Math.max(0, viewport.distanceFromBottom),
                isGluedToBottom: viewport.isGluedToBottom,
                scrollTop: Math.max(0, viewport.scrollTop),
              }
            : undefined;

        if (
          current.viewport?.scrollTop === nextViewport?.scrollTop &&
          current.viewport?.distanceFromBottom === nextViewport?.distanceFromBottom &&
          current.viewport?.isGluedToBottom === nextViewport?.isGluedToBottom
        ) {
          return current;
        }

        return {
          ...current,
          lastTouchedAt: Date.now(),
          viewport: nextViewport,
        };
      });
    },
    [threadKey, updateSession]
  );

  const setExpandedTranscriptWorkPhaseGroupIds = useCallback(
    (groupIds: string[]): void => {
      if (!threadKey) {
        return;
      }

      const nextGroupIds = [...new Set(groupIds.filter(Boolean))];
      updateSession(threadKey, (current) => {
        const currentGroupIds = current.expandedTranscriptWorkPhaseGroupIds ?? [];
        if (
          currentGroupIds.length === nextGroupIds.length
          && currentGroupIds.every(
            (groupId, index) => groupId === nextGroupIds[index]
          )
        ) {
          return current;
        }

        return {
          ...current,
          expandedTranscriptWorkPhaseGroupIds: nextGroupIds,
          lastTouchedAt: Date.now(),
        };
      });
    },
    [threadKey, updateSession]
  );

  const setExpandedTranscriptActivityIds = useCallback(
    (activityIds: string[]): void => {
      if (!threadKey) {
        return;
      }

      const nextActivityIds = [...new Set(activityIds.filter(Boolean))];
      updateSession(threadKey, (current) => {
        const currentActivityIds = current.expandedTranscriptActivityIds ?? [];
        if (
          currentActivityIds.length === nextActivityIds.length
          && currentActivityIds.every(
            (activityId, index) => activityId === nextActivityIds[index]
          )
        ) {
          return current;
        }

        return {
          ...current,
          expandedTranscriptActivityIds: nextActivityIds,
          lastTouchedAt: Date.now(),
        };
      });
    },
    [threadKey, updateSession]
  );

  const setRenderedTranscriptEntryLimit = useCallback(
    (limit: number): void => {
      if (!threadKey || !Number.isFinite(limit)) {
        return;
      }

      const nextLimit = Math.max(1, Math.floor(limit));
      updateSession(threadKey, (current) => {
        if (current.renderedTranscriptEntryLimit === nextLimit) {
          return current;
        }

        return {
          ...current,
          lastTouchedAt: Date.now(),
          renderedTranscriptEntryLimit: nextLimit,
        };
      });
    },
    [threadKey, updateSession]
  );

  const selectedRetainedLiveEntryVersion =
    selectedSession?.retainedLiveEntryVersion;
  const selectedLaunchpadMessageCandidate =
    threadKey && launchpadMessageCandidateRef.current?.threadKey === threadKey
      ? launchpadMessageCandidateRef.current.candidate
      : undefined;
  const selectedReconciledLaunchpadMessageId = threadKey
    ? reconciledLaunchpadMessageIdsRef.current[threadKey]
    : undefined;
  const selectedRetainedLiveEntries = useMemo(() => {
    if (!threadKey || selectedRetainedLiveEntryVersion === undefined) {
      return [];
    }
    return [...(retainedLiveEntriesRef.current[threadKey]?.values() ?? [])];
  }, [selectedRetainedLiveEntryVersion, threadKey]);
  const visibleLocalOptimisticEntries = useMemo(
    () => pruneOptimisticEntries(
      selectedSession?.optimisticEntries ?? [],
      selectedSession?.response,
      selectedReconciledLaunchpadMessageId,
      selectedLaunchpadMessageCandidate,
    ),
    [
      selectedSession?.optimisticEntries,
      selectedSession?.response,
      selectedLaunchpadMessageCandidate,
      selectedReconciledLaunchpadMessageId,
    ],
  );
  const visibleOptimisticEntries = useMemo(
    () => selectedRetainedLiveEntries.length > 0
      ? [...visibleLocalOptimisticEntries, ...selectedRetainedLiveEntries]
      : visibleLocalOptimisticEntries,
    [
      selectedRetainedLiveEntries,
      visibleLocalOptimisticEntries,
    ],
  );

  const selectedHistoryIndex = threadKey
    ? loadedHistoryIndexesRef.current[threadKey]
    : undefined;
  const response = useMemo(
    () => combineTranscriptResponse({
      history: selectedSession?.loadedHistory,
      index: selectedHistoryIndex,
      response: selectedSession?.response,
    }),
    [
      selectedHistoryIndex,
      selectedSession?.loadedHistory,
      selectedSession?.response,
    ],
  );

  const mergedTailEntries = useMemo(
    () => mergeTranscriptEntries(
      selectedSession?.response?.replay.entries ?? [],
      visibleOptimisticEntries,
    ),
    [selectedSession?.response?.replay.entries, visibleOptimisticEntries],
  );
  const visibleLaunchpadMessageCandidate = useMemo(
    () => selectedLaunchpadMessageCandidate
      && visibleLocalOptimisticEntries.some(
        (entry) => entry.id === selectedLaunchpadMessageCandidate.entry.id,
      )
      ? selectedLaunchpadMessageCandidate
      : undefined,
    [selectedLaunchpadMessageCandidate, visibleLocalOptimisticEntries],
  );
  const selectedResponseEntries = selectedSession?.response?.replay.entries;
  const selectedResponseMessages = selectedSession?.response?.replay.messages;
  const authoritativeLaunchpadMessageExists = useMemo(
    () => Boolean(
      visibleLaunchpadMessageCandidate
      && selectedResponseEntries
      && selectedResponseMessages
      && hasAuthoritativeLaunchpadMessageProjection({
        candidate: visibleLaunchpadMessageCandidate,
        entries: selectedResponseEntries,
        messages: selectedResponseMessages,
        reconciledMessageId: selectedReconciledLaunchpadMessageId,
      })
    ),
    [
      selectedReconciledLaunchpadMessageId,
      selectedResponseEntries,
      selectedResponseMessages,
      visibleLaunchpadMessageCandidate,
    ],
  );
  const visibleOptimisticMessageEntries = useMemo(() => {
    return visibleOptimisticEntries.filter(
      (entry): entry is AppServerThreadMessageEntry =>
        entry.type === "message"
        && !(
          authoritativeLaunchpadMessageExists
          && entry.id === selectedLaunchpadMessageCandidate?.entry.id
        )
    );
  }, [
    authoritativeLaunchpadMessageExists,
    selectedLaunchpadMessageCandidate,
    visibleOptimisticEntries,
  ]);
  const reconciledTailEntries = useMemo(
    () => reconcileCompletedTurnUsageEntries({
      activeTurnId: selectedSession?.activeTurnId,
      entries: mergedTailEntries,
      lines: selectedSession?.response?.pricing?.lines,
    }),
    [
      mergedTailEntries,
      selectedSession?.activeTurnId,
      selectedSession?.response?.pricing?.lines,
    ],
  );
  const mergedTailMessages = useMemo(
    () => mergeTranscriptMessages(
      selectedSession?.response?.replay.messages ?? [],
      visibleOptimisticMessageEntries.map(({ type: _type, ...message }) => message),
    ),
    [selectedSession?.response?.replay.messages, visibleOptimisticMessageEntries],
  );
  const reviewPresentation = useMemo(
    () => createTranscriptReviewPresentation({
      history: selectedSession?.loadedHistory,
      index: selectedHistoryIndex,
      tailEntries: reconciledTailEntries,
      tailMessages: mergedTailMessages,
    }),
    [
      mergedTailMessages,
      reconciledTailEntries,
      selectedHistoryIndex,
      selectedSession?.loadedHistory,
    ],
  );

  const entries = useMemo(
    () =>
      combineTranscriptEntries(
        selectedSession?.loadedHistory,
        selectedHistoryIndex,
        reviewPresentation.tailEntries,
        reviewPresentation,
      ),
    [
      reviewPresentation,
      selectedHistoryIndex,
      selectedSession?.loadedHistory,
    ]
  );

  const messages = useMemo(
    () =>
      combineTranscriptMessages(
        selectedSession?.loadedHistory,
        selectedHistoryIndex,
        reviewPresentation.tailMessages,
        reviewPresentation,
      ),
    [
      reviewPresentation,
      selectedHistoryIndex,
      selectedSession?.loadedHistory,
    ]
  );

  const thinkingThreadKeys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sessions)
          .filter(([, session]) => hasThinkingState(session))
          .map(([sessionThreadKey]) => [sessionThreadKey, true])
      ),
    [sessions]
  );
  const approvalRequestThreadKeys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sessions)
          .filter(([, session]) => Boolean(session.pendingRequest))
          .map(([sessionThreadKey]) => [sessionThreadKey, true])
      ),
    [sessions]
  );
  const inputRequestThreadKeys = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(sessions)
          .filter(([, session]) => Boolean(session.pendingUserInput))
          .map(([sessionThreadKey]) => [sessionThreadKey, true])
      ),
    [sessions]
  );
  const pendingStatusText =
    selectedSession?.pendingStatusText &&
    selectedSession.pendingStatusText !== "Thinking"
      ? selectedSession.pendingStatusText
      : selectedSession?.transientMessage
        ? undefined
        : selectedSession?.pendingStatusText ??
          (selectedSession?.activeTurnId || selectedSession?.backendReportedActive
            ? "Thinking"
            : undefined);
  const threadBusy = selectedSession ? hasThinkingState(selectedSession) : false;
  const transientMessages = useMemo(
    () => [
      ...(selectedSession?.settledTransientMessages ?? []),
      ...(selectedSession?.transientMessage
        ? [selectedSession.transientMessage]
        : []),
    ],
    [
      selectedSession?.settledTransientMessages,
      selectedSession?.transientMessage,
    ],
  );

  return {
    activeTurnId: selectedSession?.activeTurnId,
    activeTurnStartedAt: selectedSession?.activeTurnStartedAt,
    addOptimisticUserMessage,
    addOptimisticReviewEntry,
    clearPendingRequest,
    entries,
    error: selectedSession?.error,
    initialLoadDurationMs: selectedSession?.initialLoadDurationMs,
    loading: selectedSession?.loading ?? false,
    loadingMore: selectedSession?.loadingMore ?? false,
    loadOlder,
    reload,
    messages,
    contextWindow: selectedSession?.contextWindow,
    pendingAssistantMessage: selectedSession?.pendingAssistantMessage,
    pendingMcpInteraction: selectedSession?.pendingMcpInteraction,
    pendingRequest: selectedSession?.pendingRequest,
    pendingUserInput: selectedSession?.pendingUserInput,
    pendingStatusText,
    transientMessage: selectedSession?.transientMessage,
    transientMessages,
    runningTurnUsageText: runningTurnUsageTextFromEntry(
      selectedSession?.pendingUsageActivityEntry
    ),
    approvalRequestThreadKeys,
    inputRequestThreadKeys,
    removeOptimisticMessage,
    response,
    setActiveTurnId,
    setExpandedTranscriptWorkPhaseGroupIds,
    upsertLiveTranscriptEntry,
    updatePendingUserInput,
    updatePendingMcpInteraction,
    setPendingStatusText,
    setExpandedTranscriptActivityIds,
    setRenderedTranscriptEntryLimit,
    threadBusy,
    thinkingThreadKeys,
    setViewport,
    viewport: selectedSession?.viewport,
    expandedTranscriptActivityIds:
      selectedSession?.expandedTranscriptActivityIds
      ?? EMPTY_EXPANDED_TRANSCRIPT_ACTIVITY_IDS,
    expandedTranscriptWorkPhaseGroupIds:
      selectedSession?.expandedTranscriptWorkPhaseGroupIds
      ?? EMPTY_EXPANDED_TRANSCRIPT_WORK_PHASE_GROUP_IDS,
    renderedTranscriptEntryLimit: selectedSession?.renderedTranscriptEntryLimit,
  };
}
