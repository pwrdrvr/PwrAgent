import { useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { FolderIcon, UnlinkedDotIcon, WorkspaceIcon } from "../../icons";
import { ThreadRow } from "./ThreadRow";

type DirectoriesListProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  directories: NavigationDirectorySummary[];
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onOpenThreadContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ) => void;
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
};

function buildLaunchpadSelectionKey(directoryKey: string): string {
  return `launchpad:${directoryKey}`;
}

function hasPendingLaunchpadState(directory: NavigationDirectorySummary): boolean {
  const launchpad = directory.launchpad;
  if (!launchpad) {
    return false;
  }

  return (
    launchpad.prompt.trim().length > 0 ||
    (launchpad.imageAttachments?.length ?? 0) > 0 ||
    launchpad.settingsTouchedAt !== undefined
  );
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
                    {directory.kind === "workspace" ? (
                      <WorkspaceIcon size={14} />
                    ) : directory.kind === "unlinked" ? (
                      <UnlinkedDotIcon size={14} />
                    ) : (
                      <FolderIcon size={14} />
                    )}
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
                  hasPendingLaunchpadState(directory) ? " has-draft" : ""
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
                    {visibleThreads.map((thread) => (
                      <ThreadRow
                        key={`${directory.key}:${buildThreadIdentityKey(thread.source, thread.id)}`}
                        approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                        compact
                        includeLinkedDirectories
                        linkedDirectoryMode="kind"
                        selectedThreadKey={props.selectedItemKey}
                        thinkingThreadKeys={props.thinkingThreadKeys}
                        thread={thread}
                        onOpenContextMenu={props.onOpenThreadContextMenu}
                        onSelectThread={props.onSelectThread}
                        onSetReaction={props.onSetReaction}
                      />
                    ))}
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
