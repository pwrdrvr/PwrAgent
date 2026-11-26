import { useEffect, useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadAutoCompactionStatus } from "../features/composer/context-window-budget";
import type { DesktopApi } from "./desktop-api";
import { agentEventThreadIdentityKey, threadSummaryIdentityKey } from "./federated-thread-events";

/**
 * The owner's latest auto-compaction phase for one thread. Window-local and
 * transient: the owner sends it only when the phase changes, so a thread
 * opened later shows nothing until the next change.
 */
export function useThreadAutoCompaction(
  desktopApi: Pick<DesktopApi, "onAgentEvent"> | undefined,
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation"> | undefined,
): ThreadAutoCompactionStatus | undefined {
  const threadKey = thread ? threadSummaryIdentityKey(thread) : undefined;
  const [status, setStatus] = useState<{ key: string; value: ThreadAutoCompactionStatus }>();
  useEffect(() => {
    if (!threadKey || !desktopApi?.onAgentEvent) return;
    return desktopApi.onAgentEvent((event) => {
      if (event.notification.method !== "thread/autoCompaction/updated") return;
      const params = event.notification.params as ThreadAutoCompactionStatus;
      if (agentEventThreadIdentityKey(event, params.threadId) !== threadKey) return;
      setStatus({ key: threadKey, value: params });
    });
  }, [desktopApi, threadKey]);
  return status && status.key === threadKey ? status.value : undefined;
}
