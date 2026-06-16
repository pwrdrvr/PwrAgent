import {
  isBranchDrifted,
  type BackendSummary,
  type MessagingChannelKind,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { accessModeChipClassName, formatAccessModeLabel } from "../../lib/execution-mode";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { PanelToggleButtons } from "../chrome/PanelToggleButtons";
import {
  HistoryNavButtons,
  type HistoryNavControls,
} from "../chrome/HistoryNavButtons";
import { MastheadActions, type MastheadActionsProps } from "../chrome/MastheadActions";
import { formatAutomationRelative } from "../automations/automation-format";

type ThreadHeaderLayoutControls = {
  sidebarOpen: boolean;
  railOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRail: () => void;
};

type ThreadHeaderProps = {
  desktopApi?: DesktopApi;
  projectLabel?: string;
  thread: NavigationThreadSummary;
  backends?: BackendSummary[];
  /** Forwarded to MessagingStatusBar - opens Messaging Activity. */
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  onRevealSelectedThreadInList?: () => void;
  /**
   * Window panel toggles. Rendered here (top-right, beside MSG) on
   * macOS/Linux; on Windows the AppTitleBar owns them instead, so this
   * is skipped to avoid a duplicate control + a second hotkey listener.
   */
  layout?: ThreadHeaderLayoutControls;
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
};

function missingDirectoryPath(thread: NavigationThreadSummary): string | undefined {
  const projectKey = thread.projectKey?.trim();
  if (!projectKey || thread.linkedDirectories.length > 0) {
    return undefined;
  }

  return projectKey;
}

export function ThreadHeader(props: ThreadHeaderProps) {
  const missingPath = missingDirectoryPath(props.thread);
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

  return (
    <header className="thread-header">
      <div className="thread-header__top">
        {showMasthead && props.masthead ? (
          <div className="thread-header__masthead">
            <p className="sidebar__brand">
              Pwr<span className="sidebar__brand-accent">Agent</span>
            </p>
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
            <span className={accessModeChipClassName(props.thread.executionMode)}>
              {formatAccessModeLabel(
                props.thread,
                props.backends?.find((backend) => backend.kind === props.thread.source),
              )}
            </span>
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
          {props.layout && !isWindows ? (
            <PanelToggleButtons
              sidebarOpen={props.layout.sidebarOpen}
              railOpen={props.layout.railOpen}
              onToggleSidebar={props.layout.onToggleSidebar}
              onToggleRail={props.layout.onToggleRail}
            />
          ) : null}
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={props.onOpenMessagingActivity}
          />
        </div>
      </div>
      {missingPath ? (
        <p className="thread-header__warning" role="alert">
          This thread is linked to a directory that no longer exists:{" "}
          <code>{missingPath}</code>
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
