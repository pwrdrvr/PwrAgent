import { useEffect, useMemo, useState } from "react";
import type { CodexAppServerRestartStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

/** Every notice id this producer can emit, as prefixes for the host's sweep. */
export const CODEX_RESTART_NOTICE_ID_PREFIXES = ["codex-restart-stopped:"] as const;

type RestartAttempt =
  | { state: "idle" }
  | { state: "restarting" }
  | { state: "failed"; error: string };

/**
 * Shown when PwrAgent stopped restarting a Codex app server that kept exiting
 * on its own. Ordinary exits restart after a backoff with no notice; this one
 * needs the operator, because nothing starts Codex again until they ask.
 */
export function CodexRestartNotice(props: {
  desktopApi?: Pick<
    DesktopApi,
    "getCodexRestartStatus" | "onCodexRestartStatusChanged" | "restartCodex"
  >;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
}) {
  const { desktopApi, onNoticeChanged } = props;
  const [status, setStatus] = useState<CodexAppServerRestartStatus>({ stopped: false });
  const [attempt, setAttempt] = useState<RestartAttempt>({ state: "idle" });
  const [dismissedStoppedAt, setDismissedStoppedAt] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = desktopApi?.onCodexRestartStatusChanged?.((next) => {
      if (cancelled) return;
      setStatus(next);
      // A breaker that opens again is a new stop, not the old attempt's failure.
      if (next.stopped) setAttempt({ state: "idle" });
    });
    void desktopApi?.getCodexRestartStatus?.()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // Best effort only. The breaker opening later still pushes an event.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  const notice = useMemo(
    () => buildCodexRestartNotice({
      attempt,
      dismissedStoppedAt,
      onDismiss: (stoppedAt) => {
        setDismissedStoppedAt(stoppedAt);
        setAttempt({ state: "idle" });
      },
      onRestart: () => {
        setAttempt({ state: "restarting" });
        void desktopApi?.restartCodex?.()
          .then((result) => {
            setStatus(result.status);
            setAttempt(result.error
              ? { state: "failed", error: result.error }
              : { state: "idle" });
          })
          .catch((error: unknown) => {
            setAttempt({
              state: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
      status,
    }),
    [attempt, desktopApi, dismissedStoppedAt, status],
  );

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

export function buildCodexRestartNotice(params: {
  attempt: RestartAttempt;
  dismissedStoppedAt?: number;
  onDismiss: (stoppedAt: number | undefined) => void;
  onRestart: () => void;
  status: CodexAppServerRestartStatus;
}): AppNoticeToastNotice | undefined {
  const { attempt, status } = params;
  // A restart that failed again leaves the breaker closed but Codex down;
  // keep the notice so the operator sees why and can try once more.
  if (!status.stopped && attempt.state !== "failed") return undefined;
  if (status.stopped && status.stoppedAt === params.dismissedStoppedAt) return undefined;

  const stoppedAt = status.stopped ? status.stoppedAt : undefined;
  const minutes = status.stopped ? Math.round(status.windowMs / 60_000) : 0;
  const lastExit = status.stopped
    ? status.lastExit.signal
      ? `Last exit: signal ${status.lastExit.signal}.`
      : status.lastExit.code !== null
        ? `Last exit: code ${status.lastExit.code}.`
        : undefined
    : undefined;
  return {
    autoDismiss: false,
    id: `codex-restart-stopped:${stoppedAt ?? "restart-failed"}`,
    onDismiss: () => params.onDismiss(stoppedAt),
    title: "Codex stopped",
    message: status.stopped
      ? `Codex stopped unexpectedly ${status.exits} times in ${minutes} minutes,`
        + " so PwrAgent stopped restarting it. Codex threads can't run until it"
        + " starts again."
      : "Codex did not start again.",
    ...(lastExit ? { detail: lastExit } : {}),
    ...(attempt.state === "restarting"
      ? { status: { label: "Restarting Codex…", state: "progress" as const } }
      : attempt.state === "failed"
        ? {
            status: { label: attempt.error, state: "error" as const },
            copyText: attempt.error,
          }
        : {}),
    ...(attempt.state === "restarting"
      ? {}
      : {
          actions: [{
            label: "Restart Codex",
            onClick: params.onRestart,
            tone: "primary" as const,
          }],
        }),
    tone: "error",
  };
}
