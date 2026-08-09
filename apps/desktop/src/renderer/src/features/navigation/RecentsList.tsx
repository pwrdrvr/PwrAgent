import { useState, type MouseEvent } from "react";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  moveThreadKey,
  parseThreadIdentityKey,
  resolveThreadParentKey,
  sortSubthreadSummaries,
} from "@pwragent/shared";
import {
  didDragLeaveCurrentTarget,
  getDropIndicatorPosition,
  type DropIndicatorState,
} from "./drag-drop";
import type { ThreadQueuedMessageState } from "../../lib/useThreadQueuedMessageIndicators";
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
    event: MouseEvent<HTMLButtonElement>,
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
  const [dropIndicator, setDropIndicator] = useState<
    DropIndicatorState | undefined
  >(undefined);
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
  const renderSubthreads = (parent: NavigationThreadSummary) => {
    const parentKey = buildThreadIdentityKey(parent.source, parent.id);
    const children = sortSubthreadSummaries(parent, childrenByParentKey.get(parentKey) ?? []);
    const nativeSubAgentCount = parent.codexNativeSubAgents?.length ?? 0;
    const subthreadsCollapsed = isSubthreadSectionCollapsed(parent);
    if (
      (children.length === 0 && nativeSubAgentCount === 0)
      || subthreadsCollapsed
    ) {
      return null;
    }

    const childKeys = children.map((child) =>
      buildThreadIdentityKey(child.source, child.id),
    );
    return (
      <div className="subthread-list" role="list" aria-label={`Sub-threads of ${parent.title}`}>
        {children.map((child) => {
          const childKey = buildThreadIdentityKey(child.source, child.id);
          const rowDropKey = `${parentKey}:${childKey}`;
          return (
            <ThreadRow
              key={childKey}
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              terminalThreadKeys={props.terminalThreadKeys}
              inputRequestThreadKeys={props.inputRequestThreadKeys}
              queuedMessageThreadKeys={props.queuedMessageThreadKeys}
              composerSourceThreadKey={props.composerSourceThreadKey}
              dropIndicator={
                dropIndicator?.targetKey === rowDropKey
                  ? dropIndicator.position
                  : undefined
              }
              draggable={children.length > 1 && Boolean(props.onUpdateSubthreadOrder)}
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
                  || resolveThreadParentKey(draggedThread, threadByKey) !== parentKey
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
                if (
                  !draggedThread
                  || resolveThreadParentKey(draggedThread, threadByKey) !== parentKey
                ) {
                  return;
                }
                const draggedId = parseThreadIdentityKey(draggedKey)?.threadId;
                if (!draggedId) return;
                const nextKeys = moveThreadKey(
                  childKeys,
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
            />
          );
        })}
        {nativeSubAgentCount > 0 ? (
          <NativeSubAgentsDisclosure thread={parent} />
        ) : null}
      </div>
    );
  };

  // Shift selection follows the rows a person can actually see: parents and
  // any expanded children, in render order. Collapsed children are
  // deliberately absent, just like Finder ranges do not reach into a closed
  // disclosure.
  const selectionOrder = topLevelThreads.flatMap((thread) => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const children = sortSubthreadSummaries(
      thread,
      childrenByParentKey.get(threadKey) ?? [],
    );
    return [
      threadKey,
      ...(isSubthreadSectionCollapsed(thread)
        ? []
        : children.map((child) =>
            buildThreadIdentityKey(child.source, child.id),
          )),
    ];
  });

  const renderThreadGroup = (thread: NavigationThreadSummary) => {
    const key = buildThreadIdentityKey(thread.source, thread.id);
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
            subthreadCount > 0 && props.onSetSubthreadsCollapsed
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
