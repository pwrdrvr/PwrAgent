import { useState, type MouseEvent } from "react";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import {
  moveThreadKey,
  resolveThreadParentKey,
  sortSubthreadSummaries,
} from "@pwragent/shared";
import {
  didDragLeaveCurrentTarget,
  getDropIndicatorPosition,
  useDropIndicatorController,
} from "./drag-drop";
import type { ThreadQueuedMessageState } from "../../lib/useThreadQueuedMessageIndicators";
import {
  threadSummaryIdentityKey,
  threadSupportsFederationCapability,
} from "../../lib/federated-thread-events";
import {
  getSubthreadDisclosureCount,
  isSubthreadSectionCollapsed,
  NativeSubAgentsDisclosure,
} from "./NativeSubAgentsDisclosure";
import { ThreadRow } from "./ThreadRow";

type RecentsListProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  /** Thread keys with a live integrated terminal in the main process. */
  terminalThreadKeys?: Record<string, boolean>;
  inputRequestThreadKeys?: Record<string, boolean>;
  queuedMessageThreadKeys?: Record<string, ThreadQueuedMessageState>;
  draftThreadKeys?: Record<string, boolean>;
  composerSourceThreadKey?: string;
  revealSelectedThreadRequest?: number;
  selectedThreadKey?: string;
  selectedThreadKeys?: ReadonlySet<string>;
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
  onPrefetchGitWorkingState?: (thread: NavigationThreadSummary) => void;
  onDetachPullRequest?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
  ) => void;
  onUpdateSubthreadOrder?: (
    parent: NavigationThreadSummary,
    threadIds: string[],
  ) => Promise<void>;
  onSetSubthreadsCollapsed?: (
    parent: NavigationThreadSummary,
    collapsed: boolean,
  ) => Promise<void>;
  onSelectThread: (
    thread: NavigationThreadSummary,
    event: MouseEvent<HTMLElement>,
    selectionOrder: string[],
  ) => void;
  onRevealSelectedThreadComplete?: (request: number) => void;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onSetThreadPin?: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  onUnbindMessagingBinding?: (
    thread: NavigationThreadSummary,
    binding: MessagingThreadBindingSummary,
  ) => Promise<void>;
};

/**
 * The Updated and Created lenses are pure sort orders: every top-level thread
 * renders in the order the caller supplies, pinned or not. A pinned thread
 * still appears — just in its natural position by updated/created time,
 * instead of floating into a section that crowds out what the sort is for.
 *
 * Pin *ordering* is therefore not editable here. It lives in the Directories
 * lens, which is the only place a pinned section still exists and which
 * carries both the drag and the keyboard (`onMovePinnedThread`) paths against
 * the same global pinned-key list.
 */
