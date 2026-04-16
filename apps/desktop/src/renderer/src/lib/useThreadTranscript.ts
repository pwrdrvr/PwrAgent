import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerReadThreadResponse,
  AppServerThreadMessage
} from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

function mergeMessages(
  olderMessages: AppServerThreadMessage[],
  newerMessages: AppServerThreadMessage[]
): AppServerThreadMessage[] {
  const deduped = new Map<string, AppServerThreadMessage>();

  for (const message of [...olderMessages, ...newerMessages]) {
    deduped.set(message.id, message);
  }

  return [...deduped.values()];
}

export function useThreadTranscript(params: {
  desktopApi?: DesktopApi;
  threadId?: string;
}): {
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  loadOlder: () => Promise<void>;
  messages: AppServerThreadMessage[];
  refresh: () => Promise<void>;
  response?: AppServerReadThreadResponse;
} {
  const { desktopApi, threadId } = params;
  const [response, setResponse] = useState<AppServerReadThreadResponse>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const requestVersionRef = useRef(0);

  const loadLatest = useCallback(async (): Promise<void> => {
    if (!threadId) {
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
    setResponse(undefined);

    try {
      const nextResponse = await desktopApi.readThread({
        backend: "codex",
        threadId
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
  }, [desktopApi, threadId]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (
      !threadId ||
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
        backend: "codex",
        threadId,
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
            messages: mergeMessages(
              olderResponse.replay.messages,
              current.replay.messages
            )
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
  }, [desktopApi, response, threadId]);

  const messages = useMemo(
    () => response?.replay.messages ?? [],
    [response?.replay.messages]
  );

  return {
    error,
    loading,
    loadingMore,
    loadOlder,
    messages,
    refresh: loadLatest,
    response
  };
}
