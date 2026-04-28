import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type {
  BackendSummary,
  NavigationThreadSummary,
  WorktreeSnapshotSummary,
} from "@pwragnt/shared";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";
import { formatExecutionModeLabel } from "../../lib/execution-mode";

type ThreadContextPanelProps = {
  backendError?: string;
  backends: BackendSummary[];
  onPinnedChange?: (pinned: boolean) => void;
  onResizingChange?: (resizing: boolean) => void;
  onWidthChange?: (width: number) => void;
  platform?: string;
  thread: NavigationThreadSummary;
  worktreeArchiveError?: string;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
};

export function ThreadContextPanel(props: ThreadContextPanelProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [railWidth, setRailWidth] = useState(380);
  const [resizing, setResizing] = useState(false);
  const [tooltip, setTooltip] = useState<{
    left?: number;
    text: string;
    targetBottom: number;
    targetCenter: number;
    targetTop: number;
    top?: number;
  }>();
  const open = pinned || revealed;

  useLayoutEffect(() => {
    if (!tooltip || tooltip.left !== undefined) {
      return;
    }

    const tooltipElement = tooltipRef.current;
    if (!tooltipElement) {
      return;
    }

    const tooltipRect = tooltipElement.getBoundingClientRect();
    const viewportPadding = 12;
    const left = Math.min(
      window.innerWidth - tooltipRect.width - viewportPadding,
      Math.max(viewportPadding, tooltip.targetCenter - tooltipRect.width / 2)
    );
    const top =
      tooltip.targetTop - tooltipRect.height - 10 >= viewportPadding
        ? tooltip.targetTop - 10
        : tooltip.targetBottom + tooltipRect.height + 10;

    setTooltip({
      ...tooltip,
      left,
      top,
    });
  }, [tooltip]);

  const updatePinned = (nextPinned: boolean): void => {
    setPinned(nextPinned);
    props.onPinnedChange?.(nextPinned);
  };

  const resizeRail = (nextWidth: number): void => {
    const clampedWidth = Math.min(560, Math.max(300, nextWidth));
    setRailWidth(clampedWidth);
    props.onWidthChange?.(clampedWidth);
  };
  const startRailResize = (event: PointerEvent<HTMLElement>): void => {
    if (!pinned) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setResizing(true);
    props.onResizingChange?.(true);
    const startX = event.clientX;
    const startWidth = railWidth;

    const move = (moveEvent: globalThis.PointerEvent): void => {
      resizeRail(startWidth + startX - moveEvent.clientX);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setResizing(false);
      props.onResizingChange?.(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <aside
      aria-label="Thread context"
      className={`context-rail${open ? " is-open" : " is-collapsed"}${
        pinned ? " is-pinned" : ""
      }${resizing ? " is-resizing" : ""}`}
      style={{ "--context-rail-width": `${railWidth}px` } as CSSProperties}
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
      {pinned ? (
        <div
          aria-label="Resize context rail"
          aria-orientation="vertical"
          className="context-rail__resize-handle"
          role="separator"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              resizeRail(railWidth + 16);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              resizeRail(railWidth - 16);
            }
          }}
          onPointerDown={startRailResize}
        />
      ) : null}
      <div className="context-rail__spine">
        <button
          aria-label={pinned ? "Unpin context rail" : "Open context rail"}
          className={`context-rail__menu-button${open ? " is-active" : ""}`}
          type="button"
          onClick={() => {
            if (pinned) {
              updatePinned(false);
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
                  updatePinned(!pinned);
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
                {props.thread.linkedDirectories.map((directory) => {
                  const worktreePath = directory.worktreePath ?? directory.path;
                  const snapshot = findSnapshotForWorktree(
                    props.thread.worktreeSnapshots,
                    worktreePath
                  );
                  const canRestore =
                    directory.kind === "worktree" &&
                    snapshot?.state === "archived" &&
                    Boolean(props.onRestoreWorktree);

                  return (
                    <li key={directory.id} className="context-list__item">
                      <button
                        aria-label={`Copy path for ${directory.label}`}
                        className="context-list__label path-copy-target"
                        type="button"
                        onBlur={hideRailTooltip}
                        onClick={(event) => {
                          void handleCopyPath(event, directory.path);
                        }}
                        onFocus={(event) => showRailTooltip(event, directory.path)}
                        onMouseEnter={(event) => showRailTooltip(event, directory.path)}
                        onMouseLeave={hideRailTooltip}
                      >
                        <span aria-hidden="true" className="context-list__icon">
                          {directory.kind === "worktree" ? "🔀" : "📁"}
                        </span>
                        {directory.label}
                      </button>
                      <div className="context-list__actions">
                        {canRestore && snapshot ? (
                          <button
                            className="context-list__action"
                            type="button"
                            onClick={() => {
                              void props.onRestoreWorktree?.(
                                props.thread,
                                snapshot.snapshotRef,
                                snapshot.worktreePath
                              );
                            }}
                          >
                            Restore
                          </button>
                        ) : null}
                        <button
                          aria-label={`Copy path for ${directory.kind} ${directory.label}`}
                          className="context-list__meta path-copy-target"
                          type="button"
                          onBlur={hideRailTooltip}
                          onClick={(event) => {
                            void handleCopyPath(event, worktreePath);
                          }}
                          onFocus={(event) => showRailTooltip(event, worktreePath)}
                          onMouseEnter={(event) => showRailTooltip(event, worktreePath)}
                          onMouseLeave={hideRailTooltip}
                        >
                          {snapshot?.state === "archived" ? "archived" : directory.kind}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : props.thread.projectKey?.trim() ? (
              <>
                <ul className="context-list">
                  <li className="context-list__item">
                    <button
                      aria-label="Copy recorded working directory"
                      className="context-list__label path-copy-target"
                      type="button"
                      onBlur={hideRailTooltip}
                      onClick={(event) => {
                        void handleCopyPath(event, props.thread.projectKey!);
                      }}
                      onFocus={(event) => showRailTooltip(event, props.thread.projectKey!)}
                      onMouseEnter={(event) => showRailTooltip(event, props.thread.projectKey!)}
                      onMouseLeave={hideRailTooltip}
                    >
                      <span aria-hidden="true" className="context-list__icon">
                        📁
                      </span>
                      {pathBaseName(props.thread.projectKey)}
                    </button>
                    <button
                      aria-label="Copy missing working directory path"
                      className="context-list__meta path-copy-target"
                      type="button"
                      onBlur={hideRailTooltip}
                      onClick={(event) => {
                        void handleCopyPath(event, props.thread.projectKey!);
                      }}
                      onFocus={(event) => showRailTooltip(event, props.thread.projectKey!)}
                      onMouseEnter={(event) => showRailTooltip(event, props.thread.projectKey!)}
                      onMouseLeave={hideRailTooltip}
                    >
                      missing
                    </button>
                  </li>
                </ul>
                <p className="context-empty">Recorded working directory is no longer available.</p>
              </>
            ) : (
              <p className="context-empty">No linked directory</p>
            )}
            {props.worktreeArchiveError ? (
              <p className="context-empty context-empty--error">
                {props.worktreeArchiveError}
              </p>
            ) : null}
          </section>

          {props.thread.worktreeSnapshots?.some(
            (snapshot) => snapshot.state === "archived"
          ) ? (
            <section className="context-panel__section">
              <h3>Worktree snapshots</h3>
              <ul className="context-list">
                {props.thread.worktreeSnapshots
                  .filter((snapshot) => snapshot.state === "archived")
                  .map((snapshot) => (
                    <li key={snapshot.id} className="context-list__item">
                      <button
                        aria-label={`Copy snapshot ref ${snapshot.snapshotRef}`}
                        className="context-list__label path-copy-target"
                        type="button"
                        onBlur={hideRailTooltip}
                        onClick={(event) => {
                          void handleCopyPath(event, snapshot.snapshotRef);
                        }}
                        onFocus={(event) => showRailTooltip(event, snapshot.snapshotRef)}
                        onMouseEnter={(event) => showRailTooltip(event, snapshot.snapshotRef)}
                        onMouseLeave={hideRailTooltip}
                      >
                        <span aria-hidden="true" className="context-list__icon">
                          🔀
                        </span>
                        {pathBaseName(snapshot.worktreePath)}
                      </button>
                      <div className="context-list__actions">
                        <button
                          className="context-list__action"
                          type="button"
                          onClick={() => {
                            void props.onRestoreWorktree?.(
                              props.thread,
                              snapshot.snapshotRef,
                              snapshot.worktreePath
                            );
                          }}
                        >
                          Restore
                        </button>
                        <span className="context-list__meta">
                          {snapshot.archivedAt
                            ? formatTimestamp(snapshot.archivedAt)
                            : "archived"}
                        </span>
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}

          <section className="context-panel__section">
            <h3>Execution context</h3>
            <dl className="context-grid">
              <div>
                <dt>Backend</dt>
                <dd>{props.thread.source}</dd>
              </div>
              <div>
                <dt>Thread ID</dt>
                <dd>
                  <button
                    aria-label="Copy thread id"
                    className="context-grid__copy context-grid__mono path-copy-target"
                    type="button"
                    onBlur={hideRailTooltip}
                    onClick={(event) => {
                      void handleCopyPath(event, props.thread.id);
                    }}
                    onFocus={(event) => showRailTooltip(event, props.thread.id, 48)}
                    onMouseEnter={(event) => showRailTooltip(event, props.thread.id, 48)}
                    onMouseLeave={hideRailTooltip}
                  >
                    {props.thread.id}
                  </button>
                </dd>
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

      {tooltip ? (
        <div
          ref={tooltipRef}
          className="context-rail__tooltip"
          role="tooltip"
          style={{
            left: tooltip.left,
            top: tooltip.top,
            visibility: tooltip.left === undefined ? "hidden" : undefined,
          }}
        >
          {tooltip.text}
        </div>
      ) : null}
    </aside>
  );

  function showRailTooltip(
    event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
    path: string,
    maxLength?: number
  ): void {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      text: formatCopyTooltip(path, maxLength),
      targetBottom: rect.bottom,
      targetCenter: rect.left + rect.width / 2,
      targetTop: rect.top,
    });
  }

  function hideRailTooltip(): void {
    setTooltip(undefined);
  }
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

function findSnapshotForWorktree(
  snapshots: WorktreeSnapshotSummary[] | undefined,
  worktreePath: string
): WorktreeSnapshotSummary | undefined {
  return snapshots?.find((snapshot) => snapshot.worktreePath === worktreePath);
}

function pathBaseName(pathname: string): string {
  const normalized = pathname.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? pathname;
}
