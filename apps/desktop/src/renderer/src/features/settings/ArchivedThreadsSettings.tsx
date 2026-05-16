import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

type ArchivedThreadsState = {
  error?: string;
  fetchedAt?: number;
  loading: boolean;
  threads: AppServerThreadSummary[];
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function ArchivedThreadsSettings(props: {
  desktopApi?: DesktopApi;
}) {
  const [state, setState] = useState<ArchivedThreadsState>({
    loading: true,
    threads: [],
  });
  const [restoringThreadKey, setRestoringThreadKey] = useState<string>();
  const [restoreMessage, setRestoreMessage] = useState<string>();
  const restoredThreadKeysRef = useRef(new Set<string>());

  const loadArchivedThreads = useCallback(async () => {
    const listThreads = props.desktopApi?.listThreads;
    if (!listThreads) {
      setState({
        error: "Desktop bridge is missing listThreads().",
        loading: false,
        threads: [],
      });
      return;
    }

    setState((current) => ({ ...current, error: undefined, loading: true }));
    try {
      const response = await listThreads({ archived: true });
      setState({
        fetchedAt: response.fetchedAt,
        loading: false,
        threads: sortArchivedThreads(
          response.threads.filter(
            (thread) =>
              !restoredThreadKeysRef.current.has(buildArchivedThreadKey(thread)),
          ),
        ),
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    }
  }, [props.desktopApi]);

  useEffect(() => {
    void loadArchivedThreads();
  }, [loadArchivedThreads]);

  const fetchedAtLabel = useMemo(() => {
    return state.fetchedAt ? `Updated ${formatTimestamp(state.fetchedAt)}` : "Archive";
  }, [state.fetchedAt]);

  const restoreThread = async (thread: AppServerThreadSummary) => {
    const restoreThreadRequest = props.desktopApi?.restoreThread;
    if (!restoreThreadRequest) {
      setState((current) => ({
        ...current,
        error: "Desktop bridge is missing restoreThread().",
      }));
      return;
    }

    const threadKey = buildArchivedThreadKey(thread);
    setRestoreMessage(undefined);
    setState((current) => ({ ...current, error: undefined }));
    setRestoringThreadKey(threadKey);
    try {
      await restoreThreadRequest({
        backend: thread.source,
        threadId: thread.id,
      });
      restoredThreadKeysRef.current.add(threadKey);
      setState((current) => ({
        ...current,
        threads: current.threads.filter(
          (candidate) => buildArchivedThreadKey(candidate) !== threadKey,
        ),
      }));
      setRestoreMessage(`Restored ${thread.title}.`);
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRestoringThreadKey(undefined);
    }
  };

  return (
    <SettingsSectionStack paneId="archived" aria-label="Archived thread settings">
      <SettingsPanelHead
        eyebrow="Archive"
        title="Archived threads"
        help="Archived threads stay out of Inbox, Recents, and Directories. Restore one here to make it visible again."
        action={
          <button
            className="button button--secondary"
            disabled={state.loading}
            type="button"
            onClick={() => {
              void loadArchivedThreads();
            }}
          >
            Refresh
          </button>
        }
      />

      <SettingsSection
        eyebrow="Threads"
        title="Archive"
        description="Review archived work and restore threads that should return to the main thread lists."
        chip={state.loading ? "loading" : fetchedAtLabel}
        chipKind="muted"
      >
        {state.loading && state.threads.length === 0 ? (
          <p className="settings-empty settings-archive-empty">
            Loading archived threads...
          </p>
        ) : state.threads.length ? (
          <div className="settings-archive-list">
            {state.threads.map((thread) => {
              const threadKey = buildArchivedThreadKey(thread);
              return (
                <ArchivedThreadRow
                  key={threadKey}
                  restoring={restoringThreadKey === threadKey}
                  thread={thread}
                  onRestore={() => {
                    void restoreThread(thread);
                  }}
                />
              );
            })}
          </div>
        ) : (
          <p className="settings-empty settings-archive-empty">
            No archived threads.
          </p>
        )}
        {restoreMessage ? (
          <p className="settings-archive-status" role="status">
            {restoreMessage}
          </p>
        ) : null}
        {state.error ? (
          <p className="settings-row__error settings-archive-status" role="alert">
            {state.error}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsSectionStack>
  );
}

function ArchivedThreadRow(props: {
  restoring: boolean;
  thread: AppServerThreadSummary;
  onRestore: () => void;
}) {
  const thread = props.thread;
  const directories = thread.linkedDirectories
    .map((directory) => directory.label || directory.path)
    .filter(Boolean);
  const activityLabel = thread.updatedAt
    ? `Updated ${formatTimestamp(thread.updatedAt)}`
    : thread.createdAt
      ? `Created ${formatTimestamp(thread.createdAt)}`
      : "No timestamp";

  return (
    <article className="settings-archive-row">
      <div className="settings-archive-row__body">
        <h3 className="settings-archive-row__title">{thread.title}</h3>
        {thread.summary ? (
          <p className="settings-archive-row__summary">{thread.summary}</p>
        ) : null}
        <p className="settings-archive-row__meta">
          <span>{activityLabel}</span>
          {directories.length ? <span>{directories.join(", ")}</span> : null}
        </p>
      </div>
      <div className="settings-archive-row__side">
        <div className="settings-pathrow__chips">
          <span className="settings-pathrow__chip">{thread.source}</span>
          {thread.gitBranch ? (
            <span className="settings-pathrow__chip">{thread.gitBranch}</span>
          ) : null}
        </div>
        <button
          className="button button--secondary settings-archive-row__button"
          disabled={props.restoring}
          type="button"
          onClick={props.onRestore}
        >
          {props.restoring ? "Restoring..." : "Restore"}
        </button>
      </div>
    </article>
  );
}

function sortArchivedThreads(
  threads: AppServerThreadSummary[],
): AppServerThreadSummary[] {
  return [...threads].sort((left, right) => {
    const rightTimestamp = right.updatedAt ?? right.createdAt ?? 0;
    const leftTimestamp = left.updatedAt ?? left.createdAt ?? 0;
    const timestampDelta = rightTimestamp - leftTimestamp;
    return timestampDelta !== 0
      ? timestampDelta
      : left.title.localeCompare(right.title);
  });
}

function buildArchivedThreadKey(thread: AppServerThreadSummary): string {
  return `${thread.source}:${thread.id}`;
}

function formatTimestamp(timestamp: number): string {
  return dateFormatter.format(timestamp);
}
