import {
  isBranchDrifted,
  type BackendSummary,
  type MessagingChannelKind,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatAccessModeLabel } from "../../lib/execution-mode";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import type { DesktopApi } from "../../lib/desktop-api";

type ThreadHeaderProps = {
  desktopApi?: DesktopApi;
  projectLabel?: string;
  thread: NavigationThreadSummary;
  backends?: BackendSummary[];
  /** Forwarded to MessagingStatusBar — fires when a platform chip is clicked. */
  onOpenMessagingActivity?: (platform: MessagingChannelKind) => void;
  onRevealSelectedThreadInList?: () => void;
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

  return (
    <header className="thread-header">
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
          <span className="chip chip--mode">
            {formatAccessModeLabel(
              props.thread,
              props.backends?.find((backend) => backend.kind === props.thread.source),
            )}
          </span>
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
      </div>
      <MessagingStatusBar
        desktopApi={props.desktopApi}
        onOpenActivity={props.onOpenMessagingActivity}
      />
    </header>
  );
}
