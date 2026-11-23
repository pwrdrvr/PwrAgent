import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { NavigationThreadSummary, SetThreadJobMonitorCreationResponse } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "./desktop-api";

/** A remote window without owner metadata cannot establish capability. */
export function threadJobMonitorControl(
  desktopApi: DesktopApi | undefined,
  thread: NavigationThreadSummary | undefined,
  windowTarget: FederationTarget | undefined,
): ((enabled: boolean) => Promise<SetThreadJobMonitorCreationResponse>) | undefined {
  const setJobMonitorCreation = desktopApi?.setThreadJobMonitorCreation;
  if (!setJobMonitorCreation || (thread?.source !== "codex" && thread?.source !== "claude")) return undefined;
  const federation = thread.federation;
  const target = federation?.ref.target ?? windowTarget;
  if (target?.scope !== "remote") return (enabled) => setJobMonitorCreation({
    threadId: thread.id, enabled, ...(thread.source === "claude" ? { backend: "claude" } : {}),
  });
  if (thread.source !== "codex" || federation?.ref.target.scope !== "remote" || federation.ref.threadId !== thread.id
    || federation.ref.backend !== thread.source
    || (federation.peerStatus !== undefined && federation.peerStatus !== "connected")
    || !federation.capabilities?.includes("thread_job_monitor_control")
    || !federation.capabilities.includes("turn_control")) return undefined;
  return (enabled) => setJobMonitorCreation({ threadId: thread.id, enabled, federationTarget: target });
}
