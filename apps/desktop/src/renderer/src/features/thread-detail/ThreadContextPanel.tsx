import type { BackgroundTerminalsViewProps } from "./BackgroundTerminalsView";
import type { SubAgentLens } from "@pwragent/shared/subagent-kind";
import { useThreadDisplayResource } from "../../lib/useThreadDisplayResource";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type {
  CodexEnvironmentActionRun,
  ThreadCompactionRecord,
  ThreadTokenMiserAccounting,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { DesktopApplicationDiscoveryCandidate } from "@pwragent/shared/contracts/settings";
import type { EditGroupCommitState, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadPricingSummary, ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import type { ToolOutputIncidentExplorerLens } from "@pwragent/shared/contracts/tool-output-incidents";
import { isThreadPendingWakeLive } from "@pwragent/shared/contracts/thread-pending-wakes";
import { operatorTodoItemKey } from "@pwragent/shared/contracts/operator-requests";
import type { WindowPointerSnapshot } from "../../../../shared/window-pointer";
import {
  DecisionsIcon,
  GaugeIcon,
  InfoIcon,
  HourglassIcon,
  PauseIcon,
  PlugIcon,
  PricingIcon,
  ResearchIcon,
  TodoIcon,
  type IconProps,
} from "../../icons";
import { buildPullRequestStatusKey } from "@pwragent/shared/contracts/navigation";
import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared/token-usage-pricing";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import type { NavigationPresentedThread } from "../../lib/navigation-loaded-rows";
import {
  readRendererFederationTarget,
  resolveThreadOwnerFederationTarget,
} from "../../lib/federation-window";
import { threadJobMonitorControl } from "../../lib/job-monitor-control";
import { resolveThreadWorkingStatePath } from "../../lib/thread-working-state-path";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ThreadAutomationsPanel } from "../automations/ThreadAutomationsPanel";
import { ThreadTodosPanel } from "../thread-todos/ThreadTodosPanel";
import type { ThreadTodoReviewSetup } from "../thread-todos/ThreadTodoCard";
import { ResearchPanel } from "../research/ResearchPanel";
import type { ThreadTodoRevealRequest } from "../thread-todos/thread-todo-reveal";
import type {
  ThreadTodoDoHereOptions,
  ThreadTodoResolveOptions,
  ThreadTodosView,
} from "../thread-todos/thread-todos-view";
import { PrActivityPanel } from "./context-panels/PrActivityPanel";
import { ProviderStatusPanel } from "./context-panels/ProviderStatusPanel";
import { SubAgentsPanel } from "./context-panels/SubAgentsPanel";
import { PullRequestsPanel } from "./context-panels/PullRequestsPanel";
import { useThreadPrWatches } from "../pr-watches/useThreadPrWatchIndicators";
import { readFollowUpsSuspended, useThreadPendingWakes } from "../thread-pending-wakes/useThreadPendingWakes";
import { useThreadDependencyIndicatorsContext } from "../thread-dependencies/useThreadDependencyIndicators";
import { WaitingForPanel } from "./context-panels/WaitingForPanel";
import { EditsPanel } from "./context-panels/EditsPanel";
import { PricingPanel } from "./context-panels/PricingPanel";
import { DecisionsPanel, type DecisionSetupSettings } from "./context-panels/DecisionsPanel";
import { useDecisionsRail } from "./context-panels/useDecisionsRail";
import { ActionRunsPanel } from "./context-panels/ActionRunsPanel";
import { ConnectionsPanel } from "./context-panels/ConnectionsPanel";
import { buildRailTooltipText } from "./context-panels/context-rail-shared";
import {
  contextTabIdForDetailsSegment,
  resolveContextTabTarget,
  type ContextTabId,
  type ContextRailTabId,
  type ActionRunsDock,
  type DetailsSegmentId,
  type EditedFilesDock,
} from "./context-panels/context-tab";
import { DetailsPanel } from "./context-panels/DetailsPanel";
import { DetailsThreadView, type DetailsThreadControls } from "./context-panels/DetailsThreadView";
import {
  countChangedFiles,
  summarizeDetailsJobs,
  type DetailsJobsSectionId,
} from "./context-panels/details-model";
import type { EditedFileGroup } from "./edited-file-groups";

const HOVER_RAIL_POINTER_POLL_MS = 500;
const HOVER_RAIL_OFF_TARGET_CLOSE_MS = 1_200;
const HOVER_RAIL_REVEAL_DELAY_MS = 350;

const noop = (): void => {};

/** The PRs segment's activity filter value for every PR of the thread. */
const ALL_PULL_REQUESTS = "all";

type ContextTab = {
  id: ContextRailTabId;
  label: string;
  /** What the panel holds, after the name in the tab's tooltip. The rail is
   *  icon-only, so this line is the only place the tab explains itself. */
  hint: string;
  Icon: ComponentType<IconProps>;
  /** Anchored to the bottom of the tab rail (below the spacer). */
  bottom?: boolean;
};

const CONTEXT_TABS: ContextTab[] = [
  { id: "connections", label: "Connections", hint: "PwrGit, PwrSnap, and Sandboxer", Icon: PlugIcon },
  { id: "details", label: "Details", hint: "where it runs, its changes, PRs, and jobs", Icon: InfoIcon },
  { id: "todos", label: "To-dos", hint: "cards raised for this thread", Icon: TodoIcon },
  { id: "research", label: "Research", hint: "this thread's research runs", Icon: ResearchIcon },
  { id: "waiting", label: "Waiting for", hint: "wakes, watches, and follow-ups", Icon: HourglassIcon },
  { id: "pricing", label: "Pricing", hint: "token usage and cost", Icon: PricingIcon },
  { id: "decisions", label: "Decisions", hint: "typed questions agents run in bulk", Icon: DecisionsIcon },
  {
    id: "providers",
    label: "AI provider info",
    hint: "accounts, rate limits, and usage pace",
    Icon: GaugeIcon,
    bottom: true,
  },
];

type ThreadContextPanelProps = {
  /**
   * The launchpad's connection cards, once the operator moved them here.
   * `landing` counts those moves; each new value replays the tab's arrival
   * ring so the eye follows the cards to it.
   */
  launchpadConnections?: {
    content: ReactNode;
    landing: number;
    /** `keyboard` is true when the button was activated from the keyboard. */
    onShowOnLaunchpad: (keyboard: boolean) => void;
  };
  /** The always-visible tab spine, which the launchpad cards fly into. */
  spineRef?: Ref<HTMLDivElement>;
  /** To-dos for the thread on screen. */
  todos?: {
    view: ThreadTodosView;
    threadKey: string;
    projectKey?: string;
    projectOwner?: FederationRemoteTarget;
    onStartReview: (todo: ThreadTodo, options?: ThreadTodoResolveOptions) => void;
    reviewSetup?: ThreadTodoReviewSetup;
    onDoHere?: (todo: ThreadTodo, options?: ThreadTodoDoHereOptions) => void;
    /** Answers a question in this thread through its composer. */
    onAnswerQuestion?: (text: string) => Promise<boolean>;
    /** This thread's answers the composer took, by question item id. */
    sentQuestionAnswers?: ReadonlyMap<string, string>;
    /** A thread row's to-do chip asked to show this thread's cards. */
    revealRequest?: ThreadTodoRevealRequest;
  };
  activeTurnId?: string;
  backendError?: string;
  backends: BackendSummary[];
  /** The owning peer's providers, for a thread that runs on another instance. */
  ownerBackends?: BackendSummary[];
  desktopApi?: DesktopApi;
  initialLoadDurationMs?: number;
  onOpenAutomations?: () => void;
  /** The profile's Settings, for the Decisions tab's provider setup. */
  decisionSettings?: DecisionSetupSettings;
  onOpenDecisionSettings?: (focus?: string) => void;
  /** Settings › Experimental, where Open Math Harness is configured. */
  onOpenResearchSettings?: () => void;
  onRefreshNavigation?: () => Promise<void>;
  onFocusWaitingHeading?: () => void;
  /** Backs Turn Off on the Pull requests tab's Auto-fix row. */
  onSetThreadPrAutoDispatch?: (enabled: boolean) => Promise<void>;
  /** Unlocks the selected thread, as its lock card does. */
  onUnlockThread?: () => Promise<void>;
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
    compactions?: ThreadCompactionRecord[];
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
  tokenMiserAccounting?: ThreadTokenMiserAccounting;
  onOpenToolOutputIncidentExplorer?: (
    lens?: ToolOutputIncidentExplorerLens,
  ) => void;
  pricingDisplayOptions?: {
    codexCredits: boolean;
    usd: boolean;
  };
  threadPricingSummaryEnabled?: boolean;
  researchEnabled?: boolean;
  /** Absent on the new-thread launchpad, where only provider context applies. */
  thread?: NavigationPresentedThread;
  worktreeArchiveError?: string;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  /**
   * The stored tab, in the old tab vocabulary: the eight tabs Details took
   * in name its segments (`resolveContextTabTarget`).
   */
  activeTab: ContextTabId;
  onActiveTabChange: (tab: ContextTabId) => void;
  /** What the Details › Thread view needs from the thread's window. */
  detailsControls?: DetailsThreadControls;
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
  backgroundTerminals?: BackgroundTerminalsViewProps;
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
  const {
    onOpenToolOutputIncidentExplorer,
    onActionRunsDockChange,
    onShowActionRunsAboveComposer,
  } = props;
  const openIncidentExplorer = useCallback(() => {
    onOpenToolOutputIncidentExplorer?.();
  }, [onOpenToolOutputIncidentExplorer]);
  const changeActionRunsDock = useCallback((dock: ActionRunsDock) => {
    onActionRunsDockChange?.(dock);
    if (dock === "above") {
      onShowActionRunsAboveComposer?.();
    }
  }, [onActionRunsDockChange, onShowActionRunsAboveComposer]);
  const editedFileGroups = useMemo(
    () => props.editedFileGroups ?? [],
    [props.editedFileGroups],
  );
  const actionRuns = useMemo(() => props.actionRuns ?? [], [props.actionRuns]);
  // The Pull requests tab counts what wakes this thread: this instance's own
  // list for a local thread, the owner's projection for a peer's, plus the
  // merge build watches its card lists from Continue After.
  const localPrWatches = useThreadPrWatches(props.thread);
  const prWatchCount = props.thread
    ? (props.thread.federation || readRendererFederationTarget()
      ? props.thread.activePrWatches?.length ?? 0
      : localPrWatches?.watches.length ?? 0)
      + (localPrWatches?.mergeBuildWaits?.length ?? 0)
    : 0;
  // The Waiting for tab counts every pending wake, so a waiting thread says
  // so before the tab opens. Unknown (an older owner) draws no badge.
  const dependencyContext = useThreadDependencyIndicatorsContext();
  const openTokenMiserSavings = useCallback(() => {
    onOpenToolOutputIncidentExplorer?.("savings");
  }, [onOpenToolOutputIncidentExplorer]);
  const railRef = useRef<HTMLElement>(null);
  const [revealed, setRevealed] = useState(false);
  // A modal portaled to document.body is outside the rail in DOM and pointer
  // geometry, but remains part of the same interaction. Keep the panel
  // mounted while it is open so its own hover-dismissal cannot destroy it.
  const [portaledInteractionOpen, setPortaledInteractionOpen] = useState(false);
  // Width is owned by ThreadView (single source of truth). Used only for the
  // resize delta math here; the rendered width comes from the inherited
  // `--context-rail-effective` custom property. No local copy → no desync.
  const railWidth = props.width ?? 380;
  const [resizing, setResizing] = useState(false);
  const railTooltip = useViewportTooltip({ className: "context-rail__tooltip" });
  const showTooltip = railTooltip.show;
  const showRailTooltip = useCallback((
    event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
    path: string,
    maxLength?: number,
    copyHint = true
  ): void => {
    showTooltip(
      event.currentTarget,
      buildRailTooltipText(path, maxLength, copyHint),
    );
  }, [showTooltip]);

  const hideRailTooltip = railTooltip.hide;
  const pinned = props.pinned;
  const open = pinned || revealed || portaledInteractionOpen;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const revealIntentRef = useRef(0);
  // The ref synchronously guards timers and in-flight cursor polls that were
  // created by the previous render before the state update commits.
  const portaledInteractionOpenRef = useRef(false);
  const lastMousePositionRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const outsideRailSinceRef = useRef<number | undefined>(undefined);
  const threadPricingSummaryEnabled = props.threadPricingSummaryEnabled ?? true;
  // Research runs live on the thread's owning instance; viewers route reads and mutations there.
  const researchEnabled = props.researchEnabled === true && Boolean(props.thread);
  // The tab shows on every thread this machine owns, set up or not: it is
  // where the operator finds decisions and sets a provider up.
  const decisionsRail = useDecisionsRail({
    desktopApi: props.desktopApi,
    thread: props.thread,
    open: open && props.activeTab === "decisions",
  });
  const decisionsVisible = decisionsRail.available;

  // The launchpad picks its own tab and never persists it: the stored tab
  // belongs to threads, and a launchpad visit should not reset it.
  const [launchpadTab, setLaunchpadTab] = useState<"connections" | "providers">(
    "connections",
  );
  const connectionsLanding = props.launchpadConnections?.landing ?? 0;
  // The last move whose ring has played. Without it the tab would replay
  // the ring on every remount, i.e. every return to a launchpad.
  const [landedRingPlayed, setLandedRingPlayed] = useState(0);
  useEffect(() => {
    if (connectionsLanding > 0) setLaunchpadTab("connections");
  }, [connectionsLanding]);
  const activeTab = !props.thread
    ? props.launchpadConnections && launchpadTab === "connections"
      ? "connections"
      : "providers"
    : props.activeTab === "pricing" && !threadPricingSummaryEnabled
      ? "info"
      : props.activeTab === "todos" && !props.todos
        ? "info"
      : props.activeTab === "research" && !researchEnabled
        ? "info"
      : props.activeTab === "decisions" && !decisionsVisible
        ? "info"
      : props.activeTab;
  // The eight tabs Details took in name a segment, and some a section in it.
  const activeTarget = resolveContextTabTarget(activeTab);
  const activeRailTab = activeTarget.tab;
  // The segment Details shows when its spine icon is chosen again.
  const [rememberedSegment, setRememberedSegment] = useState<DetailsSegmentId>(
    activeTarget.segment ?? "thread",
  );
  if (activeTarget.segment && activeTarget.segment !== rememberedSegment) {
    setRememberedSegment(activeTarget.segment);
  }
  const detailsSegment = activeTarget.segment ?? rememberedSegment;
  // The PR whose activity the PRs segment shows, chosen per thread.
  const [activityPr, setActivityPr] = useState<{ thread: string; key: string }>();
  const pricingSummaries = props.pricing?.summaries ?? [];
  const threadCost = threadPricingSummaryEnabled
    && props.pricingDisplayOptions?.usd !== false
    && pricingSummaries.some((summary) => summary.currency === "USD")
    ? formatTokenUsageMicrosAsUsd(pricingSummaries
      .filter((summary) => summary.currency === "USD")
      .reduce((total, summary) => total + summary.totalCostMicros, 0))
    : undefined;
  const detailsOpen = open && activeRailTab === "details";
  const jobsSummary = summarizeDetailsJobs({
    terminalCount: props.backgroundTerminals?.terminals?.length ?? 0,
    runs: actionRuns,
    subAgents: props.thread?.subAgents ?? [],
  });
  const pendingWakes = useThreadPendingWakes(props.thread, props.desktopApi, { includeEnded: open && activeTab === "waiting" });
  const pendingWakeCount = pendingWakes.state.status === "ready"
    ? pendingWakes.state.wakes.filter(isThreadPendingWakeLive).length
    : 0;
  // Loop protection's suspension waits on the operator, not on a wake, so it
  // marks the tab without adding to the count.
  const followUpsSuspended = readFollowUpsSuspended(pendingWakes.state);
  const monitorWakesSuspended = pendingWakes.state.status === "ready" && pendingWakes.state.monitorWakesSuspended;
  const [subAgentLens, setSubAgentLens] = useState<SubAgentLens>();
  const displayResource = useThreadDisplayResource({
    subAgentLens,
    desktopApi: props.desktopApi,
    thread: props.thread,
    resource: !open
      ? undefined
      : activeTab === "pricing"
        ? "pricing"
        : detailsOpen && detailsSegment === "jobs"
          ? "subagents"
          : undefined,
  });
  const subAgentsPanelThread = useMemo(() => {
    if (!props.thread) {
      return undefined;
    }
    const nextSubAgents = displayResource.data?.subAgents ?? props.thread.subAgents;
    return nextSubAgents === props.thread.subAgents
      ? props.thread
      : { ...props.thread, subAgents: nextSubAgents };
  }, [displayResource.data?.subAgents, props.thread]);
  const visibleTabs = CONTEXT_TABS.filter((tab) =>
    props.thread
      ? tab.id !== "connections"
        && (tab.id !== "pricing" || threadPricingSummaryEnabled)
        && (tab.id !== "todos" || props.todos !== undefined)
        && (tab.id !== "research" || researchEnabled)
        && (tab.id !== "decisions" || decisionsVisible)
      : tab.id === "providers"
        || (tab.id === "connections" && props.launchpadConnections !== undefined),
  );
  const topTabs = visibleTabs.filter((tab) => !tab.bottom);
  const bottomTabs = visibleTabs.filter((tab) => tab.bottom);
  const editsWorktreeRoot = props.editedFilesWorktreeRoot
    ?? (props.thread ? resolveThreadWorkingStatePath(props.thread) : undefined);

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
    if (portaledInteractionOpenRef.current) {
      outsideRailSinceRef.current = undefined;
      return;
    }
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
      if (portaledInteractionOpenRef.current) {
        outsideRailSinceRef.current = undefined;
        return;
      }
      hideTimerRef.current = setTimeout(() => {
        if (portaledInteractionOpenRef.current) {
          outsideRailSinceRef.current = undefined;
          return;
        }
        const latestPoint = lastMousePositionRef.current ?? point;
        if (latestPoint && isMouseInsideRail(latestPoint)) {
          return;
        }

        hideRailNow();
      }, 300);
    },
    [clearRevealTimer, hideRailNow, isMouseInsideRail]
  );

  const handlePortaledInteractionChange = useCallback(
    (nextOpen: boolean) => {
      portaledInteractionOpenRef.current = nextOpen;
      setPortaledInteractionOpen(nextOpen);
      if (nextOpen) {
        clearTimeout(hideTimerRef.current);
        clearRevealTimer();
        outsideRailSinceRef.current = undefined;
        setRevealed(true);
      }
    },
    [clearRevealTimer],
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

      if (portaledInteractionOpenRef.current) {
        clearTimeout(hideTimerRef.current);
        outsideRailSinceRef.current = undefined;
        return;
      }

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
    if (pinned || !revealed || portaledInteractionOpen || !readPointerSnapshot) {
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
    portaledInteractionOpen,
    props.desktopApi?.getWindowPointerSnapshot,
    revealed,
  ]);

  /** Shows a tab by any of its ids, old ones included, and reveals the rail. */
  const showContextTab = (tab: ContextTabId): void => {
    if (!props.thread) {
      setLaunchpadTab(tab === "connections" ? "connections" : "providers");
    } else {
      props.onActiveTabChange(tab);
    }
    if (!pinned) {
      revealRail();
    }
  };
  const selectTab = (tab: ContextRailTabId): void => {
    showContextTab(tab === "details" ? contextTabIdForDetailsSegment(detailsSegment) : tab);
  };
  const selectDetailsSegment = (segment: DetailsSegmentId): void => {
    showContextTab(contextTabIdForDetailsSegment(segment));
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
      aria-label={props.thread ? "Thread context" : "New thread context"}
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
        if (
          !pinned
          && !portaledInteractionOpenRef.current
          && !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
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
              aria-labelledby={`context-rail-tab-${activeRailTab}`}
            >
              {displayResource.error ? <p className="context-empty" role="alert">{displayResource.error} <button className="button button--ghost" onClick={displayResource.refresh} type="button">Retry</button></p> : null}
              {activeTab === "pricing" && displayResource.loading && !displayResource.data
                ? <p className="context-empty">Loading…</p>
                : renderActivePanel()}
            </div>
          </div>
        </div>
      ) : null}

      <div ref={props.spineRef} className="context-rail__spine">
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

      {railTooltip.tooltipNode}
    </aside>
  );

  function renderTab(tab: ContextTab) {
    const isActive = tab.id === activeRailTab;
    const TabIcon = tab.Icon;
    const jobsRunning = tab.id === "details" ? jobsSummary.running : 0;
    const todoBadge = tab.id === "todos" && props.todos
      ? readTodoTabBadge(props.todos.view, props.todos.threadKey)
      : undefined;
    const watchCount = tab.id === "waiting" ? pendingWakeCount : 0;
    const suspended = tab.id === "waiting" && (followUpsSuspended || monitorWakesSuspended);
    const baseLabel = jobsRunning
      ? `${tab.label} · ${jobsRunning} job${jobsRunning === 1 ? "" : "s"} running`
      : watchCount
        ? `${tab.label} · ${watchCount} pending wake${watchCount === 1 ? "" : "s"}`
        : todoBadge?.unread
        ? `${tab.label} · ${todoBadge.count} unread`
        : todoBadge
          ? `${tab.label} · ${todoBadge.count} open for this thread`
          : tab.label;
    const label = tab.id === "waiting"
      ? `${baseLabel}${followUpsSuspended ? " · agent follow-ups suspended" : ""}${monitorWakesSuspended ? " · Job Monitor wakes suspended" : ""}`
      : baseLabel;
    const landing = tab.id === "connections" && connectionsLanding > landedRingPlayed;
    const tooltipText = `${label} — ${tab.hint}`;
    return (
      <button
        key={tab.id}
        id={`context-rail-tab-${tab.id}`}
        aria-label={label}
        aria-describedby={`context-rail-tab-${tab.id}-hint`}
        aria-selected={isActive && open}
        aria-controls={open ? "context-rail-panel" : undefined}
        className={`context-rail__tab${isActive ? " is-active" : ""}${
          landing ? " is-landing" : ""
        }`}
        role="tab"
        tabIndex={isActive ? 0 : -1}
        type="button"
        // The rail's one tooltip, shared with its panels' controls: a tab's
        // explanation is replaced, never joined, when a panel control raises
        // its own. A second tooltip system here left both on screen.
        onMouseEnter={(event) => railTooltip.showAfterDelay(event.currentTarget, tooltipText)}
        onMouseLeave={railTooltip.hide}
        onFocus={(event) => railTooltip.show(event.currentTarget, tooltipText)}
        onBlur={railTooltip.hide}
        onClick={() => selectTab(tab.id)}
        onAnimationEnd={landing ? () => setLandedRingPlayed(connectionsLanding) : undefined}
      >
        <TabIcon size={18} aria-hidden="true" />
        {/* The tooltip is sighted-only; this carries its explanation to
            assistive tech without changing the tab's accessible name. */}
        <span id={`context-rail-tab-${tab.id}-hint`} hidden>{tab.hint}</span>
        {jobsRunning > 0 ? <span className="context-rail__activity status-dot status-dot--active" aria-hidden="true" /> : null}
        {todoBadge ? (
          <span
            className={`context-rail__activity context-rail__activity--todos${
              todoBadge.unread ? "" : " context-rail__activity--quiet"
            }`}
            aria-hidden="true"
          >
            {todoBadge.count > 9 ? "9+" : todoBadge.count}
          </span>
        ) : null}
        {watchCount > 0 || suspended ? (
          <span
            className={`context-rail__activity context-rail__activity--watches${
              suspended ? " context-rail__activity--suspended" : ""
            }`}
            aria-hidden="true"
          >
            {watchCount > 9 ? "9+" : watchCount > 0 ? watchCount : <PauseIcon size={8} />}
          </span>
        ) : null}
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
    switch (activeRailTab) {
      case "details":
        return renderDetails();
      case "connections":
        if (!props.launchpadConnections) return null;
        return (
          <ConnectionsPanel onShowOnLaunchpad={props.launchpadConnections.onShowOnLaunchpad}>
            {props.launchpadConnections.content}
          </ConnectionsPanel>
        );
      case "research": {
        const ownerTarget = props.thread
          ? resolveThreadOwnerFederationTarget(props.thread, readRendererFederationTarget()?.instanceId)
          : undefined;
        return (
          <ResearchPanel
            key={`${ownerTarget?.instanceId ?? "local"}:${props.thread?.source}:${props.thread?.id}`}
            desktopApi={props.desktopApi}
            thread={props.thread}
            onOpenSettings={ownerTarget ? undefined : props.onOpenResearchSettings}
            decisionSettings={ownerTarget ? undefined : props.decisionSettings}
            onOpenDecisionSettings={ownerTarget ? undefined : props.onOpenDecisionSettings}
          />
        );
      }
      case "todos":
        if (!props.thread || !props.todos) return null;
        return (
          <ThreadTodosPanel
            threadRunning={Boolean(props.activeTurnId)}
            view={props.todos.view}
            threadKey={props.todos.threadKey}
            projectKey={props.todos.projectKey}
            projectOwner={props.todos.projectOwner}
            onStartReview={props.todos.onStartReview}
            reviewSetup={props.todos.reviewSetup}
            onDoHere={props.todos.onDoHere}
            onAnswerQuestion={props.todos.onAnswerQuestion}
            sentQuestionAnswers={props.todos.sentQuestionAnswers}
            revealRequest={props.todos.revealRequest}
          />
        );
      case "pricing":
        if (!props.thread) return null;
        return (
          <PricingPanel
            desktopApi={props.desktopApi}
            backends={props.backends}
            ownerBackends={props.ownerBackends}
            thread={{ id: props.thread.id, source: props.thread.source, federation: props.thread.federation, updatedAt: props.thread.updatedAt }}
            subThreadCount={props.thread.ordinaryChildCount}
            activeTurnId={props.activeTurnId}
            pricing={props.pricing}
            display={displayResource.data?.pricingPage}
            loading={displayResource.loading}
            onLoadMore={displayResource.data?.nextCursor ? displayResource.loadMore : undefined}
            displayOptions={props.pricingDisplayOptions}
            onOpenTokenMiserSavings={
              props.onOpenToolOutputIncidentExplorer
                ? openTokenMiserSavings
                : undefined
            }
            onScrollToTurn={props.onScrollToTurn}
            subAgents={props.thread.subAgents}
            tokenMiserAccounting={props.tokenMiserAccounting}
            threadReasoningEffort={props.thread.reasoningEffort}
            turnFailures={props.thread.turnFailureLog}
          />
        );
      case "decisions":
        if (!props.thread) return null;
        return (
          <DecisionsPanel
            desktopApi={props.desktopApi}
            thread={{ backend: props.thread.source, threadId: props.thread.id }}
            snapshot={decisionsRail.snapshot}
            error={decisionsRail.error}
            onRefresh={decisionsRail.refresh}
            settings={props.decisionSettings}
            onOpenSettings={props.onOpenDecisionSettings}
            onDetailsModalOpenChange={handlePortaledInteractionChange}
          />
        );
      case "waiting": {
        if (!props.thread) return null;
        const thread = props.thread;
        const federationTarget = thread.federation?.ref.target ?? readRendererFederationTarget();
        const ownerLabel = thread.federation
          ? thread.federation.instanceLabel
          : readRendererFederationTarget() ? "the thread's own machine" : undefined;
        const sendNow = props.desktopApi?.sendScheduledThreadActionNow;
        const resolveHeld = props.desktopApi?.resolveProjectHeldWakeups;
        const turnOffAutoFix = props.onSetThreadPrAutoDispatch;
        const openContinueAfter = dependencyContext?.open;
        const setJobMonitorCreation = threadJobMonitorControl(props.desktopApi, thread, federationTarget);
        // A peer's checkout queue lives on the peer; this window reads its own.
        const readResourceCheckouts = federationTarget ? undefined : props.desktopApi?.readResourceCheckouts;
        const openResources = federationTarget ? undefined : props.desktopApi?.openResourceCheckoutsWindow;
        return (
          <WaitingForPanel
            key={JSON.stringify([thread.source, thread.id, federationTarget])}
            thread={thread}
            controller={pendingWakes}
            onFocusHeading={props.onFocusWaitingHeading}
            ownerLabel={ownerLabel}
            onTurnOffAutoFix={turnOffAutoFix ? async () => await turnOffAutoFix(false) : undefined}
            onTurnOnJobMonitors={setJobMonitorCreation ? async () => {
              await setJobMonitorCreation(true);
              await props.onRefreshNavigation?.().catch(() => undefined);
            } : undefined}
            onSendScheduledNow={sendNow ? async (id) => {
              await sendNow({ id, ...(federationTarget ? { federationTarget } : {}) });
            } : undefined}
            onSendHeldNow={resolveHeld ? async (wake) => {
              if (wake.held?.kind !== "project_paused") return;
              // The project's own release, as its Resume dialog sends one.
              const { results } = await resolveHeld({
                directoryKey: wake.held.directoryKey,
                resolutions: [{ entryId: wake.entryId, backend: thread.source, threadId: thread.id, action: "send" }],
                ...(federationTarget ? { federationTarget } : {}),
              });
              const result = results.find((candidate) => candidate.entryId === wake.entryId);
              if (result?.status !== "sent") {
                throw new Error(result?.error ?? "That wake-up is no longer held.");
              }
            } : undefined}
            onUnlockThread={props.onUnlockThread}
            onShowTab={showContextTab}
            onOpenContinueAfter={openContinueAfter ? () => openContinueAfter(thread) : undefined}
            readResourceCheckouts={readResourceCheckouts}
            onOpenResource={openResources ? (resourceId) => { void openResources({ resourceId }); } : undefined}
          />
        );
      }
      case "providers":
        return (
          <ProviderStatusPanel
            backends={props.backends}
            backendError={props.backendError}
            desktopApi={props.desktopApi}
          />
        );
    }
  }


  function renderDetails() {
    const thread = props.thread;
    if (!thread) return null;
    const changedFiles = countChangedFiles(editedFileGroups);
    const prCount = thread.prs?.length ?? 0;
    const prDescription = [
      prCount ? `${prCount} pull request${prCount === 1 ? "" : "s"}` : undefined,
      prWatchCount ? `${prWatchCount} watch${prWatchCount === 1 ? "" : "es"} waking this thread` : undefined,
    ].filter(Boolean).join(" · ");
    return (
      <DetailsPanel
        segment={detailsSegment}
        section={activeTarget.section}
        revealKey={activeTab}
        badges={{
          changes: {
            count: changedFiles,
            description: changedFiles ? `${changedFiles} file${changedFiles === 1 ? "" : "s"} changed` : undefined,
          },
          prs: { count: prCount, description: prDescription || undefined },
          jobs: {
            count: jobsSummary.running,
            description: jobsSummary.running ? `${jobsSummary.running} running` : undefined,
          },
        }}
        onSelectSegment={selectDetailsSegment}
      >
        {renderDetailsSegment(thread)}
      </DetailsPanel>
    );
  }

  function renderDetailsSegment(thread: NavigationPresentedThread) {
    switch (detailsSegment) {
      case "thread":
        return (
          <DetailsThreadView
            thread={thread}
            backends={props.backends}
            desktopApi={props.desktopApi}
            platform={props.platform}
            initialLoadDurationMs={props.initialLoadDurationMs}
            cost={threadCost}
            activeTurnId={props.activeTurnId}
            controls={props.detailsControls}
            actionRuns={actionRuns}
            onStopEnvActionRun={props.onStopEnvActionRun}
            onRefreshNavigation={props.onRefreshNavigation}
            onRestoreWorktree={props.onRestoreWorktree}
            worktreeArchiveError={props.worktreeArchiveError}
            onOpenToolOutputIncidentExplorer={
              onOpenToolOutputIncidentExplorer ? openIncidentExplorer : undefined
            }
            onShowChanges={() => selectDetailsSegment("changes")}
            onShowPullRequests={() => selectDetailsSegment("prs")}
            showTooltip={showRailTooltip}
            hideTooltip={hideRailTooltip}
            onPortaledInteractionChange={handlePortaledInteractionChange}
          />
        );
      case "changes":
        return (
          <EditsPanel
            backend={thread.source}
            groups={editedFileGroups}
            commitStatesByKey={props.editedFileCommitStates}
            worktreeRoot={editsWorktreeRoot}
            desktopApi={props.desktopApi}
            threadId={thread.id}
            workingStateRefreshKey={JSON.stringify({
              fetchedAt: thread.gitWorkingStateFetchedAt,
              state: thread.gitWorkingState ?? null,
            })}
            onOpenFile={props.onOpenEditedFile}
            preferredEditor={props.preferredEditor}
            onScrollToTurn={props.onScrollToTurn}
            dock={props.editedFilesDock ?? "above"}
            onDockChange={props.onEditedFilesDockChange ?? noop}
          />
        );
      case "prs": {
        const prs = thread.prs ?? [];
        const prKeys = prs.map((pr) => buildPullRequestStatusKey(pr));
        const threadKey = `${thread.source}\0${thread.id}`;
        const chosen = activityPr?.thread === threadKey ? activityPr.key : undefined;
        const selectedPrKey = chosen === ALL_PULL_REQUESTS
          ? undefined
          : chosen && prKeys.includes(chosen) ? chosen : prKeys[0];
        return (
          <>
            <PullRequestsPanel
              desktopApi={props.desktopApi}
              onRefreshNavigation={props.onRefreshNavigation}
              onSetThreadPrAutoDispatch={props.onSetThreadPrAutoDispatch}
              thread={thread}
            />
            <div data-details-section="activity">
              <PrActivityPanel
                desktopApi={props.desktopApi}
                thread={thread}
                prKey={selectedPrKey}
                prFilter={prs.length > 1 ? (
                  <Select
                    aria-label="Activity for"
                    className="settings-select details-select"
                    value={selectedPrKey ?? ALL_PULL_REQUESTS}
                    options={[
                      ...prs.map((pr, index) => ({
                        value: prKeys[index]!,
                        label: `#${pr.number}${pr.title?.trim() ? ` ${pr.title.trim()}` : ""}`,
                      })),
                      { value: ALL_PULL_REQUESTS, label: "All of this thread's PRs" },
                    ]}
                    onChange={(key) => setActivityPr({ thread: threadKey, key })}
                  />
                ) : undefined}
              />
            </div>
          </>
        );
      }
      case "jobs":
        return <>{jobsSummary.order.map((section) => renderJobsSection(section, thread))}</>;
    }
  }

  function renderJobsSection(section: DetailsJobsSectionId, thread: NavigationPresentedThread) {
    switch (section) {
      case "commands":
        return (
          <div key={section} data-details-section="commands">
            <ActionRunsPanel
              {...props.backgroundTerminals}
              dock={props.actionRunsDock ?? "above"}
              environmentName={props.actionRunsEnvironmentName}
              onDockChange={changeActionRunsDock}
              onDismissRun={props.onDismissEnvActionRun}
              onStopRun={props.onStopEnvActionRun}
              runs={actionRuns}
            />
          </div>
        );
      case "subagents":
        return (
          <div key={section} data-details-section="subagents">
            {displayResource.loading && !displayResource.data ? (
              <p className="context-empty">Loading…</p>
            ) : subAgentsPanelThread ? (
              <SubAgentsPanel
                lens={displayResource.data?.subAgentLens}
                lensCounts={displayResource.data?.subAgentCounts}
                onSelectLens={setSubAgentLens}
                onLoadMore={displayResource.data?.nextCursor ? displayResource.loadMore : undefined}
                loading={displayResource.loading}
                desktopApi={props.desktopApi}
                onRefreshNavigation={props.onRefreshNavigation}
                pricingDisplayOptions={props.pricingDisplayOptions}
                thread={subAgentsPanelThread}
                onDetailsModalOpenChange={handlePortaledInteractionChange}
              />
            ) : null}
          </div>
        );
      case "scheduled":
        return (
          <div key={section} data-details-section="scheduled">
            <ThreadAutomationsPanel
              desktopApi={props.desktopApi}
              thread={thread}
              onOpenAutomations={props.onOpenAutomations}
              onRefreshNavigation={props.onRefreshNavigation}
            />
          </div>
        );
    }
  }

}

/**
 * The To-dos tab's badge. Filled, it counts what the operator has not seen
 * in any thread, since a question raised elsewhere is the case it exists
 * for. With nothing unread it falls back to this thread's open items,
 * outlined.
 */
function readTodoTabBadge(
  view: ThreadTodosView,
  threadKey: string,
): { count: number; unread: boolean } | undefined {
  let unread = 0;
  for (const wait of view.waits) {
    if (!view.seenKeys.has(wait.key)) unread += 1;
  }
  for (const todo of view.open) {
    if (!view.seenKeys.has(operatorTodoItemKey(todo.id))) unread += 1;
  }
  if (unread > 0) return { count: unread, unread: true };
  const open = (view.openByThreadKey.get(threadKey)?.length ?? 0)
    + (view.waitsByThreadKey.get(threadKey)?.length ?? 0);
  return open > 0 ? { count: open, unread: false } : undefined;
}
