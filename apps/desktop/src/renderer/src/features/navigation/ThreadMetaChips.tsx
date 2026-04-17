import type { NavigationThreadSummary } from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";

type ThreadMetaChipsProps = {
  includeLinkedDirectories?: boolean;
  thread: NavigationThreadSummary;
};

export function ThreadMetaChips({
  includeLinkedDirectories = false,
  thread,
}: ThreadMetaChipsProps) {
  const linkedDirectoryChips = includeLinkedDirectories
    ? thread.linkedDirectories.length > 0
      ? thread.linkedDirectories.map((directory) => (
          <span
            aria-label={`Copy path for ${directory.label}`}
            key={`${thread.id}:${directory.id}`}
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
              {directory.kind === "worktree" ? "🔀" : "📁"}
            </span>
            {directory.label}
          </span>
        ))
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

      {linkedDirectoryChips}

      {thread.gitBranch ? (
        <span className="thread-row__chip thread-row__chip--mono">
          <span aria-hidden="true" className="thread-row__chip-icon">
            🌿
          </span>
          {thread.gitBranch}
        </span>
      ) : null}
    </span>
  );
}
