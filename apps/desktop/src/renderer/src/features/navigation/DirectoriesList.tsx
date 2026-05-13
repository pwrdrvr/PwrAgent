import { useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  comparePinnedThreads,
  isPinnedThread,
  moveThreadKey,
} from "@pwragent/shared";
import { FolderIcon, UnlinkedDotIcon, WorkspaceIcon } from "../../icons";
import {
  didDragLeaveCurrentTarget,
  getDropIndicatorPosition,
  type DropIndicatorState,
} from "./drag-drop";
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
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onReorderThreadPins?: (
    backend: AppServerBackendKind,
    threadIds: string[],
  ) => Promise<void>;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onUnbindMessagingBinding?: (
    thread: NavigationThreadSummary,
    binding: MessagingThreadBindingSummary,
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
  const [dropIndicator, setDropIndicator] = useState<
    DropIndicatorState | undefined
  >(undefined);
  const [dividerDropTarget, setDividerDropTarget] = useState<
    string | undefined
  >(undefined);
  const [draggedThreadKey, setDraggedThreadKey] = useState<string | undefined>(
    undefined,
  );
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
  const pinnedThreads = useMemo(
    () =>
      props.threads
        .filter(isPinnedThread)
        .sort(comparePinnedThreads),
    [props.threads],
  );
  const pinnedThreadKeys = useMemo(
    () =>
      pinnedThreads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    [pinnedThreads],
  );

  const pinnedThreadKeysForBackend = (backend: AppServerBackendKind): string[] =>
    pinnedThreads
      .filter((thread) => thread.source === backend)
      .map((thread) => buildThreadIdentityKey(thread.source, thread.id));

  const reorderPins = (
    backend: AppServerBackendKind,
    nextThreadKeys: string[],
  ): void => {
    const ids = nextThreadKeys
      .filter((threadKey) => threadsByKey.get(threadKey)?.source === backend)
      .map((threadKey) => threadsByKey.get(threadKey)?.id)
      .filter((threadId): threadId is string => Boolean(threadId));
    void props.onReorderThreadPins?.(backend, ids);
  };

  const buildDirectoryPinnedKeys = (
    directory: NavigationDirectorySummary,
    backend: AppServerBackendKind,
  ): string[] =>
    pinnedThreadKeys.filter(
      (threadKey) =>
        directory.threadKeys.includes(threadKey) &&
        threadsByKey.get(threadKey)?.source === backend,
    );

  const moveDirectoryPin = (
    directory: NavigationDirectorySummary,
    draggedKey: string,
    targetKey: string,
    position: "before" | "after",
  ): void => {
    if (!directory.threadKeys.includes(draggedKey)) return;

    const draggedThread = threadsByKey.get(draggedKey);
    const targetThread = threadsByKey.get(targetKey);
    if (!draggedThread || !targetThread || draggedThread.source !== targetThread.source) {
      return;
    }

    const backendPinnedThreadKeys = pinnedThreadKeysForBackend(draggedThread.source);
    const sourceKeys = backendPinnedThreadKeys.includes(draggedKey)
      ? backendPinnedThreadKeys
      : [...backendPinnedThreadKeys, draggedKey];
    reorderPins(
      draggedThread.source,
      moveThreadKey(sourceKeys, draggedKey, targetKey, position),
    );
  };

  const dropThreadAfterDirectoryPins = (
    directory: NavigationDirectorySummary,
    draggedKey: string,
  ): void => {
    if (!directory.threadKeys.includes(draggedKey)) return;

    const draggedThread = threadsByKey.get(draggedKey);
    if (!draggedThread) return;

    const backendPinnedThreadKeys = pinnedThreadKeysForBackend(draggedThread.source);
    const directoryPinnedThreadKeys = buildDirectoryPinnedKeys(
      directory,
      draggedThread.source,
    );
    const targetKey = directoryPinnedThreadKeys[directoryPinnedThreadKeys.length - 1];

    if (!targetKey) {
      if (backendPinnedThreadKeys.includes(draggedKey)) return;
      reorderPins(draggedThread.source, [...backendPinnedThreadKeys, draggedKey]);
      return;
    }

    moveDirectoryPin(
      directory,
      draggedKey,
      targetKey,
      "after",
    );
  };

  const movePinnedThreadByKeyboard = (
    directory: NavigationDirectorySummary,
    thread: NavigationThreadSummary,
    direction: "up" | "down",
  ): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const directoryPinnedThreadKeys = buildDirectoryPinnedKeys(
      directory,
      thread.source,
    );
    const currentIndex = directoryPinnedThreadKeys.indexOf(threadKey);
    if (currentIndex === -1) return;

    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    const targetKey = directoryPinnedThreadKeys[targetIndex];
    if (!targetKey) return;

    moveDirectoryPin(
      directory,
      threadKey,
      targetKey,
      direction === "up" ? "before" : "after",
    );
  };

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
        const directoryPinnedThreads = visibleThreads
          .filter(isPinnedThread)
          .sort(comparePinnedThreads);
        const directoryUnpinnedThreads = visibleThreads.filter(
          (thread) => !isPinnedThread(thread),
        );

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
                    {directoryPinnedThreads.map((thread) => {
                      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
                      const rowDropKey = `${directory.key}:${threadKey}`;
                      return (
                        <ThreadRow
                          key={`${directory.key}:${threadKey}`}
                          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                          compact
                          dropIndicator={
                            dropIndicator?.targetKey === rowDropKey
                              ? dropIndicator.position
                              : undefined
                          }
                          draggable={Boolean(props.onReorderThreadPins)}
                          includeLinkedDirectories
                          linkedDirectoryMode="kind"
                          selectedThreadKey={props.selectedItemKey}
                          thinkingThreadKeys={props.thinkingThreadKeys}
                          thread={thread}
                          onDragOverThread={(event) => {
                            event.preventDefault();
                            const draggedThread = draggedThreadKey
                              ? threadsByKey.get(draggedThreadKey)
                              : undefined;
                            if (
                              !draggedThreadKey ||
                              !draggedThread ||
                              !directory.threadKeys.includes(draggedThreadKey) ||
                              draggedThread.source !== thread.source
                            ) {
                              event.dataTransfer.dropEffect = "none";
                              setDropIndicator(undefined);
                              return;
                            }

                            event.dataTransfer.dropEffect = "move";
                            setDropIndicator({
                              targetKey: rowDropKey,
                              position: getDropIndicatorPosition(event),
                            });
                            setDividerDropTarget(undefined);
                          }}
                          onDragStartThread={(event) => {
                            setDraggedThreadKey(threadKey);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", threadKey);
                          }}
                          onDragLeaveThread={(event) => {
                            if (didDragLeaveCurrentTarget(event)) {
                              setDropIndicator(undefined);
                            }
                          }}
                          onDragEndThread={() => {
                            setDraggedThreadKey(undefined);
                            setDropIndicator(undefined);
                            setDividerDropTarget(undefined);
                          }}
                          onDropOnThread={(event) => {
                            event.preventDefault();
                            setDraggedThreadKey(undefined);
                            setDropIndicator(undefined);
                            setDividerDropTarget(undefined);
                            const draggedKey = event.dataTransfer.getData("text/plain");
                            if (!draggedKey) return;
                            const position = getDropIndicatorPosition(event);
                            moveDirectoryPin(
                              directory,
                              draggedKey,
                              threadKey,
                              position,
                            );
                          }}
                          onMovePinnedThread={(pinnedThread, direction) => {
                            movePinnedThreadByKeyboard(
                              directory,
                              pinnedThread,
                              direction,
                            );
                          }}
                          onOpenContextMenu={props.onOpenThreadContextMenu}
                          onPrefetchPullRequests={props.onPrefetchPullRequests}
                          onSelectThread={props.onSelectThread}
                          onSetReaction={props.onSetReaction}
                          onUnbindMessagingBinding={props.onUnbindMessagingBinding}
                        />
                      );
                    })}

                    {directoryPinnedThreads.length > 0 &&
                    directoryUnpinnedThreads.length > 0 ? (
                      <div
                        className={`recents-pinned-divider directory-row__thread-divider${
                          dividerDropTarget === directory.key
                            ? " is-drop-target"
                            : ""
                        }`}
                        role="separator"
                        aria-label={`Directory threads for ${directory.label}`}
                        onDragOver={(event) => {
                          event.preventDefault();
                          if (
                            !draggedThreadKey ||
                            !directory.threadKeys.includes(draggedThreadKey)
                          ) {
                            event.dataTransfer.dropEffect = "none";
                            setDividerDropTarget(undefined);
                            return;
                          }

                          event.dataTransfer.dropEffect = "move";
                          setDropIndicator(undefined);
                          setDividerDropTarget(directory.key);
                        }}
                        onDragLeave={(event) => {
                          if (didDragLeaveCurrentTarget(event)) {
                            setDividerDropTarget(undefined);
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDraggedThreadKey(undefined);
                          setDividerDropTarget(undefined);
                          dropThreadAfterDirectoryPins(
                            directory,
                            event.dataTransfer.getData("text/plain"),
                          );
                        }}
                      >
                        <span>Directory threads</span>
                      </div>
                    ) : null}

                    {directoryUnpinnedThreads.map((thread) => {
                      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
                      return (
                        <ThreadRow
                          key={`${directory.key}:${threadKey}`}
                          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                          compact
                          draggable={Boolean(props.onReorderThreadPins)}
                          includeLinkedDirectories
                          linkedDirectoryMode="kind"
                          selectedThreadKey={props.selectedItemKey}
                          thinkingThreadKeys={props.thinkingThreadKeys}
                          thread={thread}
                          onDragStartThread={(event) => {
                            setDraggedThreadKey(threadKey);
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", threadKey);
                          }}
                          onDragEndThread={() => {
                            setDraggedThreadKey(undefined);
                            setDropIndicator(undefined);
                            setDividerDropTarget(undefined);
                          }}
                          onOpenContextMenu={props.onOpenThreadContextMenu}
                          onPrefetchPullRequests={props.onPrefetchPullRequests}
                          onSelectThread={props.onSelectThread}
                          onSetReaction={props.onSetReaction}
                          onUnbindMessagingBinding={props.onUnbindMessagingBinding}
                        />
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
