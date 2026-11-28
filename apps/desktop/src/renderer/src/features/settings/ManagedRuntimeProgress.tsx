import { useEffect, useMemo, useReducer, useState } from "react";
import type {
  ManagedRuntimeId,
  ManagedRuntimeProgress,
} from "../../../../shared/managed-runtime-progress";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  MANAGED_RUNTIME_METER_RESERVE,
  MANAGED_RUNTIME_READY_LINGER_MS,
  isManagedRuntimeProgressVisible,
  managedRuntimeProgressCopy,
  managedRuntimeStatusLines,
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
 *
 * A `checking` phase stays off screen unless this surface started an install
 * (`installing`). Most checks find nothing, and a strip that pops in for a
 * second and leaves moves everything under it twice. While this surface's
 * install is starting, the strip shows `checking` from the click, before main
 * reports anything, so the card takes its final height once.
 */
export function useManagedRuntimeProgress(
  desktopApi: Pick<
    DesktopApi,
    "onManagedRuntimeProgress" | "readManagedRuntimeProgress"
  > | undefined,
  runtime: ManagedRuntimeId,
  options?: { installing?: boolean },
): ManagedRuntimeProgress | undefined {
  const [progress, setProgress] = useState<ManagedRuntimeProgress>();
  // Visibility depends on the clock, so a render is forced when the ready
  // strip is due to expire; the clock itself is read at render.
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const installing = options?.installing === true;
  // When this surface's install began, so a ready or failed strip left over
  // from an earlier attempt does not stand in for the new one.
  const [install, setInstall] = useState<{ on: boolean; at: number }>({
    on: installing,
    at: Date.now(),
  });
  if (install.on !== installing) setInstall({ on: installing, at: Date.now() });

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

  // One object per install, not per render: callers memoize on it, and a
  // fresh object each render fed a notice -> host state -> render loop.
  const starting = useMemo<ManagedRuntimeProgress>(
    () => ({ runtime, phase: "checking", updatedAt: install.at }),
    [runtime, install.at],
  );

  if (installing) {
    const settledEarlier = progress !== undefined
      && (progress.phase === "ready" || progress.phase === "failed")
      && progress.updatedAt < install.at;
    if (progress === undefined || settledEarlier) return starting;
  }
  if (!progress || (progress.phase === "checking" && !installing)) return undefined;
  return isManagedRuntimeProgressVisible(progress, Date.now()) ? progress : undefined;
}

/**
 * One strip for every managed runtime: a state line, a status line, a track,
 * and the four steps an install passes through.
 *
 * Every row keeps its height from the first busy phase to the ready strip.
 * The status line holds the phase message, or the byte meter while the archive
 * downloads, and is sized to the longest line it will ever show; the track and
 * the step rail never come and go. Only a failure, which has an error to say
 * and a button to offer, changes the card's height.
 */
export function ManagedRuntimeProgressStrip(props: {
  progress: ManagedRuntimeProgress;
  /** Codex only: the build is installed and takes over when turns go idle. */
  waitingForIdle?: boolean;
  onRetry?: () => void;
}) {
  const waitingForIdle = props.waitingForIdle === true;
  const copy = managedRuntimeProgressCopy(props.progress, waitingForIdle);
  const busy = copy.tone === "busy";
  const showsMeter = copy.message === undefined && copy.meter !== undefined;
  const line = copy.message ?? copy.meter;
  const reserved = managedRuntimeStatusLines(props.progress.runtime)
    .filter((text) => text !== line);
  return (
    <div
      className={`managed-progress managed-progress--${copy.tone}`}
      data-testid={`managed-progress-${props.progress.runtime}`}
    >
      <div className="managed-progress__head">
        <p className="managed-progress__eyebrow">{copy.eyebrow}</p>
        {copy.tag ? <span className="managed-progress__tag">{copy.tag}</span> : null}
      </div>
      <div className="managed-progress__status">
        <p
          className={showsMeter ? "managed-progress__meter" : "managed-progress__message"}
        >
          {line ?? "\u00a0"}
        </p>
        {/* Invisible copies of the other lines this strip can show, stacked
            in the same cell so the slot is already as tall as the longest. */}
        {reserved.map((text) => (
          <p aria-hidden="true" className="managed-progress__message managed-progress__reserve" key={text}>
            {text}
          </p>
        ))}
        <p aria-hidden="true" className="managed-progress__meter managed-progress__reserve">
          {MANAGED_RUNTIME_METER_RESERVE}
        </p>
      </div>
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
