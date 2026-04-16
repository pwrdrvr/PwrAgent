import { useState } from "react";
import type { NavigationThreadSummary } from "@pwragnt/shared";

type ThreadContextPanelProps = {
  platform?: string;
  thread: NavigationThreadSummary;
};

export function ThreadContextPanel(props: ThreadContextPanelProps) {
  const [pinned, setPinned] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const open = pinned || revealed;

  return (
    <aside
      aria-label="Thread context"
      className={`context-rail${open ? " is-open" : " is-collapsed"}${
        pinned ? " is-pinned" : ""
      }`}
      onMouseEnter={() => {
        if (!pinned) {
          setRevealed(true);
        }
      }}
      onMouseLeave={() => {
        if (!pinned) {
          setRevealed(false);
        }
      }}
      onFocusCapture={() => {
        if (!pinned) {
          setRevealed(true);
        }
      }}
      onBlurCapture={(event) => {
        if (!pinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setRevealed(false);
        }
      }}
    >
      <div className="context-rail__spine">
        <button
          aria-label={pinned ? "Unpin context rail" : "Open context rail"}
          className={`context-rail__menu-button${open ? " is-active" : ""}`}
          type="button"
          onClick={() => {
            if (pinned) {
              setPinned(false);
              setRevealed(false);
              return;
            }

            setRevealed(true);
          }}
        >
          <span className="context-rail__menu-glyph" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </div>

      {open ? (
        <div className="context-panel">
          <div className="context-panel__rail-header">
            <div>
              <p className="eyebrow">Context</p>
              <h3 className="context-panel__title">Thread details</h3>
            </div>

            <div className="context-panel__rail-actions">
              <span className="context-panel__rail-state">
                {pinned ? "Pinned" : "Auto-hide"}
              </span>
              <button
                aria-label={pinned ? "Unpin context rail" : "Pin context rail"}
                className="button button--ghost context-panel__pin-button"
                type="button"
                onClick={() => {
                  setPinned((current) => !current);
                  setRevealed(true);
                }}
              >
                {pinned ? "Unpin" : "Pin"}
              </button>
            </div>
          </div>

          <section className="context-panel__section">
            <h3>Linked directories</h3>
            {props.thread.linkedDirectories.length > 0 ? (
              <ul className="context-list">
                {props.thread.linkedDirectories.map((directory) => (
                  <li key={directory.id} className="context-list__item">
                    <span className="context-list__label" title={directory.path}>
                      <span aria-hidden="true" className="context-list__icon">
                        {directory.kind === "worktree" ? "🔀" : "📁"}
                      </span>
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
        </div>
      ) : null}
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
