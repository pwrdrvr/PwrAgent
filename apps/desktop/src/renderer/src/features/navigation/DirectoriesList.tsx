import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type {
  AppServerBackendKind,
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  comparePinnedDirectories,
  comparePinnedThreads,
  isPinnedDirectory,
  isPinnedThread,
  moveDirectoryKey,
  moveThreadKey,
} from "@pwragent/shared";
import {
  FolderIcon,
  NewThreadIcon,
  UnlinkedDotIcon,
  WorkspaceIcon,
} from "../../icons";
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
  /**
   * Directory pinning (plan 2026-05-09-002, Unit K). When both
   * handlers are provided, directory rows are draggable + the
   * pinned section + divider render. Mirror of the thread-pin props
   * minus the per-backend dimension.
   */
  onSetDirectoryPin?: (
    directory: NavigationDirectorySummary,
    pinned: boolean,
  ) => Promise<void>;
  onReorderDirectoryPins?: (directoryKeys: string[]) => Promise<void>;
  /**
   * Opens the directory context menu at the cursor position. Sidebar
   * owns the menu (so it can escape the sidebar's scroll container,
   * mirroring the thread context menu). DirectoriesList only knows
   * "user right-clicked this directory at (x, y); please show the
   * menu." Workspace/unlinked rows must not invoke this — see the
   * row-level guard in `renderDirectoryRow`.
   */
  onOpenDirectoryContextMenu?: (
    directory: NavigationDirectorySummary,
    position: { x: number; y: number; anchorTop?: number },
  ) => void;
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

/**
 * Window in which a post-drag synthetic `click` is suppressed.
 * Chrome/Electron fire the synthetic click immediately after
 * `dragend`, well under 50ms apart. 150ms gives margin for slow
 * frames without swallowing the user's next intentional click.
 */
const POST_DRAG_CLICK_SUPPRESS_MS = 150;

/**
 * The user can pin both `kind: "directory"` and `kind: "workspace"`
 * entries — both are named entries they click in the sidebar. Only
 * `kind: "unlinked"` (the synthetic catch-all for threads with no
 * linked directory) is excluded. Keep this policy in one place so
 * the IPC guard, snapshot builder, and renderer guards can't drift
 * apart. See plan 2026-05-09-002 Unit K.
 */
