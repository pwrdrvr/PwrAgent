import {
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  AppServerBackendKind,
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import {
  comparePinnedDirectories,
  comparePinnedThreads,
  isPinnedDirectory,
  isPinnedThread,
  isSubthreadLaunchpadKey,
  moveDirectoryKey,
  moveThreadKey,
  resolveThreadParentKey,
  sortSubthreadSummaries,
} from "@pwragent/shared";
import {
  ChevronDownIcon,
  NewThreadIcon,
  UnlinkedDotIcon,
} from "../../icons";
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
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  beginNativeDragInteraction,
  endNativeDragInteraction,
} from "../../lib/native-drag-interaction";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";
import {
  SignalCount,
  type SignalCountTone,
} from "../../components/SignalCount";
import {
  getSubthreadDisclosureCount,
  isSubthreadSectionCollapsed,
  NativeSubAgentsDisclosure,
} from "./NativeSubAgentsDisclosure";
import { ThreadRow } from "./ThreadRow";
import {
  createThreadRowPointerDragPreview,
  type ThreadRowPointerDragPreview,
} from "./thread-row-drag-preview";
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
  /**
   * Opens the "New chat on <machine>" menu for this row's launchpad button.
   * Absent when the federation has no peers to offer, which is what keeps the
   * split-button chevron from rendering on a single-instance install.
   */
  onOpenFederationTargetMenu?: (
    directory: NavigationDirectorySummary,
    position: { x: number; y: number; anchorTop?: number },
  ) => void;
  /** Directory key whose federation target menu is currently open, if any. */
  openFederationTargetMenuDirectoryKey?: string;
  onRevealSelectedThreadComplete?: (request: number) => void;
  onSelectThread: (
    thread: NavigationThreadSummary,
    event: MouseEvent<HTMLElement>,
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
const POINTER_DRAG_ACTIVATION_PX = 4;

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
  directory: Pick<NavigationDirectorySummary, "kind" | "localAvailability">,
): boolean {
  return directory.localAvailability !== "unconfigured"
    && (directory.kind === "directory" || directory.kind === "workspace");
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
  activated: boolean;
  appendTargetElement?: HTMLDivElement;
  canceled: boolean;
  directory: NavigationDirectorySummary;
  directoryElement: HTMLElement;
  frame: number;
  lastPoint: { x: number; y: number };
  pointerId: number;
  preview?: ThreadRowPointerDragPreview;
  releaseClickSuppression?: () => void;
  removeListeners?: () => void;
  scrollElement?: HTMLElement;
  sourceElement: HTMLDivElement;
  sourceWasPinned: boolean;
  target?: ThreadPinPointerDropTarget;
  threadKey: string;
};

type ThreadPinPointerDropTarget =
  | {
      element: HTMLDivElement;
      kind: "append";
    }
  | {
      element: HTMLDivElement;
      kind: "row";
      position: "before" | "after";
      threadKey: string;
    };

function setThreadPinAppendTargetActive(
  session: ThreadPinDragSession,
  active: boolean,
): void {
  session.appendTargetElement?.classList.toggle("is-drag-enabled", active);
  if (active) {
    session.appendTargetElement?.removeAttribute("aria-hidden");
  } else {
    session.appendTargetElement?.setAttribute("aria-hidden", "true");
  }
}

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

function getPointInsideElement(
  element: Element,
  point: { x: number; y: number },
): boolean {
  const bounds = element.getBoundingClientRect();
  return (
    bounds.right > bounds.left
    && bounds.bottom > bounds.top
    && point.x >= bounds.left
    && point.x <= bounds.right
    && point.y >= bounds.top
    && point.y <= bounds.bottom
  );
}

