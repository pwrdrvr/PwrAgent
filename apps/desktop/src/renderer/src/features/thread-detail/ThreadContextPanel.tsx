import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  BackendSummary,
  DesktopApplicationDiscoveryCandidate,
  EditGroupCommitState,
  NavigationThreadSummary,
  CodexEnvironmentActionRun,
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import type { WindowPointerSnapshot } from "../../../../shared/window-pointer";
import {
  AutomationsIcon,
  EditsIcon,
  InfoIcon,
  PricingIcon,
  ProjectsIcon,
  PullRequestIcon,
  ServerIcon,
  SubAgentsIcon,
  TerminalIcon,
  type IconProps,
} from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThreadAutomationsPanel } from "../automations/ThreadAutomationsPanel";
import { ThreadInfoPanel } from "./context-panels/ThreadInfoPanel";
import { ProviderStatusPanel } from "./context-panels/ProviderStatusPanel";
import { SubAgentsPanel } from "./context-panels/SubAgentsPanel";
import { PullRequestsPanel } from "./context-panels/PullRequestsPanel";
import { LinkedProjectsPanel } from "./context-panels/LinkedProjectsPanel";
import { EditsPanel } from "./context-panels/EditsPanel";
import { PricingPanel } from "./context-panels/PricingPanel";
import { ActionRunsPanel } from "./context-panels/ActionRunsPanel";
import { buildRailTooltipText } from "./context-panels/context-rail-shared";
import type {
  ContextTabId,
  ActionRunsDock,
  EditedFilesDock,
} from "./context-panels/context-tab";
import type { EditedFileGroup } from "./edited-file-groups";

const HOVER_RAIL_POINTER_POLL_MS = 500;
const HOVER_RAIL_OFF_TARGET_CLOSE_MS = 1_200;
const HOVER_RAIL_REVEAL_DELAY_MS = 350;

const noop = (): void => {};

type ContextTab = {
  id: ContextTabId;
  label: string;
  Icon: ComponentType<IconProps>;
  /** Anchored to the bottom of the tab rail (below the spacer). */
  bottom?: boolean;
};

const CONTEXT_TABS: ContextTab[] = [
  { id: "info", label: "Thread info", Icon: InfoIcon },
  { id: "edits", label: "Edits", Icon: EditsIcon },
  { id: "pricing", label: "Pricing", Icon: PricingIcon },
  { id: "actions", label: "Actions", Icon: TerminalIcon },
  { id: "subagents", label: "Sub-agents", Icon: SubAgentsIcon },
  { id: "automations", label: "Automations", Icon: AutomationsIcon },
  { id: "prs", label: "Pull requests", Icon: PullRequestIcon },
  { id: "projects", label: "Linked projects", Icon: ProjectsIcon },
  { id: "providers", label: "Provider status", Icon: ServerIcon, bottom: true },
];

