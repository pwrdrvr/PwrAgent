import { useState } from "react";
import type {
  AppServerBackendKind,
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  comparePinnedThreads,
  isPinnedThread,
  moveThreadKey,
  parseThreadIdentityKey,
} from "@pwragent/shared";
import {
  didDragLeaveCurrentTarget,
  getDropIndicatorPosition,
  type DropIndicatorState,
} from "./drag-drop";
import { ThreadRow } from "./ThreadRow";

type RecentsListProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onOpenThreadContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ) => void;
  onOpenPullRequestContextMenu?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
    position: { x: number; y: number; anchorTop?: number }
  ) => void;
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onReorderThreadPins?: (
    backend: AppServerBackendKind,
    threadIds: string[],
  ) => Promise<void>;
  onUpdateSubthreadOrder?: (
    parent: NavigationThreadSummary,
    threadIds: string[],
  ) => Promise<void>;
  onSetSubthreadsCollapsed?: (
    parent: NavigationThreadSummary,
    collapsed: boolean,
  ) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
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

export function RecentsList(props: RecentsListProps) {
  const [dropIndicator, setDropIndicator] = useState<
    DropIndicatorState | undefined
  >(undefined);
  const [dividerDropTarget, setDividerDropTarget] = useState(false);
  const [draggedThreadKey, setDraggedThreadKey] = useState<string | undefined>(
    undefined,
  );
  const threadByKey = new Map(
    props.threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ]),
  );
  const topLevelThreads = props.threads.filter((thread) => {
    if (!thread.parentThreadId) return true;
    return !threadByKey.has(buildThreadIdentityKey(thread.source, thread.parentThreadId));
  });
  const childrenByParentKey = new Map<string, NavigationThreadSummary[]>();
  for (const thread of props.threads) {
    if (!thread.parentThreadId) continue;
    const parentKey = buildThreadIdentityKey(thread.source, thread.parentThreadId);
    if (!threadByKey.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey) ?? [];
    children.push(thread);
    childrenByParentKey.set(parentKey, children);
  }
  const sortSubthreads = (
    parent: NavigationThreadSummary,
    children: NavigationThreadSummary[],
  ): NavigationThreadSummary[] => {
    const order = new Map(
      (parent.subthreadOrder ?? []).map((threadId, index) => [threadId, index]),
    );
    return [...children].sort((left, right) => {
      const leftRank = order.get(left.id);
      const rightRank = order.get(right.id);
      if (leftRank !== undefined || rightRank !== undefined) {
        return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
      }
      return (right.createdAt ?? 0) - (left.createdAt ?? 0);
    });
  };
  const pinnedThreads = topLevelThreads
    .filter(isPinnedThread)
    .sort(comparePinnedThreads);
  const pinnedThreadKeys = pinnedThreads.map((thread) =>
    buildThreadIdentityKey(thread.source, thread.id),
  );
  const unpinnedThreads = topLevelThreads.filter((thread) => !isPinnedThread(thread));

  const pinnedThreadKeysForBackend = (backend: AppServerBackendKind): string[] =>
    pinnedThreads
      .filter((thread) => thread.source === backend)
      .map((thread) => buildThreadIdentityKey(thread.source, thread.id));

  const reorderPins = (
    backend: AppServerBackendKind,
    nextThreadKeys: string[],
  ): void => {
    const ids = nextThreadKeys
      .filter((threadKey) => threadByKey.get(threadKey)?.source === backend)
      .map((threadKey) => parseThreadIdentityKey(threadKey)?.threadId)
      .filter((threadId): threadId is string => Boolean(threadId));
    void props.onReorderThreadPins?.(backend, ids);
  };

  const movePinnedThreadByKeyboard = (
    thread: NavigationThreadSummary,
    direction: "up" | "down",
  ): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const backendPinnedThreadKeys = pinnedThreadKeysForBackend(thread.source);
    const currentIndex = backendPinnedThreadKeys.indexOf(threadKey);
    if (currentIndex === -1) return;

    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    const targetKey = backendPinnedThreadKeys[targetIndex];
    if (!targetKey) return;

    reorderPins(
      thread.source,
      moveThreadKey(
        backendPinnedThreadKeys,
        threadKey,
        targetKey,
        direction === "up" ? "before" : "after",
      ),
    );
  };

  const renderSubthreads = (parent: NavigationThreadSummary) => {
    const parentKey = buildThreadIdentityKey(parent.source, parent.id);
    const children = sortSubthreads(parent, childrenByParentKey.get(parentKey) ?? []);
    if (children.length === 0 || parent.subthreadsCollapsed) {
      return null;
    }

    const childIds = children.map((child) => child.id);
    return (
      <div className="subthread-list" role="list" aria-label={`Sub-threads of ${parent.title}`}>
        {children.map((child) => {
          const childKey = buildThreadIdentityKey(child.source, child.id);
          const rowDropKey = `${parentKey}:${childKey}`;
          return (
            <ThreadRow
              key={childKey}
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              dropIndicator={
                dropIndicator?.targetKey === rowDropKey
                  ? dropIndicator.position
                  : undefined
              }
              draggable={children.length > 1 && Boolean(props.onUpdateSubthreadOrder)}
              includeLinkedDirectories
              nested
              selectedThreadKey={props.selectedThreadKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              thread={child}
              onDragOverThread={(event) => {
                event.preventDefault();
                const draggedKey = draggedThreadKey;
                const draggedThread = draggedKey ? threadByKey.get(draggedKey) : undefined;
                if (!draggedThread || draggedThread.parentThreadId !== parent.id) {
                  event.dataTransfer.dropEffect = "none";
                  setDropIndicator(undefined);
                  return;
                }
                event.dataTransfer.dropEffect = "move";
                setDropIndicator({
                  targetKey: rowDropKey,
                  position: getDropIndicatorPosition(event),
                });
              }}
              onDragStartThread={(event) => {
                setDraggedThreadKey(childKey);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", childKey);
                event.dataTransfer.setData("application/x-pwragent-subthread", childKey);
              }}
              onDragLeaveThread={(event) => {
                if (didDragLeaveCurrentTarget(event)) {
                  setDropIndicator(undefined);
                }
              }}
              onDragEndThread={() => {
                setDraggedThreadKey(undefined);
                setDropIndicator(undefined);
              }}
              onDropOnThread={(event) => {
                event.preventDefault();
                setDraggedThreadKey(undefined);
                setDropIndicator(undefined);
                const draggedKey =
                  event.dataTransfer.getData("application/x-pwragent-subthread") ||
                  event.dataTransfer.getData("text/plain");
                const draggedThread = threadByKey.get(draggedKey);
                if (!draggedThread || draggedThread.parentThreadId !== parent.id) {
                  return;
                }
                const draggedId = parseThreadIdentityKey(draggedKey)?.threadId;
                if (!draggedId) return;
                const nextKeys = moveThreadKey(
                  childIds.map((threadId) => buildThreadIdentityKey(parent.source, threadId)),
                  draggedKey,
                  childKey,
                  getDropIndicatorPosition(event),
                );
                void props.onUpdateSubthreadOrder?.(
                  parent,
                  nextKeys
                    .map((threadKey) => parseThreadIdentityKey(threadKey)?.threadId)
                    .filter((threadId): threadId is string => Boolean(threadId)),
                );
              }}
              onOpenContextMenu={props.onOpenThreadContextMenu}
              onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
              onPrefetchPullRequests={props.onPrefetchPullRequests}
              onSelectThread={props.onSelectThread}
              onSetReaction={props.onSetReaction}
              onUnbindMessagingBinding={props.onUnbindMessagingBinding}
            />
          );
        })}
      </div>
    );
  };

  const renderThreadGroup = (thread: NavigationThreadSummary) => {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    const children = sortSubthreads(thread, childrenByParentKey.get(key) ?? []);
    const pinned = isPinnedThread(thread);
    return (
      <div key={key} className="thread-group">
        <ThreadRow
          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
          dropIndicator={
            dropIndicator?.targetKey === key
              ? dropIndicator.position
              : undefined
          }
          draggable={pinned || pinnedThreads.length > 0}
          includeLinkedDirectories
          selectedThreadKey={props.selectedThreadKey}
          subthreadCount={children.length}
          subthreadsCollapsed={thread.subthreadsCollapsed === true}
          thinkingThreadKeys={props.thinkingThreadKeys}
          thread={thread}
          onToggleSubthreads={
            children.length > 0 && props.onSetSubthreadsCollapsed
              ? () =>
                  void props.onSetSubthreadsCollapsed!(
                    thread,
                    thread.subthreadsCollapsed !== true,
                  )
              : undefined
          }
          onDragOverThread={
            pinned
              ? (event) => {
                  event.preventDefault();
                  const draggedThread = draggedThreadKey
                    ? threadByKey.get(draggedThreadKey)
                    : undefined;
                  if (
                    !draggedThread ||
                    draggedThread.source !== thread.source ||
                    draggedThread.parentThreadId
                  ) {
                    event.dataTransfer.dropEffect = "none";
                    setDropIndicator(undefined);
                    return;
                  }

                  event.dataTransfer.dropEffect = "move";
                  setDropIndicator({
                    targetKey: key,
                    position: getDropIndicatorPosition(event),
                  });
                  setDividerDropTarget(false);
                }
              : undefined
          }
          onDragStartThread={(event) => {
            setDraggedThreadKey(key);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", key);
          }}
          onDragLeaveThread={(event) => {
            if (didDragLeaveCurrentTarget(event)) {
              setDropIndicator(undefined);
            }
          }}
          onDragEndThread={() => {
            setDraggedThreadKey(undefined);
            setDropIndicator(undefined);
            setDividerDropTarget(false);
          }}
          onDropOnThread={
            pinned
              ? (event) => {
                  event.preventDefault();
                  setDraggedThreadKey(undefined);
                  setDropIndicator(undefined);
                  setDividerDropTarget(false);
                  const draggedKey = event.dataTransfer.getData("text/plain");
                  if (!draggedKey) return;
                  const draggedThread = threadByKey.get(draggedKey);
                  if (
                    !draggedThread ||
                    draggedThread.source !== thread.source ||
                    draggedThread.parentThreadId
                  ) return;
                  const backendPinnedThreadKeys = pinnedThreadKeysForBackend(thread.source);
                  const position = getDropIndicatorPosition(event);
                  const nextKeys = backendPinnedThreadKeys.includes(draggedKey)
                    ? moveThreadKey(backendPinnedThreadKeys, draggedKey, key, position)
                    : moveThreadKey(
                        [...backendPinnedThreadKeys, draggedKey],
                        draggedKey,
                        key,
                        position,
                      );
                  reorderPins(thread.source, nextKeys);
                }
              : undefined
          }
          onMovePinnedThread={pinned ? movePinnedThreadByKeyboard : undefined}
          onOpenContextMenu={props.onOpenThreadContextMenu}
          onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
          onPrefetchPullRequests={props.onPrefetchPullRequests}
          onSelectThread={props.onSelectThread}
          onSetReaction={props.onSetReaction}
          onUnbindMessagingBinding={props.onUnbindMessagingBinding}
        />
        {renderSubthreads(thread)}
      </div>
    );
  };

  return (
    <div className="sidebar-list sidebar-list--dense" role="list">
      {pinnedThreads.map((thread) => renderThreadGroup(thread))}
      {pinnedThreads.length > 0 ? (
        <div
          className={`recents-pinned-divider${
            dividerDropTarget ? " is-drop-target" : ""
          }`}
          role="separator"
          aria-label="Unpinned threads"
          onDragOver={(event) => {
            event.preventDefault();
            const draggedThread = draggedThreadKey
              ? threadByKey.get(draggedThreadKey)
              : undefined;
            if (
              !draggedThread ||
              !draggedThreadKey ||
              draggedThread.parentThreadId ||
              pinnedThreadKeys.includes(draggedThreadKey)
            ) {
              event.dataTransfer.dropEffect = "none";
              setDividerDropTarget(false);
              return;
            }

            event.dataTransfer.dropEffect = "move";
            setDropIndicator(undefined);
            setDividerDropTarget(true);
          }}
          onDragLeave={(event) => {
            if (didDragLeaveCurrentTarget(event)) {
              setDividerDropTarget(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDraggedThreadKey(undefined);
            setDividerDropTarget(false);
            const draggedKey = event.dataTransfer.getData("text/plain");
            const draggedThread = threadByKey.get(draggedKey);
            if (!draggedThread || draggedThread.parentThreadId || pinnedThreadKeys.includes(draggedKey)) return;
            reorderPins(draggedThread.source, [
              ...pinnedThreadKeysForBackend(draggedThread.source),
              draggedKey,
            ]);
          }}
        >
          <span>Recent threads</span>
        </div>
      ) : null}
      {unpinnedThreads.map((thread) => renderThreadGroup(thread))}
    </div>
  );
}
