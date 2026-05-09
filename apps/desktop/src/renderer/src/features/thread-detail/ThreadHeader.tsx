import {
  isBranchDrifted,
  type MessagingChannelKind,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import type { DesktopApi } from "../../lib/desktop-api";

type ThreadHeaderProps = {
  desktopApi?: DesktopApi;
  thread: NavigationThreadSummary;
  /** Forwarded to MessagingStatusBar — fires when a platform chip is clicked. */
  onOpenMessagingActivity?: (platform: MessagingChannelKind) => void;
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
  const branchDrifted = isBranchDrifted(
    props.thread.gitBranch,
    props.thread.observedGitBranch,
  );

  return (
    <header className="thread-header">
      <div className="thread-header__main">
        <div className="thread-header__eyebrow-row">
          <h2 className="thread-header__compact-title" title={props.thread.title}>
            {props.thread.title}
          </h2>
          <span className="thread-row__chip thread-row__chip--backend">
            {formatBackendLabel(props.thread.source)}
          </span>
          <span className="thread-row__chip thread-row__chip--mode">
            {formatExecutionModeLabel(props.thread.executionMode)}
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
