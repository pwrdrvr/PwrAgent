import type { NavigationThreadSummary } from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";

type ThreadHeaderProps = {
  thread: NavigationThreadSummary;
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
        {missingPath ? (
          <p className="thread-header__warning" role="alert">
            This thread is linked to a directory that no longer exists:{" "}
            <code>{missingPath}</code>
          </p>
        ) : null}
      </div>
    </header>
  );
}
