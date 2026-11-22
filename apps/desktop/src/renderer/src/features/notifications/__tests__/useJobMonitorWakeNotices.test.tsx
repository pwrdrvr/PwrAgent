import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ThreadPendingWakesRequest, ThreadPendingWakesResponse } from "@pwragent/shared/contracts/thread-pending-wakes";
import { useJobMonitorWakeNotices } from "../useJobMonitorWakeNotices";

it.each(["Acknowledge", "Rearm"])("reads the durable alert on mount and sends the distinct %s action", async (label) => {
  const alert = { backend: "codex" as const, threadId: "thread", generation: 3, trippedAt: 4 };
  let acknowledged = false;
  let tripped = true;
  const manageThreadPendingWakes = vi.fn(async (request: ThreadPendingWakesRequest): Promise<ThreadPendingWakesResponse> => {
    if (request.action === "list_monitor_wake_alerts") return { ok: true, monitorWakeAlerts: tripped && !acknowledged ? [alert] : [] };
    if (request.action === "acknowledge_monitor_wake_alert") acknowledged = true;
    if (request.action === "rearm_monitor_wakes") tripped = false;
    return { ok: true };
  });
  const api = { manageThreadPendingWakes, onAgentEvent: undefined };
  const showNotice = vi.fn();
  const view = renderHook(() => useJobMonitorWakeNotices(api, showNotice));
  await waitFor(() => expect(view.result.current).toHaveLength(1));
  expect(view.result.current[0]?.autoDismiss).toBe(false);
  act(() => view.result.current[0]?.actions?.find((action) => action.label === label)?.onClick());
  await waitFor(() => expect(view.result.current).toHaveLength(0));
  expect(manageThreadPendingWakes).toHaveBeenCalledWith({
    action: label === "Acknowledge" ? "acknowledge_monitor_wake_alert" : "rearm_monitor_wakes",
    backend: "codex", threadId: "thread", generation: 3,
  });
  expect(tripped).toBe(label === "Acknowledge");
  expect(showNotice).not.toHaveBeenCalled();
});
