import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type {
  BackendSummary,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";
import { formatExecutionModeLabel } from "../../lib/execution-mode";

type ThreadContextPanelProps = {
  backendError?: string;
  backends: BackendSummary[];
  platform?: string;
  thread: NavigationThreadSummary;
  setExecutionModeError?: string;
  updatingExecutionMode?: ThreadExecutionMode;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
};

export function ThreadContextPanel(props: ThreadContextPanelProps) {
  const [pinned, setPinned] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const open = pinned || revealed;
  const threadBackend = props.backends.find(
    (backend) => backend.kind === props.thread.source
  );
  const executionModes =
    threadBackend?.executionModes.filter((mode) => mode.available) ?? [];

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
                    <button
                      aria-label={`Copy path for ${directory.label}`}
                      className="context-list__label path-copy-target tooltip-target"
                      data-tooltip={formatCopyTooltip(directory.path)}
                      type="button"
                      onClick={(event) => {
                        void handleCopyPath(event, directory.path);
                      }}
                    >
                      <span aria-hidden="true" className="context-list__icon">
                        {directory.kind === "worktree" ? "🔀" : "📁"}
                      </span>
                      {directory.label}
                    </button>
                    <button
                      aria-label={`Copy path for ${directory.kind} ${directory.label}`}
                      className="context-list__meta path-copy-target tooltip-target"
                      data-tooltip={formatCopyTooltip(directory.worktreePath ?? directory.path)}
                      type="button"
                      onClick={(event) => {
                        void handleCopyPath(event, directory.worktreePath ?? directory.path);
                      }}
                    >
                      {directory.kind}
                    </button>
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
                <dt>Access</dt>
                <dd>{formatExecutionModeLabel(props.thread.executionMode)}</dd>
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

            {props.thread.source === "codex" && executionModes.length > 0 ? (
              <div className="context-mode-switch">
                {executionModes.map((mode) => {
                  const active = (props.thread.executionMode ?? "default") === mode.mode;
                  return (
                    <button
                      key={mode.mode}
                      aria-pressed={active}
                      className={`context-mode-switch__button${
                        active ? " is-active" : ""
                      }`}
                      disabled={Boolean(props.updatingExecutionMode)}
                      type="button"
                      onClick={() => {
                        if (!active) {
                          void props.onSetExecutionMode?.(mode.mode);
                        }
                      }}
                    >
                      {formatExecutionModeLabel(mode.mode)}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {props.setExecutionModeError ? (
              <p className="context-empty context-empty--error">
                {props.setExecutionModeError}
              </p>
            ) : props.updatingExecutionMode ? (
              <p className="context-empty">
                Switching to {formatExecutionModeLabel(props.updatingExecutionMode)}…
              </p>
            ) : null}
          </section>

          <section className="context-panel__section context-panel__section--status">
            <h3>App servers</h3>
            {props.backendError ? (
              <p className="context-empty">{props.backendError}</p>
            ) : props.backends.length > 0 ? (
              <ul className="backend-status-list">
                {props.backends.map((backend) => (
                  <li key={backend.kind} className="backend-status-list__item">
                    <div className="backend-status-list__summary">
                      <span
                        aria-hidden="true"
                        className={`backend-status-list__dot${
                          backend.available ? "" : " is-unavailable"
                        }`}
                      />
                      <span>{backend.label}</span>
                    </div>
                    <p className="backend-status-list__details">
                      {backend.available
                        ? "Available"
                        : backend.unavailableReason ?? "Unavailable"}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="context-empty">Status unavailable</p>
            )}
          </section>
        </div>
      ) : null}
    </aside>
  );
}

async function handleCopyPath(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  path: string
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  await copyText(path);
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}
