import type { NavigationThreadSummary } from "@pwragnt/shared";
import { Fragment } from "react";
import { formatBackendLabel } from "../../lib/backend-label";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";

type ThreadMetaChipsProps = {
  hasApprovalRequest?: boolean;
  includeLinkedDirectories?: boolean;
  thread: NavigationThreadSummary;
};

export function ThreadMetaChips({
  hasApprovalRequest = false,
  includeLinkedDirectories = false,
  thread,
}: ThreadMetaChipsProps) {
  const branchDrifted =
    thread.gitBranch &&
    thread.observedGitBranch &&
    thread.observedGitBranch !== thread.gitBranch;
  const linkedDirectoryChips = includeLinkedDirectories
    ? thread.linkedDirectories.length > 0
      ? thread.linkedDirectories.flatMap((directory) => [
          (
            <span
              aria-label={`Copy path for ${directory.label}`}
              key={`${thread.id}:${directory.id}:root`}
              className="thread-row__chip path-copy-target tooltip-target"
              role="button"
              tabIndex={0}
              data-tooltip={formatCopyTooltip(directory.path)}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void copyText(directory.path);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                void copyText(directory.path);
              }}
            >
              <span aria-hidden="true" className="thread-row__chip-icon">
                {directory.worktreePath ? "🔀" : "📁"}
              </span>
              {directory.label}
            </span>
          ),
          directory.worktreePath ? (
            <span
              aria-label={`Copy path for worktree ${directory.label}`}
              key={`${thread.id}:${directory.id}:worktree`}
              className="thread-row__chip path-copy-target tooltip-target thread-row__chip--mono"
              role="button"
              tabIndex={0}
              data-tooltip={formatCopyTooltip(directory.worktreePath ?? directory.path)}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void copyText(directory.worktreePath ?? directory.path);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                void copyText(directory.worktreePath ?? directory.path);
              }}
            >
              worktree
            </span>
          ) : (
            <Fragment key={`${thread.id}:${directory.id}:worktree`} />
          ),
        ])
      : (
          <span className="thread-row__chip thread-row__chip--muted">
            No linked directory
          </span>
        )
    : null;

  return (
    <span className="thread-row__meta">
      <span className="thread-row__chip thread-row__chip--backend">
        {formatBackendLabel(thread.source)}
      </span>

      {hasApprovalRequest ? (
        <span
          aria-label="Waiting for approval"
          className="thread-row__chip thread-row__chip--approval"
          title="Waiting for approval"
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            !
          </span>
          Waiting for approval
        </span>
      ) : null}

      {linkedDirectoryChips}

      {thread.gitBranch ? (
        <span className="thread-row__chip thread-row__chip--mono">
          <span aria-hidden="true" className="thread-row__chip-icon">
            🌿
          </span>
          {thread.gitBranch}
        </span>
      ) : null}

      {branchDrifted ? (
        <span
          className="thread-row__chip thread-row__chip--muted thread-row__chip--mono"
          title={`Current branch: ${thread.observedGitBranch}`}
        >
          <span aria-hidden="true" className="thread-row__chip-icon">
            !
          </span>
          now {thread.observedGitBranch}
        </span>
      ) : null}
    </span>
  );
}
