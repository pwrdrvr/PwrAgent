import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import type { WindowPointerSnapshot } from "../../../../shared/window-pointer";
import {
  AutomationsIcon,
  InfoIcon,
  PinIcon,
  ProjectsIcon,
  PullRequestIcon,
  ServerIcon,
  SubAgentsIcon,
  type IconProps,
} from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThreadAutomationsPanel } from "../automations/ThreadAutomationsPanel";
import { ThreadInfoPanel } from "./context-panels/ThreadInfoPanel";
import { ProviderStatusPanel } from "./context-panels/ProviderStatusPanel";
import { SubAgentsPanel } from "./context-panels/SubAgentsPanel";
import { PullRequestsPanel } from "./context-panels/PullRequestsPanel";
import { LinkedProjectsPanel } from "./context-panels/LinkedProjectsPanel";
import { buildRailTooltipText } from "./context-panels/context-rail-shared";
import type { ContextTabId } from "./context-panels/context-tab";

const HOVER_RAIL_POINTER_POLL_MS = 500;
const HOVER_RAIL_OFF_TARGET_CLOSE_MS = 1_200;
const HOVER_RAIL_REVEAL_DELAY_MS = 350;

type ContextTab = {
  id: ContextTabId;
  label: string;
  Icon: ComponentType<IconProps>;
  /** Anchored to the bottom of the rail, above the pin toggle. */
  bottom?: boolean;
};

const CONTEXT_TABS: ContextTab[] = [
  { id: "info", label: "Thread info", Icon: InfoIcon },
  { id: "subagents", label: "Sub-agents", Icon: SubAgentsIcon },
  { id: "automations", label: "Automations", Icon: AutomationsIcon },
  { id: "prs", label: "Pull requests", Icon: PullRequestIcon },
  { id: "projects", label: "Linked projects", Icon: ProjectsIcon },
  { id: "providers", label: "Provider status", Icon: ServerIcon, bottom: true },
];

type ThreadContextPanelProps = {
  backendError?: string;
  backends: BackendSummary[];
  desktopApi?: DesktopApi;
  onPinnedChange?: (pinned: boolean) => void;
  onRefreshNavigation?: () => Promise<void>;
  onResizingChange?: (resizing: boolean) => void;
  onWidthChange?: (width: number) => void;
  pinned: boolean;
  platform?: string;
  thread: NavigationThreadSummary;
  worktreeArchiveError?: string;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  activeTab: ContextTabId;
  onActiveTabChange: (tab: ContextTabId) => void;
};

export function ThreadContextPanel(props: ThreadContextPanelProps) {
  const railRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [railWidth, setRailWidth] = useState(380);
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

  const activeTab = props.activeTab;
  const activeTabMeta =
    CONTEXT_TABS.find((tab) => tab.id === activeTab) ?? CONTEXT_TABS[0]!;
  const topTabs = CONTEXT_TABS.filter((tab) => !tab.bottom);
  const bottomTabs = CONTEXT_TABS.filter((tab) => tab.bottom);

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

  const updatePinned = (nextPinned: boolean): void => {
    props.onPinnedChange?.(nextPinned);
  };

  const selectTab = (tab: ContextTabId): void => {
    props.onActiveTabChange(tab);
    if (!pinned) {
      revealRail();
    }
  };

  const resizeRail = (nextWidth: number): void => {
    const clampedWidth = Math.min(560, Math.max(300, nextWidth));
    setRailWidth(clampedWidth);
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
      style={{ "--context-rail-width": `${railWidth}px` } as CSSProperties}
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
            <div className="context-panel__header">
              <span className="context-panel__title">{activeTabMeta.label}</span>
            </div>
            <div className="context-panel__scroll">{renderActivePanel()}</div>
          </div>
        </div>
      ) : null}

      <div className="context-rail__spine">
        <div
          className="context-rail__tablist"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Context panels"
        >
          {topTabs.map((tab) => renderTab(tab))}
          {bottomTabs.length > 0 ? (
            <div className="context-rail__tablist-spacer" aria-hidden="true" />
          ) : null}
          {bottomTabs.map((tab) => renderTab(tab))}
        </div>
        <div className="context-rail__spine-footer">
          <button
            aria-label={pinned ? "Unpin context rail" : "Pin context rail"}
            aria-pressed={pinned}
            className={`context-rail__pin${pinned ? " is-active" : ""}`}
            title={pinned ? "Unpin context rail" : "Pin context rail"}
            type="button"
            onClick={() => {
              const next = !pinned;
              updatePinned(next);
              if (next) {
                setRevealed(true);
              } else {
                clearTimeout(hideTimerRef.current);
                clearRevealTimer();
                setRevealed(false);
              }
            }}
          >
            <PinIcon size={16} filled={pinned} aria-hidden="true" />
          </button>
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
        aria-label={tab.label}
        aria-selected={isActive && open}
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
      case "subagents":
        return <SubAgentsPanel thread={props.thread} />;
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
