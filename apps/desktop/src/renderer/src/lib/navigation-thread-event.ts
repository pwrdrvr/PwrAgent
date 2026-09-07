import { normalizeRenamedTitleSource } from "@pwragent/shared";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { agentEventMatchesThread } from "./federated-thread-events";

type CanonicalNotification = Extract<AgentEvent["notification"], { method:
  | "thread/name/updated" | "thread/status/changed" | "thread/executionMode/updated"
  | "thread/executionMode/queued" | "thread/executionMode/queueCleared" | "thread/modelSettings/updated"
  | "thread/codexEnvironment/updated" | "thread/acpRuntime/updated" | "thread/prAutoDispatch/updated"
  | "thread/prAutoDispatch/pendingUpdated" | "navigation/thread/seen"
}>;

/** Canonical owner events update a retained exact detail without any collection read. */
export function applyNavigationThreadEvent(thread: NavigationThreadSummary, event: AgentEvent): NavigationThreadSummary {
  const notification = event.notification as CanonicalNotification;
  if (!("threadId" in notification.params) || typeof notification.params.threadId !== "string"
    || !agentEventMatchesThread(event, thread, notification.params.threadId)) return thread;
  switch (notification.method) {
    case "thread/name/updated": {
      const title = notification.params.threadName?.trim();
      return title ? { ...thread, title, titleSource: normalizeRenamedTitleSource(notification.params.titleSource) } : thread;
    }
    case "thread/status/changed": {
      const status = notification.params.status.type;
      return status === "active" || status === "idle" || status === "notLoaded" || status === "unknown"
        ? { ...thread, threadStatus: status } : thread;
    }
    case "thread/executionMode/updated":
      return { ...thread, executionMode: notification.params.executionMode };
    case "thread/executionMode/queued":
      return { ...thread, queuedExecutionMode: notification.params.queuedExecutionMode, queuedExecutionModeAt: notification.params.queuedAt };
    case "thread/executionMode/queueCleared":
      return { ...thread, queuedExecutionMode: undefined, queuedExecutionModeAt: undefined };
    case "thread/modelSettings/updated": {
      const params = notification.params;
      return { ...thread, ...("model" in params ? { model: params.model } : {}),
        ...("reasoningEffort" in params ? { reasoningEffort: params.reasoningEffort } : {}),
        ...("serviceTier" in params ? { serviceTier: params.serviceTier } : {}),
        ...("fastMode" in params ? { fastMode: params.fastMode } : {}) };
    }
    case "thread/codexEnvironment/updated":
      return { ...thread, codexEnvironmentRuntime: notification.params.codexEnvironmentRuntime };
    case "thread/acpRuntime/updated":
      return { ...thread, acpRuntime: notification.params.acpRuntime };
    case "thread/prAutoDispatch/updated":
      return { ...thread, prAutoDispatchEnabled: notification.params.enabled };
    case "thread/prAutoDispatch/pendingUpdated":
      return { ...thread, prAutoDispatchPending: notification.params.pending ?? undefined };
    case "navigation/thread/seen": {
      const watermark = notification.params.seenUpdatedAt;
      if (watermark !== undefined && (thread.updatedAt ?? 0) > watermark) return thread;
      return { ...thread, inbox: { ...thread.inbox, inInbox: false, reason: undefined, lastSeenUpdatedAt: watermark } };
    }
    default:
      return thread;
  }
}
