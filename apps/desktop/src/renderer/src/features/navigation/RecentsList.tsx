import type { NavigationThreadSummary } from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { ThreadMetaChips } from "./ThreadMetaChips";

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

            <ThreadMetaChips includeLinkedDirectories thread={thread} />
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
