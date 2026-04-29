import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerNotification,
  AppServerMcpElicitationRequestNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerReviewOutput,
  AppServerToolRequestUserInputNotification,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadReviewEntry,
  AppServerThreadTurnMetadata,
  AppServerThreadImagePart,
  NavigationThreadSummary,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";
import {
  createQuestionnaireState,
  type PendingQuestionnaireState,
} from "../features/thread-detail/questionnaire";
import { normalizeReviewDisplayText } from "../../../shared/review-command";
import {
  createMcpElicitationState,
  type PendingMcpInteractionState,
} from "../features/thread-detail/mcp-elicitation";

const MAX_VIEW_ONLY_THREADS = 10;
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
  scrollTop: number;
};

export type ThreadContextWindowState = {
  cachedInputTokens?: number;
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

type ThreadSessionEntry = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  completionHydrationRetries: number;
  contextWindow?: ThreadContextWindowState;
  error?: string;
  expectOwnUpdate: boolean;
  failedHydrationVersion?: number | "unknown";
  hydratedUpdatedAt?: number;
  interacted: boolean;
  lastTouchedAt: number;
  loading: boolean;
  loadingMore: boolean;
  needsHydrationAfterCompletion: boolean;
  optimisticEntries: AppServerThreadEntry[];
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  response?: AppServerReadThreadResponse;
  viewport?: ThreadViewportState;
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
    optimisticEntries: [],
  };
}

function mergeItems<T extends { id: string }>(olderItems: T[], newerItems: T[]): T[] {
  const deduped = new Map<string, T>();

  for (const item of [...olderItems, ...newerItems]) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()];
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

function getThreadHydrationVersion(
  thread: Pick<NavigationThreadSummary, "updatedAt">
): number | "unknown" {
  return typeof thread.updatedAt === "number" ? thread.updatedAt : "unknown";
}

function pruneOptimisticEntries(
  optimisticEntries: AppServerThreadEntry[],
  response: AppServerReadThreadResponse | undefined
): AppServerThreadEntry[] {
  if (!response) {
    return optimisticEntries;
  }

  return optimisticEntries.filter((entry) => {
    if (entry.type === "message") {
      return !response.replay.messages.some((message) =>
        messageMatchesOptimisticEntry(message, entry)
      );
    }

    if (entry.type === "review") {
      return !response.replay.entries.some(
        (candidate) =>
          candidate.type === "review" &&
          reviewEntriesMatch(candidate, entry)
      );
    }

    return !response.replay.entries.some((candidate) => candidate.id === entry.id);
  });
}

function reviewEntriesMatch(
  candidate: AppServerThreadReviewEntry,
  optimisticEntry: AppServerThreadReviewEntry
): boolean {
  const candidateLabels = reviewEntryLabels(candidate);
  const optimisticLabels = reviewEntryLabels(optimisticEntry);
  return optimisticLabels.some((label) => candidateLabels.includes(label));
}

function reviewEntryLabels(entry: AppServerThreadReviewEntry): string[] {
  return [entry.displayText, entry.review]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeReviewDisplayText(value).toLocaleLowerCase());
}

function normalizeTranscriptText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function reviewResultTexts(entries: AppServerThreadEntry[]): Set<string> {
  const output = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "review") {
      continue;
    }

    const text = entry.output?.overall_explanation ?? entry.review;
    if (text.trim()) {
      output.add(normalizeTranscriptText(text));
    }
  }
  return output;
}

function suppressReviewDuplicateMessages<T extends AppServerThreadMessage | AppServerThreadEntry>(
  messagesOrEntries: T[],
  reviewTexts: Set<string>
): T[] {
  if (reviewTexts.size === 0) {
    return messagesOrEntries;
  }

  return messagesOrEntries.filter((entry) => {
    if (
      "role" in entry &&
      entry.role === "assistant" &&
      "text" in entry &&
      typeof entry.text === "string"
    ) {
      return !reviewTexts.has(normalizeTranscriptText(entry.text));
    }
    return true;
  });
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
      session.pendingAssistantMessage ||
      session.pendingMcpInteraction ||
      session.pendingRequest ||
      session.pendingUserInput
  );
}

