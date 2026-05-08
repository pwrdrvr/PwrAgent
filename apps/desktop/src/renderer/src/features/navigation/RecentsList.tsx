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
} from "@pwragent/shared";
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
      .map((threadKey) => threadKey.split(":").slice(1).join(":"));
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
            draggable
            includeLinkedDirectories
            selectedThreadKey={props.selectedThreadKey}
            thinkingThreadKeys={props.thinkingThreadKeys}
            thread={thread}
            onDragOverThread={(event) => {
              event.preventDefault();
            }}
            onDragStartThread={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", key);
            }}
            onDropOnThread={(event) => {
              event.preventDefault();
              const draggedKey = event.dataTransfer.getData("text/plain");
              if (!draggedKey) return;
              const draggedThread = threadByKey.get(draggedKey);
              if (!draggedThread || draggedThread.source !== thread.source) return;
              const backendPinnedThreadKeys = pinnedThreadKeysForBackend(thread.source);
              const rect = event.currentTarget.getBoundingClientRect();
              const position = event.clientY > rect.top + rect.height / 2
                ? "after"
                : "before";
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
          className="recents-pinned-divider"
          role="separator"
          aria-label="Unpinned threads"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
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
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", key);
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
