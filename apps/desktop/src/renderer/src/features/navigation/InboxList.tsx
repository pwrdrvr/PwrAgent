import type { NavigationThreadSummary } from "@pwragnt/shared";

type InboxListProps = {
  selectedThreadId?: string;
  threads: NavigationThreadSummary[];
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function InboxList(props: InboxListProps) {
  if (props.threads.length === 0) {
    return (
      <p className="sidebar-empty">
        Nothing is waiting on you.
      </p>
    );
  }

  return (
    <div className="sidebar-list" role="list">
      {props.threads.slice(0, 4).map((thread) => {
        const selected = thread.id === props.selectedThreadId;
        return (
          <button
            key={thread.id}
            aria-pressed={selected}
            className={`thread-row thread-row--compact${selected ? " is-selected" : ""}`}
            type="button"
            onClick={() => props.onSelectThread(thread)}
          >
            <span className="thread-row__title">{thread.title}</span>
            <span className="thread-row__time">
              {formatRelativeTime(thread.updatedAt)}
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
