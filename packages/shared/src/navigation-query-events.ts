/**
 * An owner's directory identity set (key, kind, label, path, origin and
 * availability) changed, or a viewer just subscribed to the `directory_set`
 * event class (`reason: "subscribed"`), which acknowledges the watch. Only an
 * owner advertising `navigation_directory_set_events` sends it, and only to
 * `directory_set` subscribers. It carries no rows.
 */
export const NAVIGATION_DIRECTORY_SET_CHANGED_METHOD = "navigation/directorySet/changed";

export const NAVIGATION_DIRECTORY_SCOPE_MAX_KEYS = 100;
export const NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES = 16 * 1024;

/** Validate once per event, before a viewer uses an owner's exclusion proof. */
export function readNavigationDirectoryScope(value: unknown): readonly string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const scope = value as { version?: unknown; directoryKeys?: unknown };
  if (scope.version !== 1 || !Array.isArray(scope.directoryKeys)
    || scope.directoryKeys.length > NAVIGATION_DIRECTORY_SCOPE_MAX_KEYS) return undefined;
  let characters = 0;
  for (const key of scope.directoryKeys) {
    if (typeof key !== "string" || !key || key.length > 1_024) return undefined;
    characters += key.length;
  }
  if (characters > NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES) return undefined;
  // Shared runs without DOM or Node globals. JSON escapes lone surrogates;
  // iteration counts paired supplementary code points as four UTF-8 bytes.
  let bytes = 0;
  for (const character of JSON.stringify({ version: 1, directoryKeys: scope.directoryKeys })) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > NAVIGATION_DIRECTORY_SCOPE_MAX_BYTES) return undefined;
  }
  return scope.directoryKeys as string[];
}

const ROW_CHANGE_METHODS = new Set([
  "navigation/invalidated", "federation/eventStream/changed",
  "thread/started", "thread/archived", "thread/deleted", "thread/unarchived", "thread/status/changed",
  "navigation/thread/seen", "thread/name/updated", "thread/rewound",
  "thread/pullRequests/updated", "pullRequest/status/updated", "thread/reactions/updated", "thread/lock/updated",
  "thread/checkoutHibernation/updated",
  "thread/pin/added", "thread/pin/removed", "thread/pin/reordered",
  "thread/agent/updated", "thread/parent/set", "thread/parent/cleared", "thread/turnQueue/updated",
  "thread/subthreadOrder/updated", "thread/subthreadsCollapsed/updated", "thread/subAgents/updated",
  "thread/backgroundTasks/updated", "thread/modelSettings/updated", "thread/executionMode/updated", "thread/executionMode/queued",
  "thread/executionMode/queueCleared", "thread/prAutoDispatch/updated", "thread/prAutoDispatch/pendingUpdated",
  "thread/prWatches/updated",
  "thread/automations/updated", "automation/run/updated",
  "directory/pin/added", "directory/pin/removed", "directory/pin/reordered", "directory/threadsCollapsed/updated",
  "directory/forgeAutomation/updated",
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
  "thread/dependencies/updated", "thread/scheduledAction/updated",
  "thread/status/changed", "thread/name/updated", "navigation/thread/seen",
  "thread/pullRequests/updated", "thread/reactions/updated", "thread/lock/updated", "thread/agent/updated",
  "thread/modelSettings/updated", "thread/executionMode/updated", "thread/executionMode/queued",
  "thread/executionMode/queueCleared", "thread/prAutoDispatch/updated", "thread/prAutoDispatch/pendingUpdated",
  "thread/turnQueue/updated", "thread/turnQueue/reordered",
  // A row's hibernation marks; hibernating never moves a thread between groups.
  "thread/checkoutHibernation/updated",
  // A row's CI watch marks; watches never move a thread between groups.
  "thread/prWatches/updated",
  "navigation/threadGitWorkingState/updated", "navigation/directoryGitStatus/updated",
  // Subagent detail and native-group presence belong to the named parent.
  // Ordinary child discovery uses thread/started and thread/parent/set.
  "thread/subAgents/updated",
  // Background tasks only toggle the owning row's working marker.
  "thread/backgroundTasks/updated",
  // A backend's own scheduled wakes refresh only that thread's Waiting for.
  "thread/sessionWakes/updated",
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
