import { buildPullRequestStatusKey, normalizeRenamedTitleSource } from "@pwragent/shared";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { resolveThreadWorkingStatePath } from "./thread-working-state-path";
import { agentEventMatchesThread, federationTargetsEqual } from "./federated-thread-events";

type CanonicalNotification = Extract<AgentEvent["notification"], { method:
  | "thread/name/updated" | "thread/status/changed" | "thread/executionMode/updated"
  | "thread/executionMode/queued" | "thread/executionMode/queueCleared" | "thread/modelSettings/updated"
  | "thread/codexEnvironment/updated" | "thread/acpRuntime/updated" | "thread/prAutoDispatch/updated"
  | "thread/prAutoDispatch/pendingUpdated" | "navigation/thread/seen"
  | "thread/pullRequests/updated" | "pullRequest/status/updated" | "navigation/threadGitWorkingState/updated"
  | "thread/parent/set" | "thread/parent/cleared" | "thread/subAgents/updated" | "thread/reactions/updated"
  | "thread/subthreadOrder/updated" | "thread/subthreadsCollapsed/updated"
}>;

/** Canonical owner events update a retained exact detail without any collection read. */
export function applyNavigationThreadEvent(thread: NavigationThreadSummary, event: AgentEvent): NavigationThreadSummary {
  const notification = event.notification as CanonicalNotification;
  if (!federationTargetsEqual(event.federationTarget, thread.federation?.ref.target)) return thread;
  if (notification.method === "navigation/threadGitWorkingState/updated") {
    const params = notification.params;
    if (resolveThreadWorkingStatePath(thread) !== params.worktreePath
      || (thread.gitWorkingStateFetchedAt ?? 0) > params.fetchedAt) return thread;
    return { ...thread, gitWorkingState: params.gitWorkingState ?? undefined, gitWorkingStateFetchedAt: params.fetchedAt };
  }
  if (notification.method === "pullRequest/status/updated") {
    const { prKey, pr } = notification.params;
    if (!thread.prs?.some((item) => buildPullRequestStatusKey(item) === prKey)) return thread;
    return { ...thread, prs: thread.prs.map((item) => buildPullRequestStatusKey(item) === prKey ? pr : item) };
  }
  if (notification.method === "thread/subthreadOrder/updated" || notification.method === "thread/subthreadsCollapsed/updated") {
    if (!agentEventMatchesThread(event, thread, notification.params.parentThreadId)) return thread;
    return notification.method === "thread/subthreadOrder/updated"
      ? { ...thread, subthreadOrder: notification.params.threadIds }
      : { ...thread, subthreadsCollapsed: notification.params.collapsed };
  }
  if (!("threadId" in notification.params) || typeof notification.params.threadId !== "string"
    || !agentEventMatchesThread(event, thread, notification.params.threadId)) return thread;
  switch (notification.method) {
    case "thread/pullRequests/updated":
      return { ...thread, prs: notification.params.prs };
    case "thread/reactions/updated":
      return { ...thread, reactions: notification.params.reactions };
    case "thread/subAgents/updated":
      return { ...thread, subAgents: notification.params.subAgents };
    case "thread/parent/set":
      return { ...thread, parentThreadId: notification.params.parentThreadId,
        parentThreadBackend: notification.params.parentThreadBackend, parentThreadInstanceId: notification.params.parentThreadInstanceId };
    case "thread/parent/cleared":
      return { ...thread, parentThreadId: undefined, parentThreadBackend: undefined, parentThreadInstanceId: undefined };
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
