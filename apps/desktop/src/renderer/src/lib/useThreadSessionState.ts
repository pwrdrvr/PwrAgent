import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  NavigationThreadSummary,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

const MAX_VIEW_ONLY_THREADS = 10;

type ThreadSessionEntry = {
  activeRunId?: string;
  error?: string;
  expectOwnUpdate: boolean;
  hydratedUpdatedAt?: number;
  interacted: boolean;
  lastTouchedAt: number;
  loading: boolean;
  loadingMore: boolean;
  optimisticEntries: AppServerThreadMessageEntry[];
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingStatusText?: string;
  response?: AppServerReadThreadResponse;
};

type ThreadSessionState = Record<string, ThreadSessionEntry>;

function createEmptyThreadSessionEntry(): ThreadSessionEntry {
  return {
    expectOwnUpdate: false,
    interacted: false,
    lastTouchedAt: Date.now(),
    loading: false,
    loadingMore: false,
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
        (message) => message.role === entry.role && message.text === entry.text
      )
  );
}

function appendAssistantMessage(
  response: AppServerReadThreadResponse | undefined,
  params: {
    backend: NavigationThreadSummary["source"];
    threadId: NavigationThreadSummary["id"];
  },
  message: AppServerThreadMessageEntry
): AppServerReadThreadResponse {
  const baseResponse = response ?? buildEmptyResponse(params);
  const assistantMessage: AppServerThreadMessage = {
    id: message.id,
    role: message.role,
    text: message.text,
    parts: message.parts,
    createdAt: message.createdAt,
  };

  return {
    ...baseResponse,
    fetchedAt: Date.now(),
    replay: {
      ...baseResponse.replay,
      entries: mergeItems(baseResponse.replay.entries, [message]),
      messages: mergeItems(baseResponse.replay.messages, [assistantMessage]),
      lastAssistantMessage: message.text,
    },
  };
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

export function useThreadSessionState(params: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
}): {
  activeRunId?: string;
  addOptimisticUserMessage: (text: string) => string;
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  entries: AppServerThreadEntry[];
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;
  messages: AppServerThreadMessage[];
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingStatusText?: string;
  removeOptimisticMessage: (id: string) => void;
  response?: AppServerReadThreadResponse;
  setActiveRunId: (runId?: string) => void;
  setPendingStatusText: (status?: string) => void;
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

      if (!readThread) {
        updateSession(targetThreadKey, (current) => ({
          ...current,
          error: "Desktop bridge is missing readThread().",
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

        updateSession(targetThreadKey, (current) => ({
          ...current,
          error: undefined,
          expectOwnUpdate: false,
          hydratedUpdatedAt: targetThread.updatedAt,
          lastTouchedAt: Date.now(),
          loading: false,
          optimisticEntries: pruneOptimisticEntries(current.optimisticEntries, response),
          response,
        }));
      } catch (error) {
        if (requestVersionsRef.current[targetThreadKey] !== requestVersion) {
          return;
        }

        updateSession(targetThreadKey, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
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

    const session = sessions[threadKey];
    if (!session?.response) {
      if (!session?.loading) {
        void loadLatest(thread);
      }
      return;
    }

    if (session.loading || session.activeRunId) {
      return;
    }

    if (thread.updatedAt == null || session.hydratedUpdatedAt === thread.updatedAt) {
      return;
    }

    if (session.expectOwnUpdate) {
      updateSession(threadKey, (current) => ({
        ...current,
        expectOwnUpdate: false,
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

        if (
          (event.notification.method === "turn/requestApproval" ||
            event.notification.method === "review/requestApproval") &&
          "requestId" in event.notification.params
        ) {
          return {
            ...current,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingRequest:
              event.notification as AppServerPendingRequestNotification,
            pendingStatusText: "Waiting for approval",
          };
        }

        if (
          event.notification.method === "item/agentMessage/delta" &&
          typeof event.notification.params.itemId === "string" &&
          typeof event.notification.params.delta === "string"
        ) {
          const { itemId, delta } = event.notification.params;
          return {
            ...current,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingAssistantMessage: {
              type: "message",
              id: itemId,
              role: "assistant",
              text:
                current.pendingAssistantMessage?.id === itemId
                  ? `${current.pendingAssistantMessage.text}${delta}`
                  : delta,
            },
          };
        }

        if (event.notification.method === "turn/started") {
          const startedTurnRecord =
            typeof event.notification.params.turn === "object" &&
            event.notification.params.turn !== null
              ? (event.notification.params.turn as { id?: unknown })
              : undefined;
          const runId =
            typeof startedTurnRecord?.id === "string"
              ? startedTurnRecord.id
              : event.notification.params.runId;

          return {
            ...current,
            activeRunId: runId,
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
            pendingStatusText: "Thinking",
          };
        }

        if (event.notification.method === "turn/completed") {
          const completedText =
            readCompletedTurnText(event.notification.params) ??
            current.pendingAssistantMessage?.text;

          return {
            ...current,
            activeRunId: undefined,
            error: undefined,
            expectOwnUpdate: true,
            interacted: true,
            lastTouchedAt: nextLastTouchedAt,
            pendingAssistantMessage: undefined,
            pendingRequest: undefined,
            pendingStatusText: undefined,
            response:
              completedText
                ? appendAssistantMessage(current.response, {
                    backend: event.backend,
                    threadId: notificationThreadId,
                  }, {
                    type: "message",
                    id:
                      current.pendingAssistantMessage?.id ??
                      `${event.notification.params.runId}:assistant`,
                    role: "assistant",
                    text: completedText,
                    createdAt: Date.now(),
                  })
                : current.response,
          };
        }

        if (
          event.notification.method === "turn/failed" ||
          event.notification.method === "turn/cancelled"
        ) {
          return {
            ...current,
            activeRunId: undefined,
            error: undefined,
            expectOwnUpdate: false,
            lastTouchedAt: nextLastTouchedAt,
            pendingAssistantMessage: undefined,
            pendingRequest: undefined,
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
            return {
              ...current,
              activeRunId: undefined,
              lastTouchedAt: nextLastTouchedAt,
              pendingAssistantMessage: undefined,
              pendingStatusText: undefined,
            };
          }
        }

        if (event.notification.method === "thread/compacted") {
          return {
            ...current,
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
    (text: string): string => {
      if (!thread || !threadKey) {
        return `optimistic-${Date.now()}`;
      }

      const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  const setActiveRunId = useCallback(
    (runId?: string): void => {
      if (!threadKey) {
        return;
      }

      updateSession(threadKey, (current) => ({
        ...current,
        activeRunId: runId,
        expectOwnUpdate: Boolean(runId) || current.expectOwnUpdate,
        interacted: Boolean(runId) || current.interacted,
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
        pendingStatusText: nextStatus,
      }));
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

  return {
    activeRunId: selectedSession?.activeRunId,
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
    pendingStatusText: selectedSession?.pendingStatusText,
    removeOptimisticMessage,
    response: selectedSession?.response,
    setActiveRunId,
    setPendingStatusText,
  };
}
