import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatDurationMs, formatRunningDurationMs } from "../../lib/format-duration";
import { TranscriptCopyButton } from "../thread-detail/TranscriptCopyButton";

/**
 * What the composer band shows for an environment's setup command (or, for
 * a thread that has no turns yet, a failed environment action). ThreadView
 * owns the state; the Composer renders it so it can add Retry, which goes
 * through the same `setCodexThreadEnvironment` call as the picker.
 */
export type EnvironmentSetupRowModel = {
  /** Changes when a new run starts, so a fresh run opens collapsed. */
  key: string;
  phase: "setup" | "action";
  status: "running" | "failed";
  environmentId?: string;
  environmentName?: string;
  command?: string;
  cwd?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  startedAt?: number;
  /** Existing threads: hides the row. */
  onDismiss?: () => void;
  /**
   * A thread with no turns yet: the operator still has to decide whether
   * to keep it. Shown under the summary, so it is visible while collapsed.
   */
  decision?: {
    busy: boolean;
    continuing: boolean;
    disabled?: boolean;
    error?: string;
    hasWorktree: boolean;
    onCleanup: () => void;
    onContinue: () => void;
  };
};

function lastOutputLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line) {
      return line;
    }
  }
  return undefined;
}

/**
 * Wall clock for the elapsed counter while a run is live. Re-read when a run
 * starts: the launchpad row mounts before its first progress event, so its
 * `startedAt` lands after the mount-time reading.
 */
function useRunningClock(running: boolean, startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  return now;
}

/**
 * Environment setup, as one row in the composer band beside the env action
 * rows. It is collapsed by default in every state and never opens itself:
 * the band above the reply box is height-capped and scrolls, so the full
 * command, path and output live here without ever pushing the input off the
 * window. The old surfaces this replaces were content-sized panels above the
 * transcript; see `composer-band-bounds.test.ts`.
 */
