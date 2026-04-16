import type { NavigationThreadSummary } from "@pwragnt/shared";

type ThreadHeaderProps = {
  fetchedAt?: number;
  messageCount: number;
  thread: NavigationThreadSummary;
};

export function ThreadHeader(props: ThreadHeaderProps) {
  return (
    <header className="thread-header">
      <div>
        <p className="eyebrow">Thread detail</p>
        <h2 className="thread-header__title">{props.thread.title}</h2>
        {props.thread.summary ? (
          <p className="thread-header__summary">{props.thread.summary}</p>
        ) : null}
      </div>

      <div className="thread-header__stats">
        <div>
          <span className="thread-header__stat-label">Messages</span>
          <strong>{props.messageCount}</strong>
        </div>
        <div>
          <span className="thread-header__stat-label">Synced</span>
          <strong>{props.fetchedAt ? formatTimestamp(props.fetchedAt) : "Waiting"}</strong>
        </div>
      </div>
    </header>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}
