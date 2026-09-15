const ROW_CHANGE_METHODS = new Set([
  "navigation/invalidated", "federation/eventStream/changed",
  "thread/started", "thread/archived", "thread/unarchived", "thread/status/changed",
  "navigation/thread/seen", "thread/name/updated", "thread/rewound",
  "thread/pullRequests/updated", "pullRequest/status/updated", "thread/reactions/updated",
  "thread/pin/added", "thread/pin/removed", "thread/pin/reordered",
  "thread/agent/updated", "thread/parent/set", "thread/parent/cleared", "thread/turnQueue/updated",
  "thread/subthreadOrder/updated", "thread/subthreadsCollapsed/updated", "thread/subAgents/updated",
  "thread/modelSettings/updated", "thread/executionMode/updated", "thread/executionMode/queued",
  "thread/executionMode/queueCleared", "thread/prAutoDispatch/updated", "thread/prAutoDispatch/pendingUpdated",
  "thread/automations/updated", "automation/run/updated",
  "directory/pin/added", "directory/pin/removed", "directory/pin/reordered", "directory/threadsCollapsed/updated",
  "navigation/providerThreads/refreshed", "navigation/remoteThreadPins/changed",
  "navigation/directory/seen", "navigation/directory/removed", "navigation/directoryGitStatus/updated",
  "navigation/threadGitWorkingState/updated", "navigation/threadDirectories/updated",
  "turn/started", "turn/completed", "turn/failed", "turn/cancelled",
  "serverRequest/resolved", "item/tool/requestUserInput",
]);

/** Streamed text, token accounting and tool deltas do not refresh collection queries. */
export function navigationQueryEventRequiresRefresh(method: string, params?: unknown): boolean {
  if (method === "thread/subAgents/updated" && params && typeof params === "object"
    && "navigationChanged" in params && params.navigationChanged === false) return false;
  return ROW_CHANGE_METHODS.has(method) || method.endsWith("/requestApproval");
}

// Only these events are known to leave group membership unchanged. Creation,
// archive, reparenting, provider refreshes and unknown future events retain
// discovery coverage even when the new child's identity is not subscribed yet.
const THREAD_ROW_ONLY_METHODS = new Set([
  "thread/status/changed", "thread/name/updated", "navigation/thread/seen",
  "thread/pullRequests/updated", "thread/reactions/updated", "thread/agent/updated",
  "thread/modelSettings/updated", "thread/executionMode/updated", "thread/executionMode/queued",
  "thread/executionMode/queueCleared", "thread/prAutoDispatch/updated", "thread/prAutoDispatch/pendingUpdated",
  "thread/turnQueue/updated", "navigation/threadGitWorkingState/updated", "navigation/directoryGitStatus/updated",
  // Subagent detail and native-group presence belong to the named parent.
  // Ordinary child discovery uses thread/started and thread/parent/set.
  "thread/subAgents/updated",
  "turn/started", "turn/completed", "turn/failed", "turn/cancelled",
]);

export function navigationInvalidationMayChangeMembership(sourceMethod: unknown): boolean {
  return typeof sourceMethod !== "string" || !THREAD_ROW_ONLY_METHODS.has(sourceMethod);
}

/** Same path precedence used by owner working-state probes and visible rows. */
export function navigationWorkingStatePath(thread: {
  projectKey?: string;
  linkedDirectories: readonly { kind?: string; path?: string; worktreePath?: string }[];
}): string | undefined {
  return thread.projectKey?.trim()
    || thread.linkedDirectories.find((directory) => directory.worktreePath?.trim())?.worktreePath?.trim()
    || thread.linkedDirectories.find((directory) => directory.kind === "local" && directory.path?.trim())?.path?.trim();
}
