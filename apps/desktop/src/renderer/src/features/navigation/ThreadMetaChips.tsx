import type { NavigationThreadSummary } from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";

type ThreadMetaChipsProps = {
  hasApprovalRequest?: boolean;
  includeLinkedDirectories?: boolean;
  linkedDirectoryMode?: "label" | "kind";
  thread: NavigationThreadSummary;
};

export function ThreadMetaChips({
  hasApprovalRequest = false,
  includeLinkedDirectories = false,
  linkedDirectoryMode = "label",
  thread,
}: ThreadMetaChipsProps) {
  const branchDrifted =
    thread.gitBranch &&
    thread.observedGitBranch &&
    thread.observedGitBranch !== thread.gitBranch;
  const linkedDirectoryChips = includeLinkedDirectories
    ? thread.linkedDirectories.length > 0
      ? linkedDirectoryMode === "kind"
        ? [
            ...new Map(
              thread.linkedDirectories.map((directory) => [
                directory.kind,
                (
                  <span
                    aria-label={
                      directory.kind === "worktree"
                        ? `Copy path for worktree ${directory.label}`
                        : `Copy local path for ${directory.label}`
                    }
                    key={`${thread.id}:${directory.kind}:location-kind`}
                    className="thread-row__chip path-copy-target tooltip-target thread-row__chip--mono"
                    role="button"
                    tabIndex={0}
                    data-tooltip={formatCopyTooltip(
                      directory.kind === "worktree"
                        ? directory.worktreePath ?? directory.path
                        : directory.path
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void copyText(
                        directory.kind === "worktree"
                          ? directory.worktreePath ?? directory.path
                          : directory.path
                      );
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") {
                        return;
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      void copyText(
                        directory.kind === "worktree"
                          ? directory.worktreePath ?? directory.path
                          : directory.path
                      );
                    }}
                  >
                    {directory.kind}
                  </span>
                ),
              ]),
            ).values(),
          ]
        : thread.linkedDirectories.map((directory) => {
            const copyPath =
              directory.kind === "worktree"
                ? directory.worktreePath ?? directory.path
                : directory.path;
            return (
              <span
                aria-label={
                  directory.kind === "worktree"
                    ? `Copy path for worktree ${directory.label}`
                    : `Copy path for ${directory.label}`
                }
                key={`${thread.id}:${directory.id}:root`}
                className="thread-row__chip path-copy-target tooltip-target"
                role="button"
                tabIndex={0}
                data-tooltip={formatCopyTooltip(copyPath)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void copyText(copyPath);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }

                  event.preventDefault();
                  event.stopPropagation();
                  void copyText(copyPath);
                }}
              >
                <span aria-hidden="true" className="thread-row__chip-icon">
                  {directory.kind === "worktree" ? "🔀" : "📁"}
                </span>
                {directory.label}
              </span>
            );
          })
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