type ThreadContextPanelProps = {
  activeTurnId?: string;
  backendError?: string;
  backends: BackendSummary[];
  desktopApi?: DesktopApi;
  onRefreshNavigation?: () => Promise<void>;
  onResizingChange?: (resizing: boolean) => void;
  onWidthChange?: (width: number) => void;
  /**
   * Current rail width in px, owned by `ThreadView`. The panel is a
   * controlled component: `ThreadView` publishes this as `--context-rail-width`
   * on `.thread-view`, the panel renders at the derived
   * `--context-rail-effective` (sidebar-capped) that the chat column + header
   * also reserve, and resizes report back through `onWidthChange`. Keeping a
   * single width source — instead of a second local copy here — is what
   * guarantees the panel and its reserved gutter can never disagree (the bug
   * where a widened rail slid under the MSG cluster on a freshly-created
   * subthread).
   */
  width?: number;
  pinned: boolean;
  platform?: string;
  pricing?: {
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
  pricingDisplayOptions?: {
    codexCredits: boolean;
    usd: boolean;
  };
  threadPricingSummaryEnabled?: boolean;
  thread: NavigationThreadSummary;
  worktreeArchiveError?: string;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  activeTab: ContextTabId;
  onActiveTabChange: (tab: ContextTabId) => void;
  /** Accumulated edited-file groups for the Edits tab (newest first). */
  editedFileGroups?: EditedFileGroup[];
  editedFileCommitStates?: Record<string, EditGroupCommitState>;
  editedFilesWorktreeRoot?: string;
  onOpenEditedFile?: (absolutePath: string) => void;
  /** Resolved preferred editor, for the per-row open-in-editor icon. */
  preferredEditor?: DesktopApplicationDiscoveryCandidate;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  editedFilesDock?: EditedFilesDock;
  onEditedFilesDockChange?: (dock: EditedFilesDock) => void;
  actionRuns?: CodexEnvironmentActionRun[];
  actionRunsDock?: ActionRunsDock;
  actionRunsEnvironmentName?: string;
  onActionRunsDockChange?: (dock: ActionRunsDock) => void;
  onShowActionRunsAboveComposer?: () => void;
  onDismissEnvActionRun?: (run: CodexEnvironmentActionRun) => void;
  onStopEnvActionRun?: (
    run: CodexEnvironmentActionRun,
    mode: "stop" | "terminate"
  ) => void;
};

// Clamp bounds for the context-rail width. Shared by the resize math and the
// resize handle's aria-valuemin / aria-valuemax so the announced range can
// never drift from the actual clamp.
const RAIL_MIN_WIDTH = 300;
const RAIL_MAX_WIDTH = 560;

export function ThreadContextPanel(props: ThreadContextPanelProps) {
  const railRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  // Width is owned by ThreadView (single source of truth). Used only for the
  // resize delta math here; the rendered width comes from the inherited
  // `--context-rail-effective` custom property. No local copy → no desync.
  const railWidth = props.width ?? 380;
  const [resizing, setResizing] = useState(false);
  const [tooltip, setTooltip] = useState<{
    left?: number;
    text: string;
    targetBottom: number;
    targetCenter: number;
    targetTop: number;
    top?: number;
  }>();
  const pinned = props.pinned;
  const open = pinned || revealed;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const revealIntentRef = useRef(0);
  const lastMousePositionRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const outsideRailSinceRef = useRef<number | undefined>(undefined);

  const activeTab =
    props.activeTab === "pricing" && !props.threadPricingSummaryEnabled
      ? "info"
      : props.activeTab;
  const visibleTabs = CONTEXT_TABS.filter(
    (tab) => tab.id !== "pricing" || props.threadPricingSummaryEnabled,
  );
  const topTabs = visibleTabs.filter((tab) => !tab.bottom);
  const bottomTabs = visibleTabs.filter((tab) => tab.bottom);

  const rememberMousePosition = useCallback((event: MouseEvent<HTMLElement>) => {
    lastMousePositionRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    outsideRailSinceRef.current = undefined;
  }, []);

  const isMouseInsideRail = useCallback((point: { x: number; y: number }) => {
    const rail = railRef.current;
    if (!rail) {
      return false;
    }

    const rect = rail.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    return (
      point.x >= rect.left - 1 &&
      point.x <= rect.right + 1 &&
      point.y >= rect.top - 1 &&
      point.y <= rect.bottom + 1
    );
  }, []);

  const isScreenCursorInsideRail = useCallback(
    (snapshot: WindowPointerSnapshot) => {
      if (snapshot.contentBounds.width <= 0 || snapshot.contentBounds.height <= 0) {
        return false;
      }

      return isMouseInsideRail({
        x: snapshot.cursor.x - snapshot.contentBounds.x,
        y: snapshot.cursor.y - snapshot.contentBounds.y,
      });
    },
    [isMouseInsideRail]
  );

  const clearRevealTimer = useCallback(() => {
    revealIntentRef.current += 1;
    clearTimeout(revealTimerRef.current);
    revealTimerRef.current = undefined;
  }, []);

  const isHoverStillInsideRail = useCallback(
    async (point?: { x: number; y: number }): Promise<boolean> => {
      const readPointerSnapshot = props.desktopApi?.getWindowPointerSnapshot;
      if (readPointerSnapshot) {
        try {
          return isScreenCursorInsideRail(await readPointerSnapshot());
        } catch {
          // Cursor polling is a best-effort Electron affordance. Fall back
          // to the latest renderer mouse position when the bridge is absent
          // or briefly unavailable.
        }
      }

      const latestPoint = lastMousePositionRef.current ?? point;
      return Boolean(latestPoint && isMouseInsideRail(latestPoint));
    },
    [isMouseInsideRail, isScreenCursorInsideRail, props.desktopApi?.getWindowPointerSnapshot]
  );

  const hideRailNow = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    clearRevealTimer();
    outsideRailSinceRef.current = undefined;
    setRevealed(false);
  }, [clearRevealTimer]);

  // Debounced reveal/hide prevents flicker from the panel reveal
  // transition causing spurious mouseenter→mouseleave sequences. The
  // final hit test keeps the rail open when an inactive window reports a
  // transient leave during the collapsed-spine → open-panel swap while
  // the cursor is still inside the opened rail.
  const revealRail = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    clearRevealTimer();
    outsideRailSinceRef.current = undefined;
    setRevealed(true);
  }, [clearRevealTimer]);

  const revealRailAfterHoverIntent = useCallback(
    (point: { x: number; y: number }) => {
      clearTimeout(hideTimerRef.current);
      clearRevealTimer();
      outsideRailSinceRef.current = undefined;

      const intent = revealIntentRef.current;
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = undefined;
        void (async () => {
          if (revealIntentRef.current !== intent) {
            return;
          }

          if (await isHoverStillInsideRail(point)) {
            if (revealIntentRef.current === intent) {
              revealRail();
            }
          }
        })();
      }, HOVER_RAIL_REVEAL_DELAY_MS);
    },
    [clearRevealTimer, isHoverStillInsideRail, revealRail]
  );

  const hideRail = useCallback(
    (point?: { x: number; y: number }) => {
      clearTimeout(hideTimerRef.current);
      clearRevealTimer();
      hideTimerRef.current = setTimeout(() => {
        const latestPoint = lastMousePositionRef.current ?? point;
        if (latestPoint && isMouseInsideRail(latestPoint)) {
          return;
        }

        hideRailNow();
      }, 300);
    },
    [clearRevealTimer, hideRailNow, isMouseInsideRail]
  );

  useEffect(() => {
    return () => {
      clearTimeout(hideTimerRef.current);
      clearTimeout(revealTimerRef.current);
      revealIntentRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (pinned || !revealed) {
      return;
    }

    const handleDocumentMouseMove = (event: globalThis.MouseEvent): void => {
      const point = {
        x: event.clientX,
        y: event.clientY,
      };
      lastMousePositionRef.current = point;

      if (isMouseInsideRail(point)) {
        outsideRailSinceRef.current = undefined;
        return;
      }

      hideRail(point);
    };

    document.addEventListener("mousemove", handleDocumentMouseMove, true);
    return () => {
      document.removeEventListener("mousemove", handleDocumentMouseMove, true);
    };
  }, [hideRail, isMouseInsideRail, pinned, revealed]);

  useEffect(() => {
    const readPointerSnapshot = props.desktopApi?.getWindowPointerSnapshot;
    if (pinned || !revealed || !readPointerSnapshot) {
      return;
    }

    let cancelled = false;

    const checkPointer = async (): Promise<void> => {
      try {
        const snapshot = await readPointerSnapshot();
        if (cancelled) {
          return;
        }

        if (isScreenCursorInsideRail(snapshot)) {
          outsideRailSinceRef.current = undefined;
          return;
        }

        const now = Date.now();
        const outsideSince = outsideRailSinceRef.current ?? now;
        outsideRailSinceRef.current = outsideSince;
        if (now - outsideSince >= HOVER_RAIL_OFF_TARGET_CLOSE_MS) {
          hideRailNow();
        }
      } catch {
        // Cursor polling is a best-effort Electron affordance; renderer
        // mousemove and mouseleave still cover the normal browser path.
      }
    };

    void checkPointer();
    const intervalId = window.setInterval(() => {
      void checkPointer();
    }, HOVER_RAIL_POINTER_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    hideRailNow,
    isScreenCursorInsideRail,
    pinned,
    props.desktopApi?.getWindowPointerSnapshot,
    revealed,
  ]);

  useLayoutEffect(() => {
    if (!tooltip || tooltip.left !== undefined) {
      return;
    }

    const tooltipElement = tooltipRef.current;
    if (!tooltipElement) {
      return;
    }

    const tooltipRect = tooltipElement.getBoundingClientRect();
    const viewportPadding = 12;
    const left = Math.min(
      window.innerWidth - tooltipRect.width - viewportPadding,
      Math.max(viewportPadding, tooltip.targetCenter - tooltipRect.width / 2)
    );
    const top =
      tooltip.targetTop - tooltipRect.height - 10 >= viewportPadding
        ? tooltip.targetTop - 10
        : tooltip.targetBottom + tooltipRect.height + 10;

    setTooltip({
      ...tooltip,
      left,
      top,
    });
  }, [tooltip]);

  const selectTab = (tab: ContextTabId): void => {
    props.onActiveTabChange(tab);
    if (!pinned) {
      revealRail();
    }
  };

  const resizeRail = (nextWidth: number): void => {
    const clampedWidth = Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, nextWidth));
    props.onWidthChange?.(clampedWidth);
  };
  const startRailResize = (event: PointerEvent<HTMLElement>): void => {
    if (!pinned) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setResizing(true);
    props.onResizingChange?.(true);
    const startX = event.clientX;
    const startWidth = railWidth;

    const move = (moveEvent: globalThis.PointerEvent): void => {
      resizeRail(startWidth + startX - moveEvent.clientX);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setResizing(false);
      props.onResizingChange?.(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <aside
      ref={railRef}
      aria-label="Thread context"
      className={`context-rail${open ? " is-open" : " is-collapsed"}${
        pinned ? " is-pinned" : ""
      }${resizing ? " is-resizing" : ""}`}
      onMouseEnter={(event) => {
        rememberMousePosition(event);
        if (!pinned) {
          revealRailAfterHoverIntent({
            x: event.clientX,
            y: event.clientY,
          });
        }
      }}
      onMouseMove={rememberMousePosition}
      onMouseLeave={(event) => {
        rememberMousePosition(event);
        if (!pinned) {
          hideRail({
            x: event.clientX,
            y: event.clientY,
          });
        }
      }}
      onFocusCapture={() => {
        if (!pinned) {
          revealRail();
        }
      }}
      onBlurCapture={(event) => {
        if (!pinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          hideRail();
        }
      }}
    >
      {pinned ? (
        <div
          aria-label="Resize context rail"
          aria-orientation="vertical"
          aria-valuenow={railWidth}
          aria-valuemin={RAIL_MIN_WIDTH}
          aria-valuemax={RAIL_MAX_WIDTH}
          className="context-rail__resize-handle"
          role="separator"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              resizeRail(railWidth + 16);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              resizeRail(railWidth - 16);
            }
          }}
          onPointerDown={startRailResize}
        />
      ) : null}

      {open ? (
        <div className="context-panel">
          <div className="context-panel__inner">
            {/* No panel title here — each panel's own section <h3> is the
                title. A separate header duplicated it verbatim on the
                single-section tabs (Sub-agents, Automations, …). */}
            <div
              className="context-panel__scroll"
              id="context-rail-panel"
              role="tabpanel"
              aria-labelledby={`context-rail-tab-${activeTab}`}
            >
              {renderActivePanel()}
            </div>
          </div>
        </div>
      ) : null}

      <div className="context-rail__spine">
        <div
          className="context-rail__tablist"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Context panels"
          onKeyDown={handleTablistKeyDown}
        >
          {topTabs.map((tab) => renderTab(tab))}
          {bottomTabs.length > 0 ? (
            <div className="context-rail__tablist-spacer" aria-hidden="true" />
          ) : null}
          {bottomTabs.map((tab) => renderTab(tab))}
        </div>
      </div>

      {tooltip && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltipRef}
              className="context-rail__tooltip"
              role="tooltip"
              style={{
                left: tooltip.left,
                top: tooltip.top,
                visibility: tooltip.left === undefined ? "hidden" : undefined,
              }}
            >
              {tooltip.text}
            </div>,
            document.body
          )
        : null}
    </aside>
  );

  function renderTab(tab: ContextTab) {
    const isActive = tab.id === activeTab;
    const TabIcon = tab.Icon;
    return (
      <button
        key={tab.id}
        id={`context-rail-tab-${tab.id}`}
        aria-label={tab.label}
        aria-selected={isActive && open}
        aria-controls={open ? "context-rail-panel" : undefined}
        className={`context-rail__tab${isActive ? " is-active" : ""}`}
        role="tab"
        tabIndex={isActive ? 0 : -1}
        title={tab.label}
        type="button"
        onClick={() => selectTab(tab.id)}
      >
        <TabIcon size={18} aria-hidden="true" />
      </button>
    );
  }

  // Vertical tablist roving focus (WAI-ARIA tabs pattern). Arrow keys move
  // focus between the tab buttons; activation stays manual (Enter/Space or
  // click) so arrowing through the rail doesn't fire a config write +
  // reveal on every keypress. Home/End jump to the first/last tab.
  function handleTablistKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    if (tabs.length === 0) {
      return;
    }
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : (current + 1) % tabs.length;
        break;
      case "ArrowUp":
        next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      default:
        next = tabs.length - 1;
        break;
    }
    event.preventDefault();
    tabs[next]?.focus();
  }

  function renderActivePanel() {
    switch (activeTab) {
      case "info":
        return (
          <ThreadInfoPanel
            thread={props.thread}
            backends={props.backends}
            platform={props.platform}
            desktopApi={props.desktopApi}
            worktreeArchiveError={props.worktreeArchiveError}
            onRefreshNavigation={props.onRefreshNavigation}
            onRestoreWorktree={props.onRestoreWorktree}
            showTooltip={showRailTooltip}
            hideTooltip={hideRailTooltip}
          />
        );
      case "edits":
        return (
          <EditsPanel
            groups={props.editedFileGroups ?? []}
            commitStatesByKey={props.editedFileCommitStates}
            worktreeRoot={props.editedFilesWorktreeRoot}
            desktopApi={props.desktopApi}
            workingStateRefreshKey={JSON.stringify(props.thread.gitWorkingState ?? null)}
            onOpenFile={props.onOpenEditedFile}
            preferredEditor={props.preferredEditor}
            onScrollToTurn={props.onScrollToTurn}
            dock={props.editedFilesDock ?? "above"}
            onDockChange={props.onEditedFilesDockChange ?? noop}
          />
        );
      case "pricing":
        return (
          <PricingPanel
            activeTurnId={props.activeTurnId}
            pricing={props.pricing}
            displayOptions={props.pricingDisplayOptions}
            onScrollToTurn={props.onScrollToTurn}
          />
        );
      case "actions":
        return (
          <ActionRunsPanel
            dock={props.actionRunsDock ?? "above"}
            environmentName={props.actionRunsEnvironmentName}
            onDockChange={(dock) => {
              props.onActionRunsDockChange?.(dock);
              if (dock === "above") {
                props.onShowActionRunsAboveComposer?.();
              }
            }}
            onDismissRun={props.onDismissEnvActionRun}
            onStopRun={props.onStopEnvActionRun}
            runs={props.actionRuns ?? []}
          />
        );
      case "subagents":
        return (
          <SubAgentsPanel
            pricingDisplayOptions={props.pricingDisplayOptions}
            thread={props.thread}
          />
        );
      case "automations":
        return (
          <ThreadAutomationsPanel
            desktopApi={props.desktopApi}
            thread={props.thread}
            onRefreshNavigation={props.onRefreshNavigation}
          />
        );
      case "prs":
        return <PullRequestsPanel thread={props.thread} />;
      case "projects":
        return (
          <LinkedProjectsPanel
            thread={props.thread}
            showTooltip={showRailTooltip}
            hideTooltip={hideRailTooltip}
          />
        );
      case "providers":
        return (
          <ProviderStatusPanel
            backends={props.backends}
            backendError={props.backendError}
          />
        );
    }
  }

  function showRailTooltip(
    event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
    path: string,
    maxLength?: number,
    copyHint = true
  ): void {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      text: buildRailTooltipText(path, maxLength, copyHint),
      targetBottom: rect.bottom,
      targetCenter: rect.left + rect.width / 2,
      targetTop: rect.top,
    });
  }

  function hideRailTooltip(): void {
    setTooltip(undefined);
  }
}
