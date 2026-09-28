import type { ThreadToolInvocationRecord } from "@pwragent/shared";

export const MONITOR_JOB_SUGGESTION =
  "PwrAgent System - Monitor Job Suggestion: You appear to be repeatedly checking a long-running task. "
  + "Consider using create_monitor_delegation to avoid repeatedly waking this parent model and paying for its accumulated context. "
  + "Give the monitor the target, check interval, completion conditions, and problems to watch for. "
  + "It will stop and report back when the task finishes or a specified problem occurs. "
  + "For an attached PR, first check PwrAgent's PR automation guidance and use watch_thread_pull_request when applicable. "
  + "After the monitor or PR watch starts, end this turn if no unrelated work remains. "
  + "A monitor cannot inherit a parent-local session or cell ID; give it durable process, log, or status identifiers. "
  + "This is an automatic reminder, sent at most once this turn.";

/** Observe protocol boundaries only. No timers, model calls, or per-poll writes. */
export class MonitorJobSuggestionDetector {
  private readonly turns = new Map<string, {
    turnId: string;
    seen: Set<string>;
    checks: Map<string, number[]>;
    suggested: boolean;
  }>();

  clear(backend: string, threadId: string): void {
    this.turns.delete(`${backend}:${threadId}`);
  }

  observe(record: ThreadToolInvocationRecord): boolean {
    if (!record.turnId) return false;
    const signal = pollingSignal(record);
    if (!signal) return false;
    const threadKey = `${record.backend}:${record.threadId}`;
    const key = `${record.turnId}:${signal}`;
    let state = this.turns.get(threadKey);
    if (!state || state.turnId !== record.turnId) {
      state = { turnId: record.turnId, seen: new Set(), checks: new Map(), suggested: false };
      this.turns.set(threadKey, state);
    }
    if (state.suggested || state.seen.has(record.invocationId)) return false;
    state.seen.add(record.invocationId);
    // Bound retained evidence even if a provider never emits turn completion.
    if (state.seen.size > 100) state.seen.delete(state.seen.values().next().value!);
    const checks = (state.checks.get(key) ?? []).filter(
      (time) => record.observedAt - time <= 10 * 60_000,
    );
    checks.push(record.observedAt);
    // Keep the window's first observation as well as the latest two. Keeping
    // only the latest three loses sustained duration at short poll intervals.
    // The latest two retain the minimum-count evidence when the first expires.
    state.checks.set(key, checks.length > 3 ? [checks[0]!, ...checks.slice(-2)] : checks);
    if (state.checks.size > 32) state.checks.delete(state.checks.keys().next().value!);
    if (checks.length < 3 || record.observedAt - checks[0]! < 30_000) return false;
    state.suggested = true;
    return true;
  }
}

function pollingSignal(record: ThreadToolInvocationRecord): string | undefined {
  const tool = record.toolName.split(/[./]/).pop() ?? record.toolName;
  if (tool === "wait" || (tool === "write_stdin" && record.category === "polling")) {
    return record.normalizedCommand;
  }
  if (tool === "sleep" || tool.endsWith("__sleep")) return "sleep";
  const command = record.normalizedCommand ?? "";
  if (/^sleep\s+\d/.test(command)) return "sleep";
  // Group only read-only status requests for the same target. Logs and mutations
  // are investigation/work, not evidence of a polling loop.
  const gh = command.match(/^gh\s+(run\s+view|pr\s+(?:view|checks))\s+(\d+|https:\/\/[^\s'"]+)/);
  if (!gh || /--log(?:-failed)?\b/.test(command)) return undefined;
  const repo = command.match(/(?:--repo|-R)\s+([^\s'"]+)/)?.[1] ?? "";
  return `gh:${gh[1]}:${repo}:${gh[2]}`;
}