export function EnvironmentSetupRow(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  model: EnvironmentSetupRowModel;
  onRetry?: () => void;
  retrying?: boolean;
}): ReactNode {
  const { model } = props;
  const [open, setOpen] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const running = model.status === "running";
  const now = useRunningClock(running, model.startedAt);
  const output = `${model.output?.trimEnd() ?? ""}${
    model.error ? `${model.output?.trim() ? "\n" : ""}${model.error}` : ""
  }`;
  const lineCount = output ? output.split("\n").length : 0;

  // Follow the end of the output while it is still being written, as a
  // terminal would. Only while open: a collapsed row has no output box.
  useEffect(() => {
    const node = outputRef.current;
    if (open && running && node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [open, output, running]);

  const subject = model.phase === "action" ? "Env action" : "Env setup";
  const label = `${subject} ${running ? "running" : "failed"}`;
  const meta: string[] = [];
  if (model.environmentName) meta.push(model.environmentName);
  if (running && typeof model.startedAt === "number") {
    meta.push(formatRunningDurationMs(Math.max(0, now - model.startedAt)));
  }
  if (!running && typeof model.exitCode === "number") {
    meta.push(`exit ${model.exitCode}`);
  }
  if (!running && model.durationMs) {
    meta.push(`ran ${formatDurationMs(model.durationMs)}`);
  }
  const tail = lastOutputLine(output);
  const decision = model.decision;
  const actionsDisabled = Boolean(
    decision?.disabled || decision?.busy || props.retrying,
  );
  const retryButton = props.onRetry ? (
    <button
      className="composer__secondary-action environment-setup-row__retry"
      disabled={actionsDisabled}
      type="button"
      onClick={props.onRetry}
    >
      {props.retrying ? "Retrying…" : decision ? "Retry setup" : "Retry"}
    </button>
  ) : null;

  return (
    <div
      className={`composer__queued composer__queued--env-action composer__queued--env-action-${
        running ? "running" : "failed"
      } environment-setup-row`}
      data-open={open ? "true" : undefined}
      aria-label={label}
      role={running ? undefined : "alert"}
    >
      <div className="environment-setup-row__header">
        <button
          aria-expanded={open}
          className="composer__queued-env-action-summary environment-setup-row__toggle"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="composer__queued-env-action-chevron" aria-hidden="true" />
          {running ? (
            <span
              className="status-dot status-dot--active status-dot--blink"
              aria-hidden="true"
            />
          ) : null}
          <span className="composer__queued-env-action-summary-text">
            {/* Polite live region: an existing thread's run keeps one row
                from running to failed, and a role added to a mounted node is
                not reliably announced. */}
            <span className="composer__queued-label" aria-live="polite">
              {label}
            </span>
            <span className="composer__queued-text">
              {meta.join(" · ")}
              {tail ? (
                <>
                  {meta.length > 0 ? " · " : ""}
                  <span className="environment-setup-row__tail">{tail}</span>
                </>
              ) : null}
            </span>
          </span>
        </button>
        <span className="composer__queued-env-action-actions">
          {!running && !decision ? retryButton : null}
          {output ? (
            <TranscriptCopyButton
              className="transcript-copy-button--composer-error"
              desktopApi={props.desktopApi}
              label={`Copy ${subject.toLowerCase()} output`}
              text={output}
            />
          ) : null}
          {!running && !decision && model.onDismiss ? (
            <button
              className="composer__secondary-action composer__queued-env-action-dismiss"
              type="button"
              onClick={model.onDismiss}
            >
              Dismiss
            </button>
          ) : null}
        </span>
      </div>
      {decision ? (
        <div className="environment-setup-row__decision">
          <p
            className={`environment-setup-row__hint${
              decision.error ? " environment-setup-row__hint--error" : ""
            }`}
          >
            {decision.error
              ?? (decision.hasWorktree
                ? `The new worktree is ready, but its ${
                    model.phase === "action" ? "action" : "setup command"
                  } failed.`
                : `The ${
                    model.phase === "action" ? "environment action" : "setup command"
                  } failed.`)}
          </p>
          <span className="environment-setup-row__decision-actions">
            <button
              className="composer__secondary-action environment-setup-row__cleanup"
              disabled={actionsDisabled}
              type="button"
              onClick={decision.onCleanup}
            >
              {decision.hasWorktree ? "Delete worktree and close" : "Close thread"}
            </button>
            <button
              className="composer__secondary-action environment-setup-row__continue"
              disabled={actionsDisabled}
              type="button"
              onClick={decision.onContinue}
            >
              {decision.continuing ? "Continuing…" : "Continue anyway"}
            </button>
          </span>
        </div>
      ) : null}
      {open ? (
        <div className="composer__queued-env-action-body">
          {model.command?.trim() ? (
            <div className="composer__queued-env-action-section">
              <div className="composer__queued-env-action-section-label">Command</div>
              <pre className="composer__queued-env-action-command-block">
                <code>{`$ ${model.command.trim()}`}</code>
              </pre>
            </div>
          ) : null}
          {model.cwd?.trim() ? (
            <div className="composer__queued-env-action-section">
              <div className="composer__queued-env-action-section-label">Path</div>
              <code className="environment-setup-row__path">{model.cwd}</code>
            </div>
          ) : null}
          <div className="composer__queued-env-action-section">
            <div className="composer__queued-env-action-section-label">
              {model.error ? "Output and errors" : "Output"}
              {lineCount ? ` · ${lineCount} line${lineCount === 1 ? "" : "s"}` : ""}
            </div>
            <pre
              ref={outputRef}
              className="composer__queued-env-action-output environment-setup-row__output"
              aria-label={`${subject} output`}
            >
              {output || (running ? "Waiting for output…" : "(no output captured)")}
            </pre>
          </div>
          {decision && retryButton ? (
            <div className="environment-setup-row__body-actions">{retryButton}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