function resolveThreadPinPointerDropTarget(
  session: ThreadPinDragSession,
): ThreadPinPointerDropTarget | undefined {
  if (
    session.canceled
    || isPointInsideDragSource(session, session.lastPoint)
  ) {
    return undefined;
  }

  if (!session.sourceWasPinned) {
    return session.appendTargetElement
      ? { element: session.appendTargetElement, kind: "append" }
      : undefined;
  }

  const buildRowTarget = (
    row: HTMLDivElement,
  ): ThreadPinPointerDropTarget | undefined => {
    const threadKey = row.dataset.threadPinKey;
    if (
      row === session.sourceElement
      || !threadKey
      || threadKey === session.threadKey
    ) {
      return undefined;
    }
    const bounds = row.getBoundingClientRect();
    return {
      element: row,
      kind: "row",
      position:
        session.lastPoint.y > bounds.top + bounds.height / 2
          ? "after"
          : "before",
      threadKey,
    };
  };

  if (typeof document.elementFromPoint === "function") {
    const hit = document.elementFromPoint(
      session.lastPoint.x,
      session.lastPoint.y,
    );
    const hitRow = hit?.closest<HTMLDivElement>(
      '.thread-row-shell[data-thread-pin-state="pinned"]',
    );
    if (
      hitRow
      && session.directoryElement.contains(hitRow)
    ) {
      return buildRowTarget(hitRow);
    }
    if (
      hit
      && session.appendTargetElement?.contains(hit)
    ) {
      return { element: session.appendTargetElement, kind: "append" };
    }
    return undefined;
  }

  const pinnedRows = session.directoryElement.querySelectorAll<HTMLDivElement>(
    '.thread-row-shell[data-thread-pin-state="pinned"]',
  );
  for (const row of pinnedRows) {
    if (
      !getPointInsideElement(row, session.lastPoint)
    ) {
      continue;
    }
    const target = buildRowTarget(row);
    if (target) return target;
  }

  if (
    session.appendTargetElement
    && getPointInsideElement(session.appendTargetElement, session.lastPoint)
  ) {
    return { element: session.appendTargetElement, kind: "append" };
  }
  return undefined;
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
 * One activity count in a directory header.
 *
 * `SignalCount`'s shape, which is the Attention tab's shape directly above
 * it: the mark, then the digits. The words ("active", "to review") live in
 * the tooltip — a directory row is a dense line already carrying a chevron,
 * a folder glyph, an elided path, and a new-thread button, and two trailing
 * phrases pushed the label they belong to down to a few characters.
 *
 * This read count-then-mark until the rail and the tab were two renderings
 * of one idea. That order existed to hold the mark at a constant x down the
 * right-aligned rail; the flip keeps that with a fixed two-digit box on the
 * digits instead (`.directory-row__summary-meta .signal-count__value`), so
 * a 1-digit row and a 2-digit row still line their marks up.
 *
 * Not `aria-hidden`, unlike the tab's readouts: the tab spells every count
 * out in its control's `aria-label`, and here the digits ARE the
 * announcement, with the tooltip text as the description.
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
  tone: SignalCountTone;
  tooltipText: string;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <>
      <SignalCount
        className={props.className}
        count={props.count}
        data={{
          "data-active-thread-count": props.activeCount,
          "data-review-thread-count": props.reviewCount,
        }}
        indicator={props.indicator}
        tone={props.tone}
        onMouseEnter={(event) =>
          tooltip.show(event.currentTarget, props.tooltipText)
        }
        onMouseLeave={tooltip.hide}
      />
      {tooltip.tooltipNode}
    </>
  );
}

