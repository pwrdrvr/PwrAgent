import { useState } from "react";
import type {
  AppServerBackendKind,
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
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
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onReorderThreadPins?: (
    backend: AppServerBackendKind,
    threadIds: string[],
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
  const pinnedThreads = props.threads
    .filter(isPinnedThread)
    .sort(comparePinnedThreads);
  const pinnedThreadKeys = pinnedThreads.map((thread) =>
    buildThreadIdentityKey(thread.source, thread.id),
  );
  const threadByKey = new Map(
    props.threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ]),
  );
  const unpinnedThreads = props.threads.filter((thread) => !isPinnedThread(thread));

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

  return (
    <div className="sidebar-list sidebar-list--dense" role="list">
      {pinnedThreads.map((thread) => {
        const key = buildThreadIdentityKey(thread.source, thread.id);
        return (
          <ThreadRow
            key={key}
            approvalRequestThreadKeys={props.approvalRequestThreadKeys}
            dropIndicator={
              dropIndicator?.targetKey === key
                ? dropIndicator.position
                : undefined
            }
            draggable
            includeLinkedDirectories
            selectedThreadKey={props.selectedThreadKey}
            thinkingThreadKeys={props.thinkingThreadKeys}
            thread={thread}
            onDragOverThread={(event) => {
              event.preventDefault();
              const draggedThread = draggedThreadKey
                ? threadByKey.get(draggedThreadKey)
                : undefined;
              if (!draggedThread || draggedThread.source !== thread.source) {
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
            }}
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
            onDropOnThread={(event) => {
              event.preventDefault();
              setDraggedThreadKey(undefined);
              setDropIndicator(undefined);
              setDividerDropTarget(false);
              const draggedKey = event.dataTransfer.getData("text/plain");
              if (!draggedKey) return;
              const draggedThread = threadByKey.get(draggedKey);
              if (!draggedThread || draggedThread.source !== thread.source) return;
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
            }}
            onMovePinnedThread={movePinnedThreadByKeyboard}
            onOpenContextMenu={props.onOpenThreadContextMenu}
            onPrefetchPullRequests={props.onPrefetchPullRequests}
            onSelectThread={props.onSelectThread}
            onSetReaction={props.onSetReaction}
            onUnbindMessagingBinding={props.onUnbindMessagingBinding}
          />
        );
      })}
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
            if (!draggedThread || pinnedThreadKeys.includes(draggedKey)) return;
            reorderPins(draggedThread.source, [
              ...pinnedThreadKeysForBackend(draggedThread.source),
              draggedKey,
            ]);
          }}
        >
          <span>Recent threads</span>
        </div>
      ) : null}
      {unpinnedThreads.map((thread) => {
        const key = buildThreadIdentityKey(thread.source, thread.id);
        return (
          <ThreadRow
            key={key}
            approvalRequestThreadKeys={props.approvalRequestThreadKeys}
            draggable={pinnedThreads.length > 0}
            includeLinkedDirectories
            selectedThreadKey={props.selectedThreadKey}
            thinkingThreadKeys={props.thinkingThreadKeys}
            thread={thread}
            onDragStartThread={(event) => {
              setDraggedThreadKey(key);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", key);
            }}
            onDragEndThread={() => {
              setDraggedThreadKey(undefined);
              setDropIndicator(undefined);
              setDividerDropTarget(false);
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
  );
}
