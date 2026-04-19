import type { NavigationThreadSummary } from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { ThreadMarkdown } from "./ThreadMarkdown";

type ThreadHeaderProps = {
  fetchedAt?: number;
  messageCount: number;
  thread: NavigationThreadSummary;
};

export function ThreadHeader(props: ThreadHeaderProps) {
  return (
    <header className="thread-header">
      <div>
        <div className="thread-header__eyebrow-row">
          <p className="eyebrow">Thread detail</p>
          <span className="thread-row__chip thread-row__chip--backend">
            {formatBackendLabel(props.thread.source)}
          </span>
          <span className="thread-row__chip thread-row__chip--mode">
            {formatExecutionModeLabel(props.thread.executionMode)}
          </span>
        </div>
        <h2 className="thread-header__title">{props.thread.title}</h2>
        {props.thread.summary ? (
          <ThreadMarkdown
            className="thread-header__summary"
            text={props.thread.summary}
            variant="summary"
          />
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