function isPinnableDirectoryKind(
  directory: Pick<NavigationDirectorySummary, "kind">,
): boolean {
  return directory.kind === "directory" || directory.kind === "workspace";
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
  // Directory drag/drop state (plan 2026-05-09-002 Unit K). Mirrors
  // the per-thread state above but tracks directory keys rather
  // than thread keys. The `directoriesPinnedDividerDropTarget`
  // boolean toggles the divider's "promote to pinned" affordance
  // when an unpinned directory is dragged over it.
  const [draggedDirectoryKey, setDraggedDirectoryKey] = useState<
    string | undefined
  >(undefined);
  const [directoryDropIndicator, setDirectoryDropIndicator] = useState<
    DropIndicatorState | undefined
  >(undefined);
  const [directoriesPinnedDividerDropTarget, setDirectoriesPinnedDividerDropTarget] =
    useState(false);
  /**
   * Suppress the directory summary button's expand/collapse click
   * when the click is the trailing edge of a drag gesture. Browsers
   * fire a synthetic `click` on the element under the mouse on
   * drag-release; that click used to expand/collapse whatever row
   * the user dropped onto — a confusing side-effect of a reorder.
   *
   * We record `Date.now()` at every drag-end and drop, and the
   * summary button's onClick bails if the click arrives within
   * `POST_DRAG_CLICK_SUPPRESS_MS` of the last drag end. Using a
   * timestamp (instead of a `boolean` ref cleared on a timer)
   * means we can never get stuck in "clicks suppressed forever"
   * mode if a `dragend` handler doesn't fire — the comparison
   * naturally expires. Plan 2026-05-09-002 Unit K follow-up.
   */
  const lastDirectoryDragEndedAtRef = useRef(0);
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

  // Directory pinning (plan 2026-05-09-002 Unit K). Same shape as
  // pinnedThreads above. The `pinnedDirectoryKeys` array is the
  // input to `moveDirectoryKey` for drag-reorder calculations.
  const directoryDragEnabled = Boolean(
    props.onSetDirectoryPin && props.onReorderDirectoryPins,
  );
  const pinnedDirectories = useMemo(
    () =>
      props.directories
        .filter(isPinnedDirectory)
        .sort(comparePinnedDirectories),
    [props.directories],
  );
  const pinnedDirectoryKeys = useMemo(
    () => pinnedDirectories.map((directory) => directory.key),
    [pinnedDirectories],
  );
  const unpinnedDirectories = useMemo(
    () => props.directories.filter((directory) => !isPinnedDirectory(directory)),
    [props.directories],
  );
  const directoryByKey = useMemo(
    () => new Map(props.directories.map((directory) => [directory.key, directory])),
    [props.directories],
  );

  const reorderDirectoryPins = (nextKeys: string[]): void => {
    void props.onReorderDirectoryPins?.(nextKeys);
  };

  const movePinnedDirectoryByKeyboard = (
    directory: NavigationDirectorySummary,
    direction: "up" | "down",
  ): void => {
    const currentIndex = pinnedDirectoryKeys.indexOf(directory.key);
    if (currentIndex === -1) return;

    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    const targetKey = pinnedDirectoryKeys[targetIndex];
    if (!targetKey) return;

    reorderDirectoryPins(
      moveDirectoryKey(
        pinnedDirectoryKeys,
        directory.key,
        targetKey,
        direction === "up" ? "before" : "after",
      ),
    );
  };

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
          // Respect explicit user state in either direction. If the
          // user has touched this directory's expand state at all
          // (true OR false), leave it alone — they're driving. We
          // only auto-expand on the first reveal when the key is
          // `undefined`. Previously this checked `if (current[key])`
          // which treated `false` as "not yet expanded" and re-
          // overrode the user's collapse every time `directories`
          // changed reference (which happens on EVERY snapshot
          // mutation, e.g. unpinning an unrelated sibling).
          if (current[directory.key] !== undefined) {
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

  /**
   * Render a single directory row. Extracted so the pinned and
   * unpinned sections can render the same row markup. The drag
   * handlers attach to `.directory-row__header` only when this is a
   * pinnable entry (see `isPinnableDirectoryKind`) AND directory
   * pinning is enabled (both props provided). Mirrors RecentsList's
   * pinned-vs-unpinned `draggable` toggling. See plan
   * 2026-05-09-002 Unit K.
   */
  const renderDirectoryRow = (
    directory: NavigationDirectorySummary,
  ): ReactElement => {
    const directoryPinned = isPinnedDirectory(directory);
    const directoryDraggable =
      directoryDragEnabled &&
      isPinnableDirectoryKind(directory) &&
      // Unpinned directories only become draggable when at least one
      // directory is already pinned (matches the thread-pin pattern:
      // first pin lives via context menu, drag is reordering).
      (directoryPinned || pinnedDirectories.length > 0);
    const isDirectoryDropTarget =
      directoryDropIndicator?.targetKey === directory.key;

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

    const dropIndicatorClass = isDirectoryDropTarget
      ? ` is-drop-target-${directoryDropIndicator!.position}`
      : "";

    return (
      <section
        key={directory.key}
        className={`directory-row${dropIndicatorClass}`}
        onDragOver={
          directoryDragEnabled
            ? (event) => {
                // Gate on `draggedDirectoryKey` (state) first; the
                // `application/x-pwragent-directory` MIME is set on
                // dragStart but `getData()` returns "" during
                // dragOver for security, so the state is the
                // reliable signal for same-document drags. Thread
                // drags don't set this state, so they fall through
                // and the inner thread-row handlers take over.
                const draggedKey =
                  draggedDirectoryKey ??
                  event.dataTransfer.getData(
                    "application/x-pwragent-directory",
                  );
                if (!draggedKey || draggedKey === directory.key) {
                  return;
                }
                const draggedDirectory = directoryByKey.get(draggedKey);
                if (
                  !draggedDirectory ||
                  !isPinnableDirectoryKind(draggedDirectory)
                ) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDirectoryDropIndicator({
                  targetKey: directory.key,
                  position: getDropIndicatorPosition(event),
                });
                setDirectoriesPinnedDividerDropTarget(false);
              }
            : undefined
        }
        onDragLeave={
          directoryDragEnabled
            ? (event) => {
                if (didDragLeaveCurrentTarget(event)) {
                  setDirectoryDropIndicator(undefined);
                }
              }
            : undefined
        }
        onDrop={
          directoryDragEnabled
            ? (event) => {
                const draggedKey =
                  draggedDirectoryKey ??
                  event.dataTransfer.getData(
                    "application/x-pwragent-directory",
                  );
                // Bail without consuming the event for non-directory
                // drags so inner thread-row drop handlers still fire.
                if (!draggedKey) {
                  return;
                }
                event.preventDefault();
                setDraggedDirectoryKey(undefined);
                setDirectoryDropIndicator(undefined);
                setDirectoriesPinnedDividerDropTarget(false);
                lastDirectoryDragEndedAtRef.current = Date.now();
                if (draggedKey === directory.key) {
                  return;
                }
                const draggedDirectory = directoryByKey.get(draggedKey);
                if (
                  !draggedDirectory ||
                  !isPinnableDirectoryKind(draggedDirectory)
                ) {
                  return;
                }

                const position = getDropIndicatorPosition(event);
                // Drop on a pinned target → reorder within pinned
                // section. Drop on an unpinned target → drag is
                // moving among unpinned (no-op for pin state) OR
                // dragging an unpinned over an unpinned (also a
                // no-op since they have no pin order). The
                // promote-to-pinned path uses the divider as
                // drop target.
                if (!directoryPinned) {
                  return;
                }

                const nextKeys = pinnedDirectoryKeys.includes(draggedKey)
                  ? moveDirectoryKey(
                      pinnedDirectoryKeys,
                      draggedKey,
                      directory.key,
                      position,
                    )
                  : moveDirectoryKey(
                      [...pinnedDirectoryKeys, draggedKey],
                      draggedKey,
                      directory.key,
                      position,
                    );
                reorderDirectoryPins(nextKeys);
              }
            : undefined
        }
      >
        <div
          className="directory-row__header"
          draggable={directoryDraggable}
          onDragStart={
            directoryDraggable
              ? (event) => {
                  setDraggedDirectoryKey(directory.key);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "application/x-pwragent-directory",
                    directory.key,
                  );
                  // Set text/plain too so generic drop targets fall
                  // through cleanly (no accidental "drop directory
                  // into the thread list" behavior — receivers check
                  // the directory MIME).
                  event.dataTransfer.setData("text/plain", directory.key);
                }
              : undefined
          }
          onDragEnd={
            directoryDragEnabled
              ? () => {
                  setDraggedDirectoryKey(undefined);
                  setDirectoryDropIndicator(undefined);
                  setDirectoriesPinnedDividerDropTarget(false);
                  // Record drag-end so the summary button's click
                  // handler can suppress the synthetic post-release
                  // click that browsers fire on drag-release. The
                  // timestamp naturally expires after
                  // POST_DRAG_CLICK_SUPPRESS_MS so this can never
                  // get stuck if `dragend` doesn't fire reliably.
                  lastDirectoryDragEndedAtRef.current = Date.now();
                }
              : undefined
          }
          onKeyDown={
            directoryDragEnabled && directoryPinned
              ? (event) => {
                  if (!event.metaKey || !event.shiftKey) return;
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    movePinnedDirectoryByKeyboard(directory, "up");
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    movePinnedDirectoryByKeyboard(directory, "down");
                  }
                }
              : undefined
          }
        >
          <button
            aria-expanded={expanded}
            className={`thread-row thread-row--compact directory-row__summary${
              selectedLaunchpad ? " is-selected" : ""
            }`}
            type="button"
            onClick={() => {
              // Suppress the synthetic post-drop click that the
              // browser fires on the element under the mouse when
              // a drag releases. The timestamp comparison expires
              // on its own, so we can never get stuck in a
              // permanently-suppressed state.
              if (
                Date.now() - lastDirectoryDragEndedAtRef.current <
                POST_DRAG_CLICK_SUPPRESS_MS
              ) {
                return;
              }
              setExpandedByKey((current) => ({
                ...current,
                [directory.key]: !expanded,
              }));
            }}
            onContextMenu={(() => {
              const openMenu = props.onOpenDirectoryContextMenu;
              if (!openMenu || !isPinnableDirectoryKind(directory)) {
                return undefined;
              }
              return (event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                // Anchor at the cursor so the menu lands where the
                // user clicked, but pass `anchorTop` so the
                // viewport-flip path in `placeThreadContextMenu`
                // re-anchors above the row (not above the cursor)
                // when the menu would overflow the bottom edge.
                openMenu(directory, {
                  x: event.clientX,
                  y: event.clientY,
                  anchorTop: rect.top,
                });
              };
            })()}
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
            <NewThreadIcon size={16} />
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
      };

  return (
    <div className="directory-list sidebar-list sidebar-list--dense">
      {pinnedDirectories.map(renderDirectoryRow)}
      {directoryDragEnabled && pinnedDirectories.length > 0 ? (
        <div
          className={`directories-pinned-divider${
            directoriesPinnedDividerDropTarget ? " is-drop-target" : ""
          }`}
          role="separator"
          aria-label="Unpinned directories"
          onDragOver={(event) => {
            const draggedKey =
              draggedDirectoryKey ??
              event.dataTransfer.getData("application/x-pwragent-directory");
            if (!draggedKey) return;
            const draggedDirectory = directoryByKey.get(draggedKey);
            // Only allow promote-to-pinned drops here. Pinned →
            // divider should be a no-op (unpin happens via the
            // unpinned-section's drop target, or context menu).
            if (
              !draggedDirectory ||
              !isPinnableDirectoryKind(draggedDirectory) ||
              pinnedDirectoryKeys.includes(draggedKey)
            ) {
              event.dataTransfer.dropEffect = "none";
              setDirectoriesPinnedDividerDropTarget(false);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDirectoryDropIndicator(undefined);
            setDirectoriesPinnedDividerDropTarget(true);
          }}
          onDragLeave={(event) => {
            if (didDragLeaveCurrentTarget(event)) {
              setDirectoriesPinnedDividerDropTarget(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const draggedKey =
              draggedDirectoryKey ??
              event.dataTransfer.getData("application/x-pwragent-directory");
            setDraggedDirectoryKey(undefined);
            setDirectoriesPinnedDividerDropTarget(false);
            lastDirectoryDragEndedAtRef.current = Date.now();
            if (!draggedKey) return;
            const draggedDirectory = directoryByKey.get(draggedKey);
            if (
              !draggedDirectory ||
              !isPinnableDirectoryKind(draggedDirectory) ||
              pinnedDirectoryKeys.includes(draggedKey)
            ) {
              return;
            }
            // Append to the end of the pinned list — same as the
            // RecentsList divider behavior.
            reorderDirectoryPins([...pinnedDirectoryKeys, draggedKey]);
          }}
        >
          <span>Directories</span>
        </div>
      ) : null}
      {unpinnedDirectories.map(renderDirectoryRow)}
    </div>
  );
}
