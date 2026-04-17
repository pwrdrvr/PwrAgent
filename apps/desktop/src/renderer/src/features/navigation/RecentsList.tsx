import type { NavigationThreadSummary } from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";

type RecentsListProps = {
  selectedThreadKey?: string;
  threads: NavigationThreadSummary[];
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function RecentsList(props: RecentsListProps) {
  return (
    <div className="sidebar-list sidebar-list--dense" role="list">
      {props.threads.map((thread) => {
        const selected =
          buildThreadIdentityKey(thread.source, thread.id) === props.selectedThreadKey;
        return (
          <button
            key={buildThreadIdentityKey(thread.source, thread.id)}
            aria-pressed={selected}
            className={`thread-row${selected ? " is-selected" : ""}`}
            type="button"
            onClick={() => props.onSelectThread(thread)}
          >
            <span className="thread-row__header">
              <span className="thread-row__title">{thread.title}</span>
              <span className="thread-row__time">
                {formatRelativeTime(thread.updatedAt)}
              </span>
            </span>

            {thread.summary ? (
              <span className="thread-row__summary">{thread.summary}</span>
            ) : null}

            <span className="thread-row__meta">
              <span className="thread-row__chip thread-row__chip--backend">
                {formatBackendLabel(thread.source)}
              </span>

              {thread.linkedDirectories.length > 0 ? (
                thread.linkedDirectories.map((directory) => (
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
              ) : (
                <span className="thread-row__chip thread-row__chip--muted">
                  No linked directory
                </span>
              )}

              {thread.gitBranch ? (
                <span className="thread-row__chip thread-row__chip--mono">
                  <span aria-hidden="true" className="thread-row__chip-icon">
                    🌿
                  </span>
                  {thread.gitBranch}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return "now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(timestamp);
}
