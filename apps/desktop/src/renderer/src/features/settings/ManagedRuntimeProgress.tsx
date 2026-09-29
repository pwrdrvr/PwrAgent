import { useEffect, useReducer, useState } from "react";
import type {
  ManagedRuntimeId,
  ManagedRuntimeProgress,
} from "../../../../shared/managed-runtime-progress";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  MANAGED_RUNTIME_READY_LINGER_MS,
  isManagedRuntimeProgressVisible,
  managedRuntimeProgressCopy,
} from "./managed-runtime-progress-copy";

const STEP_MARK = { done: "✓", now: "●", failed: "✕", todo: "○" } as const;
const STEP_STATE_LABEL = {
  done: "done",
  now: "in progress",
  failed: "failed",
  todo: "waiting",
} as const;

/**
 * The live progress of a managed download, or `undefined` when none is
 * running. Settings can open mid-download, so it asks for the current state
 * before the events start.
 */
export function useManagedRuntimeProgress(
  desktopApi: Pick<
    DesktopApi,
    "onManagedRuntimeProgress" | "readManagedRuntimeProgress"
  > | undefined,
  runtime: ManagedRuntimeId,
): ManagedRuntimeProgress | undefined {
  const [progress, setProgress] = useState<ManagedRuntimeProgress>();
  // Visibility depends on the clock, so a render is forced when the ready
  // strip is due to expire; the clock itself is read at render.
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    let cancelled = false;
    // An event that lands before the read resolves is newer than the read.
    let sawEvent = false;
    const unsubscribe = desktopApi?.onManagedRuntimeProgress?.((event) => {
      if (event.runtime !== runtime) return;
      sawEvent = true;
      setProgress(event.phase === "idle" ? undefined : event);
    });
    void desktopApi?.readManagedRuntimeProgress?.().then((all) => {
      if (cancelled || sawEvent) return;
      setProgress(all.find((entry) => entry.runtime === runtime));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi, runtime]);

  // A finished strip hands back to the ordinary status line on its own.
  useEffect(() => {
    if (progress?.phase !== "ready") return undefined;
    const remaining =
      MANAGED_RUNTIME_READY_LINGER_MS - (Date.now() - progress.updatedAt);
    const timer = setTimeout(rerender, Math.max(0, remaining) + 1);
    return () => clearTimeout(timer);
  }, [progress]);

  return progress && isManagedRuntimeProgressVisible(progress, Date.now())
    ? progress
    : undefined;
}

/**
 * One strip for both providers: a state line, a track, a byte meter while the
 * archive downloads, and the four steps an install passes through.
 */
export function ManagedRuntimeProgressStrip(props: {
  progress: ManagedRuntimeProgress;
  /** Codex only: the build is installed and takes over when turns go idle. */
  waitingForIdle?: boolean;
  onRetry?: () => void;
}) {
  const copy = managedRuntimeProgressCopy(
    props.progress,
    props.waitingForIdle === true,
  );
  const busy = copy.tone === "busy";
  return (
    <div
      className={`managed-progress managed-progress--${copy.tone}`}
      data-testid={`managed-progress-${props.progress.runtime}`}
    >
      <div className="managed-progress__head">
        <p className="managed-progress__eyebrow">{copy.eyebrow}</p>
        {copy.tag ? <span className="managed-progress__tag">{copy.tag}</span> : null}
      </div>
      {copy.message ? (
        <p className="managed-progress__message">{copy.message}</p>
      ) : null}
      {busy || copy.full ? (
        <span
          aria-hidden={copy.percent === undefined ? true : undefined}
          aria-label={
            copy.percent === undefined ? undefined : `Download ${copy.percent}%`
          }
          aria-valuemax={copy.percent === undefined ? undefined : 100}
          aria-valuemin={copy.percent === undefined ? undefined : 0}
          aria-valuenow={copy.percent}
          className={`managed-progress__track${
            busy && copy.percent === undefined
              ? " managed-progress__track--indeterminate"
              : ""
          }${copy.full ? " managed-progress__track--full" : ""}`}
          role={copy.percent === undefined ? undefined : "progressbar"}
        >
          <i
            style={
              copy.percent === undefined ? undefined : { width: `${copy.percent}%` }
            }
          />
        </span>
      ) : null}
      {copy.meter || copy.steps ? (
        <div className="managed-progress__foot">
          {copy.meter ? (
            <p className="managed-progress__meter">{copy.meter}</p>
          ) : null}
          {copy.steps ? (
            <ol className="managed-progress__steps">
              {copy.steps.map((step) => (
                <li
                  aria-current={step.state === "now" ? "step" : undefined}
                  aria-label={`${step.label}, ${STEP_STATE_LABEL[step.state]}`}
                  className={`is-${step.state}`}
                  key={step.phase}
                >
                  <span aria-hidden="true">
                    {STEP_MARK[step.state]} {step.label}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {props.progress.phase === "failed" && props.onRetry ? (
        <div className="settings-inline-actions">
          <button
            className="button button--primary"
            type="button"
            onClick={props.onRetry}
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
