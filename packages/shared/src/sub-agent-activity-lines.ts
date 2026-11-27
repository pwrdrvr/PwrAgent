/**
 * What each running sub-agent of one thread is doing now, by card
 * `monitorId`: the muted line under a working sub-agent. Live only; a line is
 * command text that changes with every tool call the sub-agent makes.
 */
export type SubAgentActivityLine = { monitorId: string; activity: string };

/**
 * The `thread/subAgentActivity/updated` params after the thread id: the lines
 * that started or changed since the previous event, and the cards whose line
 * ended. One event carries only what changed, so a tool call costs one line,
 * not one line per running sub-agent.
 */
export type SubAgentActivityChanges = {
  activities: SubAgentActivityLine[];
  /** Cards whose line ended: their sub-agent stopped running or went quiet. */
  cleared?: string[];
};

/** What changed from the published lines to the current ones; undefined when nothing did. */
export function subAgentActivityChanges(
  published: ReadonlyMap<string, string>,
  current: readonly SubAgentActivityLine[],
): SubAgentActivityChanges | undefined {
  const activities = current.filter((line) => published.get(line.monitorId) !== line.activity);
  const running = new Set(current.map((line) => line.monitorId));
  const cleared = [...published.keys()].filter((monitorId) => !running.has(monitorId));
  if (activities.length === 0 && cleared.length === 0) return undefined;
  return { activities, ...(cleared.length > 0 ? { cleared } : {}) };
}

/** The lines after a change; the same map when the change changes nothing. */
export function applySubAgentActivityChanges(
  lines: ReadonlyMap<string, string>,
  changes: SubAgentActivityChanges,
): ReadonlyMap<string, string> {
  const changed = changes.activities.some((line) => lines.get(line.monitorId) !== line.activity)
    || (changes.cleared ?? []).some((monitorId) => lines.has(monitorId));
  if (!changed) return lines;
  const next = new Map(lines);
  for (const monitorId of changes.cleared ?? []) next.delete(monitorId);
  for (const line of changes.activities) next.set(line.monitorId, line.activity);
  return next;
}
