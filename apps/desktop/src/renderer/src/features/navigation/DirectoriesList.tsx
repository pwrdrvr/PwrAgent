import {
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type MouseEvent,
} from "react";
import type {
  AppServerBackendKind,
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  comparePinnedDirectories,
  comparePinnedThreads,
  isPinnedDirectory,
  isPinnedThread,
  isSubthreadLaunchpadKey,
  moveDirectoryKey,
  moveThreadKey,
  parseThreadIdentityKey,
  resolveThreadParentKey,
  sortSubthreadSummaries,
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
  useDropIndicatorController,
} from "./drag-drop";
import type { ThreadQueuedMessageState } from "../../lib/useThreadQueuedMessageIndicators";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";
import {
  getSubthreadDisclosureCount,
  isSubthreadSectionCollapsed,
  NativeSubAgentsDisclosure,
} from "./NativeSubAgentsDisclosure";
import { ThreadRow } from "./ThreadRow";
import {
  formatActiveThreadCount,
  formatReviewThreadCount,
} from "./ThreadRowStatus";
import {
  buildDirectoryThreadRenderModel,
  DIRECTORY_UNPINNED_THREAD_CAP,
  type ExpandedDirectoryThreadRenderModel,
} from "./directory-thread-render-model";

type DirectoriesListProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  /** Thread keys with a live integrated terminal in the main process. */
  terminalThreadKeys?: Record<string, boolean>;
  inputRequestThreadKeys?: Record<string, boolean>;
  queuedMessageThreadKeys?: Record<string, ThreadQueuedMessageState>;
  draftThreadKeys?: Record<string, boolean>;
  composerSourceThreadKey?: string;
  directories: NavigationDirectorySummary[];
  revealSelectedThreadRequest?: number;
  selectedItemKey?: string;
  selectedDirectoryKeys?: ReadonlySet<string>;
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
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onRevealSelectedThreadComplete?: (request: number) => void;
  onSelectThread: (
    thread: NavigationThreadSummary,
    event: MouseEvent<HTMLButtonElement>,
    selectionOrder: string[],
  ) => void;
  onSelectDirectory?: (
    directory: NavigationDirectorySummary,
    event: MouseEvent<HTMLButtonElement>,
    selectionOrder: string[],
  ) => void;
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onPrefetchGitWorkingState?: (thread: NavigationThreadSummary) => void;
  onDetachPullRequest?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
  ) => void;
  onReorderThreadPins?: (orderedThreadKeys: string[]) => Promise<void>;
  onUpdateSubthreadOrder?: (
    parent: NavigationThreadSummary,
    threadIds: string[],
  ) => Promise<void>;
  onSetSubthreadsCollapsed?: (
    parent: NavigationThreadSummary,
    collapsed: boolean,
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
  onSetDirectoryThreadsCollapsed?: (
    directory: NavigationDirectorySummary,
    collapsed: boolean,
  ) => Promise<void>;
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
  onSetThreadPin?: (
    thread: NavigationThreadSummary,
    pinned: boolean,
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

const EMPTY_EXPANDED_DIRECTORY_THREAD_MODEL: ExpandedDirectoryThreadRenderModel = {
  cappedUnpinnedThreads: [],
  childThreadsByParentKey: new Map(),
  directoryPinnedThreads: [],
  directoryThreadsCollapsed: false,
  directoryUnpinnedThreadCount: 0,
  hiddenUnpinnedCount: 0,
  overflowUnpinnedThreads: [],
  selectionOrder: [],
  unpinnedExpanded: false,
};

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

/**
 * Drives the row's orange "has-draft" marker. This means "you have composed
 * something here" — typed text or attached images — and nothing else.
 *
 * `settingsTouchedAt` is deliberately NOT part of it. That stamp records that
 * the user picked a model / reasoning level / access mode for this project,
 * which is a sticky preference we keep, not an unsent draft. Including it made
 * every project the user had ever configured look permanently half-drafted, and
 * the marker survived Cancel because the stamp is persisted.
 */
function hasPendingLaunchpadState(directory: NavigationDirectorySummary): boolean {
  const launchpad = directory.launchpad;
  if (!launchpad) {
    return false;
  }

  return (
    launchpad.prompt.trim().length > 0 ||
    (launchpad.imageAttachments?.length ?? 0) > 0
  );
}

type ThreadPinDragSession = {
  canceled: boolean;
  sourceElement: HTMLDivElement;
  sourceWasPinned: boolean;
  threadKey: string;
};

function isPointInsideDragSource(
  session: ThreadPinDragSession,
  point: { x: number; y: number },
): boolean {
  const sourceBounds = session.sourceElement.getBoundingClientRect();
  if (
    sourceBounds.right <= sourceBounds.left
    || sourceBounds.bottom <= sourceBounds.top
  ) {
    return false;
  }
  return (
    point.x >= sourceBounds.left
    && point.x <= sourceBounds.right
    && point.y >= sourceBounds.top
    && point.y <= sourceBounds.bottom
  );
}
function getDirectoryRowLinkedDirectoryMode(
  thread: NavigationThreadSummary,
): "kind" | "label" {
  // A literal "worktree" or "local" chip is useful for a thread with one
  // workspace. Once a thread spans projects, collapsing by kind hides the
  // additional roots (and makes one root stand in for all of them). Reuse the
  // label chips from Updated/Created so every linked project stays visible.
  return thread.linkedDirectories.length > 1 ? "label" : "kind";
}

/**
 * One activity count in a directory header: the indicator alone, then the
 * number. The words ("active", "to review") moved into the tooltip — a
 * directory row is a dense line already carrying a chevron, a folder glyph,
 * an elided path, and a new-thread button, and two trailing phrases pushed
 * the label it belongs to down to a few characters.
 *
 * The scanner and the orange cookie are the same marks the thread rows below
 * use for the same two states, so the header reads as a summary of the rows
 * rather than a second vocabulary. `useViewportTooltip` rather than `title`
 * because the sidebar clips, and because a native tooltip is a
 * browser-default control.
 *
 * The portal node is a sibling of the count, not a child of it. A React
 * portal still propagates events through the React tree, and this count
 * renders inside the directory summary `<button>` — so a tooltip nested here
 * would route its events into that button's onClick. `.viewport-tooltip` sets
 * `pointer-events: none` today, which masks it, but every other call site in
 * the app keeps the node outside the interactive element and a structured
 * hover card (which AGENTS.md contemplates) would not be inert.
 */
function DirectoryCount(props: {
  activeCount?: number;
  className: string;
  count: number;
  indicator: ReactElement;
  reviewCount?: number;
  tooltipText: string;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <>
      <span
        className={props.className}
        data-active-thread-count={props.activeCount}
        data-review-thread-count={props.reviewCount}
        onMouseEnter={(event) =>
          tooltip.show(event.currentTarget, props.tooltipText)
        }
        onMouseLeave={tooltip.hide}
      >
        {props.indicator}
        <span>{props.count}</span>
      </span>
      {tooltip.tooltipNode}
    </>
  );
}

export function DirectoriesList(props: DirectoriesListProps) {
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>({});
  // Per-directory "show all unpinned threads" toggle, keyed by directory.key.
  const [unpinnedExpandedByKey, setUnpinnedExpandedByKey] = useState<
    Record<string, boolean>
  >({});
  const dropIndicator = useDropIndicatorController();
  const [draggedThreadKey, setDraggedThreadKey] = useState<string | undefined>(
    undefined,
  );
  // Sub-thread (child) drag/drop state — kept SEPARATE from the
  // pinned-thread / directory drag state above so a child reorder can
  // never cross-wire with a pin or directory drag. Child drags carry the
  // `application/x-pwragent-subthread` MIME (not `text/plain`), so the
  // top-level drop handlers (which read `text/plain`) ignore them.
  const [draggedSubthreadKey, setDraggedSubthreadKey] = useState<
    string | undefined
  >(undefined);
  const subthreadDropIndicator = useDropIndicatorController();
  // Directory drag/drop state (plan 2026-05-09-002 Unit K). Mirrors
  // the per-thread state above but tracks directory keys rather
  // than thread keys. The `directoriesPinnedDividerDropTarget`
  // boolean toggles the divider's "promote to pinned" affordance
  // when an unpinned directory is dragged over it.
  const [draggedDirectoryKey, setDraggedDirectoryKey] = useState<
    string | undefined
  >(undefined);
  const directoryDropIndicator = useDropIndicatorController();
  const [directoriesPinnedDividerDropTarget, setDirectoriesPinnedDividerDropTarget] =
    useState(false);
  const previousSelectedItemKeyRef = useRef<string | undefined>(undefined);
  const handledRevealRequestRef = useRef(0);
  const threadPinDragSessionRef = useRef<ThreadPinDragSession | undefined>(
    undefined,
  );
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
  // The Directory threads disclosure is also a thread-pin drop target.
  // Suppress the click browsers synthesize immediately after a drop so
  // pinning a thread never also minimizes the section.
  const lastDirectoryThreadDropAtRef = useRef(0);

  const beginThreadPinDrag = (
    event: DragEvent<HTMLDivElement>,
    threadKey: string,
    sourceWasPinned: boolean,
  ): void => {
    threadPinDragSessionRef.current = {
      canceled: false,
      sourceElement: event.currentTarget,
      sourceWasPinned,
      threadKey,
    };
    setDraggedThreadKey(threadKey);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", threadKey);
  };

  const finishThreadPinDrag = (): void => {
    threadPinDragSessionRef.current = undefined;
    setDraggedThreadKey(undefined);
    dropIndicator.clear();
  };

  useEffect(() => {
    const cancelThreadPinDrag = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const session = threadPinDragSessionRef.current;
      if (!session) return;
      session.canceled = true;
      setDraggedThreadKey(undefined);
      dropIndicator.clear();
    };

    window.addEventListener("keydown", cancelThreadPinDrag);
    return () => window.removeEventListener("keydown", cancelThreadPinDrag);
  }, [dropIndicator]);
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
  /**
   * Sub-thread launchpads (`subthread:<source>:<parent>:<mode>`) are transient,
   * thread-scoped composers rendered inline under their parent thread — never a
   * project directory. The main-process snapshot already omits them, but the
   * renderer's launchpad merge synthesizes a `kind: "directory"` summary for the
   * one that's currently open, so filter them here too. Otherwise the open
   * composer shows up as a phantom row duplicating its parent's directory, and
   * (having no threads) it would be offered the "Remove Directory" action — which
   * would delete the overlay row of the sub-thread being composed.
   */
  const visibleDirectories = useMemo(
    () =>
      props.directories.filter(
        (directory) => !isSubthreadLaunchpadKey(directory.key),
      ),
    [props.directories],
  );
  const pinnedDirectories = useMemo(
    () =>
      visibleDirectories
        .filter(isPinnedDirectory)
        .sort(comparePinnedDirectories),
    [visibleDirectories],
  );
  const pinnedDirectoryKeys = useMemo(
    () => pinnedDirectories.map((directory) => directory.key),
    [pinnedDirectories],
  );
  const unpinnedDirectories = useMemo(
    () => visibleDirectories.filter((directory) => !isPinnedDirectory(directory)),
    [visibleDirectories],
  );
  const directorySelectionOrder = useMemo(
    () =>
      [...pinnedDirectories, ...unpinnedDirectories].map(
        (directory) => directory.key,
      ),
    [pinnedDirectories, unpinnedDirectories],
  );
  const directoryByKey = useMemo(
    () => new Map(visibleDirectories.map((directory) => [directory.key, directory])),
    [visibleDirectories],
  );
  const revealSelectedThreadRequest = props.revealSelectedThreadRequest;
  const selectedItemKeyForReveal = props.selectedItemKey;
  const setDirectoryThreadsCollapsed = props.onSetDirectoryThreadsCollapsed;

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

  // Pin order is global across backends, so reorder submits the complete new
  // order of pinned-thread keys (not a per-backend slice).
  const reorderPins = (nextThreadKeys: string[]): void => {
    void props.onReorderThreadPins?.(nextThreadKeys);
  };

  // The directory's pinned thread keys (any backend), in global rank order.
  const buildDirectoryPinnedKeys = (
    directory: NavigationDirectorySummary,
  ): string[] =>
    pinnedThreadKeys.filter((threadKey) =>
      directory.threadKeys.includes(threadKey),
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
    if (!draggedThread || !targetThread) {
      return;
    }

    // Reposition within the full pinned list (cross-backend allowed) and submit
    // the complete new order.
    const sourceKeys = pinnedThreadKeys.includes(draggedKey)
      ? pinnedThreadKeys
      : [...pinnedThreadKeys, draggedKey];
    reorderPins(moveThreadKey(sourceKeys, draggedKey, targetKey, position));
  };

  const dropThreadAfterDirectoryPins = (
    directory: NavigationDirectorySummary,
    draggedKey: string,
  ): void => {
    if (!directory.threadKeys.includes(draggedKey)) return;

    const draggedThread = threadsByKey.get(draggedKey);
    if (!draggedThread) return;

    const directoryPinnedThreadKeys = buildDirectoryPinnedKeys(directory);
    const targetKey =
      directoryPinnedThreadKeys[directoryPinnedThreadKeys.length - 1];

    if (!targetKey) {
      if (pinnedThreadKeys.includes(draggedKey)) return;
      reorderPins([...pinnedThreadKeys, draggedKey]);
      return;
    }

    moveDirectoryPin(directory, draggedKey, targetKey, "after");
  };

  const movePinnedThreadByKeyboard = (
    directory: NavigationDirectorySummary,
    thread: NavigationThreadSummary,
    direction: "up" | "down",
  ): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const directoryPinnedThreadKeys = buildDirectoryPinnedKeys(directory);
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
      previousSelectedItemKeyRef.current = undefined;
      return;
    }
    const matchingDirectory = visibleDirectories.find(
      (directory) =>
        selectedItemKey === buildLaunchpadSelectionKey(directory.key) ||
        directory.threadKeys.includes(selectedItemKey),
    );
    if (!matchingDirectory) {
      return;
    }

    const previousSelectedItemKey = previousSelectedItemKeyRef.current;
    const selectedItemKeyChanged = selectedItemKey !== previousSelectedItemKey;
    previousSelectedItemKeyRef.current = selectedItemKey;

    setExpandedByKey((current) => {
      // Preserve explicit user collapse across unrelated directory
      // snapshot changes, but allow a newly selected item (for
      // example Back/Forward navigation to a hidden thread) to
      // reopen its containing directory for reveal. Only mark a
      // selected key as consumed after a matching directory exists;
      // showThread() can set selection before the refreshed
      // directory snapshot includes the thread.
      if (
        current[matchingDirectory.key] !== undefined &&
        !selectedItemKeyChanged
      ) {
        return current;
      }

      return {
        ...current,
        [matchingDirectory.key]: true,
      };
    });
  }, [visibleDirectories, props.selectedItemKey]);

  useEffect(() => {
    const request = revealSelectedThreadRequest ?? 0;
    const selectedItemKey = selectedItemKeyForReveal;
    if (request <= handledRevealRequestRef.current || !selectedItemKey) {
      return;
    }

    const matchingDirectory = visibleDirectories.find(
      (directory) =>
        selectedItemKey === buildLaunchpadSelectionKey(directory.key) ||
        directory.threadKeys.includes(selectedItemKey),
    );
    if (!matchingDirectory) {
      // showThread() can select before a refreshed navigation snapshot adds
      // the thread to its directory. Leave the request pending until the
      // matching directory exists instead of consuming it as a no-op.
      return;
    }
    handledRevealRequestRef.current = request;
    setExpandedByKey((current) => ({
      ...current,
      [matchingDirectory.key]: true,
    }));

    const selectedThread = threadsByKey.get(selectedItemKey);
    if (!selectedThread) {
      return;
    }

    const directoryThreadKeys = new Set(matchingDirectory.threadKeys);
    let topLevelThread = selectedThread;
    const visited = new Set<string>();
    while (topLevelThread.parentThreadId) {
      const parentKey = resolveThreadParentKey(topLevelThread, threadsByKey);
      if (!parentKey) {
        break;
      }
      if (visited.has(parentKey) || !directoryThreadKeys.has(parentKey)) {
        break;
      }
      visited.add(parentKey);
      const parent = threadsByKey.get(parentKey);
      if (!parent) {
        break;
      }
      topLevelThread = parent;
    }

    if (isPinnedThread(topLevelThread)) {
      return;
    }

    // The selected child is rendered with its top-level ancestor. Reveal that
    // ancestor through both directory-only layers: the sticky pinned/unpinned
    // disclosure and the ten-row overflow cap. ThreadRow scrolls the selected
    // child into view when these state changes mount it.
    if (matchingDirectory.directoryThreadsCollapsed === true) {
      void setDirectoryThreadsCollapsed?.(matchingDirectory, false);
    }

    const topLevelUnpinnedThreads = matchingDirectory.threadKeys
      .map((threadKey) => threadsByKey.get(threadKey))
      .filter((thread): thread is NavigationThreadSummary => Boolean(thread))
      .filter((thread) => {
        if (!thread.parentThreadId) {
          return true;
        }
        const parentKey = resolveThreadParentKey(thread, threadsByKey);
        return !parentKey || !directoryThreadKeys.has(parentKey);
      })
      .filter((thread) => !isPinnedThread(thread));
    const topLevelThreadKey = buildThreadIdentityKey(
      topLevelThread.source,
      topLevelThread.id,
    );
    if (
      topLevelUnpinnedThreads.findIndex(
        (thread) =>
          buildThreadIdentityKey(thread.source, thread.id) ===
          topLevelThreadKey,
      ) >= DIRECTORY_UNPINNED_THREAD_CAP
    ) {
      setUnpinnedExpandedByKey((current) => ({
        ...current,
        [matchingDirectory.key]: true,
      }));
    }
  }, [
    revealSelectedThreadRequest,
    selectedItemKeyForReveal,
    setDirectoryThreadsCollapsed,
    threadsByKey,
    visibleDirectories,
  ]);

  if (visibleDirectories.length === 0) {
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
    const selectedLaunchpad =
      props.selectedItemKey === buildLaunchpadSelectionKey(directory.key);
    const selectedDirectory = selectedLaunchpad || Boolean(
      props.selectedDirectoryKeys?.has(directory.key),
    );
    const selectedThreadInDirectory = directory.threadKeys.includes(
      props.selectedItemKey ?? ""
    );
    const expanded =
      expandedByKey[directory.key] ??
      (selectedLaunchpad || selectedThreadInDirectory);
    const threadModel = buildDirectoryThreadRenderModel({
      directory,
      expanded,
      selectedItemKey: props.selectedItemKey,
      thinkingThreadKeys: props.thinkingThreadKeys,
      threadsByKey,
      unpinnedExpanded: unpinnedExpandedByKey[directory.key],
    });
    const {
      activeThreadCount,
      reviewThreadCount,
      visibleThreadCount,
    } = threadModel;
    const directorySummaryLabel = [
      directory.label,
      activeThreadCount > 0 ? formatActiveThreadCount(activeThreadCount) : undefined,
      reviewThreadCount > 0 ? formatReviewThreadCount(reviewThreadCount) : undefined,
    ]
      .filter((label): label is string => Boolean(label))
      .join(", ");
    const expandedThreadModel =
      threadModel.expanded ?? EMPTY_EXPANDED_DIRECTORY_THREAD_MODEL;
    const { childThreadsByParentKey } = expandedThreadModel;
    const renderStaticSubthreads = (parent: NavigationThreadSummary): ReactElement | null => {
      const parentKey = buildThreadIdentityKey(parent.source, parent.id);
      const children = sortSubthreadSummaries(parent, childThreadsByParentKey.get(parentKey) ?? []);
      const nativeSubAgentCount = parent.codexNativeSubAgents?.length ?? 0;
      const subthreadsCollapsed = isSubthreadSectionCollapsed(parent);
      if (
        (children.length === 0 && nativeSubAgentCount === 0)
        || subthreadsCollapsed
      ) {
        return null;
      }
      // The child tray is a user-ordered "pinned" section (subthreadOrder).
      // Wire drag-to-reorder, mirroring RecentsList — see the dedicated
      // `draggedSubthreadKey` state for why it stays isolated from the
      // directory / pinned-thread drag.
      const childOrderKeys = children.map((child) =>
        buildThreadIdentityKey(child.source, child.id),
      );
      const reorderable =
        children.length > 1 && Boolean(props.onUpdateSubthreadOrder);
      return (
        <div className="subthread-list subthread-list--compact" role="list" aria-label={`Sub-threads of ${parent.title}`}>
          {children.map((child) => {
            const childKey = buildThreadIdentityKey(child.source, child.id);
            const rowDropKey = `subthread:${parentKey}:${childKey}`;
            return (
            <ThreadRow
              key={`${directory.key}:${childKey}`}
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              terminalThreadKeys={props.terminalThreadKeys}
              inputRequestThreadKeys={props.inputRequestThreadKeys}
              queuedMessageThreadKeys={props.queuedMessageThreadKeys}
              draftThreadKeys={props.draftThreadKeys}
              composerSourceThreadKey={props.composerSourceThreadKey}
              compact
              draggable={reorderable}
              includeLinkedDirectories
              linkedDirectoryMode={getDirectoryRowLinkedDirectoryMode(child)}
              nested
              revealSelectedThreadRequest={props.revealSelectedThreadRequest}
              selectedThreadKey={props.selectedItemKey}
              selectedThreadKeys={props.selectedThreadKeys}
              thinkingThreadKeys={props.thinkingThreadKeys}
              thread={child}
              onDragStartThread={(event) => {
                setDraggedSubthreadKey(childKey);
                event.dataTransfer.effectAllowed = "move";
                // Subthread-only MIME — top-level drop handlers read
                // `text/plain` and so ignore a child reorder drag.
                event.dataTransfer.setData(
                  "application/x-pwragent-subthread",
                  childKey,
                );
              }}
              onDragOverThread={(event) => {
                event.preventDefault();
                const draggedThread = draggedSubthreadKey
                  ? threadsByKey.get(draggedSubthreadKey)
                  : undefined;
                if (
                  !draggedThread
                  || draggedSubthreadKey === childKey
                  || resolveThreadParentKey(draggedThread, threadsByKey) !== parentKey
                ) {
                  event.dataTransfer.dropEffect = "none";
                  subthreadDropIndicator.clear();
                  return;
                }
                event.dataTransfer.dropEffect = "move";
                subthreadDropIndicator.show(event.currentTarget, {
                  targetKey: rowDropKey,
                  position: getDropIndicatorPosition(event),
                });
              }}
              onDragLeaveThread={(event) => {
                if (didDragLeaveCurrentTarget(event)) {
                  subthreadDropIndicator.clear();
                }
              }}
              onDragEndThread={() => {
                setDraggedSubthreadKey(undefined);
                subthreadDropIndicator.clear();
              }}
              onDropOnThread={(event) => {
                event.preventDefault();
                setDraggedSubthreadKey(undefined);
                subthreadDropIndicator.clear();
                const draggedKey = event.dataTransfer.getData(
                  "application/x-pwragent-subthread",
                );
                const draggedThread = draggedKey
                  ? threadsByKey.get(draggedKey)
                  : undefined;
                if (
                  !draggedThread
                  || resolveThreadParentKey(draggedThread, threadsByKey) !== parentKey
                ) {
                  return;
                }
                const nextKeys = moveThreadKey(
                  childOrderKeys,
                  draggedKey,
                  childKey,
                  getDropIndicatorPosition(event),
                );
                void props.onUpdateSubthreadOrder?.(
                  parent,
                  nextKeys
                    .map((key) => parseThreadIdentityKey(key)?.threadId)
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
            <NativeSubAgentsDisclosure compact thread={parent} />
          ) : null}
        </div>
      );
    };
    const {
      cappedUnpinnedThreads,
      directoryPinnedThreads,
      directoryThreadsCollapsed,
      directoryUnpinnedThreadCount,
      hiddenUnpinnedCount,
      overflowUnpinnedThreads,
      selectionOrder,
      unpinnedExpanded,
    } = expandedThreadModel;
    const showPinnedAppendTarget = Boolean(
      props.onReorderThreadPins
      && draggedThreadKey
      && directory.threadKeys.includes(draggedThreadKey)
    );
    // Render one unpinned thread row. Shared by the always-shown capped
    // slice and the overflow slice so the "Show more / Show less" toggle
    // sits at a fixed pivot between them — collapsing never makes the
    // user scroll to the bottom of an expanded directory to find it.
    const renderUnpinnedRow = (
      thread: NavigationThreadSummary,
    ): ReactElement => {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const ordinarySubthreadCount =
        childThreadsByParentKey.get(threadKey)?.length ?? 0;
      const subthreadCount = getSubthreadDisclosureCount(
        thread,
        ordinarySubthreadCount,
      );
      const subthreadsCollapsed = isSubthreadSectionCollapsed(thread);
      return (
        <Fragment key={`${directory.key}:${threadKey}`}>
          <ThreadRow
            key={`${directory.key}:${threadKey}`}
            approvalRequestThreadKeys={props.approvalRequestThreadKeys}
            terminalThreadKeys={props.terminalThreadKeys}
            inputRequestThreadKeys={props.inputRequestThreadKeys}
            queuedMessageThreadKeys={props.queuedMessageThreadKeys}
            draftThreadKeys={props.draftThreadKeys}
            composerSourceThreadKey={props.composerSourceThreadKey}
            compact
            draggable={Boolean(props.onReorderThreadPins)}
            includeLinkedDirectories
            linkedDirectoryMode={getDirectoryRowLinkedDirectoryMode(thread)}
            revealSelectedThreadRequest={props.revealSelectedThreadRequest}
            selectedThreadKey={props.selectedItemKey}
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
            onDragStartThread={(event) => {
              beginThreadPinDrag(event, threadKey, false);
            }}
            onDragEndThread={finishThreadPinDrag}
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
          {renderStaticSubthreads(thread)}
        </Fragment>
      );
    };

    return (
      <section
        key={directory.key}
        className="directory-row"
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
                directoryDropIndicator.show(event.currentTarget, {
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
                  directoryDropIndicator.clear();
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
                directoryDropIndicator.clear();
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
                  directoryDropIndicator.clear();
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
            aria-label={directorySummaryLabel}
            aria-expanded={expanded}
            aria-pressed={selectedDirectory}
            className={`thread-row thread-row--compact directory-row__summary${
              selectedDirectory ? " is-selected" : ""
            }`}
            type="button"
            onClick={(event) => {
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
              props.onSelectDirectory?.(
                directory,
                event,
                directorySelectionOrder,
              );
              if (event.metaKey || event.shiftKey) {
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
              <span
                aria-hidden="true"
                className={`directory-row__chevron${expanded ? " is-open" : ""}`}
              />
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
              {activeThreadCount > 0 ? (
                <DirectoryCount
                  activeCount={activeThreadCount}
                  className="directory-row__active-count"
                  count={activeThreadCount}
                  indicator={<ThinkingScanner compact />}
                  tooltipText={formatActiveThreadCount(activeThreadCount)}
                />
              ) : null}
              {reviewThreadCount > 0 ? (
                <DirectoryCount
                  className="directory-row__review-count"
                  count={reviewThreadCount}
                  indicator={
                    <span aria-hidden="true" className="thread-row__status-cookie" />
                  }
                  reviewCount={reviewThreadCount}
                  tooltipText={formatReviewThreadCount(reviewThreadCount)}
                />
              ) : null}
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
                {visibleThreadCount > 0 ? (
                  <div className="sidebar-list sidebar-list--compact directory-row__threads">
                    {directoryPinnedThreads.map((thread) => {
	                      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
	                      const rowDropKey = `${directory.key}:${threadKey}`;
                          const ordinarySubthreadCount =
                            childThreadsByParentKey.get(threadKey)?.length ?? 0;
                          const subthreadCount = getSubthreadDisclosureCount(
                            thread,
                            ordinarySubthreadCount,
                          );
                          const subthreadsCollapsed = isSubthreadSectionCollapsed(thread);
	                      return (
                            <Fragment key={`${directory.key}:${threadKey}`}>
	                        <ThreadRow
	                          key={`${directory.key}:${threadKey}`}
                          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                          terminalThreadKeys={props.terminalThreadKeys}
                          inputRequestThreadKeys={props.inputRequestThreadKeys}
                          queuedMessageThreadKeys={props.queuedMessageThreadKeys}
                          draftThreadKeys={props.draftThreadKeys}
                          composerSourceThreadKey={props.composerSourceThreadKey}
                          compact
                          draggable={Boolean(props.onReorderThreadPins)}
                          includeLinkedDirectories
                          linkedDirectoryMode={getDirectoryRowLinkedDirectoryMode(thread)}
                          revealSelectedThreadRequest={
                            props.revealSelectedThreadRequest
                          }
	                          selectedThreadKey={props.selectedItemKey}
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
                          onDragOverThread={(event) => {
                            const draggedThread = draggedThreadKey
                              ? threadsByKey.get(draggedThreadKey)
                              : undefined;
                            const session = threadPinDragSessionRef.current;
                            if (
                              !draggedThreadKey ||
                              !draggedThread ||
                              !session ||
                              session.canceled ||
                              !session.sourceWasPinned ||
                              draggedThreadKey === threadKey ||
                              !directory.threadKeys.includes(draggedThreadKey)
                            ) {
                              event.dataTransfer.dropEffect = "none";
                              dropIndicator.clear();
                              return;
                            }

                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            dropIndicator.show(event.currentTarget, {
                              targetKey: rowDropKey,
                              position: getDropIndicatorPosition(event),
                            });
                          }}
                          onDragStartThread={(event) => {
                            beginThreadPinDrag(event, threadKey, true);
                          }}
                          onDragLeaveThread={(event) => {
                            if (didDragLeaveCurrentTarget(event)) {
                              dropIndicator.clear();
                            }
                          }}
                          onDragEndThread={finishThreadPinDrag}
                          onDropOnThread={(event) => {
                            event.preventDefault();
                            const draggedKey = event.dataTransfer.getData("text/plain");
                            const session = threadPinDragSessionRef.current;
                            const canceled =
                              !session
                              || session.canceled
                              || !session.sourceWasPinned
                              || session.threadKey !== draggedKey;
                            finishThreadPinDrag();
                            if (canceled || !draggedKey) return;
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
                          onOpenPullRequestContextMenu={props.onOpenPullRequestContextMenu}
                          onDetachPullRequest={props.onDetachPullRequest}
                          onPrefetchPullRequests={props.onPrefetchPullRequests}
                          onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
                          onRevealSelectedThreadComplete={
                            props.onRevealSelectedThreadComplete
                          }
                          onSelectThread={(target, event) =>
                            props.onSelectThread(target, event, selectionOrder)
                          }
                          onSetReaction={props.onSetReaction}
                          onSetThreadPin={props.onSetThreadPin}
	                          onUnbindMessagingBinding={props.onUnbindMessagingBinding}
	                        />
                              {renderStaticSubthreads(thread)}
                            </Fragment>
	                      );
                    })}

                    {showPinnedAppendTarget ? (
                      <div className="directory-row__pin-drop-boundary">
                        <div
                          aria-label={`Pin thread after pinned threads for ${directory.label}`}
                          className="directory-row__pin-drop-slot"
                          role="separator"
                          onDragOver={(event) => {
                            const session = threadPinDragSessionRef.current;
                            if (
                              !draggedThreadKey
                              || !session
                              || session.canceled
                              || session.threadKey !== draggedThreadKey
                              || !directory.threadKeys.includes(draggedThreadKey)
                              || isPointInsideDragSource(session, {
                                x: event.clientX,
                                y: event.clientY,
                              })
                            ) {
                              event.dataTransfer.dropEffect = "none";
                              dropIndicator.clear();
                              return;
                            }

                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            dropIndicator.show(event.currentTarget, {
                              targetKey: `pinned-append:${directory.key}`,
                              position: "before",
                            });
                          }}
                          onDragLeave={(event) => {
                            if (didDragLeaveCurrentTarget(event)) {
                              dropIndicator.clear();
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const session = threadPinDragSessionRef.current;
                            const draggedKey = event.dataTransfer.getData("text/plain");
                            const canceled =
                              !session
                              || session.canceled
                              || session.threadKey !== draggedKey
                              || isPointInsideDragSource(session, {
                                x: event.clientX,
                                y: event.clientY,
                              });
                            lastDirectoryThreadDropAtRef.current = Date.now();
                            finishThreadPinDrag();
                            if (canceled) return;
                            dropThreadAfterDirectoryPins(directory, draggedKey);
                          }}
                        />
                      </div>
                    ) : null}

                    {directoryPinnedThreads.length > 0 &&
                    directoryUnpinnedThreadCount > 0 ? (
                      <button
                        type="button"
                        className="recents-pinned-divider directory-row__thread-divider"
                        aria-expanded={!directoryThreadsCollapsed}
                        aria-label={`${
                          directoryThreadsCollapsed ? "Show" : "Hide"
                        } directory threads for ${directory.label}`}
                        disabled={!props.onSetDirectoryThreadsCollapsed}
                        onClick={() => {
                          if (
                            Date.now() - lastDirectoryThreadDropAtRef.current <
                            POST_DRAG_CLICK_SUPPRESS_MS
                          ) {
                            return;
                          }
                          void props.onSetDirectoryThreadsCollapsed?.(
                            directory,
                            !directoryThreadsCollapsed,
                          );
                        }}
                      >
                        <span className="directory-row__thread-divider-label">
                          <span
                            aria-hidden="true"
                            className={`directory-row__thread-divider-chevron${
                              directoryThreadsCollapsed ? "" : " is-open"
                            }`}
                          />
                          <span>Directory threads</span>
                          {directoryThreadsCollapsed ? (
                            <span className="directory-row__thread-divider-count">
                              {directoryUnpinnedThreadCount}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ) : null}

                    {directoryThreadsCollapsed
                      ? null
                      : cappedUnpinnedThreads.map(renderUnpinnedRow)}
                    {!directoryThreadsCollapsed && hiddenUnpinnedCount > 0 ? (
                      <button
                        type="button"
                        className="directory-row__show-more"
                        aria-expanded={unpinnedExpanded}
                        onClick={() =>
                          setUnpinnedExpandedByKey((prev) => ({
                            ...prev,
                            [directory.key]: !unpinnedExpanded,
                          }))
                        }
                      >
                        {unpinnedExpanded
                          ? "Show less"
                          : `Show ${hiddenUnpinnedCount} more`}
                      </button>
                    ) : null}
                    {!directoryThreadsCollapsed && unpinnedExpanded
                      ? overflowUnpinnedThreads.map(renderUnpinnedRow)
                      : null}
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
            directoryDropIndicator.clear();
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
