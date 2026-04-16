import type { NavigationThreadSummary } from "@pwragnt/shared";

type ThreadContextPanelProps = {
  platform?: string;
  thread: NavigationThreadSummary;
};

export function ThreadContextPanel(
  props: ThreadContextPanelProps
) {
  return (
    <aside className="context-panel" aria-label="Thread context">
      <section className="context-panel__section">
        <h3>Linked directories</h3>
        {props.thread.linkedDirectories.length > 0 ? (
          <ul className="context-list">
            {props.thread.linkedDirectories.map((directory) => (
              <li key={directory.id} className="context-list__item">
                <span className="context-list__label" title={directory.path}>
                  {directory.label}
                </span>
                <span className="context-list__meta">{directory.kind}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="context-empty">No linked directory</p>
        )}
      </section>

      <section className="context-panel__section">
        <h3>Execution context</h3>
        <dl className="context-grid">
          <div>
            <dt>Backend</dt>
            <dd>{props.thread.source}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd className="context-grid__mono">
              {props.thread.gitBranch ?? "Not attached"}
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{props.thread.updatedAt ? formatTimestamp(props.thread.updatedAt) : "Unknown"}</dd>
          </div>
          <div>
            <dt>Desktop</dt>
            <dd>{props.platform ?? "Unknown"}</dd>
          </div>
        </dl>
      </section>
    </aside>
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