export function DirectoriesList(props: DirectoriesListProps) {
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>({});
  const unavailableDirectoryTooltip = useViewportTooltip({
    className: "viewport-tooltip",
  });
  // Per-directory "show all unpinned threads" toggle, keyed by directory.key.
  const [unpinnedExpandedByKey, setUnpinnedExpandedByKey] = useState<
    Record<string, boolean>
  >({});
  const dropIndicator = useDropIndicatorController();
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
  const threadPinDragCleanupRef = useRef<(() => void) | undefined>(undefined);
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

  const deactivateThreadPinDrag = (session: ThreadPinDragSession): void => {
    if (session.frame) {
      cancelAnimationFrame(session.frame);
      session.frame = 0;
    }
    session.preview?.remove();
    session.preview = undefined;
    session.sourceElement.classList.remove("is-pointer-dragging");
    setThreadPinAppendTargetActive(session, false);
    dropIndicator.clear();
    session.target = undefined;
    if (session.activated) {
      endNativeDragInteraction();
      session.activated = false;
    }
  };

  const finishThreadPinDrag = (session: ThreadPinDragSession): void => {
    deactivateThreadPinDrag(session);
    session.removeListeners?.();
    session.removeListeners = undefined;
    session.releaseClickSuppression?.();
    session.releaseClickSuppression = undefined;
    if (threadPinDragSessionRef.current === session) {
      threadPinDragSessionRef.current = undefined;
    }
    if (threadPinDragCleanupRef.current) {
      threadPinDragCleanupRef.current = undefined;
    }
  };

  const updateThreadPinPointerTarget = (
    session: ThreadPinDragSession,
  ): void => {
    session.preview?.move(session.lastPoint);
    session.target = resolveThreadPinPointerDropTarget(session);
    if (!session.target) {
      dropIndicator.clear();
      return;
    }
    dropIndicator.show(session.target.element, {
      targetKey:
        session.target.kind === "row"
          ? `${session.directory.key}:${session.target.threadKey}`
          : `pinned-append:${session.directory.key}`,
      position:
        session.target.kind === "row" ? session.target.position : "before",
    });
  };

  const scheduleThreadPinPointerTarget = (
    session: ThreadPinDragSession,
  ): void => {
    if (session.frame || !session.activated || session.canceled) return;
    session.frame = requestAnimationFrame(() => {
      session.frame = 0;
      updateThreadPinPointerTarget(session);
    });
  };

  /**
   * Thread pinning deliberately avoids native HTML drag-and-drop. Chromium's
   * drag processing model suppresses ordinary input events, and its macOS
   * trackpad path can queue momentum at scroll boundaries for seconds. A
   * pointer session leaves wheel scrolling browser-controlled while batching
   * our preview and hit testing to one update per animation frame.
   */
  const beginThreadPinPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    directory: NavigationDirectorySummary,
    threadKey: string,
    sourceWasPinned: boolean,
  ): void => {
    if (event.button !== 0 || !props.onReorderThreadPins) return;
    threadPinDragCleanupRef.current?.();

    const sourceElement = event.currentTarget;
    const directoryElement = sourceElement.closest(".directory-row");
    if (!(directoryElement instanceof HTMLElement)) return;

    const startPoint = { x: event.clientX, y: event.clientY };
    const session: ThreadPinDragSession = {
      activated: false,
      appendTargetElement:
        directoryElement.querySelector<HTMLDivElement>(
          ".directory-row__pin-drop-slot",
        ) ?? undefined,
      canceled: false,
      directory,
      directoryElement,
      frame: 0,
      lastPoint: startPoint,
      pointerId: event.pointerId,
      scrollElement:
        sourceElement.closest<HTMLElement>(".directory-list") ?? undefined,
      sourceElement,
      sourceWasPinned,
      threadKey,
    };
    threadPinDragSessionRef.current = session;

    let suppressClickTimer: number | undefined;
    const removeClickSuppression = (): void => {
      session.directoryElement.removeEventListener(
        "click",
        suppressReleaseClick,
        true,
      );
      if (suppressClickTimer !== undefined) {
        window.clearTimeout(suppressClickTimer);
        suppressClickTimer = undefined;
      }
    };
    const suppressReleaseClick = (clickEvent: globalThis.MouseEvent): void => {
      clickEvent.preventDefault();
      clickEvent.stopImmediatePropagation();
      removeClickSuppression();
    };
    const armClickSuppression = (): void => {
      session.directoryElement.addEventListener(
        "click",
        suppressReleaseClick,
        true,
      );
      session.releaseClickSuppression = () => {
        suppressClickTimer = window.setTimeout(
          removeClickSuppression,
          POST_DRAG_CLICK_SUPPRESS_MS,
        );
      };
    };

    const activate = (): void => {
      if (session.activated || session.canceled) return;
      session.activated = true;
      beginNativeDragInteraction();
      session.sourceElement.classList.add("is-pointer-dragging");
      setThreadPinAppendTargetActive(session, true);
      session.preview = createThreadRowPointerDragPreview(
        session.sourceElement,
        startPoint,
      );
      armClickSuppression();
      session.scrollElement?.addEventListener("scroll", onScroll, {
        passive: true,
      });
      scheduleThreadPinPointerTarget(session);
    };
    const move = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId !== session.pointerId || session.canceled) {
        return;
      }
      session.lastPoint = {
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      };
      if (
        !session.activated
        && Math.hypot(
          session.lastPoint.x - startPoint.x,
          session.lastPoint.y - startPoint.y,
        ) < POINTER_DRAG_ACTIVATION_PX
      ) {
        return;
      }
      activate();
      pointerEvent.preventDefault();
      scheduleThreadPinPointerTarget(session);
    };
    const onScroll = (): void => scheduleThreadPinPointerTarget(session);
    const stop = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId !== session.pointerId) return;
      session.lastPoint = {
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      };
      if (session.activated && !session.canceled) {
        if (session.frame) {
          cancelAnimationFrame(session.frame);
          session.frame = 0;
        }
        updateThreadPinPointerTarget(session);
      }
      const target = session.target;
      const wasActivated = session.activated;
      finishThreadPinDrag(session);
      if (!target || session.canceled || !wasActivated) return;

      lastDirectoryThreadDropAtRef.current = Date.now();
      if (target.kind === "append") {
        dropThreadAfterDirectoryPins(session.directory, session.threadKey);
        return;
      }
      if (session.sourceWasPinned) {
        moveDirectoryPin(
          session.directory,
          session.threadKey,
          target.threadKey,
          target.position,
        );
      }
    };
    const cancel = (): void => {
      session.canceled = true;
      finishThreadPinDrag(session);
    };
    const cancelOnPointer = (pointerEvent: globalThis.PointerEvent): void => {
      if (pointerEvent.pointerId === session.pointerId) cancel();
    };
    const cancelOnEscape = (keyboardEvent: globalThis.KeyboardEvent): void => {
      if (keyboardEvent.key !== "Escape") return;
      session.canceled = true;
      deactivateThreadPinDrag(session);
    };
    const removeListeners = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", cancelOnPointer);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", cancelOnEscape);
      session.scrollElement?.removeEventListener("scroll", onScroll);
    };
    session.removeListeners = removeListeners;
    threadPinDragCleanupRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", cancelOnPointer);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", cancelOnEscape);
  };

  useEffect(
    () => () => threadPinDragCleanupRef.current?.(),
    [],
  );
  const threadsByKey = useMemo(
    () =>
      new Map(
        props.threads.map((thread) => [
          threadSummaryIdentityKey(thread),
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
        threadSummaryIdentityKey(thread),
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
    const threadKey = threadSummaryIdentityKey(thread);
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
    const topLevelThreadKey = threadSummaryIdentityKey(topLevelThread);
    if (
      topLevelUnpinnedThreads.findIndex(
        (thread) => threadSummaryIdentityKey(thread) === topLevelThreadKey,
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
    const directoryUnconfigured =
      directory.localAvailability === "unconfigured";
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
      directoryUnconfigured ? "not configured on this instance" : undefined,
      activeThreadCount > 0 ? formatActiveThreadCount(activeThreadCount) : undefined,
      reviewThreadCount > 0 ? formatReviewThreadCount(reviewThreadCount) : undefined,
    ]
      .filter((label): label is string => Boolean(label))
      .join(", ");
    const expandedThreadModel =
      threadModel.expanded ?? EMPTY_EXPANDED_DIRECTORY_THREAD_MODEL;
    const { childThreadsByParentKey } = expandedThreadModel;
    const renderStaticSubthreads = (parent: NavigationThreadSummary): ReactElement | null => {
      const parentKey = threadSummaryIdentityKey(parent);
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
        threadSummaryIdentityKey(child),
      );
      const reorderable =
        threadSupportsFederationCapability(parent, "thread_grouping")
        && children.length > 1
        && Boolean(props.onUpdateSubthreadOrder);
      return (
        // `listitem` box because this list is a SIBLING of its parent row
        // rather than a child of it: `renderStaticSubthreads` is called from a
        // Fragment beside <ThreadRow/>, which renders no DOM node, so the
        // sublist lands directly inside `.directory-row__threads`. A bare
        // `role="list"` there fails `aria-required-children` — list owns only
        // listitem. This is the `<li><ul>...</ul></li>` shape.
        <div className="directory-row__threads-slot" role="listitem">
          <div className="subthread-list subthread-list--compact" role="list" aria-label={`Sub-threads of ${parent.title}`}>
            {/* The parent's own workers lead its tray. Trailing them after every
                child read as the last child's workers and buried them under a
                long child list. */}
            {nativeSubAgentCount > 0 ? (
              <NativeSubAgentsDisclosure compact thread={parent} />
            ) : null}
            {children.flatMap((child) => {
              const childKey = threadSummaryIdentityKey(child);
              const rowDropKey = `subthread:${parentKey}:${childKey}`;
              // A row plus its own worker group, as siblings of this list. A
              // wrapping element would break the tray's flat list semantics.
              return [
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
                      .map((key) => threadsByKey.get(key)?.id)
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
                  key={`${directory.key}:${childKey}:subagents`}
                  compact
                  nested
                  thread={child}
                />
              ) : null,
              ];
            })}
          </div>
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
    const renderPinnedAppendTarget = Boolean(
      props.onReorderThreadPins
      && directoryUnpinnedThreadCount > 0
    );
    // Render one unpinned thread row. Shared by the always-shown capped
    // slice and the overflow slice so the "Show more / Show less" toggle
    // sits at a fixed pivot between them — collapsing never makes the
    // user scroll to the bottom of an expanded directory to find it.
    const renderUnpinnedRow = (
      thread: NavigationThreadSummary,
    ): ReactElement => {
      const threadKey = threadSummaryIdentityKey(thread);
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
            pointerDraggable={Boolean(props.onReorderThreadPins)}
            includeLinkedDirectories
            linkedDirectoryMode={getDirectoryRowLinkedDirectoryMode(thread)}
            revealSelectedThreadRequest={props.revealSelectedThreadRequest}
            selectedThreadKey={props.selectedItemKey}
            selectedThreadKeys={props.selectedThreadKeys}
            subthreadCount={subthreadCount}
            subthreadsCollapsed={subthreadsCollapsed}
            thinkingThreadKeys={props.thinkingThreadKeys}
            thread={thread}
            threadPinState="unpinned"
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
            onPointerDownThread={(event) => {
              beginThreadPinPointerDrag(event, directory, threadKey, false);
            }}
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
        data-hover-stable-row="directory"
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
          // The modifier classes mirror booleans this render already
          // computes, so the CSS that swaps the count block for the
          // launchpad cluster can match plain classes instead of
          // re-running :has() subtree scans on every header hover —
          // and `--with-launchpad` scopes the hover fade so an
          // unconfigured directory (which renders no cluster) never
          // blanks its counts with nothing in their place.
          className={`directory-row__header${
            directoryUnconfigured ? "" : " directory-row__header--with-launchpad"
          }${
            props.onOpenFederationTargetMenu
              ? " directory-row__header--split"
              : ""
          }${
            !directoryUnconfigured && hasPendingLaunchpadState(directory)
              ? " directory-row__header--has-draft"
              : ""
          }`}
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
            }${
              directoryUnconfigured ? " directory-row__summary--unconfigured" : ""
            }`}
            type="button"
            onBlur={directoryUnconfigured ? unavailableDirectoryTooltip.hide : undefined}
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
            onFocus={
              directoryUnconfigured
                ? (event) => unavailableDirectoryTooltip.show(
                    event.currentTarget,
                    "This project directory isn't configured on this instance. Use Add Directory to connect it.",
                  )
                : undefined
            }
            onMouseEnter={
              directoryUnconfigured
                ? (event) => unavailableDirectoryTooltip.show(
                    event.currentTarget,
                    "This project directory isn't configured on this instance. Use Add Directory to connect it.",
                  )
                : undefined
            }
            onMouseLeave={
              directoryUnconfigured ? unavailableDirectoryTooltip.hide : undefined
            }
          >
            <span className="directory-row__summary-main">
              <span
                aria-hidden="true"
                className={`directory-row__chevron${expanded ? " is-open" : ""}`}
              />
              {/* Icon only where it distinguishes: a glyph on EVERY row
                  carried no information (2026-08 density pass dropped the
                  folder icon; the transcript-gaps pass dropped the
                  workspace icon too — one Workspaces row with a mark read
                  as an inconsistency, not a signal). Only the synthetic
                  unlinked catch-all keeps its dot, because that row is not
                  a real directory at all. */}
              {directory.kind === "unlinked" ? (
                <span aria-hidden="true" className="directory-row__icon">
                  <UnlinkedDotIcon size={14} />
                </span>
              ) : null}
              <span className="directory-row__title-wrap">
                <span className="thread-row__title directory-row__title">
                  {directory.label}
                </span>
              </span>
            </span>

            <span className="directory-row__summary-meta">
              {activeThreadCount > 0 ? (
                <DirectoryCount
                  activeCount={activeThreadCount}
                  className="directory-row__active-count"
                  count={activeThreadCount}
                  indicator={<ThinkingScanner compact />}
                  tone="active"
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
                  tone="idle"
                  tooltipText={formatReviewThreadCount(reviewThreadCount)}
                />
              ) : null}
            </span>
          </button>

          {/* Guarded as a unit: an unconfigured row has no local launchpad, so
              it gets no machine chevron either. */}
          {directoryUnconfigured ? null : (
            <span
              className={`directory-row__launchpad-cluster${
                props.onOpenFederationTargetMenu
                  ? " directory-row__launchpad-cluster--split"
                  : ""
              }`}
            >
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
              {props.onOpenFederationTargetMenu ? (
                <button
                  // Deliberately not "...for a new thread in <directory>": the
                  // selected machine opens its OWN launchpad with its own
                  // projects, so the local directory does not scope the result.
                  // It stays in the name only as row context, which also keeps
                  // the name unique per row for locators.
                  aria-label={`Start a new thread on another machine (from ${directory.label})`}
                  aria-haspopup="menu"
                  aria-expanded={
                    props.openFederationTargetMenuDirectoryKey === directory.key
                  }
                  className="directory-row__launchpad-targets-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    // `x` is the chevron's RIGHT edge; the sidebar right-aligns
                    // the card to it once the card has been measured. The card's
                    // width is a range (220–320px), so subtracting a guess here
                    // would misplace it on the wider end.
                    props.onOpenFederationTargetMenu?.(directory, {
                      x: rect.right,
                      y: rect.bottom + 4,
                      anchorTop: rect.top,
                    });
                  }}
                >
                  {/* Heavier stroke at a smaller size: at the icon library's
                      1.75 default a 12px chevron read washed out next to the
                      16px launchpad glyph, so the pair looked like two
                      different treatments rather than one control. */}
                  <ChevronDownIcon size={14} strokeWidth={2} />
                </button>
              ) : null}
            </span>
          )}
        </div>

            {expanded ? (
              <div className="directory-row__details">
                {visibleThreadCount > 0 ? (
                  <div className="sidebar-list sidebar-list--compact directory-row__threads" role="list" aria-label={`Threads in ${directory.label}`}>
                    {directoryPinnedThreads.map((thread) => {
	                      const threadKey = threadSummaryIdentityKey(thread);
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
                          pointerDraggable={Boolean(props.onReorderThreadPins)}
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
                          threadPinState="pinned"
                              onToggleSubthreads={
                                subthreadCount > 0
                                  && threadSupportsFederationCapability(
                                    thread,
                                    "thread_grouping",
                                  )
                                  && props.onSetSubthreadsCollapsed
                                  ? () =>
                                      void props.onSetSubthreadsCollapsed!(
                                        thread,
                                        !subthreadsCollapsed,
                                      )
                                  : undefined
                              }
                          onPointerDownThread={(event) => {
                            beginThreadPinPointerDrag(
                              event,
                              directory,
                              threadKey,
                              true,
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

                    {renderPinnedAppendTarget ? (
                      <div
                        className="directory-row__pin-drop-boundary"
                        // The slot's `aria-hidden` is REMOVED for the duration
                        // of a pin drag (`setThreadPinAppendTargetActive`), so
                        // mid-drag this subtree exposes a `separator` to the
                        // `role="list"` above. Role-less, the boundary would be
                        // transparent and that separator would become an
                        // unallowed owned child; as a `listitem` it is the
                        // separator's parent and the list stays valid in both
                        // states. No axe run catches this — the gate never
                        // scans mid-drag.
                        role="listitem"
                      >
                        <div
                          aria-label={`Pin thread after pinned threads for ${directory.label}`}
                          aria-hidden="true"
                          className="directory-row__pin-drop-slot"
                          role="separator"
                        />
                      </div>
                    ) : null}

                    {directoryPinnedThreads.length > 0 &&
                    directoryUnpinnedThreadCount > 0 ? (
                      <div className="directory-row__threads-slot" role="listitem">
                        <button
                          type="button"
                          className="recents-pinned-divider directory-row__thread-divider"
                          aria-expanded={!directoryThreadsCollapsed}
                          aria-label={`${
                            directoryThreadsCollapsed ? "Show" : "Hide"
                          } directory threads for ${directory.label}`}
                          disabled={
                            directoryUnconfigured
                            || !props.onSetDirectoryThreadsCollapsed
                          }
                          onClick={() => {
                            if (
                              directoryUnconfigured
                              || Date.now() - lastDirectoryThreadDropAtRef.current <
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
                      </div>
                    ) : null}

                    {directoryThreadsCollapsed
                      ? null
                      : cappedUnpinnedThreads.map(renderUnpinnedRow)}
                    {!directoryThreadsCollapsed && hiddenUnpinnedCount > 0 ? (
                      <div className="directory-row__threads-slot" role="listitem">
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
                      </div>
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
      {unavailableDirectoryTooltip.tooltipNode}
    </div>
  );
}