function hasThinkingState(session: ThreadSessionEntry): boolean {
  return Boolean(
    session.activeTurnId ||
      session.pendingStatusText ||
      session.pendingAssistantMessage ||
      session.pendingMcpInteraction ||
      session.pendingRequest ||
      session.pendingUserInput ||
      (session.expectOwnUpdate && session.optimisticEntries.length > 0)
  );
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

type TokenUsageBreakdown = {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

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

function normalizeThreadContextWindowState(
  tokenUsage: unknown
): ThreadContextWindowState | undefined {
  const root =
    readRecord(findFirstNestedValue(tokenUsage, ["tokenUsage", "token_usage", "info"])) ??
    readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const currentUsageRecord =
    readRecord(findFirstNestedValue(root, ["last", "last_token_usage"])) ??
    readRecord(root.last) ??
    readRecord(root.last_token_usage) ??
    readRecord(findFirstNestedValue(root, ["total", "total_token_usage"])) ??
    readRecord(root.total) ??
    readRecord(root.total_token_usage);
  const totalUsageRecord =
    readRecord(findFirstNestedValue(root, ["total", "total_token_usage"])) ??
    readRecord(root.total) ??
    readRecord(root.total_token_usage);
  const currentUsage = currentUsageRecord ? readTokenBreakdown(currentUsageRecord) : undefined;
  const totalUsage = totalUsageRecord ? readTokenBreakdown(totalUsageRecord) : undefined;
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

  return {
    cachedInputTokens: currentUsage.cachedInputTokens,
    cumulativeTotalTokens:
      totalUsage?.totalTokens !== undefined && totalUsage.totalTokens !== totalTokens
        ? totalUsage.totalTokens
        : undefined,
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
): notification is Extract<AppServerNotification, { method: "item/started" | "item/completed" }> {
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

function messageMatchesOptimisticEntry(
  message: AppServerThreadMessage,
  entry: AppServerThreadMessageEntry
): boolean {
  if (message.role !== entry.role || message.text !== entry.text) {
    return false;
  }

  const entryImages = (entry.parts ?? []).filter((part) => part.type === "image");
  if (entryImages.length === 0) {
    return true;
  }

  const messageImages = (message.parts ?? []).filter((part) => part.type === "image");
  return (
    messageImages.length === entryImages.length &&
    entryImages.every((image, index) => messageImages[index]?.url === image.url)
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
      entries: mergeItems(baseResponse.replay.entries, entries),
      messages: mergeItems(baseResponse.replay.messages, nextMessages),
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
      entries: mergeItems(baseResponse.replay.entries, entries),
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

function normalizeReviewOutput(value: unknown): AppServerReviewOutput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const findings = Array.isArray(record.findings) ? record.findings : undefined;
  if (
    !findings ||
    (record.overall_correctness !== "patch is correct" &&
      record.overall_correctness !== "patch is incorrect") ||
    typeof record.overall_explanation !== "string" ||
    typeof record.overall_confidence_score !== "number"
  ) {
    return undefined;
  }

  return {
    findings: findings as AppServerReviewOutput["findings"],
    overall_correctness: record.overall_correctness,
    overall_explanation: record.overall_explanation,
    overall_confidence_score: record.overall_confidence_score,
  };
}

function reviewEntryFromCompletedItem(params: {
  turnId?: string;
  item?: {
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
  const output = normalizeReviewOutput(record.data?.reviewOutput);
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
    ...(turn ? { turn } : {}),
    createdAt: Date.now(),
  };
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
  thread?: NavigationThreadSummary;
}): {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  addOptimisticUserMessage: (
    text: string,
    imageParts?: AppServerThreadImagePart[]
  ) => string;
  addOptimisticReviewEntry: (displayText: string) => string;
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  entries: AppServerThreadEntry[];
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;
  messages: AppServerThreadMessage[];
  contextWindow?: ThreadContextWindowState;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
  removeOptimisticMessage: (id: string) => void;
  response?: AppServerReadThreadResponse;
  setActiveTurnId: (turnId?: string) => void;
  updatePendingUserInput: (
    requestId: string,
    updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState
  ) => void;
  updatePendingMcpInteraction: (
    requestId: string,
    updater: (state: PendingMcpInteractionState) => PendingMcpInteractionState
  ) => void;
  setPendingStatusText: (status?: string) => void;
  thinkingThreadKeys: Record<string, boolean>;
  setViewport: (viewport?: ThreadViewportState) => void;
  viewport?: ThreadViewportState;
} {
  const { desktopApi, thread } = params;
  const threadKey = thread
    ? buildThreadIdentityKey(thread.source, thread.id)
    : undefined;
  const selectedThreadKeyRef = useRef<string | undefined>(undefined);
  const requestVersionsRef = useRef<Record<string, number>>({});
  const [sessions, setSessions] = useState<ThreadSessionState>({});

  selectedThreadKeyRef.current = threadKey;

  const updateSession = useCallback(
    (
      targetThreadKey: string,
      updater: (current: ThreadSessionEntry) => ThreadSessionEntry
    ): void => {
      setSessions((current) => {
        const previous = current[targetThreadKey] ?? createEmptyThreadSessionEntry();
        const next = updater(previous);
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

  const loadLatest = useCallback(
    async (targetThread: NavigationThreadSummary): Promise<void> => {
      const readThread = desktopApi?.readThread;
      const targetThreadKey = buildThreadIdentityKey(targetThread.source, targetThread.id);
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
      }));

      try {
        const response = await readThread({
          backend: targetThread.source,
          threadId: targetThread.id,
        });

        if (requestVersionsRef.current[targetThreadKey] !== requestVersion) {
          return;
        }

        updateSession(targetThreadKey, (current) => {
          const hydratedCompletedTurn = didHydrateCompletedTurn(current.response, response);
          const needsHydrationAfterCompletion =
            current.needsHydrationAfterCompletion && !hydratedCompletedTurn;
          const completionHydrationRetries = needsHydrationAfterCompletion
            ? current.completionHydrationRetries + 1
            : 0;

          return {
            ...current,
            error: undefined,
            expectOwnUpdate: false,
            failedHydrationVersion: undefined,
            hydratedUpdatedAt:
              needsHydrationAfterCompletion && completionHydrationRetries < 2
                ? undefined
                : targetThread.updatedAt,
            lastTouchedAt: Date.now(),
            loading: false,
            completionHydrationRetries,
            needsHydrationAfterCompletion,
            optimisticEntries: pruneOptimisticEntries(current.optimisticEntries, response),
            response,
          };
        });
      } catch (error) {
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
    [desktopApi?.readThread, updateSession]
  );

  useEffect(() => {
    if (!threadKey) {
      return;
    }

    updateSession(threadKey, (current) => ({
      ...current,
      lastTouchedAt: Date.now(),
    }));
  }, [threadKey, updateSession]);

  useEffect(() => {
    if (!thread || !threadKey) {
      return;
    }

    const optimisticUserMessage = thread.optimisticUserMessage;
    if (optimisticUserMessage) {
      const optimisticEntry: AppServerThreadMessageEntry = {
        type: "message",
        id: `optimistic-launchpad-${threadKey}`,
        role: "user",
        text: optimisticUserMessage.text,
        parts: [
          ...(optimisticUserMessage.text
            ? [{ type: "text" as const, text: optimisticUserMessage.text }]
            : []),
          ...(optimisticUserMessage.imageParts ?? []),
        ],
        createdAt: optimisticUserMessage.createdAt ?? Date.now(),
      };

      updateSession(threadKey, (current) => {
        const persistedMessageExists = current.response?.replay.messages.some((message) =>
          messageMatchesOptimisticEntry(message, optimisticEntry)
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
            optimisticEntry
          )
        );

        if (persistedMessageExists || optimisticMessageExists) {
          return current;
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

    if (session.loading || session.activeTurnId) {
      return;
    }

    if (thread.updatedAt == null || session.hydratedUpdatedAt === thread.updatedAt) {
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
  }, [loadLatest, sessions, thread, threadKey, updateSession]);

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

      const targetThreadKey = buildThreadIdentityKey(event.backend, notificationThreadId);

      updateSession(targetThreadKey, (current) => {
        const nextLastTouchedAt = Date.now();

        if (isApprovalRequestNotification(event.notification)) {
          return {
            ...current,
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

          return {
            ...current,
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

          return {
            ...current,
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

          return {
            ...current,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingAssistantMessage: {
              type: "message",
              id: itemId,
              role: "assistant",
              phase,
              ...(turn ? { turn } : {}),
              text:
                isSamePendingMessage
                  ? `${pendingText}${delta}`
                  : delta,
            },
            response: flushedResponse,
          };
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

          return {
            ...current,
            activeTurnId: turnId,
            activeTurnStartedAt: startedAt,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
          };
        }

        if (
          event.notification.method === "serverRequest/resolved" &&
          "requestId" in event.notification.params
        ) {
          return {
            ...current,
            lastTouchedAt: nextLastTouchedAt,
            pendingRequest:
              current.pendingRequest?.params.requestId === event.notification.params.requestId
                ? undefined
                : current.pendingRequest,
            pendingMcpInteraction:
              current.pendingMcpInteraction?.requestId === event.notification.params.requestId
                ? undefined
                : current.pendingMcpInteraction,
            pendingUserInput:
              current.pendingUserInput?.requestId === event.notification.params.requestId
                ? undefined
                : current.pendingUserInput,
            pendingStatusText: "Thinking",
          };
        }

        if (event.notification.method === "item/completed") {
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
        }

        if (event.notification.method === "turn/completed") {
          const completedTurn = buildTurnMetadata({
            fallbackId: event.notification.params.turnId ?? current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "completed",
            turn: event.notification.params.turn,
          });
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
              current.pendingAssistantMessage?.text !== completedText
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
              .map((entry) =>
                entry.turn?.id === completedTurn?.id
                  ? { ...entry, turn: completedTurn }
                  : entry
              ),
            ...(current.pendingAssistantMessage
              ? completedTurnHasReview
                ? []
                : [
                  withTurnMetadataAndPhase(
                    current.pendingAssistantMessage,
                    completedTurn,
                    unphasedAssistantCompletionPhase
                  ),
                ]
              : []),
          ];

          if (shouldAppendFinalMessage && completedText) {
            nextEntries.push({
              type: "message",
              id: `${event.notification.params.turnId}:assistant`,
              role: "assistant",
              phase: "final",
              ...(completedTurn ? { turn: completedTurn } : {}),
              text: completedText,
              createdAt: Date.now(),
            });
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

          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            completionHydrationRetries: 0,
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
              !completedText || shouldHydrateUnknownPhaseAssistant,
            optimisticEntries: [],
            pendingAssistantMessage: undefined,
            pendingMcpInteraction: undefined,
            pendingRequest: undefined,
            pendingUserInput: undefined,
            pendingStatusText: undefined,
            response: nextResponse,
          };
        }

        if (event.notification.method === "turn/failed") {
          const errorMessage =
            typeof event.notification.params.turn.error?.message === "string" &&
            event.notification.params.turn.error.message.trim()
              ? event.notification.params.turn.error.message
              : "Turn failed.";

          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            completionHydrationRetries: 0,
            error: errorMessage,
            expectOwnUpdate: false,
            lastTouchedAt: nextLastTouchedAt,
            needsHydrationAfterCompletion: false,
            pendingAssistantMessage: undefined,
            pendingMcpInteraction: undefined,
            pendingRequest: undefined,
            pendingUserInput: undefined,
            pendingStatusText: undefined,
          };
        }

        if (event.notification.method === "turn/cancelled") {
          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            completionHydrationRetries: 0,
            error: undefined,
            expectOwnUpdate: false,
            lastTouchedAt: nextLastTouchedAt,
            needsHydrationAfterCompletion: false,
            pendingAssistantMessage: undefined,
            pendingMcpInteraction: undefined,
            pendingRequest: undefined,
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

          if (statusType === "idle") {
            if (current.activeTurnId || current.pendingStatusText) {
              return current;
            }

            return {
              ...current,
              activeTurnId: undefined,
              activeTurnStartedAt: undefined,
              lastTouchedAt: nextLastTouchedAt,
              pendingAssistantMessage: undefined,
              pendingStatusText: undefined,
            };
          }
        }

        if (event.notification.method === "thread/compacted") {
          return {
            ...current,
            activeTurnId: undefined,
            activeTurnStartedAt: undefined,
            contextWindow: undefined,
            failedHydrationVersion: undefined,
            hydratedUpdatedAt: undefined,
            lastTouchedAt: nextLastTouchedAt,
            pendingStatusText: undefined,
            response: undefined,
          };
        }

        if (event.notification.method === "thread/tokenUsage/updated") {
          const contextWindow = normalizeThreadContextWindowState(
            event.notification.params.tokenUsage
          );
          if (!contextWindow) {
            return current;
          }

          return {
            ...current,
            contextWindow,
            lastTouchedAt: nextLastTouchedAt,
          };
        }

        return current;
      });
    });
  }, [desktopApi, thread, threadKey, updateSession]);

  const selectedSession = threadKey ? sessions[threadKey] : undefined;

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      !thread ||
      !threadKey ||
      !desktopApi?.readThread ||
      !selectedSession?.response?.replay.pagination.supportsPagination ||
      !selectedSession.response.replay.pagination.hasPreviousPage ||
      !selectedSession.response.replay.pagination.previousCursor
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
        threadId: thread.id,
        before: selectedSession.response.replay.pagination.previousCursor,
      });

      if ((requestVersionsRef.current[threadKey] ?? 0) !== requestVersion) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        lastTouchedAt: Date.now(),
        loadingMore: false,
        response: current.response
          ? {
              ...olderResponse,
              replay: {
                ...olderResponse.replay,
                entries: mergeItems(
                  olderResponse.replay.entries,
                  current.response.replay.entries
                ),
                messages: mergeItems(
                  olderResponse.replay.messages,
                  current.response.replay.messages
                ),
              },
            }
          : olderResponse,
      }));
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
  }, [desktopApi, selectedSession?.response, thread, threadKey, updateSession]);

  const addOptimisticUserMessage = useCallback(
    (text: string, imageParts: AppServerThreadImagePart[] = []): string => {
      if (!thread || !threadKey) {
        return `optimistic-${Date.now()}`;
      }

      const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const parts: AppServerThreadMessageEntry["parts"] = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...imageParts,
      ];
      updateSession(threadKey, (current) => ({
        ...current,
        expectOwnUpdate: true,
        interacted: true,
        lastTouchedAt: Date.now(),
        optimisticEntries: [
          ...current.optimisticEntries,
          {
            type: "message",
            id,
            role: "user",
            text,
            parts,
            createdAt: Date.now(),
          },
        ],
      }));
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
                scrollTop: Math.max(0, viewport.scrollTop),
              }
            : undefined;

        if (
          current.viewport?.scrollTop === nextViewport?.scrollTop &&
          current.viewport?.distanceFromBottom === nextViewport?.distanceFromBottom
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

  const visibleOptimisticEntries = useMemo(
    () =>
      pruneOptimisticEntries(
        selectedSession?.optimisticEntries ?? [],
        selectedSession?.response
      ),
    [selectedSession?.optimisticEntries, selectedSession?.response]
  );

  const entries = useMemo(
    () => {
      const mergedEntries = mergeItems(
        selectedSession?.response?.replay.entries ?? [],
        visibleOptimisticEntries
      );
      return suppressReviewDuplicateMessages(
        mergedEntries,
        reviewResultTexts(mergedEntries)
      );
    },
    [selectedSession?.response?.replay.entries, visibleOptimisticEntries]
  );

  const messages = useMemo(
    () => {
      const mergedMessages = mergeItems(
        selectedSession?.response?.replay.messages ?? [],
        visibleOptimisticEntries
          .filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message")
          .map(({ type: _type, ...message }) => message)
      );
      return suppressReviewDuplicateMessages(
        mergedMessages,
        reviewResultTexts(entries)
      );
    },
    [entries, selectedSession?.response?.replay.messages, visibleOptimisticEntries]
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
  const pendingStatusText =
    selectedSession?.pendingStatusText ??
    (selectedSession?.activeTurnId ? "Thinking" : undefined);

  return {
    activeTurnId: selectedSession?.activeTurnId,
    activeTurnStartedAt: selectedSession?.activeTurnStartedAt,
    addOptimisticUserMessage,
    addOptimisticReviewEntry,
    clearPendingRequest,
    entries,
    error: selectedSession?.error,
    loading: selectedSession?.loading ?? false,
    loadingMore: selectedSession?.loadingMore ?? false,
    loadOlder,
    messages,
    contextWindow: selectedSession?.contextWindow,
    pendingAssistantMessage: selectedSession?.pendingAssistantMessage,
    pendingMcpInteraction: selectedSession?.pendingMcpInteraction,
    pendingRequest: selectedSession?.pendingRequest,
    pendingUserInput: selectedSession?.pendingUserInput,
    pendingStatusText,
    removeOptimisticMessage,
    response: selectedSession?.response,
    setActiveTurnId,
    updatePendingUserInput,
    updatePendingMcpInteraction,
    setPendingStatusText,
    thinkingThreadKeys,
    setViewport,
    viewport: selectedSession?.viewport,
  };
}
