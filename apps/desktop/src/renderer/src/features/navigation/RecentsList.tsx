import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";
import type { useBoundedNavigationWindow } from "../../lib/useBoundedNavigationWindow";
import { navigationIdentityKey, navigationThreadSelectionKey } from "../../lib/navigation-query-state";
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
  pagedNavigation?: ReturnType<typeof useBoundedNavigationWindow>;
  resourceIds?: string[];
  loadedThreads?: NavigationThreadSummary[];
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
    (props.loadedThreads ?? props.threads).map((thread) => [
      threadSummaryIdentityKey(thread),
      thread,
    ]),
  );
  const entries = props.pagedNavigation ? (props.resourceIds ?? ["lens"]).flatMap((id) => props.pagedNavigation?.resources.get(id)?.state.page?.entries ?? []) : undefined;
  const visibleKeys = new Set(props.threads.map(threadSummaryIdentityKey));
  const topLevelThreads: NavigationThreadSummary[] = entries
    ? entries.filter((entry) => entry.placement.kind === "root" && visibleKeys.has(navigationThreadSelectionKey(entry.row.ref)))
      .map((entry) => threadByKey.get(navigationThreadSelectionKey(entry.row.ref))).filter((thread): thread is NavigationThreadSummary => Boolean(thread))
    : props.threads.filter((thread) => !thread.parentThreadId);
  const childrenByParentKey = new Map<string, NavigationThreadSummary[]>();
  const childEntries = [...entries ?? [], ...[...props.pagedNavigation?.resources.values() ?? []]
    .filter((resource) => resource.state.request.query.kind === "children").flatMap((resource) => resource.state.page?.entries ?? [])];
  for (const entry of childEntries) {
    if (entry.placement.kind !== "child") continue;
    const parentKey = navigationThreadSelectionKey(entry.placement.parent);
    const children = childrenByParentKey.get(parentKey) ?? [];
    const key = navigationThreadSelectionKey(entry.row.ref);
    const row = threadByKey.get(key);
    if (row && !children.some((child) => threadSummaryIdentityKey(child) === key)) children.push(row);
    childrenByParentKey.set(parentKey, children);
  }
  const renderSubthreads = (parent: NavigationPresentedThread) => {
    const parentKey = threadSummaryIdentityKey(parent);
    const children = sortSubthreadSummaries(parent, childrenByParentKey.get(parentKey) ?? []);
    const nativeSubAgentCount = parent.nativeSubAgentCount ?? parent.codexNativeSubAgents?.length ?? 0;
    const childResourceId = `children:${navigationIdentityKey({ backend: parent.source, threadId: parent.id,
      ownerInstanceId: parent.federation?.ref.target.scope === "remote" ? parent.federation.ref.target.instanceId : undefined })}`;
    const childResource = props.pagedNavigation?.resources.get(childResourceId);
    const subthreadsCollapsed = isSubthreadSectionCollapsed(parent);
    const canManageSubthreads = threadSupportsFederationCapability(
      parent,
      "thread_grouping",
    );
    if (
      ((parent.ordinaryChildCount ?? children.length) === 0 && nativeSubAgentCount === 0)
      || subthreadsCollapsed
    ) {
      return null;
    }

    const childKeys = children.map((child) =>
      threadSummaryIdentityKey(child),
    );
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
                && children.length > 1
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
                  || resolveThreadParentKey(draggedThread, threadByKey) !== parentKey
                ) {
                  return;
                }
                const nextKeys = moveThreadKey(
                  childKeys,
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
        {childResource?.state.error ? <p role="alert">{childResource.state.error}</p> : null}
        {childResource?.loading ? <p>Loading sub-threads…</p> : null}
        {childResource?.state.rebaselineRequired ? (
          <button type="button" onClick={() => void props.pagedNavigation?.restart(childResourceId)}>Reload sub-threads</button>
        ) : childResource?.state.page?.nextCursor ? (
          <button type="button" disabled={childResource.loading} onClick={() => void props.pagedNavigation?.loadMore(childResourceId)}>Load more sub-threads</button>
        ) : null}
      </div>
    );
  };

  // Shift selection follows the rows a person can actually see: parents and
  // any expanded children, in render order. Collapsed children are
  // deliberately absent, just like Finder ranges do not reach into a closed
  // disclosure.
  const selectionOrder = topLevelThreads.flatMap((thread) => {
    const threadKey = threadSummaryIdentityKey(thread);
    const children = sortSubthreadSummaries(
      thread,
      childrenByParentKey.get(threadKey) ?? [],
    );
    return [
      threadKey,
      ...(isSubthreadSectionCollapsed(thread)
        ? []
        : children.map((child) =>
            threadSummaryIdentityKey(child),
          )),
    ];
  });

  const renderThreadGroup = (thread: NavigationThreadSummary) => {
    const key = threadSummaryIdentityKey(thread);
    const children = sortSubthreadSummaries(thread, childrenByParentKey.get(key) ?? []);
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
