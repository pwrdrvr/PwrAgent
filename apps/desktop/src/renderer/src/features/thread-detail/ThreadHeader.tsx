import type { NavigationThreadSummary } from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";

type ThreadHeaderProps = {
  thread: NavigationThreadSummary;
};

export function ThreadHeader(props: ThreadHeaderProps) {
  return (
    <header className="thread-header">
      <div>
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
      </div>
    </header>
  );
}
