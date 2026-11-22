import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobMonitorWakeAlert } from "@pwragent/shared/contracts/thread-pending-wakes";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function useJobMonitorWakeNotices(
  api: Pick<DesktopApi, "manageThreadPendingWakes" | "onAgentEvent"> | undefined,
  showNotice: (notice: AppNoticeToastNotice) => void,
): AppNoticeToastNotice[] {
  const [alerts, setAlerts] = useState<JobMonitorWakeAlert[]>([]);
  const revision = useRef(0);
  const manage = api?.manageThreadPendingWakes;
  const subscribe = api?.onAgentEvent;
  const refresh = useCallback(async () => {
    if (!manage) return;
    const reading = ++revision.current;
    const result = await manage({ action: "list_monitor_wake_alerts" });
    if (reading === revision.current && result.ok) setAlerts(result.monitorWakeAlerts ?? []);
  }, [manage]);

  useEffect(() => {
    const reload = () => { void refresh().catch(() => undefined); };
    const unsubscribe = subscribe?.((event) => {
      if (event.notification.method === "thread/taskMonitorWakeGuard/updated" && event.federationTarget?.scope !== "remote") reload();
    });
    reload();
    return () => {
      revision.current++;
      unsubscribe?.();
    };
  }, [refresh, subscribe]);

  return useMemo(() => alerts.map(({ backend, threadId, generation }) => {
    const id = `job-monitor-wake:${backend}:${threadId}:${generation}`;
    const act = async (action: "acknowledge_monitor_wake_alert" | "rearm_monitor_wakes") => {
      try {
        const result = await manage?.({ action, backend, threadId, generation });
        if (result && !result.ok) throw new Error(result.error.message);
        await refresh();
      } catch (error) {
        showNotice({ id: `${id}:error`, title: "Could not update Job Monitors", message: String(error), tone: "error" });
      }
    };
    const acknowledge = () => { void act("acknowledge_monitor_wake_alert"); };
    return {
      id,
      title: "Job Monitors suspended",
      message: "A lightweight review detected repeat monitoring of the same work. Results are in Sub-agents.",
      tone: "warning",
      autoDismiss: false,
      threadLink: { backend, threadId, title: "Open thread" },
      dismissLabel: "Acknowledge without rearming",
      onDismiss: acknowledge,
      actions: [
        { label: "Rearm", onClick: () => { void act("rearm_monitor_wakes"); } },
        { label: "Acknowledge", onClick: acknowledge, tone: "secondary" },
      ],
    };
  }), [alerts, manage, refresh, showNotice]);
}
