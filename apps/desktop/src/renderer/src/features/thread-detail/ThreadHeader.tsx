import {
  isBranchDrifted,
  type BackendSummary,
  type MessagingChannelKind,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { TerminalIcon } from "../../icons/TerminalIcon";
import { HistoryIcon } from "../../icons/HistoryIcon";
import { SubAgentsIcon } from "../../icons/SubAgentsIcon";
import { StarMapIcon } from "../../icons/StarMapIcon";
import { PanelToggleButtons } from "../chrome/PanelToggleButtons";
import {
  HistoryNavButtons,
  type HistoryNavControls,
} from "../chrome/HistoryNavButtons";
import { FederationRemoteBadge } from "../chrome/FederationRemoteBadge";
import { MastheadActions, type MastheadActionsProps } from "../chrome/MastheadActions";
import { formatAutomationRelative } from "../automations/automation-format";

type ThreadHeaderLayoutControls = {
  sidebarOpen: boolean;
  railOpen: boolean;
  terminalOpen: boolean;
  /** A PTY is alive for this thread even if the panel is collapsed. */
  terminalRunning?: boolean;
  /**
   * Why the terminal cannot open right now (remote thread whose peer lacks
   * `remote_pty` or is disconnected). Renders the toggle disabled with this
   * as its tooltip instead of hiding it.
   */
  terminalDisabledReason?: string;
  onToggleSidebar: () => void;
  onToggleRail: () => void;
  onToggleTerminal: () => void;
};

/**
 * The header's Star Map control. The map lives in its own OS window, so
 * this is a launcher, not a toggle — opening again focuses the existing
 * window instead of closing anything.
 */
export type StarMapToggleControls = {
  onOpen: () => void;
};

type ThreadHeaderProps = {
  desktopApi?: DesktopApi;
  hasApprovalRequest?: boolean;
  projectLabel?: string;
  thread: NavigationThreadSummary;
  backends?: BackendSummary[];
  /** Forwarded to MessagingStatusBar - opens Messaging Activity. */
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  /** Forwarded to MessagingStatusBar - opens Settings at Messaging. */
  onOpenMessagingSettings?: () => void;
  onRevealSelectedThreadInList?: () => void;
  /**
   * Window panel toggles. Rendered here (top-right, beside MSG) on
   * macOS/Linux; on Windows the AppTitleBar owns them instead, so this
   * is skipped to avoid a duplicate control + a second hotkey listener.
   */
  layout?: ThreadHeaderLayoutControls;
  /**
   * Star Map mission-control toggle, rendered left of the MSG chip on
   * macOS/Linux (Windows renders it in the AppTitleBar instead). Absent in
   * federation remote windows — the map is a whole-federation surface owned
   * by the primary window.
   */
  starMap?: StarMapToggleControls;
  /**
   * The wordmark + action buttons that normally live in the sidebar
   * masthead. When the sidebar is hidden (macOS/Linux), they relocate
   * here, left of the thread name, so they don't vanish with the sidebar.
   * Windows keeps them in the AppTitleBar, so this is skipped there.
   */
  masthead?: MastheadActionsProps;
  /**
   * Browser-style Back/Forward across threads + search, rendered at the
   * leading edge of the title bar. Optional so render-only tests don't
   * have to thread history state; App always supplies it.
   */
  history?: HistoryNavControls;
  rewind?: {
    disabledReason?: string;
    onOpen: () => void;
  };
  workflowBudget?: {
    disabledReason?: string;
    onOpen: () => void;
  };
};

/**
 * The thread records a working directory the backend reported, but nothing
 * resolved it to a linked project. Deliberately NOT an "it was deleted" test:
 * the renderer never stats a path, and an empty `linkedDirectories` has
 * several causes besides absence — a cwd that is not a git checkout, a git
 * probe that failed or timed out, or a backend that reports no cwd at all.
 * Absence is only one of them, so the copy this drives must stay limited to
 * what is actually known here. Do not reword it back into a claim about the
 * directory no longer existing without a real absence signal on the summary.
 */
function unlinkedWorkspacePath(thread: NavigationThreadSummary): string | undefined {
  const projectKey = thread.projectKey?.trim();
  if (!projectKey || thread.linkedDirectories.length > 0) {
    return undefined;
  }

  return projectKey;
}

export function ThreadHeader(props: ThreadHeaderProps) {
  const unlinkedPath = unlinkedWorkspacePath(props.thread);
  const projectLabel = props.projectLabel?.trim();
  const branchDrifted = isBranchDrifted(
    props.thread.gitBranch,
    props.thread.observedGitBranch,
  );
  // On Windows the AppTitleBar strip owns the layout toggles + masthead
  // actions; rendering them here too would duplicate the control and the
  // ⌘B/⌘⌥B listener.
  const isWindows = getDesktopApi()?.platform === "win32";
  // When the sidebar is hidden, its wordmark + action buttons relocate
  // here (macOS/Linux only — Windows keeps them in the title bar).
  const sidebarHidden = props.layout ? !props.layout.sidebarOpen : false;
  const showMasthead = sidebarHidden && !isWindows && Boolean(props.masthead);
  // Custom viewport tooltip for the terminal toggle, so it matches the
  // sidebar/rail toggles sitting right beside it instead of falling back to the
  // slow, edge-clipping native `title`.
  const terminalTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const starMapTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const rewindTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const workflowBudgetTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const starMapLabel = "Open Star Map";
  // A collapsed-but-running terminal gets its own affordance: the toggle wears
  // a live dot and says so, otherwise the shell is invisible from here.
  const terminalCollapsedRunning =
    Boolean(props.layout?.terminalRunning) && !props.layout?.terminalOpen;
  const terminalDisabledReason = props.layout?.terminalDisabledReason;
  const terminalLabel =
    terminalDisabledReason ??
    (props.layout?.terminalOpen
      ? "Hide integrated terminal"
      : terminalCollapsedRunning
        ? "Show running integrated terminal"
        : "Open integrated terminal");

  return (
    <header className="thread-header">
      <div className="thread-header__top">
        {showMasthead && props.masthead ? (
          <div className="thread-header__masthead">
            <p className="sidebar__brand">
              Pwr<span className="sidebar__brand-accent">Agent</span>
            </p>
            {/* With the sidebar hidden its remote-instance pill is gone,
                so the title bar becomes the window's only remote marker. */}
            <FederationRemoteBadge />
            <MastheadActions {...props.masthead} />
          </div>
        ) : null}
        {props.history ? <HistoryNavButtons {...props.history} /> : null}
        <div className="thread-header__main">
          <div className="thread-header__eyebrow-row">
            <div className="thread-header__breadcrumb">
              {projectLabel ? (
                <>
                  <span className="thread-header__eyebrow" title={projectLabel}>
                    {projectLabel}
                  </span>
                  <span aria-hidden="true" className="thread-header__separator">
                    ›
                  </span>
                </>
              ) : null}
              <h2
                aria-label={props.thread.title}
                className="thread-header__compact-title"
                title={props.thread.title}
              >
                {props.onRevealSelectedThreadInList ? (
                  <button
                    aria-label="Show selected thread in thread list"
                    className="thread-header__title-button"
                    title="Show in thread list"
                    type="button"
                    onClick={props.onRevealSelectedThreadInList}
                  >
                    {props.thread.title}
                  </button>
                ) : (
                  props.thread.title
                )}
              </h2>
            </div>
            <span className="chip chip--backend">
              {formatBackendLabel(props.thread.source)}
            </span>
            {props.hasApprovalRequest ? (
              <span
                aria-label="Waiting for approval"
                className="thread-row__chip thread-row__chip--approval"
              >
                Waiting for approval
              </span>
            ) : null}
            {props.thread.agent ? (
              <span className="chip chip--mode" title={formatThreadAgentTitle(props.thread)}>
                Agent: {props.thread.agent.name}
              </span>
            ) : null}
            {props.thread.automationSummary?.totalCount ? (
              <span
                className="thread-row__chip thread-row__chip--automation"
                title={formatThreadAutomationTitle(props.thread)}
              >
                {formatThreadAutomationChip(props.thread)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="thread-header__chrome">
          {props.rewind ? (
            <button
              aria-disabled={props.rewind.disabledReason ? true : undefined}
              aria-label={props.rewind.disabledReason ?? "Rewind Grok conversation"}
              className={`thread-header__rewind-toggle${
                props.rewind.disabledReason ? " is-disabled" : ""
              }`}
              type="button"
              onBlur={rewindTooltip.hide}
              onClick={() => {
                rewindTooltip.hide();
                if (!props.rewind?.disabledReason) {
                  props.rewind?.onOpen();
                }
              }}
              onFocus={(event) =>
                rewindTooltip.show(
                  event.currentTarget,
                  props.rewind?.disabledReason ?? "Rewind conversation",
                )
              }
              onMouseEnter={(event) =>
                rewindTooltip.show(
                  event.currentTarget,
                  props.rewind?.disabledReason ?? "Rewind conversation",
                )
              }
              onMouseLeave={rewindTooltip.hide}
            >
              <HistoryIcon size={14} />
            </button>
          ) : null}
          {rewindTooltip.tooltipNode}
          {props.workflowBudget ? (
            <button
              aria-disabled={props.workflowBudget.disabledReason ? true : undefined}
              aria-label={
                props.workflowBudget.disabledReason ?? "Configure Grok workflow budgets"
              }
              className={`thread-header__rewind-toggle${
                props.workflowBudget.disabledReason ? " is-disabled" : ""
              }`}
              type="button"
              onBlur={workflowBudgetTooltip.hide}
              onClick={() => {
                workflowBudgetTooltip.hide();
                if (!props.workflowBudget?.disabledReason) {
                  props.workflowBudget?.onOpen();
                }
              }}
              onFocus={(event) =>
                workflowBudgetTooltip.show(
                  event.currentTarget,
                  props.workflowBudget?.disabledReason ?? "Configure workflow budgets",
                )
              }
              onMouseEnter={(event) =>
                workflowBudgetTooltip.show(
                  event.currentTarget,
                  props.workflowBudget?.disabledReason ?? "Configure workflow budgets",
                )
              }
              onMouseLeave={workflowBudgetTooltip.hide}
            >
              <SubAgentsIcon size={14} />
            </button>
          ) : null}
          {workflowBudgetTooltip.tooltipNode}
          {props.layout && !isWindows ? (
            <PanelToggleButtons
              sidebarOpen={props.layout.sidebarOpen}
              railOpen={props.layout.railOpen}
              onToggleSidebar={props.layout.onToggleSidebar}
              onToggleRail={props.layout.onToggleRail}
            />
          ) : null}
          {/* For a remote (federated) thread this attaches to a PTY running
              on the OWNING instance over the federation transport. When the
              peer lacks the remote_pty grant or is disconnected, the toggle
              renders disabled with the reason as its tooltip. */}
          {props.layout ? (
            <button
              type="button"
              className={`thread-header__terminal-toggle${
                props.layout.terminalOpen ? " is-open" : ""
              }${terminalCollapsedRunning ? " is-running" : ""}${
                terminalDisabledReason ? " is-disabled" : ""
              }`}
              aria-label={terminalLabel}
              aria-pressed={props.layout.terminalOpen}
              // aria-disabled (not `disabled`) so the button still receives
              // hover/focus and can explain WHY via the tooltip.
              aria-disabled={terminalDisabledReason ? true : undefined}
              onClick={() => {
                terminalTooltip.hide();
                if (terminalDisabledReason) return;
                props.layout?.onToggleTerminal();
              }}
              onMouseEnter={(event) =>
                terminalTooltip.show(event.currentTarget, terminalLabel)
              }
              onMouseLeave={terminalTooltip.hide}
              onFocus={(event) =>
                terminalTooltip.show(event.currentTarget, terminalLabel)
              }
              onBlur={terminalTooltip.hide}
            >
              <TerminalIcon size={14} />
            </button>
          ) : null}
          {terminalTooltip.tooltipNode}
          {props.starMap ? (
            <button
              type="button"
              className="thread-header__star-map-toggle"
              aria-label={starMapLabel}
              onClick={() => {
                starMapTooltip.hide();
                props.starMap?.onOpen();
              }}
              onMouseEnter={(event) =>
                starMapTooltip.show(event.currentTarget, starMapLabel)
              }
              onMouseLeave={starMapTooltip.hide}
              onFocus={(event) =>
                starMapTooltip.show(event.currentTarget, starMapLabel)
              }
              onBlur={starMapTooltip.hide}
            >
              <StarMapIcon size={14} />
            </button>
          ) : null}
          {starMapTooltip.tooltipNode}
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={props.onOpenMessagingActivity}
            onOpenSettings={props.onOpenMessagingSettings}
          />
        </div>
      </div>
      {unlinkedPath ? (
        // `role="status"` (polite), not `alert`: this reports an unresolved
        // link, not a failure, and it is derived state that re-announces on
        // every thread selection. Matches the branch-drift banner right
        // below, which shares this class and is the more urgent of the two.
        <p className="thread-header__warning" role="status">
          This thread's recorded working directory is not linked to a project:{" "}
          <code>{unlinkedPath}</code>
        </p>
      ) : null}
      {branchDrifted ? (
        <p className="thread-header__warning" role="status">
          Branch warning: this thread expects <code>{props.thread.gitBranch}</code>, but the
          worktree is on <code>{props.thread.observedGitBranch}</code>.
        </p>
      ) : null}
    </header>
  );
}

function formatThreadAutomationChip(thread: NavigationThreadSummary): string {
  const summary = thread.automationSummary;
  if (!summary) {
    return "";
  }
  if (summary.pendingRunCount > 0) {
    return `${summary.pendingRunCount} queued automation${
      summary.pendingRunCount === 1 ? "" : "s"
    }`;
  }
  if (summary.nextRunAt) {
    return `${summary.enabledCount} automation${
      summary.enabledCount === 1 ? "" : "s"
    } - next ${formatAutomationRelative(summary.nextRunAt)}`;
  }
  return `${summary.totalCount} automation${summary.totalCount === 1 ? "" : "s"}`;
}

function formatThreadAutomationTitle(thread: NavigationThreadSummary): string {
  const summary = thread.automationSummary;
  if (!summary) {
    return "";
  }
  const coalesced = summary.coalescedWindowCount
    ? `, ${summary.coalescedWindowCount} coalesced`
    : "";
  return `${summary.enabledCount} enabled, ${summary.pausedCount} paused${coalesced}`;
}

function formatThreadAgentTitle(thread: NavigationThreadSummary): string {
  const agent = thread.agent;
  if (!agent) {
    return "";
  }
  const guidance = agent.instructionsTooLong
    ? `, instructions over ${agent.instructionLineCount} lines`
    : agent.instructionLineCount <= 0
      ? ", no Agent instructions"
      : `, ${agent.instructionLineCount} instruction line${
          agent.instructionLineCount === 1 ? "" : "s"
        }`;
  return `${agent.name}${guidance}`;
}
