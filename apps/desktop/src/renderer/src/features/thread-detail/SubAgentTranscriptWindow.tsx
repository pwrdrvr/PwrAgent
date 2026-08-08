import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
  AppServerThreadMessage,
} from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { useDesktopApi } from "../../lib/desktop-api";
import { THREAD_HISTORY_PAGE_LIMIT } from "../../lib/thread-history-limits";
import { TranscriptList } from "./TranscriptList";

const LIVE_TRANSCRIPT_REFRESH_MS = 2_000;

type SubAgentTranscriptTarget = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
};

type LoadState = {
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  response?: AppServerReadThreadResponse;
};

/**
 * An inspection-only transcript window for delegated agents.
 *
 * It intentionally owns no composer, normal thread navigation, or mutation
 * controls. Native Codex child ids are readable via `thread/read`, even when
 * they do not appear in PwrAgent's durable thread navigation snapshot.
 */
export function SubAgentTranscriptWindow() {
  const desktopApi = useDesktopApi();
  const target = useMemo(() => subAgentTranscriptTargetFromHash(), []);
  const targetKey = target ? `${target.backend}:${target.threadId}` : undefined;
  const [state, setState] = useState<LoadState>({
    loading: Boolean(target),
    loadingMore: false,
  });
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const loadedOlderRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const reader = desktopApi?.readThread;
    if (!target || !reader) {
      setState((current) => ({
        ...current,
        error: target
          ? "The desktop bridge is unavailable."
          : "This sub-agent transcript address is invalid.",
        loading: false,
      }));
      return;
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }

    refreshInFlightRef.current = true;
    do {
      refreshQueuedRef.current = false;
      try {
        const response = await reader({
          backend: target.backend,
          threadId: target.threadId,
          limit: THREAD_HISTORY_PAGE_LIMIT,
          viewOnly: true,
        });
        setState((current) => ({
          error: undefined,
          loading: false,
          loadingMore: current.loadingMore,
          response: mergeLatestTranscriptResponse({
            current: current.response,
            fresh: response,
            preserveOlderPages: loadedOlderRef.current,
          }),
        }));
      } catch (error) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Transcript could not be loaded.",
          loading: false,
        }));
      }
    } while (refreshQueuedRef.current);
    refreshInFlightRef.current = false;
  }, [desktopApi?.readThread, target]);

  useEffect(() => {
    loadedOlderRef.current = false;
    setState({ loading: Boolean(target), loadingMore: false });
    void refresh();
  }, [refresh, target]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const reader = desktopApi?.readThread;
    const cursor = state.response?.replay.pagination.previousCursor;
    if (!target || !reader || !cursor || state.loadingMore) {
      return;
    }

    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const olderResponse = await reader({
        backend: target.backend,
        threadId: target.threadId,
        before: cursor,
        limit: THREAD_HISTORY_PAGE_LIMIT,
        viewOnly: true,
      });
      loadedOlderRef.current = true;
      setState((current) => ({
        error: undefined,
        loading: false,
        loadingMore: false,
        response: mergeOlderTranscriptResponse({
          current: current.response,
          older: olderResponse,
        }),
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Older transcript could not be loaded.",
        loadingMore: false,
      }));
    }
  }, [desktopApi?.readThread, state.loadingMore, state.response?.replay.pagination.previousCursor, target]);

  const threadStatus = state.response?.threadStatus ?? state.response?.replay.threadStatus;
  const isLive = threadStatus === "active";

  useEffect(() => {
    if (!isLive) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      void refresh();
    }, LIVE_TRANSCRIPT_REFRESH_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [isLive, refresh]);

  useEffect(() => {
    if (target) {
      document.title = `Sub-agent transcript — ${target.title}`;
    }
  }, [target]);

  const entries = state.response?.replay.entries ?? [];

  return (
    <div className="subagent-transcript-window">
      <section aria-label="Sub-agent transcript" className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div className="activity-titlebar__breadcrumb" aria-label="Sub-agents > Transcript">
            <span className="activity-titlebar__eyebrow">Sub-agents</span>
            <span aria-hidden="true" className="activity-titlebar__separator">›</span>
            <span className="activity-titlebar__current">Transcript</span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>

        <main className="subagent-transcript-window__content">
          <header className="subagent-transcript-window__header">
            <div className="subagent-transcript-window__identity">
              <h1>{target?.title ?? "Sub-agent transcript"}</h1>
              {target ? (
                <p>
                  <span>{formatBackendLabel(target.backend)}</span>
                  <code>{target.threadId}</code>
                </p>
              ) : null}
            </div>
            <div className="subagent-transcript-window__actions">
              {isLive ? <span className="subagent-transcript-window__live">Live</span> : null}
              <button
                type="button"
                className="subagent-transcript-window__close"
                aria-label="Close window"
                title="Close"
                onClick={() => window.close()}
              >
                <CloseIcon size={18} aria-hidden="true" />
              </button>
            </div>
          </header>

          <TranscriptList
            desktopApi={desktopApi}
            entries={entries}
            error={state.error}
            loading={state.loading}
            loadingMore={state.loadingMore}
            pagination={state.response?.replay.pagination}
            parentThreadId={target?.threadId}
            threadId={targetKey}
            onLoadOlder={loadOlder}
          />
        </main>
      </section>
    </div>
  );
}