export function RecentsList(props: RecentsListProps) {
  const dropIndicator = useDropIndicatorController();
  const [draggedThreadKey, setDraggedThreadKey] = useState<string | undefined>(
    undefined,
  );
  const threadByKey = new Map(
    props.threads.map((thread) => [
      threadSummaryIdentityKey(thread),
      thread,
    ]),
  );
  const topLevelThreads = props.threads.filter((thread) => {
    if (!thread.parentThreadId) return true;
    const parentKey = resolveThreadParentKey(thread, threadByKey);
    return !parentKey || !threadByKey.has(parentKey);
  });
  const childrenByParentKey = new Map<string, NavigationThreadSummary[]>();
  for (const thread of props.threads) {
    if (!thread.parentThreadId) continue;
    const parentKey = resolveThreadParentKey(thread, threadByKey);
    if (!parentKey || !threadByKey.has(parentKey)) continue;
    const children = childrenByParentKey.get(parentKey) ?? [];
    children.push(thread);
    childrenByParentKey.set(parentKey, children);
  }
  // One tray per top-level row, holding its whole descendant subtree in
  // depth-first order. Sub-threads nest at their true depth in the data; only
  // the view is one level deep, and depth-first keeps a sub-thread immediately
  // after the thread that created it. Rendering direct children alone would
  // silently drop every grandchild from the lens.
  const subtreeByTopLevelKey = new Map<string, NavigationThreadSummary[]>();
  const directChildKeysByParentKey = new Map<string, string[]>();
  const placedThreadKeys = new Set<string>();
  const collectSubtree = (
    trayKey: string,
    parent: NavigationThreadSummary,
    parentKey: string,
  ): void => {
    const children = sortSubthreadSummaries(
      parent,
      childrenByParentKey.get(parentKey) ?? [],
    );
    if (parentKey === trayKey) {
      directChildKeysByParentKey.set(
        trayKey,
        children.map((child) => threadSummaryIdentityKey(child)),
      );
    }
    for (const child of children) {
      const childKey = threadSummaryIdentityKey(child);
      // A cycle in the stored parent links must not recurse forever, and a
      // thread already placed must not render twice.
      if (placedThreadKeys.has(childKey)) continue;
      placedThreadKeys.add(childKey);
      const tray = subtreeByTopLevelKey.get(trayKey) ?? [];
      tray.push(child);
      subtreeByTopLevelKey.set(trayKey, tray);
      collectSubtree(trayKey, child, childKey);
    }
  };
  for (const thread of topLevelThreads) {
    const threadKey = threadSummaryIdentityKey(thread);
    placedThreadKeys.add(threadKey);
    collectSubtree(threadKey, thread, threadKey);
  }
  const renderSubthreads = (parent: NavigationThreadSummary) => {
    const parentKey = threadSummaryIdentityKey(parent);
    // Already depth-first ordered above. Re-sorting by this row's
    // `subthreadOrder` would rank its grandchildren as unlisted and scatter
    // them away from the sub-threads that own them.
    const children = subtreeByTopLevelKey.get(parentKey) ?? [];
    const directChildKeys = directChildKeysByParentKey.get(parentKey) ?? [];
    const directChildKeySet = new Set(directChildKeys);
    const nativeSubAgentCount = parent.codexNativeSubAgents?.length ?? 0;
    const subthreadsCollapsed = isSubthreadSectionCollapsed(parent);
    const canManageSubthreads = threadSupportsFederationCapability(
      parent,
      "thread_grouping",
    );
    if (
      (children.length === 0 && nativeSubAgentCount === 0)
      || subthreadsCollapsed
    ) {
      return null;
    }

    return (
      <div className="subthread-list" role="list" aria-label={`Sub-threads of ${parent.title}`}>
        {/* The parent's own workers lead its tray. Trailing them after every
            child read as the last child's workers and buried them under a
            long child list. */}
        {nativeSubAgentCount > 0 ? (
          <NativeSubAgentsDisclosure thread={parent} />
        ) : null}
        {children.flatMap((child) => {
          const childKey = threadSummaryIdentityKey(child);
          const rowDropKey = `${parentKey}:${childKey}`;
          // A row plus its own worker group, as siblings of this list. A
          // wrapping element would break the tray's flat list semantics.
          return [
            <ThreadRow
              key={childKey}
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              terminalThreadKeys={props.terminalThreadKeys}
              inputRequestThreadKeys={props.inputRequestThreadKeys}
              queuedMessageThreadKeys={props.queuedMessageThreadKeys}
              draftThreadKeys={props.draftThreadKeys}
              composerSourceThreadKey={props.composerSourceThreadKey}
              draggable={
                canManageSubthreads
                && directChildKeys.length > 1
                && directChildKeySet.has(childKey)
                && Boolean(props.onUpdateSubthreadOrder)
              }
              includeLinkedDirectories
              nested
              revealSelectedThreadRequest={props.revealSelectedThreadRequest}
              selectedThreadKey={props.selectedThreadKey}
              selectedThreadKeys={props.selectedThreadKeys}
              thinkingThreadKeys={props.thinkingThreadKeys}
              thread={child}
              onDragOverThread={(event) => {
                event.preventDefault();
                const draggedKey = draggedThreadKey;
                const draggedThread = draggedKey ? threadByKey.get(draggedKey) : undefined;
                if (
                  !draggedThread
                  || draggedKey === childKey
                  || !directChildKeySet.has(childKey)
                  || resolveThreadParentKey(draggedThread, threadByKey) !== parentKey
                ) {
                  event.dataTransfer.dropEffect = "none";
                  dropIndicator.clear();
                  return;
                }
                event.dataTransfer.dropEffect = "move";
                dropIndicator.show(event.currentTarget, {
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
                  dropIndicator.clear();
                }
              }}
              onDragEndThread={() => {
                setDraggedThreadKey(undefined);
                dropIndicator.clear();
              }}
              onDropOnThread={(event) => {
                event.preventDefault();
                setDraggedThreadKey(undefined);
                dropIndicator.clear();
                const draggedKey =
                  event.dataTransfer.getData("application/x-pwragent-subthread") ||
                  event.dataTransfer.getData("text/plain");
                const draggedThread = threadByKey.get(draggedKey);
                if (
                  !draggedThread
                  || !directChildKeySet.has(childKey)
                  || resolveThreadParentKey(draggedThread, threadByKey) !== parentKey
                ) {
                  return;
                }
                // `subthreadOrder` names this row's own children, so a
                // reorder moves keys within that list — never the flattened
                // tray, which also carries rows owned by those children.
                const nextKeys = moveThreadKey(
                  directChildKeys,
                  draggedKey,
                  childKey,
                  getDropIndicatorPosition(event),
                );
                void props.onUpdateSubthreadOrder?.(
                  parent,
                  nextKeys
                    .map((threadKey) => threadByKey.get(threadKey)?.id)
                    .filter((threadId): threadId is string => Boolean(threadId)),
                );
              }}
              onOpenContextMenu={props.onOpenThreadContextMenu}
              onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
              onDetachPullRequest={props.onDetachPullRequest}
              onPrefetchPullRequests={props.onPrefetchPullRequests}
              onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
              onRevealSelectedThreadComplete={
                props.onRevealSelectedThreadComplete
              }
              onSelectThread={(thread, event) =>
                props.onSelectThread(thread, event, selectionOrder)
              }
              onSetReaction={props.onSetReaction}
              onSetThreadPin={props.onSetThreadPin}
              onUnbindMessagingBinding={props.onUnbindMessagingBinding}
            />,
            // A child's workers belong to the child, so they render under its
            // own row. They follow it out of this tray when it is unlinked,
            // because the child summary is what carries them.
            child.codexNativeSubAgents?.length ? (
              <NativeSubAgentsDisclosure
                key={`${childKey}:subagents`}
                nested
                thread={child}
              />
            ) : null,
          ];
        })}
      </div>
    );
  };

  // Shift selection follows the rows a person can actually see: parents and
  // any expanded children, in render order. Collapsed children are
  // deliberately absent, just like Finder ranges do not reach into a closed
  // disclosure.
  const selectionOrder = topLevelThreads.flatMap((thread) => {
    const threadKey = threadSummaryIdentityKey(thread);
    return [
      threadKey,
      ...(isSubthreadSectionCollapsed(thread)
        ? []
        : (subtreeByTopLevelKey.get(threadKey) ?? []).map((child) =>
            threadSummaryIdentityKey(child),
          )),
    ];
  });

  const renderThreadGroup = (thread: NavigationThreadSummary) => {
    const key = threadSummaryIdentityKey(thread);
    const children = subtreeByTopLevelKey.get(key) ?? [];
    const subthreadCount = getSubthreadDisclosureCount(thread, children.length);
    const subthreadsCollapsed = isSubthreadSectionCollapsed(thread);
    return (
      <div key={key} className="thread-group">
        <ThreadRow
          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
          terminalThreadKeys={props.terminalThreadKeys}
          inputRequestThreadKeys={props.inputRequestThreadKeys}
          queuedMessageThreadKeys={props.queuedMessageThreadKeys}
          draftThreadKeys={props.draftThreadKeys}
          composerSourceThreadKey={props.composerSourceThreadKey}
          includeLinkedDirectories
          revealSelectedThreadRequest={props.revealSelectedThreadRequest}
          selectedThreadKey={props.selectedThreadKey}
          selectedThreadKeys={props.selectedThreadKeys}
          subthreadCount={subthreadCount}
          subthreadsCollapsed={subthreadsCollapsed}
          thinkingThreadKeys={props.thinkingThreadKeys}
          thread={thread}
          onToggleSubthreads={
            subthreadCount > 0
              && threadSupportsFederationCapability(thread, "thread_grouping")
              && props.onSetSubthreadsCollapsed
              ? () =>
                  void props.onSetSubthreadsCollapsed!(
                    thread,
                    !subthreadsCollapsed,
                  )
              : undefined
          }
          onOpenContextMenu={props.onOpenThreadContextMenu}
          onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
          onDetachPullRequest={props.onDetachPullRequest}
          onPrefetchPullRequests={props.onPrefetchPullRequests}
          onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
          onRevealSelectedThreadComplete={props.onRevealSelectedThreadComplete}
          onSelectThread={(target, event) =>
            props.onSelectThread(target, event, selectionOrder)
          }
          onSetReaction={props.onSetReaction}
          onSetThreadPin={props.onSetThreadPin}
          onUnbindMessagingBinding={props.onUnbindMessagingBinding}
        />
        {renderSubthreads(thread)}
      </div>
    );
  };

  return (
    <div className="sidebar-list sidebar-list--dense" role="list">
      {topLevelThreads.map((thread) => renderThreadGroup(thread))}
    </div>
  );
}
