import { readNavigationPresentationOrder, type NavigationPresentationOrder } from "./navigation-presentation-order";
import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";
import type { useBoundedNavigationWindow } from "../../lib/useBoundedNavigationWindow";
import { isNavigationPeerUnavailable, navigationIdentityKey, navigationThreadSelectionKey } from "../../lib/navigation-query-state";
import { useState, type MouseEvent, type ReactNode } from "react";
import { useEventCallback } from "../../lib/useEventCallback";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  NavigationRelativeChildMove,
  PrSummary,
} from "@pwragent/shared";
import {
  resolveThreadParentKey,
} from "@pwragent/shared";
import {
  didDragLeaveCurrentTarget,
  getDropIndicatorPosition,
  useDropIndicatorController,
} from "./drag-drop";
import { createSubthreadTrays } from "./subthread-trays";
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
import { SubthreadPagination } from "./SubthreadPagination";
import { ThreadRow, type ThreadRowRef } from "./ThreadRow";
import { isRenamingRow, type RenamingThreadRow } from "./thread-action-hotkeys";
import {
  interleaveStartingSubthreads,
  isSubthreadLaunchpadDraft,
  selectUnlandedStartingThreads,
  type PendingSidebarRow,
} from "./StartingThreadRow";
import { PendingThreadRow } from "./SubthreadDraftRow";
import type { SubthreadLaunchpadDraft } from "../../lib/useThreadNavigation";

