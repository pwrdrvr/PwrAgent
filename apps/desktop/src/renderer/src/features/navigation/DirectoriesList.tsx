import { useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { ThreadMetaChips } from "./ThreadMetaChips";

type DirectoriesListProps = {
  directories: NavigationDirectorySummary[];
  selectedItemKey?: string;
  threads: NavigationThreadSummary[];
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

function buildLaunchpadSelectionKey(directoryKey: string): string {
  return `launchpad:${directoryKey}`;
}

export function DirectoriesList(props: DirectoriesListProps) {
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>({});
  const threadsByKey = useMemo(
    () =>
      new Map(
        props.threads.map((thread) => [
          buildThreadIdentityKey(thread.source, thread.id),
          thread,
        ]),
      ),
    [props.threads]
  );

  useEffect(() => {
    const selectedItemKey = props.selectedItemKey;
    if (!selectedItemKey) {
      return;
    }

    setExpandedByKey((current) => {
      for (const directory of props.directories) {
        if (
          selectedItemKey === buildLaunchpadSelectionKey(directory.key) ||
          directory.threadKeys.includes(selectedItemKey)
        ) {
          if (current[directory.key]) {
            return current;
          }

          return {
            ...current,
            [directory.key]: true,
          };
        }
      }

      return current;
    });
  }, [props.directories, props.selectedItemKey]);

  if (props.directories.length === 0) {
    return <p className="sidebar-empty">No directory-linked threads.</p>;
  }

  return (
    <div className="directory-list sidebar-list sidebar-list--dense">
      {props.directories.map((directory) => {
        const selectedLaunchpad =
          props.selectedItemKey === buildLaunchpadSelectionKey(directory.key);
        const selectedThreadInDirectory = directory.threadKeys.includes(
          props.selectedItemKey ?? ""
        );
        const expanded =
          expandedByKey[directory.key] ??
          (selectedLaunchpad || selectedThreadInDirectory);
        const visibleThreads = directory.threadKeys
          .map((threadKey) => threadsByKey.get(threadKey))
          .filter((thread): thread is NavigationThreadSummary => Boolean(thread));

        return (
          <section key={directory.key} className="directory-row">
            <div className="directory-row__header">
              <button
                aria-expanded={expanded}
                className={`thread-row thread-row--compact directory-row__summary${
                  selectedLaunchpad ? " is-selected" : ""
                }`}
                type="button"
                onClick={() => {
                  setExpandedByKey((current) => ({
                    ...current,
                    [directory.key]: !expanded,
                  }));
                }}
              >
                <span className="directory-row__summary-main">
                  <span aria-hidden="true" className="directory-row__icon">
                    {directory.kind === "workspace" ? "🗂" : directory.kind === "unlinked" ? "•" : "📁"}
                  </span>
                  <span className="directory-row__title-wrap">
                    <span className="thread-row__title">{directory.label}</span>
                  </span>
                </span>

                <span className="directory-row__summary-meta">
                  {directory.needsAttentionCount > 0 ? (
                    <span className="count-pill directory-row__attention">
                      {directory.needsAttentionCount}
                    </span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={`directory-row__chevron${expanded ? " is-open" : ""}`}
                  />
                </span>
              </button>

              <button
                aria-label={`Open new thread launchpad for ${directory.label}`}
                className={`directory-row__launchpad-button${
                  directory.launchpad ? " has-draft" : ""
                }`}
                type="button"
                onClick={() => {
                  void props.onOpenLaunchpad(directory, directory.launchpad?.backend);
                }}
              >
                +
              </button>
            </div>

            {expanded ? (
              <div className="directory-row__details">
                {visibleThreads.length > 0 ? (
                  <div className="sidebar-list sidebar-list--compact directory-row__threads">
                    {visibleThreads.map((thread) => {
                      const selected =
                        buildThreadIdentityKey(thread.source, thread.id) === props.selectedItemKey;
                      return (
                        <button
                          key={`${directory.key}:${buildThreadIdentityKey(thread.source, thread.id)}`}
                          aria-pressed={selected}
                          className={`thread-row${selected ? " is-selected" : ""}`}
                          type="button"
                          onClick={() => props.onSelectThread(thread)}
                        >
                          <span className="thread-row__header">
                            <span className="thread-row__title">{thread.title}</span>
                            <span className="thread-row__time">
                              {formatRelativeTime(thread.updatedAt)}
                            </span>
                          </span>
                          <ThreadMetaChips thread={thread} />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="sidebar-empty directory-row__empty">No threads in this directory yet.</p>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return "now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(timestamp);
}
