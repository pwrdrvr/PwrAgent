const ROW_CHANGE_METHODS = new Set([
  "thread/started", "thread/archived", "thread/unarchived", "thread/status/changed",
  "thread/inbox/changed", "thread/name/updated", "thread/pr/updated",
  "thread/gitWorkingState/updated", "thread/pin/updated", "thread/pin/reordered",
  "thread/agent/updated", "thread/parent/updated", "thread/turnQueue/updated",
  "directory/pin/reordered", "directory/registered", "directory/removed",
  "turn/started", "turn/completed", "serverRequest/resolved", "item/tool/requestUserInput",
]);

/** Streamed text, token accounting and tool deltas do not refresh collection queries. */
export function navigationQueryEventRequiresRefresh(method: string): boolean {
  return ROW_CHANGE_METHODS.has(method) || method.endsWith("/requestApproval");
}
