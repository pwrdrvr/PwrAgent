const ROW_CHANGE_METHODS = new Set([
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
export function navigationQueryEventRequiresRefresh(method: string): boolean {
  return ROW_CHANGE_METHODS.has(method) || method.endsWith("/requestApproval");
}