function mergeById<T extends { id: string }>(
  first: T[],
  second: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of [...first, ...second]) {
    merged.set(item.id, item);
  }
  return [...merged.values()];
}

function mergeLatestTranscriptResponse(params: {
  current?: AppServerReadThreadResponse;
  fresh: AppServerReadThreadResponse;
  preserveOlderPages: boolean;
}): AppServerReadThreadResponse {
  if (!params.current || !params.preserveOlderPages) {
    return params.fresh;
  }

  return {
    ...params.fresh,
    replay: {
      ...params.fresh.replay,
      entries: mergeById<AppServerThreadEntry>(
        params.current.replay.entries,
        params.fresh.replay.entries,
      ),
      messages: mergeById<AppServerThreadMessage>(
        params.current.replay.messages,
        params.fresh.replay.messages,
      ),
      pagination: params.current.replay.pagination,
    },
  };
}

function mergeOlderTranscriptResponse(params: {
  current?: AppServerReadThreadResponse;
  older: AppServerReadThreadResponse;
}): AppServerReadThreadResponse {
  if (!params.current) {
    return params.older;
  }

  return {
    ...params.current,
    fetchedAt: params.older.fetchedAt,
    ...(params.older.threadStatus ? { threadStatus: params.older.threadStatus } : {}),
    replay: {
      ...params.current.replay,
      entries: mergeById<AppServerThreadEntry>(
        params.older.replay.entries,
        params.current.replay.entries,
      ),
      messages: mergeById<AppServerThreadMessage>(
        params.older.replay.messages,
        params.current.replay.messages,
      ),
      pagination: params.older.replay.pagination,
    },
  };
}

function subAgentTranscriptTargetFromHash(): SubAgentTranscriptTarget | undefined {
  const hash = window.location.hash.replace(/^#/, "");
  const [kind, backendPart, threadIdPart, titlePart] = hash.split("/");
  if (
    kind !== "sub-agent" ||
    !backendPart ||
    !threadIdPart ||
    !titlePart
  ) {
    return undefined;
  }

  try {
    const backend = decodeURIComponent(backendPart);
    const threadId = decodeURIComponent(threadIdPart).trim();
    const title = decodeURIComponent(titlePart).trim();
    if (!isAppServerBackendKind(backend) || !threadId || !title) {
      return undefined;
    }
    return { backend, threadId, title };
  } catch {
    return undefined;
  }
}

function isAppServerBackendKind(value: string): value is AppServerBackendKind {
  return value === "codex" || value.startsWith("acp:");
}
