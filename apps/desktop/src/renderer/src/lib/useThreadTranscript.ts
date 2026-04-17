import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  NavigationThreadSummary
} from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

function mergeItems<T extends { id: string }>(
  olderItems: T[],
  newerItems: T[]
): T[] {
  const deduped = new Map<string, T>();

  for (const item of [...olderItems, ...newerItems]) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()];
}

export function useThreadTranscript(params: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
}): {
  addOptimisticUserMessage: (text: string) => string;
  error?: string;
  entries: AppServerThreadEntry[];
  loading: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;
  messages: AppServerThreadMessage[];
  removeOptimisticMessage: (id: string) => void;
  refresh: () => Promise<void>;
  response?: AppServerReadThreadResponse;
} {
  const { desktopApi, thread } = params;
  const [response, setResponse] = useState<AppServerReadThreadResponse>();
  const [optimisticEntries, setOptimisticEntries] = useState<AppServerThreadMessageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const requestVersionRef = useRef(0);

  useEffect(() => {
    setOptimisticEntries([]);
  }, [thread?.id]);

  const loadLatest = useCallback(async (): Promise<void> => {
    if (!thread) {
      setResponse(undefined);
      setError(undefined);
      setLoading(false);
      setLoadingMore(false);
      return;
    }

    if (!desktopApi?.readThread) {
      setResponse(undefined);
      setError("Desktop bridge is missing readThread().");
      setLoading(false);
      setLoadingMore(false);
      return;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setLoading(true);
    setError(undefined);
    setResponse((current) =>
      current?.threadId === thread.id ? current : undefined
    );

    try {
      const nextResponse = await desktopApi.readThread({
        backend: thread.source,
        threadId: thread.id
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setResponse(nextResponse);
    } catch (nextError) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setResponse(undefined);
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (requestVersionRef.current === requestVersion) {
        setLoading(false);
      }
    }
  }, [desktopApi, thread]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      !thread ||
      !desktopApi?.readThread ||
      !response?.replay.pagination.supportsPagination ||
      !response.replay.pagination.hasPreviousPage ||
      !response.replay.pagination.previousCursor
    ) {
      return;
    }

    setLoadingMore(true);
    setError(undefined);
    const requestVersion = requestVersionRef.current;

    try {
      const olderResponse = await desktopApi.readThread({
        backend: thread.source,
        threadId: thread.id,
        before: response.replay.pagination.previousCursor
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }

      setResponse((current) => {
        if (!current) {
          return olderResponse;
        }

        return {
          ...olderResponse,
          replay: {
            ...olderResponse.replay,
            entries: mergeItems(olderResponse.replay.entries, current.replay.entries),
            messages: mergeItems(olderResponse.replay.messages, current.replay.messages)
          }
        };
      });
    } catch (nextError) {
      if (requestVersionRef.current === requestVersion) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      if (requestVersionRef.current === requestVersion) {
        setLoadingMore(false);
      }
    }
  }, [desktopApi, response, thread]);

  const addOptimisticUserMessage = useCallback((text: string): string => {
    const id = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOptimisticEntries((current) => [
      ...current,
      {
        type: "message",
        id,
        role: "user",
        text,
        createdAt: Date.now()
      }
    ]);
    return id;
  }, []);

  const removeOptimisticMessage = useCallback((id: string): void => {
    setOptimisticEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const visibleOptimisticEntries = useMemo(
    () =>
      optimisticEntries.filter(
        (entry) =>
          !response?.replay.messages.some(
            (message) => message.role === entry.role && message.text === entry.text
          )
      ),
    [optimisticEntries, response?.replay.messages]
  );

  const entries = useMemo(
    () => mergeItems(response?.replay.entries ?? [], visibleOptimisticEntries),
    [response?.replay.entries, visibleOptimisticEntries]
  );

  const messages = useMemo(
    () =>
      mergeItems(
        response?.replay.messages ?? [],
        visibleOptimisticEntries.map(({ type: _type, ...message }) => message)
      ),
    [response?.replay.messages, visibleOptimisticEntries]
  );

  return {
    addOptimisticUserMessage,
    entries,
    error,
    loading,
    loadingMore,
    loadOlder,
    messages,
    removeOptimisticMessage,
    refresh: loadLatest,
    response
  };
}
