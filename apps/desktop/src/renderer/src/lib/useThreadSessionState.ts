import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerToolRequestUserInputNotification,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
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

const MAX_VIEW_ONLY_THREADS = 10;
const SUPPORTED_APPROVAL_REQUEST_METHODS = new Set([
  "turn/requestApproval",
  "review/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export type ThreadViewportState = {
  distanceFromBottom: number;
  scrollTop: number;
};

type ThreadSessionEntry = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  completionHydrationRetries: number;
  error?: string;
  expectOwnUpdate: boolean;
  failedHydrationVersion?: number | "unknown";
  hydratedUpdatedAt?: number;
  interacted: boolean;
  lastTouchedAt: number;
  loading: boolean;
  loadingMore: boolean;
  needsHydrationAfterCompletion: boolean;
  optimisticEntries: AppServerThreadMessageEntry[];
  pendingAssistantMessage?: AppServerThreadMessageEntry;
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
  optimisticEntries: AppServerThreadMessageEntry[],
  response: AppServerReadThreadResponse | undefined
): AppServerThreadMessageEntry[] {
  if (!response) {
    return optimisticEntries;
  }

  return optimisticEntries.filter(
    (entry) =>
      !response.replay.messages.some(
        (message) => messageMatchesOptimisticEntry(message, entry)
      )
  );
}

function hasHydratedTranscriptContent(session: ThreadSessionEntry): boolean {
  return Boolean(
    session.response?.replay.entries.length ||
      session.optimisticEntries.length ||
      session.pendingAssistantMessage ||
      session.pendingRequest ||
      session.pendingUserInput
  );
}

function hasThinkingState(session: ThreadSessionEntry): boolean {
  return Boolean(
    session.activeTurnId ||
      session.pendingStatusText ||
      session.pendingAssistantMessage ||
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
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  entries: AppServerThreadEntry[];
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;
  messages: AppServerThreadMessage[];
  pendingAssistantMessage?: AppServerThreadMessageEntry;
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
        const optimisticMessageExists = current.optimisticEntries.some((entry) =>
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
      if (!hasHydratedTranscriptContent(session)) {
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

      updateSession(threadKey, (current) => ({
        ...current,
        hydratedUpdatedAt: thread.updatedAt,
        lastTouchedAt: Date.now(),
      }));
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
                current.optimisticEntries,
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
            pendingUserInput:
              current.pendingUserInput?.requestId === event.notification.params.requestId
                ? undefined
                : current.pendingUserInput,
            pendingStatusText: "Thinking",
          };
        }

        if (event.notification.method === "turn/completed") {
          const completedTurn = buildTurnMetadata({
            fallbackId: event.notification.params.turnId ?? current.activeTurnId,
            fallbackStartedAt: current.activeTurnStartedAt,
            fallbackStatus: "completed",
            turn: event.notification.params.turn,
          });
          const completedTurnText = readCompletedTurnText(event.notification.params);
          const completedText =
            completedTurnText ?? current.pendingAssistantMessage?.text;
          const shouldAppendFinalMessage = Boolean(
            completedText &&
              current.pendingAssistantMessage?.text !== completedText
          );
          const unphasedAssistantCompletionPhase =
            shouldAppendFinalMessage ? "commentary" : undefined;
          const shouldHydrateUnknownPhaseAssistant =
            !completedTurnText &&
            Boolean(
              current.pendingAssistantMessage &&
                current.pendingAssistantMessage.phase === undefined
            );
          const nextEntries = [
            ...current.optimisticEntries.map((entry) =>
              entry.turn?.id === completedTurn?.id
                ? withTurnMetadata(entry, completedTurn)
                : entry
            ),
            ...(current.pendingAssistantMessage
              ? [
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
            failedHydrationVersion: undefined,
            hydratedUpdatedAt: undefined,
            lastTouchedAt: nextLastTouchedAt,
            response: undefined,
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
    () => mergeItems(selectedSession?.response?.replay.entries ?? [], visibleOptimisticEntries),
    [selectedSession?.response?.replay.entries, visibleOptimisticEntries]
  );

  const messages = useMemo(
    () =>
      mergeItems(
        selectedSession?.response?.replay.messages ?? [],
        visibleOptimisticEntries.map(({ type: _type, ...message }) => message)
      ),
    [selectedSession?.response?.replay.messages, visibleOptimisticEntries]
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
    clearPendingRequest,
    entries,
    error: selectedSession?.error,
    loading: selectedSession?.loading ?? false,
    loadingMore: selectedSession?.loadingMore ?? false,
    loadOlder,
    messages,
    pendingAssistantMessage: selectedSession?.pendingAssistantMessage,
    pendingRequest: selectedSession?.pendingRequest,
    pendingUserInput: selectedSession?.pendingUserInput,
    pendingStatusText,
    removeOptimisticMessage,
    response: selectedSession?.response,
    setActiveTurnId,
    updatePendingUserInput,
    setPendingStatusText,
    thinkingThreadKeys,
    setViewport,
    viewport: selectedSession?.viewport,
  };
}
