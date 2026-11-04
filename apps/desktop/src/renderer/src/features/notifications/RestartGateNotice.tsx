import { useEffect, useMemo, useState } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import type { RestartGateStatus } from "../../../../shared/restart-gate";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const RESTART_GATE_NOTICE_ID = "restart-gate-resuming";

/**
 * Shown while the threads a quiet restart stopped are being continued. Until
 * they have all started, PwrAgent holds every other queued message,
 * automation and Continue After, so the operator sees why nothing else runs
 * and can start everything now.
 */
export function RestartGateNotice(props: {
  desktopApi?: Pick<
    DesktopApi,
    "getRestartGateStatus" | "onRestartGateStatusChanged" | "releaseRestartGate"
  >;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
}) {
  const { desktopApi, onNoticeChanged } = props;
  const [status, setStatus] = useState<RestartGateStatus>({ phase: "open" });
  const [releasing, setReleasing] = useState(false);
  // Closed by the operator: stays closed until this restart's gate opens.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = desktopApi?.onRestartGateStatusChanged?.((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.phase !== "resuming") {
        setReleasing(false);
        setDismissed(false);
      }
    });
    void desktopApi?.getRestartGateStatus?.()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // Best effort only. Every later change still pushes an event.
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  const notice = useMemo(
    () => dismissed ? undefined : buildRestartGateNotice({
      onDismiss: () => setDismissed(true),
      onRelease: () => {
        setReleasing(true);
        void desktopApi?.releaseRestartGate?.()
          .catch(() => setReleasing(false));
      },
      releasing,
      status,
    }),
    [desktopApi, dismissed, releasing, status],
  );

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function buildRestartGateNotice(params: {
  onDismiss?: () => void;
  onRelease: () => void;
  releasing: boolean;
  status: RestartGateStatus;
  formatTime?: (at: number) => string;
}): AppNoticeToastNotice | undefined {
  const { status } = params;
  if (status.phase !== "resuming") return undefined;
  const formatTime = params.formatTime ?? formatClock;
  const threads = status.waiting === 1 ? "1 thread" : `${status.waiting} threads`;
  const facts = [
    ...(status.nextAt !== undefined ? [{ label: "Next start", value: formatTime(status.nextAt) }] : []),
    ...(status.releaseBy !== undefined ? [{ label: "Everything starts by", value: formatTime(status.releaseBy) }] : []),
  ];
  return {
    autoDismiss: false,
    id: RESTART_GATE_NOTICE_ID,
    ...(params.onDismiss ? { onDismiss: params.onDismiss } : {}),
    title: "Continuing after restart",
    message: `${threads} stopped for the restart will continue a few at a time.`
      + " Other queued messages, automations and Continue After wait until they start.",
    ...(facts.length > 0 ? { facts } : {}),
    ...(params.releasing
      ? { status: { label: "Starting everything…", state: "progress" as const } }
      : {
          actions: [{
            label: "Start everything now",
            onClick: params.onRelease,
            tone: "primary" as const,
          }],
        }),
    tone: "neutral",
  };
}
