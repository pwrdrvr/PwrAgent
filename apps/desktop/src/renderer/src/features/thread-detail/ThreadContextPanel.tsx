import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  BackendSummary,
  NavigationThreadSummary,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { FolderIcon, WorktreeIcon } from "../../icons";
import { copyText, formatCopyTooltip } from "../../lib/copy-text";
import { formatExecutionModeLabel } from "../../lib/execution-mode";

type ThreadContextPanelProps = {
  backendError?: string;
  backends: BackendSummary[];
  onPinnedChange?: (pinned: boolean) => void;
  onResizingChange?: (resizing: boolean) => void;
  onWidthChange?: (width: number) => void;
  pinned: boolean;
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
  const pinned = props.pinned;
  const open = pinned || revealed;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounced reveal/hide prevents flicker from CSS transform transitions
  // causing spurious mouseenter→mouseleave sequences.
  const revealRail = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    setRevealed(true);
  }, []);

  const hideRail = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setRevealed(false);
    }, 200);
  }, []);

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
          revealRail();
        }
      }}
      onMouseLeave={() => {
        if (!pinned) {
          hideRail();
        }
      }}
      onFocusCapture={() => {
        if (!pinned) {
          revealRail();
        }
      }}
      onBlurCapture={(event) => {
        if (!pinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          hideRail();
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
              clearTimeout(hideTimerRef.current);
              setRevealed(false);
              return;
            }

            revealRail();
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
                      <div className="context-list__label">
                        <CopyValueButton
                          label={`Copy path for ${directory.label}`}
                          value={directory.path}
                          onBlur={hideRailTooltip}
                          onCopy={handleCopyPath}
                          onShowTooltip={showRailTooltip}
                        />
                        <TooltipValue
                          label={`Path for ${directory.label}`}
                          value={directory.path}
                          onBlur={hideRailTooltip}
                          onShowTooltip={showRailTooltip}
                        >
                          <span aria-hidden="true" className="context-list__icon">
                            {directory.kind === "worktree" ? (
                              <WorktreeIcon size={14} />
                            ) : (
                              <FolderIcon size={14} />
                            )}
                          </span>
                          {directory.label}
                        </TooltipValue>
                      </div>
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
                        <span className="context-list__meta">
                          <CopyValueButton
                            label={`Copy path for ${directory.kind} ${directory.label}`}
                            value={worktreePath}
                            onBlur={hideRailTooltip}
                            onCopy={handleCopyPath}
                            onShowTooltip={showRailTooltip}
                          />
                          <TooltipValue
                            label={`Path for ${
                              snapshot?.state === "archived" ? "archived" : directory.kind
                            } ${directory.label}`}
                            value={worktreePath}
                            onBlur={hideRailTooltip}
                            onShowTooltip={showRailTooltip}
                          >
                            {snapshot?.state === "archived" ? "archived" : directory.kind}
                          </TooltipValue>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : props.thread.projectKey?.trim() ? (
              <>
                <ul className="context-list">
                  <li className="context-list__item">
                    <div className="context-list__label">
                      <CopyValueButton
                        label="Copy recorded working directory"
                        value={props.thread.projectKey!}
                        onBlur={hideRailTooltip}
                        onCopy={handleCopyPath}
                        onShowTooltip={showRailTooltip}
                      />
                      <TooltipValue
                        label="Recorded working directory path"
                        value={props.thread.projectKey!}
                        onBlur={hideRailTooltip}
                        onShowTooltip={showRailTooltip}
                      >
                        <span aria-hidden="true" className="context-list__icon">
                          <FolderIcon size={14} />
                        </span>
                        {pathBaseName(props.thread.projectKey)}
                      </TooltipValue>
                    </div>
                    <span className="context-list__meta">
                      <CopyValueButton
                        label="Copy missing working directory path"
                        value={props.thread.projectKey!}
                        onBlur={hideRailTooltip}
                        onCopy={handleCopyPath}
                        onShowTooltip={showRailTooltip}
                      />
                      <TooltipValue
                        label="Missing working directory path"
                        value={props.thread.projectKey!}
                        onBlur={hideRailTooltip}
                        onShowTooltip={showRailTooltip}
                      >
                        missing
                      </TooltipValue>
                    </span>
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
                          <WorktreeIcon size={14} />
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
                <dd className="context-value-row">
                  <CopyValueButton
                    aria-label="Copy thread id"
                    label="Copy thread id"
                    maxTooltipLength={48}
                    value={props.thread.id}
                    onBlur={hideRailTooltip}
                    onCopy={handleCopyPath}
                    onShowTooltip={showRailTooltip}
                  />
                  <span className="context-grid__mono">
                    {props.thread.id}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>{formatExecutionModeLabel(props.thread.executionMode)}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd className="context-value-row">
                  {props.thread.gitBranch ? (
                    <CopyValueButton
                      label="Copy branch name"
                      value={props.thread.gitBranch}
                      onBlur={hideRailTooltip}
                      onCopy={handleCopyPath}
                      onShowTooltip={showRailTooltip}
                    />
                  ) : null}
                  <span className="context-grid__mono">
                    {props.thread.gitBranch ?? "Not attached"}
                  </span>
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
                    {backend.available &&
                    (backend.account || (backend.rateLimits?.length ?? 0) > 0) ? (
                      <div className="backend-status-list__metadata">
                        {backend.account ? (
                          <dl className="backend-status-list__metadata-grid">
                            <div>
                              <dt>Account</dt>
                              <dd>{formatBackendAccountText(backend.account)}</dd>
                            </div>
                            {backend.account.planType ? (
                              <div>
                                <dt>Plan</dt>
                                <dd>{backend.account.planType}</dd>
                              </div>
                            ) : null}
                          </dl>
                        ) : null}
                        {backend.rateLimits?.length ? (
                          <ul className="backend-status-list__limits">
                            {selectVisibleRateLimits(backend, props.thread).map((limit) => (
                              <li key={`${limit.limitId ?? "limit"}:${limit.name}`}>
                                {formatRateLimitLine(limit)}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="context-empty">Status unavailable</p>
            )}
          </section>
        </div>
      ) : null}

      {tooltip && typeof document !== "undefined"
        ? createPortal(
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
            </div>,
            document.body
          )
        : null}
    </aside>
  );

  function showRailTooltip(
    event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
    path: string,
    maxLength?: number,
    copyHint = true
  ): void {
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({
      text: copyHint
        ? formatCopyTooltip(path, maxLength)
        : formatTooltipValue(path, maxLength),
      targetBottom: rect.bottom,
      targetCenter: rect.left + rect.width / 2,
      targetTop: rect.top,
    });
  }

  function hideRailTooltip(): void {
    setTooltip(undefined);
  }
}

function CopyValueButton(props: {
  label?: string;
  "aria-label"?: string;
  maxTooltipLength?: number;
  onBlur: () => void;
  onCopy: (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
    value: string
  ) => Promise<void>;
  onShowTooltip: (
    event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
    value: string,
    maxLength?: number,
    copyHint?: boolean
  ) => void;
  value: string;
}) {
  const label = props["aria-label"] ?? props.label ?? "Copy to clipboard";

  return (
    <button
      aria-label={label}
      className="context-copy-button path-copy-target"
      type="button"
      onBlur={props.onBlur}
      onClick={(event) => {
        void props.onCopy(event, props.value);
      }}
      onFocus={(event) => props.onShowTooltip(event, props.value, props.maxTooltipLength)}
      onMouseEnter={(event) =>
        props.onShowTooltip(event, props.value, props.maxTooltipLength)
      }
      onMouseLeave={props.onBlur}
    >
      <span aria-hidden="true">📋</span>
    </button>
  );
}

function TooltipValue(props: {
  children: ReactNode;
  label: string;
  onBlur: () => void;
  onShowTooltip: (
    event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
    value: string,
    maxLength?: number,
    copyHint?: boolean
  ) => void;
  value: string;
}) {
  return (
    <span
      aria-label={props.label}
      className="context-tooltip-value"
      tabIndex={0}
      onBlur={props.onBlur}
      onFocus={(event) => props.onShowTooltip(event, props.value, undefined, false)}
      onMouseEnter={(event) => props.onShowTooltip(event, props.value, undefined, false)}
      onMouseLeave={props.onBlur}
    >
      {props.children}
    </span>
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

function formatTooltipValue(value: string, maxLength = 72): string {
  return elideMiddle(value, maxLength);
}

function elideMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const visible = Math.max(8, maxLength - 1);
  const left = Math.ceil(visible / 2);
  const right = Math.floor(visible / 2);
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function formatBackendAccountText(
  account: NonNullable<BackendSummary["account"]>
): string {
  if (account.type === "chatgpt" && account.email?.trim()) {
    return account.email.trim();
  }
  if (account.type === "apiKey") {
    return "API key";
  }
  if (account.requiresOpenaiAuth === false) {
    return "Not required";
  }
  if (account.requiresOpenaiAuth === true) {
    return "Not signed in";
  }
  return "Unknown";
}

function splitRateLimitName(name: string): {
  label: string;
  labelOrder: number;
  prefix: string;
} {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("5h limit")) {
    const prefix = trimmed.slice(0, Math.max(0, trimmed.length - "5h limit".length)).trim();
    return { label: "5h limit", labelOrder: 0, prefix };
  }
  if (lower.endsWith("weekly limit")) {
    const prefix = trimmed.slice(0, Math.max(0, trimmed.length - "weekly limit".length)).trim();
    return { label: "Weekly limit", labelOrder: 1, prefix };
  }
  return { label: trimmed, labelOrder: 99, prefix: "" };
}

function selectVisibleRateLimits(
  backend: BackendSummary,
  thread: NavigationThreadSummary
): NonNullable<BackendSummary["rateLimits"]> {
  const limits = backend.rateLimits ?? [];
  const currentThreadUsesSpark = backend.kind === "codex" && isSparkName(thread.model);
  const sparkHasUsage = limits.some((limit) => isSparkRateLimit(limit) && hasRateLimitUsage(limit));

  return [...limits]
    .filter((limit) => {
      const { label } = splitRateLimitName(limit.name);
      if (label !== "5h limit" && label !== "Weekly limit") {
        return false;
      }
      if (!isSparkRateLimit(limit)) {
        return true;
      }
      return currentThreadUsesSpark || sparkHasUsage;
    })
    .sort((left, right) => {
      const leftName = splitRateLimitName(left.name);
      const rightName = splitRateLimitName(right.name);
      const leftFamilyOrder = rateLimitFamilyOrder(left);
      const rightFamilyOrder = rateLimitFamilyOrder(right);
      if (leftFamilyOrder !== rightFamilyOrder) {
        return leftFamilyOrder - rightFamilyOrder;
      }
      if (leftName.labelOrder !== rightName.labelOrder) {
        return leftName.labelOrder - rightName.labelOrder;
      }
      return left.name.localeCompare(right.name);
    });
}

function formatRateLimitLine(limit: NonNullable<BackendSummary["rateLimits"]>[number]): string {
  const { label } = splitRateLimitName(limit.name);
  const displayLabel = isSparkRateLimit(limit) ? `Spark ${label}` : label;
  const resetText = formatRateLimitReset(limit.resetAt);
  if (typeof limit.usedPercent === "number") {
    const remaining = Math.max(0, Math.round(100 - limit.usedPercent));
    return `${displayLabel}: ${remaining}% left${resetText ? `, resets ${resetText}` : ""}`;
  }
  if (typeof limit.remaining === "number" && typeof limit.limit === "number") {
    return `${displayLabel}: ${limit.remaining}/${limit.limit} remaining${
      resetText ? `, resets ${resetText}` : ""
    }`;
  }
  return `${displayLabel}: unavailable`;
}

function isSparkRateLimit(limit: NonNullable<BackendSummary["rateLimits"]>[number]): boolean {
  return isSparkName(limit.limitId) || isSparkName(limit.name);
}

function isSparkName(value: string | undefined): boolean {
  return value?.toLowerCase().includes("spark") ?? false;
}

function hasRateLimitUsage(limit: NonNullable<BackendSummary["rateLimits"]>[number]): boolean {
  if (typeof limit.usedPercent === "number") {
    return limit.usedPercent > 0;
  }
  if (typeof limit.used === "number") {
    return limit.used > 0;
  }
  if (typeof limit.remaining === "number" && typeof limit.limit === "number") {
    return limit.remaining < limit.limit;
  }
  return false;
}

function rateLimitFamilyOrder(limit: NonNullable<BackendSummary["rateLimits"]>[number]): number {
  return isSparkRateLimit(limit) ? 1 : 0;
}

function formatRateLimitReset(resetAt: number | undefined): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const now = new Date();
  if (now.toDateString() === date.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
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