type RecentsListProps = {
  presentationOrder?: NavigationPresentationOrder;
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
  /** The thread whose ⋮ actions menu is open, for that button's `aria-expanded`. */
  actionsMenuThreadKey?: string;
  /** The row whose title is a rename field. */
  renamingRow?: RenamingThreadRow;
  onRequestRenameThread?: (thread: NavigationThreadSummary, row: ThreadRowRef) => void;
  onCommitRenameThread?: (thread: NavigationThreadSummary, name: string | null) => void;
  revealSelectedThreadRequest?: number;
  selectedThreadKey?: string;
  selectedThreadKeys?: ReadonlySet<string>;
  thinkingThreadKeys?: Record<string, boolean>;
  agentCommandThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  /**
   * Threads still starting, and sub-threads still being written. Each
   * renders where its thread will land: under its parent when that row is
   * here, otherwise at the top, where a new thread sorts in every lens that
   * renders this list.
   */
  startingThreads?: PendingSidebarRow[];
  /**
   * The lane's last item, after every row (the start actions). Inside the
   * scrolling lane so it scrolls with the rows, outside the `role="list"` so
   * it is not counted as a thread.
   */
  footer?: ReactNode;
  onSelectStartingThread?: (entry: PendingSidebarRow) => void;
  onOpenSubthreadDraftContextMenu?: (
    draft: SubthreadLaunchpadDraft,
    position: { x: number; y: number },
  ) => void;
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
    move: NavigationRelativeChildMove,
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
  const presentation = props.presentationOrder ?? readNavigationPresentationOrder(props.pagedNavigation?.resources ?? new Map());
  const entries = props.pagedNavigation ? (props.resourceIds ?? ["lens"]).flatMap((id) => presentation.get(id) ?? []) : undefined;
  const visibleKeys = new Set(props.threads.map(threadSummaryIdentityKey));
  const topLevelThreads: NavigationThreadSummary[] = entries
    ? entries.filter((entry) => entry.placement.kind === "root" && visibleKeys.has(entry.key))
      .map((entry) => threadByKey.get(entry.key)).filter((thread): thread is NavigationThreadSummary => Boolean(thread))
    : props.threads.filter((thread) => !thread.parentThreadId);
  const topLevelKeys = new Set(topLevelThreads.map(threadSummaryIdentityKey));
  const childrenByParentKey = new Map<string, NavigationThreadSummary[]>();
  const childEntries = [...entries ?? [], ...[...props.pagedNavigation?.resources.values() ?? []]
    .filter((resource) => resource.state.request.query.kind === "children").flatMap((resource) => presentation.get(resource.id) ?? [])];
  for (const entry of childEntries) {
    // A lens can promote a descendant whose parent does not qualify. Its
    // root placement owns both the row and its subtree, even when an expanded
    // ancestor's child pages also carry its original parent relationship.
    if (entry.placement.kind !== "child" || topLevelKeys.has(entry.key)) continue;
    const parentKey = navigationThreadSelectionKey(entry.placement.parent);
    const children = childrenByParentKey.get(parentKey) ?? [];
    const key = entry.key;
    const row = threadByKey.get(key);
    if (row && !children.some((child) => threadSummaryIdentityKey(child) === key)) children.push(row);
    childrenByParentKey.set(parentKey, children);
  }
  // One tray per top-level row, holding its whole descendant subtree in
  // depth-first order. The owner keys each child under its *true* parent,
  // so a grandchild is filed under a row that is itself a child; rendering
  // only direct children would silently drop it from this lens.
  const trays = createSubthreadTrays(childrenByParentKey);
  for (const thread of topLevelThreads) trays.addTrayOwner(thread);
  const renderedThreadKeys = new Set(topLevelKeys);
  for (const key of topLevelKeys) {
    for (const child of trays.subtree(key)) renderedThreadKeys.add(threadSummaryIdentityKey(child));
  }
  const startingThreads = selectUnlandedStartingThreads(props.startingThreads, renderedThreadKeys);
  const startingSubthreads = startingThreads.filter((creation) =>
    creation.parentThreadKey && renderedThreadKeys.has(creation.parentThreadKey));
  const startingRootThreads = startingThreads.filter((creation) => !startingSubthreads.includes(creation));
  const renderSubthreads = (parent: NavigationPresentedThread) => {
    const parentKey = threadSummaryIdentityKey(parent);
    // Already depth-first ordered by the tray. Re-sorting here by this
    // row's `subthreadOrder` would rank its grandchildren as unlisted and
    // scatter them away from the sub-threads that own them.
    const children = trays.subtree(parentKey);
    const directChildKeys = trays.directChildKeys(parentKey);
    const directChildKeySet = new Set(directChildKeys);
    const nativeSubAgentCount = parent.nativeSubAgentCount ?? parent.codexNativeSubAgents?.length ?? 0;
    const childResourceId = `children:${navigationIdentityKey({ backend: parent.source, threadId: parent.id,
      ownerInstanceId: parent.federation?.ref.target.scope === "remote" ? parent.federation.ref.target.instanceId : undefined })}`;
    const childResources = [childResourceId, `${childResourceId}:viewer`]
      .flatMap((id) => {
        const resource = props.pagedNavigation?.resources.get(id);
        return resource ? [resource] : [];
      });
    const subthreadsCollapsed = isSubthreadSectionCollapsed(parent);
    const canManageSubthreads = threadSupportsFederationCapability(
      parent,
      "thread_grouping",
    );
    const trayEntries = interleaveStartingSubthreads({
      trayKey: parentKey,
      subtree: children,
      depthOf: trays.depth,
      creations: startingSubthreads,
    });
    // A starting child opens its tray: the created thread does the same when
    // it lands, so the row is already where it will be.
    const startsSubthread = trayEntries.length > children.length;
    if (
      (((parent.ordinaryChildCount ?? children.length) === 0 && nativeSubAgentCount === 0)
        || subthreadsCollapsed)
      && !startsSubthread
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
        {trayEntries.flatMap((entry) => {
          if (entry.kind === "starting") {
            return [
              <PendingThreadRow
                key={entry.creation.selectionKey}
                entry={entry.creation}
                locationMode="label"
                nestedDepth={entry.depth}
                selected={props.selectedThreadKey === entry.creation.selectionKey}
                onOpenSubthreadDraftContextMenu={props.onOpenSubthreadDraftContextMenu}
                onSelect={props.onSelectStartingThread}
              />,
            ];
          }
          const child = entry.thread;
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
              actionsMenuOpen={childKey === props.actionsMenuThreadKey}
              renaming={isRenamingRow(props.renamingRow, childKey, undefined)}
              onRequestRename={props.onRequestRenameThread}
              onCommitRename={props.onCommitRenameThread}
              draggable={
                canManageSubthreads
                && directChildKeys.length > 1
                && directChildKeySet.has(childKey)
                && Boolean(props.onUpdateSubthreadOrder)
              }
              includeLinkedDirectories
              nested
              nestedDepth={trays.depth(childKey)}
              revealSelectedThreadRequest={props.revealSelectedThreadRequest}
              selectedThreadKey={props.selectedThreadKey}
              selectedThreadKeys={props.selectedThreadKeys}
              thinkingThreadKeys={props.thinkingThreadKeys}
              agentCommandThreadKeys={props.agentCommandThreadKeys}
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
                // `subthreadOrder` names this row's own children, so the
                // move stays inside that list — never the flattened tray,
                // which also carries rows owned by those children.
                void props.onUpdateSubthreadOrder?.(parent, {
                  threadId: draggedThread.id,
                  anchorThreadId: child.id,
                  placement: getDropIndicatorPosition(event),
                });
              }}
              onOpenContextMenu={props.onOpenThreadContextMenu}
              onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
              onDetachPullRequest={props.onDetachPullRequest}
              onPrefetchPullRequests={props.onPrefetchPullRequests}
              onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
              onRevealSelectedThreadComplete={
                props.onRevealSelectedThreadComplete
              }
              onSelectThread={selectThread}
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
        {childResources.filter((resource) => !isNavigationPeerUnavailable(resource.state.error)).map((childResource) => (
          <SubthreadPagination
            key={childResource.id}
            resource={childResource}
            pagedNavigation={props.pagedNavigation}
          />
        ))}
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
        : trays.subtree(threadKey).map((child) =>
            threadSummaryIdentityKey(child),
          )),
    ];
  });

  // One handler for every row rather than a closure per row: a closure per
  // row is a new function on every render, which the row's `memo` cannot bail
  // out past. `selectionOrder` belongs to the whole list, so the row has
  // nothing to report back here.
  const selectThread = useEventCallback(
    (thread: NavigationThreadSummary, event: MouseEvent<HTMLElement>) => {
      props.onSelectThread(thread, event, selectionOrder);
    },
  );
  const toggleSubthreads = useEventCallback((thread: NavigationThreadSummary) => {
    void props.onSetSubthreadsCollapsed?.(
      thread,
      !isSubthreadSectionCollapsed(thread),
    );
  });

  const renderThreadGroup = (thread: NavigationThreadSummary) => {
    const key = threadSummaryIdentityKey(thread);
    const children = trays.subtree(key);
    // A sub-thread being written opens its parent's tray and gives the
    // parent its chevron, as the thread will once it lands.
    const holdsDraft = startingSubthreads.some((entry) =>
      isSubthreadLaunchpadDraft(entry)
      && (entry.parentThreadKey === key
        || children.some((child) => threadSummaryIdentityKey(child) === entry.parentThreadKey)));
    const subthreadCount = getSubthreadDisclosureCount(thread, children.length) + (holdsDraft ? 1 : 0);
    const subthreadsCollapsed = isSubthreadSectionCollapsed(thread) && !holdsDraft;
    const tray = renderSubthreads(thread);
    return (
      <div key={key} className="thread-group">
        <ThreadRow
          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
          terminalThreadKeys={props.terminalThreadKeys}
          inputRequestThreadKeys={props.inputRequestThreadKeys}
          queuedMessageThreadKeys={props.queuedMessageThreadKeys}
          draftThreadKeys={props.draftThreadKeys}
          composerSourceThreadKey={props.composerSourceThreadKey}
          actionsMenuOpen={key === props.actionsMenuThreadKey}
          renaming={isRenamingRow(props.renamingRow, key, undefined)}
          onRequestRename={props.onRequestRenameThread}
          onCommitRename={props.onCommitRenameThread}
          includeLinkedDirectories
          revealSelectedThreadRequest={props.revealSelectedThreadRequest}
          selectedThreadKey={props.selectedThreadKey}
          selectedThreadKeys={props.selectedThreadKeys}
          subthreadCount={subthreadCount}
          subthreadsCollapsed={subthreadsCollapsed}
          thinkingThreadKeys={props.thinkingThreadKeys}
          agentCommandThreadKeys={props.agentCommandThreadKeys}
          thread={thread}
          onToggleSubthreads={
            subthreadCount > 0
              && threadSupportsFederationCapability(thread, "thread_grouping")
              && props.onSetSubthreadsCollapsed
              ? toggleSubthreads
              : undefined
          }
          onOpenContextMenu={props.onOpenThreadContextMenu}
          onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
          onDetachPullRequest={props.onDetachPullRequest}
          onPrefetchPullRequests={props.onPrefetchPullRequests}
          onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
          onRevealSelectedThreadComplete={props.onRevealSelectedThreadComplete}
          onSelectThread={selectThread}
          onSetReaction={props.onSetReaction}
          onSetThreadPin={props.onSetThreadPin}
          onUnbindMessagingBinding={props.onUnbindMessagingBinding}
        />
        {/* `.thread-group` carries no role, so the tray would sit straight
            inside the `role="list"` below, and a list owns only listitem.
            The Directories lens wraps its trays the same way. */}
        {tray ? (
          <div className="thread-group__subthreads-slot" role="listitem">
            {tray}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="sidebar-list sidebar-list--dense">
      <div className="sidebar-list sidebar-list--compact" role="list">
        {startingRootThreads.map((creation) => (
          <div key={creation.selectionKey} className="thread-group">
            <PendingThreadRow
              entry={creation}
              locationMode="label"
              selected={props.selectedThreadKey === creation.selectionKey}
              showParent
              onOpenSubthreadDraftContextMenu={props.onOpenSubthreadDraftContextMenu}
              onSelect={props.onSelectStartingThread}
            />
          </div>
        ))}
        {topLevelThreads.map((thread) => renderThreadGroup(thread))}
      </div>
      {props.footer}
    </div>
  );
}
