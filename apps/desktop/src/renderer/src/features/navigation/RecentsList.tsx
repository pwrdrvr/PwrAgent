import { readNavigationPresentationOrder, readOwnerChildOrder, type NavigationPresentationOrder } from "./navigation-presentation-order";
import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";
import type { useBoundedNavigationWindow } from "../../lib/useBoundedNavigationWindow";
import { isNavigationPeerUnavailable, navigationIdentityKey, navigationThreadSelectionKey } from "../../lib/navigation-query-state";
import { Fragment, useId, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useEventCallback } from "../../lib/useEventCallback";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  NavigationRelativeChildMove,
  NavigationQueryPage,
  NavigationRelativePinMove,
  PrSummary,
} from "@pwragent/shared";
import {
  comparePinnedThreads,
  isKeptAtTopThread,
  isPinnedThread,
  resolveThreadParentKey,
} from "@pwragent/shared";
import { PinIcon } from "../../icons";
import { useDropIndicatorController } from "./drag-drop";
import { useSubthreadReorderDrag } from "./useSubthreadReorderDrag";
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
import { KeepAtTopSlot } from "./KeepAtTopSlot";
import { SidebarShowMore } from "./SidebarShowMore";
import { SubthreadPagination } from "./SubthreadPagination";
import { ThreadRow, type ThreadRowRef } from "./ThreadRow";
import { isRenamingRow, type RenamingThreadRow } from "./thread-action-hotkeys";
import { AttentionReviewReadout, AttentionTurnReadouts, describeAttentionCounts } from "./AttentionSignals";
import { isThreadActive, isThreadAwaitingReview, isThreadRemoteWork } from "./ThreadRowStatus";
import { isFederationViewerWindow } from "../../lib/federation-window";
import { useThreadPinOrdering, type ThreadPinScope } from "./useThreadPinOrdering";
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
  /**
   * The Pinned group's own page, while pinned threads sit on top in Updated
   * and Created. Its roots render once, in one collapsible group above the
   * time-sorted list, and never in the list.
   */
  pinnedResourceId?: string;
  pinnedGroupCollapsed?: boolean;
  onSetPinnedGroupCollapsed?: (collapsed: boolean) => void;
  onReorderThreadPins?: (orderedThreadKeys: string[], move?: NavigationRelativePinMove) => Promise<void>;
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
  /**
   * The list's continuation ("Load more threads"). Right under the last row
   * and before the visiting row and the footer, so it reads as the next page
   * of this list rather than one more action after it.
   */
  pager?: ReactNode;
  /**
   * A thread the operator jumped to (⌘K) that may be outside this lens. When
   * it has no row here, and no rendered ancestor whose tray the reveal will
   * open, it gets its own row after the lens's rows under `visitingLabel`,
   * so the selection is never invisible and the lens never has to change.
   */
  visitingThread?: NavigationThreadSummary;
  visitingLabel?: string;
  /** Shown in place of the rows when the lens has none, above a visiting row. */
  emptyMessage?: ReactNode;
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
 * The flat lenses. Inbox is a pure sort order: every top-level thread renders
 * in the order the caller supplies, pinned or not.
 *
 * With `general.pinned_threads_on_top`, Updated and Created add one
 * collapsible Pinned group above their time-sorted list (`pinnedResourceId`).
 * The group holds every pinned root, from every project and peer, in the one
 * global pin order; the list holds every other root. A thread renders in
 * exactly one of them, so pinning moves it into the group and unpinning
 * returns it to its slot in the list's own order. Pin ordering in the group
 * is Directories' own machinery (`useThreadPinOrdering`), so every lens edits
 * the same rank the same way.
 */
