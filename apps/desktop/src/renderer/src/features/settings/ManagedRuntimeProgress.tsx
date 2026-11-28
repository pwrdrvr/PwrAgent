import { useEffect, useMemo, useReducer, useState } from "react";
import type {
  ManagedRuntimeId,
  ManagedRuntimeProgress,
} from "../../../../shared/managed-runtime-progress";
import { ProgressStrip } from "../../components/ProgressStrip";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  MANAGED_RUNTIME_READY_LINGER_MS,
  isManagedRuntimeProgressVisible,
  managedRuntimeProgressCopy,
  managedRuntimeStatusLines,
} from "./managed-runtime-progress-copy";

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
  options?: {
    installing?: boolean;
    /** The runtime reports `checking` only as the first step of an install
     *  (PwrDrvr Git), never for a check that may find nothing, so it shows. */
    checkingStartsInstall?: boolean;
  },
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
  if (!progress) return undefined;
  if (progress.phase === "checking" && !installing && options?.checkingStartsInstall !== true) {
    return undefined;
  }
  return isManagedRuntimeProgressVisible(progress, Date.now()) ? progress : undefined;
}

/**
 * One strip for every managed runtime, drawn by the shared `ProgressStrip`:
 * a state line, a status line, a track, and the four steps an install passes
 * through. Only a failure, which has an error to say and a button to offer,
 * changes the card's height.
 */
export function ManagedRuntimeProgressStrip(props: {
  progress: ManagedRuntimeProgress;
  /** Codex only: the build is installed and takes over when turns go idle. */
  waitingForIdle?: boolean;
  onRetry?: () => void;
}) {
  const copy = managedRuntimeProgressCopy(props.progress, props.waitingForIdle === true);
  const busy = copy.tone === "busy";
  return (
    <ProgressStrip
      eyebrow={copy.eyebrow}
      line={copy.message ?? copy.meter}
      lineIsMeter={copy.message === undefined && copy.meter !== undefined}
      reservedLines={managedRuntimeStatusLines(props.progress.runtime)}
      steps={copy.steps?.map((step) => ({ key: step.phase, label: step.label, state: step.state }))}
      tag={copy.tag}
      testId={`managed-progress-${props.progress.runtime}`}
      tone={copy.tone}
      track={busy || copy.full
        ? {
            percent: copy.percent,
            full: copy.full,
            label: copy.percent === undefined ? copy.eyebrow : `Download ${copy.percent}%`,
          }
        : undefined}
    >
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
    </ProgressStrip>
  );
}