export function RecentsList(props: RecentsListProps) {
  // Pin drags keep their own indicator, as in Directories: a sub-thread
  // reorder and a pin move must never light each other's targets.
  const pinDropIndicator = useDropIndicatorController();
  const pinOrdering = useThreadPinOrdering({
    threads: props.loadedThreads ?? props.threads,
    dropIndicator: pinDropIndicator,
    onReorderThreadPins: props.onReorderThreadPins,
    onSetThreadPin: props.onSetThreadPin,
  });
  const threadByKey = new Map(
    (props.loadedThreads ?? props.threads).map((thread) => [
      threadSummaryIdentityKey(thread),
      thread,
    ]),
  );
  const pointerDownSubthread = useSubthreadReorderDrag({
    threadByKey,
    onUpdateSubthreadOrder: props.onUpdateSubthreadOrder,
  });
  const presentation = props.presentationOrder ?? readNavigationPresentationOrder(props.pagedNavigation?.resources ?? new Map());
  const entries = props.pagedNavigation ? (props.resourceIds ?? ["lens"]).flatMap((id) => presentation.get(id) ?? []) : undefined;
  const pinnedEntries = props.pagedNavigation && props.pinnedResourceId
    ? presentation.get(props.pinnedResourceId) ?? [] : [];
  const visibleKeys = new Set(props.threads.map(threadSummaryIdentityKey));
  const rootThreads = (rootEntries: readonly { key: string; placement: { kind: string } }[]) => [...new Map(rootEntries
    .filter((entry) => entry.placement.kind === "root" && visibleKeys.has(entry.key))
    .flatMap((entry) => {
      const thread = threadByKey.get(entry.key);
      return thread ? [[entry.key, thread] as const] : [];
    })).values()];
  // The group takes pinned roots from the list only once its own page is
  // demanded. Before that, as when the setting turns on mid-session, a pin
  // stays in the list rather than vanishing from both.
  const pinnedResource = props.pinnedResourceId
    ? props.pagedNavigation?.resources.get(props.pinnedResourceId) : undefined;
  const groupActive = Boolean(props.pinnedResourceId) && (!props.pagedNavigation || Boolean(pinnedResource));
  // Each root's own pin decides its side, not only the page that carried it,
  // as in Directories. An owner that predates the split answers both queries
  // with every thread, and a pin or unpin patches the row before the stale
  // pages are read again: it moves at once rather than vanishing from both.
  const pinnedRoots = groupActive
    ? (entries ? rootThreads([...pinnedEntries, ...entries]) : props.threads.filter((thread) => !thread.parentThreadId))
      .filter(isPinnedThread).sort(comparePinnedThreads)
    : [];
  const pinnedRootKeys = new Set(pinnedRoots.map(threadSummaryIdentityKey));
  const topLevelThreads: NavigationThreadSummary[] = (entries
    ? rootThreads(entries)
    : props.threads.filter((thread) => !thread.parentThreadId))
    .filter((thread) => !groupActive
      || (!isPinnedThread(thread) && !pinnedRootKeys.has(threadSummaryIdentityKey(thread))));
  // `collectionSize` is the owner's acknowledgment of the split. An older
  // owner's group page is the whole unsplit lens, not a set of pins.
  if (groupActive && entries && pinnedResource?.state.page?.collectionSize !== undefined) {
    // A just-unpinned root is still on the group's page. Return it to its
    // slot in the list's own order until the list's page is read again.
    const listedKeys = new Set(topLevelThreads.map(threadSummaryIdentityKey));
    const groupQuery = pinnedResource.state.request.query;
    const sortTime = (thread: NavigationThreadSummary) =>
      (groupQuery.kind === "lens" && groupQuery.lens === "recents" ? thread.createdAt : thread.updatedAt) ?? 0;
    for (const thread of rootThreads(pinnedEntries)) {
      if (isPinnedThread(thread) || listedKeys.has(threadSummaryIdentityKey(thread))) continue;
      const before = topLevelThreads.findIndex((listed) => sortTime(listed) < sortTime(thread));
      topLevelThreads.splice(before < 0 ? topLevelThreads.length : before, 0, thread);
    }
  }
  const topLevelKeys = new Set([...pinnedRootKeys, ...topLevelThreads.map(threadSummaryIdentityKey)]);
  const childrenByParentKey = new Map<string, NavigationThreadSummary[]>();
  const childEntries = [...entries ?? [], ...pinnedEntries, ...[...props.pagedNavigation?.resources.values() ?? []]
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
  const trays = createSubthreadTrays(childrenByParentKey, [...pinnedRoots, ...topLevelThreads],
    readOwnerChildOrder(props.pagedNavigation?.resources ?? new Map(), presentation));
  const renderedThreadKeys = new Set(topLevelKeys);
  for (const key of topLevelKeys) {
    for (const child of trays.subtree(key)) renderedThreadKeys.add(threadSummaryIdentityKey(child));
  }
  const childResourcesOf = (parent: NavigationThreadSummary) => {
    const childResourceId = `children:${navigationIdentityKey({ backend: parent.source, threadId: parent.id,
      ownerInstanceId: parent.federation?.ref.target.scope === "remote" ? parent.federation.ref.target.instanceId : undefined })}`;
    return [childResourceId, `${childResourceId}:viewer`]
      .flatMap((id) => {
        const resource = props.pagedNavigation?.resources.get(id);
        return resource ? [resource] : [];
      });
  };
  const startingThreads = selectUnlandedStartingThreads(props.startingThreads, renderedThreadKeys);
  // A rendered ancestor is still revealing the thread while its tray is shut,
  // or open with its children page on the way. Once that page has landed
  // without the thread (it is further down the tray), the thread needs a row.
  const trayStillRevealing = (parent: NavigationThreadSummary): boolean => {
    if (isSubthreadSectionCollapsed(parent)) return true;
    const resources = childResourcesOf(parent);
    return resources.length === 0 || resources.some((resource) => resource.loading || !resource.state.page);
  };
  const visitingThread = props.visitingThread
    && !hasRenderedLineage(props.visitingThread, renderedThreadKeys, threadByKey, trayStillRevealing)
    ? props.visitingThread
    : undefined;
  const visitingLabelId = useId();
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
    const childResources = childResourcesOf(parent);
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
      <div className="subthread-list" role="list" aria-label={`Sub-threads of ${parent.title}`} data-subthread-tray={parentKey}>
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
          const reorderable =
            canManageSubthreads
            && directChildKeys.length > 1
            && directChildKeySet.has(childKey)
            && Boolean(props.onUpdateSubthreadOrder);
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
              pointerDraggable={reorderable}
              includeLinkedDirectories
              nested
              nestedDepth={trays.depth(childKey)}
              revealSelectedThreadRequest={props.revealSelectedThreadRequest}
              selectedThreadKey={props.selectedThreadKey}
              selected={props.selectedThreadKeys?.has(childKey)}
              thinkingThreadKeys={props.thinkingThreadKeys}
              agentCommandThreadKeys={props.agentCommandThreadKeys}
              thread={child}
              onPointerDownThread={reorderable ? pointerDownSubthread : undefined}
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
  const pinnedGroupCollapsed = Boolean(props.pinnedGroupCollapsed);
  const selectionOrder = [...(pinnedGroupCollapsed ? [] : pinnedRoots), ...topLevelThreads].flatMap((thread) => {
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
  // The group is one pin scope: every root in it is a source and an anchor.
  const pinScope: ThreadPinScope = {
    key: "recents-pinned",
    admitsRoot: (threadKey) => pinnedRootKeys.has(threadKey),
    pinnedKeys: () => [...pinnedRootKeys],
  };
  const pointerDownPinnedThread = useEventCallback(
    (event: ReactPointerEvent<HTMLDivElement>, row: ThreadRowRef) => {
      pinOrdering.beginPointerDrag(event, pinScope, row.threadKey, row.pinned);
    },
  );
  const movePinnedThread = useEventCallback(
    (thread: NavigationThreadSummary, direction: "up" | "down") => {
      pinOrdering.movePinnedThreadByKeyboard(thread, direction);
    },
  );
  const pinOrderingEnabled = Boolean(props.onReorderThreadPins);

  // What a top-level card here receives, lens row or visiting row alike.
  const topLevelRowProps = (thread: NavigationThreadSummary) => {
    const key = threadSummaryIdentityKey(thread);
    return {
      approvalRequestThreadKeys: props.approvalRequestThreadKeys,
      terminalThreadKeys: props.terminalThreadKeys,
      inputRequestThreadKeys: props.inputRequestThreadKeys,
      queuedMessageThreadKeys: props.queuedMessageThreadKeys,
      draftThreadKeys: props.draftThreadKeys,
      composerSourceThreadKey: props.composerSourceThreadKey,
      actionsMenuOpen: key === props.actionsMenuThreadKey,
      renaming: isRenamingRow(props.renamingRow, key, undefined),
      onRequestRename: props.onRequestRenameThread,
      onCommitRename: props.onCommitRenameThread,
      includeLinkedDirectories: true,
      revealSelectedThreadRequest: props.revealSelectedThreadRequest,
      selectedThreadKey: props.selectedThreadKey,
      selected: props.selectedThreadKeys?.has(key),
      thinkingThreadKeys: props.thinkingThreadKeys,
      agentCommandThreadKeys: props.agentCommandThreadKeys,
      thread,
      onOpenContextMenu: props.onOpenThreadContextMenu,
      onOpenPullRequestContextMenu: props.onOpenPullRequestContextMenu,
      onDetachPullRequest: props.onDetachPullRequest,
      onPrefetchPullRequests: props.onPrefetchPullRequests,
      onPrefetchGitWorkingState: props.onPrefetchGitWorkingState,
      onRevealSelectedThreadComplete: props.onRevealSelectedThreadComplete,
      onSelectThread: selectThread,
      onSetReaction: props.onSetReaction,
      onSetThreadPin: props.onSetThreadPin,
      onUnbindMessagingBinding: props.onUnbindMessagingBinding,
    };
  };

  const renderThreadGroup = (thread: NavigationThreadSummary, pinned = false) => {
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
          {...topLevelRowProps(thread)}
          subthreadCount={subthreadCount}
          subthreadsCollapsed={subthreadsCollapsed}
          threadPinState={pinned ? "pinned" : undefined}
          pointerDraggable={pinned && pinOrderingEnabled}
          onPointerDownThread={pinned && pinOrderingEnabled ? pointerDownPinnedThread : undefined}
          onMovePinnedThread={pinned && pinOrderingEnabled ? movePinnedThread : undefined}
          onToggleSubthreads={
            subthreadCount > 0
              && threadSupportsFederationCapability(thread, "thread_grouping")
              && props.onSetSubthreadsCollapsed
              ? toggleSubthreads
              : undefined
          }
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

  // A failed group page raises the thread-list toast like any other page.
  // Its recovery control must still show with no pin loaded: the list below
  // never carries a pin, so without it every pin would stay hidden.
  const pinnedFooter = pinnedResource && (pinnedResource.state.rebaselineRequired
    || pinnedResource.state.page?.nextCursor) ? (
    <div role="listitem">
      {pinnedResource.state.rebaselineRequired ? (
        <SidebarShowMore kind="reload" label="Reload pinned threads" onClick={() => void props.pagedNavigation?.restart(pinnedResource.id)} />
      ) : pinnedResource.state.page?.nextCursor ? (
        <SidebarShowMore busy={pinnedResource.loading} label="Load more pinned threads" onClick={() => void props.pagedNavigation?.loadMore(pinnedResource.id)} />
      ) : null}
    </div>
  ) : null;
  const pinnedGroup = pinnedRoots.length > 0 ? (
    <PinnedGroup
      collapsed={pinnedGroupCollapsed}
      counts={readPinnedGroupCounts({
        page: pinnedResource?.state.page,
        roots: pinnedRoots,
        subtree: (thread) => trays.subtree(threadSummaryIdentityKey(thread)),
        thinkingThreadKeys: props.thinkingThreadKeys,
      })}
      onToggle={props.onSetPinnedGroupCollapsed
        ? () => props.onSetPinnedGroupCollapsed?.(!pinnedGroupCollapsed)
        : undefined}
    >
      {pinnedRoots.map((thread, index) => {
        // Kept pins sort first, so the Keep at top slot sits before the
        // first ordinary pin: below the last kept pin, or above the pins
        // when none is kept yet. With every pin kept there is no slot; a
        // drop on the last kept row's lower half keeps there. The slot is
        // Directories' own, and grows only while a drag is live.
        const keepAtTopSeam = pinOrderingEnabled
          && !isKeptAtTopThread(thread)
          && (index === 0 || isKeptAtTopThread(pinnedRoots[index - 1]!));
        return (
          <Fragment key={threadSummaryIdentityKey(thread)}>
            {keepAtTopSeam ? (
              <KeepAtTopSlot label="Keep thread at top of pinned threads" />
            ) : null}
            {renderThreadGroup(thread, true)}
          </Fragment>
        );
      })}
      {pinnedFooter}
    </PinnedGroup>
  ) : pinnedFooter && groupActive ? (
    <div className="sidebar-list sidebar-list--compact" role="list" aria-label="Pinned threads">
      {pinnedFooter}
    </div>
  ) : null;

  // After the lens's rows rather than above them: no queue row moves when the
  // slot appears or goes away, and in the paged lenses that is also where the
  // thread really is.
  const visitingSlot = visitingThread ? (
    <div className="sidebar-visiting">
      <p className="recents-pinned-divider" id={visitingLabelId}>
        {props.visitingLabel}
      </p>
      <div className="sidebar-list sidebar-list--compact" role="list" aria-labelledby={visitingLabelId}>
        <div className="thread-group">
          <ThreadRow {...topLevelRowProps(visitingThread)} />
        </div>
      </div>
    </div>
  ) : null;

  if (topLevelThreads.length === 0 && startingRootThreads.length === 0 && !pinnedGroup && props.emptyMessage) {
    return (
      <div className="sidebar-list sidebar-list--dense">
        {props.emptyMessage}
        {props.pager}
        {visitingSlot}
        {props.footer}
      </div>
    );
  }

  return (
    <div className={`sidebar-list sidebar-list--dense${pinnedRoots.length > 0 ? " sidebar-list--pinned-group" : ""}`}>
      {pinnedGroup}
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
      {props.pager}
      {visitingSlot}
      {props.footer}
    </div>
  );
}

type PinnedGroupCounts = {
  total: number;
  activeLocal: number;
  /** Turns on other instances; undefined keeps the readout off, as on the Attention tab. */
  activeRemote?: number;
  review: number;
};

/**
 * What the Pinned group's header reports. An owner that splits the lens
 * counts its whole bucket, so a pin past the loaded page still counts; its
 * `collectionSize` is the pinned root count. An older owner sent no split
 * and its counts cover every thread, so the header falls back to the loaded
 * pins and their sub-threads.
 */
export function readPinnedGroupCounts(params: {
  page?: NavigationQueryPage;
  roots: readonly NavigationThreadSummary[];
  subtree: (thread: NavigationThreadSummary) => readonly NavigationThreadSummary[];
  thinkingThreadKeys?: Record<string, boolean>;
}): PinnedGroupCounts {
  const viewer = isFederationViewerWindow();
  if (params.page?.collectionSize !== undefined) {
    const activeRemote = viewer ? 0 : params.page.counts.activeRemote ?? 0;
    return {
      total: params.page.collectionSize,
      activeLocal: params.page.counts.active - activeRemote,
      ...(activeRemote > 0 ? { activeRemote } : {}),
      review: params.page.counts.review,
    };
  }
  let activeLocal = 0;
  let activeRemote = 0;
  let review = 0;
  for (const thread of params.roots.flatMap((root) => [root, ...params.subtree(root)])) {
    const active = isThreadActive(thread, params.thinkingThreadKeys);
    if (active && !viewer && isThreadRemoteWork(thread)) activeRemote += 1;
    else if (active) activeLocal += 1;
    if (!active && isThreadAwaitingReview(thread)) review += 1;
  }
  return {
    total: params.roots.length,
    activeLocal,
    ...(activeRemote > 0 ? { activeRemote } : {}),
    review,
  };
}

function formatPinnedThreadCount(count: number): string {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

function formatUnreadThreadCount(count: number): string {
  return `${count} unread`;
}

/**
 * The Pinned group of Updated and Created: a project header's primitives (the
 * disclosure caret, the label, the right-aligned meta), so the group reads
 * as the same kind of thing a Directories project is.
 *
 * Collapsed, the header carries the Attention tab's two readouts scoped to
 * the group, both on screen and grey at zero: closing the group must never
 * hide a running turn or an unread thread. Open, the rows show their own
 * state and the header shows only the count.
 */
function PinnedGroup(props: {
  collapsed: boolean;
  counts: PinnedGroupCounts;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const { counts } = props;
  const label = [
    "Pinned",
    formatPinnedThreadCount(counts.total),
    ...(props.collapsed ? [describeAttentionCounts(counts, formatUnreadThreadCount)] : []),
  ].join(", ");
  return (
    <section
      className="pinned-group"
      data-thread-pin-scope="recents"
    >
      <div className="directory-row__header">
        <button
          aria-expanded={!props.collapsed}
          aria-label={label}
          className="thread-row thread-row--compact directory-row__summary pinned-group__summary"
          data-hover-stable-release="pinned-group"
          type="button"
          onClick={props.onToggle}
        >
          <span className="directory-row__summary-main">
            <span
              aria-hidden="true"
              className={`directory-row__chevron${props.collapsed ? "" : " is-open"}`}
            />
            <span aria-hidden="true" className="directory-row__icon pinned-group__icon">
              <PinIcon size={12} />
            </span>
            <span className="directory-row__title-wrap">
              <span className="thread-row__title directory-row__title">Pinned</span>
            </span>
          </span>
          <span className="directory-row__summary-meta">
            {props.collapsed ? (
              <>
                <AttentionTurnReadouts
                  activeLocal={counts.activeLocal}
                  activeRemote={counts.activeRemote}
                />
                <AttentionReviewReadout count={counts.review} />
              </>
            ) : null}
            <span aria-hidden="true" className="pinned-group__count">
              {counts.total}
            </span>
          </span>
        </button>
      </div>
      {props.collapsed ? null : (
        <div className="directory-row__details pinned-group__details">
          <div className="sidebar-list sidebar-list--compact" role="list" aria-label="Pinned threads">
            {props.children}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Whether the thread has a row here already, or sits under a rendered
 * ancestor whose tray is still revealing it. The second case is still the
 * lens's own row: the sidebar's reveal opens collapsed parents, and the child
 * lands in its tray a moment later. A visiting row in that gap would flash at
 * the end of the list and take the reveal's scroll with it.
 */
function hasRenderedLineage(
  thread: NavigationThreadSummary,
  renderedThreadKeys: ReadonlySet<string>,
  threadByKey: ReadonlyMap<string, NavigationThreadSummary>,
  trayStillRevealing: (parent: NavigationThreadSummary) => boolean,
): boolean {
  const visited = new Set<string>();
  let key: string | undefined = threadSummaryIdentityKey(thread);
  let current: NavigationThreadSummary | undefined = thread;
  while (key && !visited.has(key)) {
    if (renderedThreadKeys.has(key)) {
      // The nearest rendered ancestor owns the tray the thread would land in.
      return current === thread || !current || trayStillRevealing(current);
    }
    visited.add(key);
    key = current ? resolveThreadParentKey(current, threadByKey) : undefined;
    current = key ? threadByKey.get(key) : undefined;
  }
  return false;
}
