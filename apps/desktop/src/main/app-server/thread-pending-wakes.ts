import {
  THREAD_DEPENDENCY_CONDITION_PHRASES,
  THREAD_PENDING_WAKE_TEXT_MAX_CHARS,
  THREAD_PENDING_WAKES_ENDED_MAX_LIMIT,
  buildThreadPendingWakeKey,
  parseThreadPendingWakeKey,
  type AppServerBackendKind,
  type AppServerBackgroundTask,
  type ScheduledThreadAction,
  type ThreadDependency,
  type ThreadPendingWake,
  type ThreadPendingWakeEnded,
  type ThreadPendingWakesErrorCode,
  type ThreadPendingWakesList,
  type ThreadPendingWakesResponse,
  type ThreadPrAutoFixState,
  type ThreadPrWatchHistoryEntry,
  type ThreadPullRequestWatchSummary,
  type ThreadSubAgentSummary,
} from "@pwragent/shared";

export type PendingWakeThread = { backend: AppServerBackendKind; threadId: string };

export type PendingTaskMonitorWake = {
  monitorId: string;
  task: string;
  backend: AppServerBackendKind;
  monitorThreadId?: string;
  model?: string;
  createdAt: number;
  lastActivityAt: number;
  pollIntervalSeconds: number;
};

/**
 * Each source's own read. All are reads: building the list writes nothing.
 * A reader that throws leaves its source out and marks the list incomplete.
 */
export type ThreadPendingWakeReaders = {
  prWatches: (thread: PendingWakeThread) => Promise<ThreadPullRequestWatchSummary[]>;
  prWatchHistory: (thread: PendingWakeThread, limit: number) => Promise<ThreadPrWatchHistoryEntry[]>;
  /** Auto-fix states for this thread's PRs. */
  autoFix: (thread: PendingWakeThread) => Promise<ThreadPrAutoFixState[]>;
  /** Every registration this thread waits on, active and ended. */
  dependencies: (thread: PendingWakeThread) => Promise<ThreadDependency[]>;
  /** The thread's active scheduled actions, plus recently ended ones when asked. */
  scheduledActions: (
    thread: PendingWakeThread,
    includeEnded: boolean,
  ) => ScheduledThreadAction[] | Promise<ScheduledThreadAction[]>;
  monitors: (thread: PendingWakeThread) => PendingTaskMonitorWake[];
  /** The thread's newest sub-agent cards, for monitors that ended. */
  recentSubAgents: (thread: PendingWakeThread, limit: number) => Promise<ThreadSubAgentSummary[]>;
  /** Tasks the backend runs for the thread; only background ones wake it. */
  backendTasks: (thread: PendingWakeThread) => Promise<AppServerBackgroundTask[]>;
};

export const DEFAULT_PENDING_WAKES_ENDED_LIMIT = 8;
const MONITOR_ID_PREFIX = "monitor-";
const DETAIL_MAX_CHARS = 80;

/**
 * The thread's pending wakes, soonest first, and the most recent ended ones.
 * `onReadError` hears about each source that could not be read.
 */
export async function buildThreadPendingWakes(
  readers: ThreadPendingWakeReaders,
  thread: PendingWakeThread,
  options: { endedLimit?: number; onReadError?: (source: string, error: unknown) => void } = {},
): Promise<ThreadPendingWakesList> {
  const endedLimit = clampEndedLimit(options.endedLimit);
  let incomplete = false;
  const read = async <T>(source: string, fallback: T, load: () => T | Promise<T>): Promise<T> => {
    try {
      return await load();
    } catch (error) {
      incomplete = true;
      options.onReadError?.(source, error);
      return fallback;
    }
  };
  const [
    prWatches, prHistory, autoFix, dependencies, scheduled, monitors, subAgents, tasks,
  ] = await Promise.all([
    read("prWatches", [] as ThreadPullRequestWatchSummary[], () => readers.prWatches(thread)),
    read("prWatchHistory", [] as ThreadPrWatchHistoryEntry[], () => readers.prWatchHistory(thread, endedLimit)),
    read("autoFix", [] as ThreadPrAutoFixState[], () => readers.autoFix(thread)),
    read("dependencies", [] as ThreadDependency[], () => readers.dependencies(thread)),
    read("scheduledActions", [] as ScheduledThreadAction[], () => readers.scheduledActions(thread, endedLimit > 0)),
    read("monitors", [] as PendingTaskMonitorWake[], () => readers.monitors(thread)),
    read("recentSubAgents", [] as ThreadSubAgentSummary[], () => readers.recentSubAgents(thread, endedLimit * 2)),
    read("backendTasks", [] as AppServerBackgroundTask[], () => readers.backendTasks(thread)),
  ]);
  const wakes = [
    ...scheduledWakes(scheduled),
    ...pullRequestWakes(prWatches, autoFix.filter((state) =>
      state.backend === thread.backend && state.threadId === thread.threadId)),
    ...dependencyWakes(dependencies),
    ...monitors.map(monitorWake).sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
    ...tasks.filter((task) => task.background).map(backendTaskWake),
  ];
  const ended = [
    ...prHistory.flatMap(endedPrWatch),
    ...dependencies.flatMap(endedDependency),
    ...scheduled.flatMap(endedScheduledAction),
    ...subAgents.flatMap(endedMonitor),
  ].sort((left, right) => right.endedAt - left.endedAt).slice(0, endedLimit);
  return { wakes, ended, ...(incomplete ? { incomplete: true as const } : {}) };
}

function clampEndedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PENDING_WAKES_ENDED_LIMIT;
  return Math.min(THREAD_PENDING_WAKES_ENDED_MAX_LIMIT, Math.max(0, Math.floor(limit)));
}

/** Timed actions by time; held ones, which wait for the operator, after. */
function scheduledWakes(actions: readonly ScheduledThreadAction[]): ThreadPendingWake[] {
  return actions
    .filter((action) => action.status === "scheduled" || action.status === "held")
    .sort((left, right) => (left.status === right.status ? 0 : left.status === "scheduled" ? -1 : 1)
      || left.scheduledFor - right.scheduledFor)
    .map((action): ThreadPendingWake => ({
      kind: "scheduled_action",
      key: buildThreadPendingWakeKey("scheduled_action", action.id),
      actionId: action.id,
      actionKind: action.kind,
      status: action.status === "held" ? "held" : "scheduled",
      displayText: clip(action.displayText, THREAD_PENDING_WAKE_TEXT_MAX_CHARS),
      createdAt: action.createdAt,
      ...(action.status === "scheduled" ? { wakesAt: action.scheduledFor } : {}),
      createdBy: action.origin === "messaging" ? "messaging" : action.origin === "agent" ? "agent" : "operator",
      durable: true,
      stop: "cancel",
    }));
}

/** Per PR: CI watches, then merge/close watches, then Auto-fix. */
function pullRequestWakes(
  watches: readonly ThreadPullRequestWatchSummary[],
  autoFix: readonly ThreadPrAutoFixState[],
): ThreadPendingWake[] {
  const prKeys = [...new Set([...watches.map((watch) => watch.prKey), ...autoFix.map((state) => state.prKey)])];
  return prKeys.flatMap((prKey) => {
    const forPr = watches.filter((watch) => watch.prKey === prKey)
      .sort((left, right) => watchRank(left) - watchRank(right) || left.createdAt - right.createdAt);
    const prNumber = forPr[0]?.prNumber;
    const rows: ThreadPendingWake[] = forPr.map((watch) => ({
      kind: "pr_watch",
      key: buildThreadPendingWakeKey("pr_watch", watch.watchId),
      watch,
      createdAt: watch.createdAt,
      createdBy: watch.createdBy === "operator" ? "operator" : "agent",
      durable: true,
      stop: "stop",
    }));
    for (const state of autoFix.filter((candidate) => candidate.prKey === prKey)) {
      rows.push({
        kind: "pr_auto_fix",
        key: buildThreadPendingWakeKey("pr_auto_fix", prKey),
        prKey,
        ...(prNumber !== undefined ? { prNumber } : {}),
        state: state.state,
        ...(state.handledBy ? { handledBy: state.handledBy } : {}),
        durable: true,
        // Another thread owns the PR's repairs; turning this one off changes nothing.
        ...(state.state !== "handled_by_other_thread" ? { stop: "turn_off" as const } : {}),
      });
    }
    return rows;
  });
}

function watchRank(watch: ThreadPullRequestWatchSummary): number {
  return watch.kind === "terminal" ? 1 : 0;
}

/** Waiting and met-but-not-yet-delivered registrations, oldest first. */
function dependencyWakes(dependencies: readonly ThreadDependency[]): ThreadPendingWake[] {
  return dependencies
    .filter((dependency) => dependency.status === "waiting" || dependency.status === "ready")
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((dependency): ThreadPendingWake => ({
      kind: "dependency",
      key: buildThreadPendingWakeKey("dependency", dependency.id),
      dependency: {
        id: dependency.id,
        conditions: dependency.conditions,
        mode: dependency.mode,
        onFailure: dependency.onFailure,
        ...(dependency.continuation
          ? { continuation: clip(dependency.continuation, THREAD_PENDING_WAKE_TEXT_MAX_CHARS) }
          : {}),
        ...(dependency.deliver ? { deliver: dependency.deliver } : {}),
        status: dependency.status,
        evidence: dependency.evidence,
      },
      createdAt: dependency.createdAt,
      durable: true,
      stop: "cancel",
    }));
}

function monitorWake(monitor: PendingTaskMonitorWake): ThreadPendingWake {
  return {
    kind: "monitor",
    key: buildThreadPendingWakeKey("monitor", monitor.monitorId),
    monitorId: monitor.monitorId,
    task: clip(monitor.task, THREAD_PENDING_WAKE_TEXT_MAX_CHARS),
    monitorBackend: monitor.backend,
    ...(monitor.monitorThreadId ? { monitorThreadId: monitor.monitorThreadId } : {}),
    ...(monitor.model ? { model: monitor.model } : {}),
    pollIntervalSeconds: monitor.pollIntervalSeconds,
    lastActivityAt: monitor.lastActivityAt,
    createdAt: monitor.createdAt,
    createdBy: "agent",
    // A live delegation is process memory; launch marks its card failed.
    durable: false,
    stop: "stop",
  };
}

function backendTaskWake(task: AppServerBackgroundTask): ThreadPendingWake {
  return {
    kind: "backend_task",
    key: buildThreadPendingWakeKey("backend_task", task.processId),
    task,
    ...(task.startedAt !== undefined ? { createdAt: task.startedAt } : {}),
    createdBy: "agent",
    durable: false,
    stop: "stop",
  };
}

const WOKE_ON: Record<string, string> = {
  success: "CI passed",
  failure: "CI failed",
  merged: "merged",
  closed: "closed",
};

function endedPrWatch(entry: ThreadPrWatchHistoryEntry): ThreadPendingWakeEnded[] {
  // A move hands the watch to its copy at the new head; nothing ended.
  if (entry.endedReason === "moved") return [];
  const wokeOn = entry.wokeOn ? WOKE_ON[entry.wokeOn] ?? entry.wokeOn : undefined;
  const summary = (() => {
    switch (entry.endedReason) {
      case "woke": return "PR watch woke the thread";
      case "another_thread_woke": return "Another thread was woken";
      case "head_changed": return "PR watch ended by a new push";
      case "cancelled_by_operator": return "PR watch stopped by you";
      case "cancelled_by_agent": return "PR watch stopped by the agent";
      case "detached": return "PR watch ended when the PR was detached";
      case "covered_by_auto_fix": return "PR watch handed to Auto-fix";
      case "pr_merged": return "PR watch ended when the PR merged";
      case "pr_closed": return "PR watch ended when the PR closed";
      case "failed": return "PR watch could not wake the thread";
      default:
        return entry.status === "dispatched" ? "PR watch woke the thread"
          : entry.status === "superseded" ? "PR watch ended by a new push"
          : entry.status === "cancelled" ? "PR watch stopped"
          : "PR watch could not wake the thread";
    }
  })();
  return [{
    key: buildThreadPendingWakeKey("pr_watch", entry.watchId),
    kind: "pr_watch",
    endedAt: entry.updatedAt,
    summary,
    detail: wokeOn ? `#${entry.prNumber} ${wokeOn}` : `#${entry.prNumber}`,
  }];
}

function endedDependency(dependency: ThreadDependency): ThreadPendingWakeEnded[] {
  if (dependency.status !== "delivered" && dependency.status !== "cancelled" && dependency.status !== "dismissed") {
    return [];
  }
  const summary = dependency.status === "delivered"
    ? dependency.deliver === "operator" ? "Continue after reminded you" : "Continue after woke the thread"
    : dependency.status === "cancelled" ? "Continue after cancelled" : "Continue after dismissed";
  const condition = dependency.conditions[0];
  const detail = dependency.conditions.length > 1
    ? `${dependency.conditions.length} threads`
    : condition ? (condition.title ? `${condition.title} ${THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when]}` : THREAD_DEPENDENCY_CONDITION_PHRASES[condition.when])
    : undefined;
  return [{
    key: buildThreadPendingWakeKey("dependency", dependency.id),
    kind: "dependency",
    endedAt: dependency.updatedAt,
    summary,
    ...(detail ? { detail: clip(detail, DETAIL_MAX_CHARS) } : {}),
  }];
}

function endedScheduledAction(action: ScheduledThreadAction): ThreadPendingWakeEnded[] {
  if (action.status !== "started" && action.status !== "cancelled" && action.status !== "failed") return [];
  const noun = action.kind === "review" ? "Scheduled review" : "Scheduled message";
  const summary = action.status === "started"
    ? action.kind === "review" ? `${noun} started` : `${noun} sent`
    : action.status === "cancelled" ? `${noun} cancelled` : `${noun} failed`;
  return [{
    key: buildThreadPendingWakeKey("scheduled_action", action.id),
    kind: "scheduled_action",
    endedAt: action.updatedAt,
    summary,
    ...(action.displayText.trim() ? { detail: clip(action.displayText, DETAIL_MAX_CHARS) } : {}),
  }];
}

function endedMonitor(card: ThreadSubAgentSummary): ThreadPendingWakeEnded[] {
  if (!card.monitorId.startsWith(MONITOR_ID_PREFIX) || card.completedAt === undefined) return [];
  const summary = card.outcome === "success" ? "Monitor finished"
    : card.outcome === "cancelled" ? "Monitor stopped" : "Monitor failed";
  return [{
    key: buildThreadPendingWakeKey("monitor", card.monitorId),
    kind: "monitor",
    endedAt: card.completedAt,
    summary,
    detail: clip(card.task, DETAIL_MAX_CHARS),
  }];
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/** Each source's own stop, on the instance that owns the thread. */
export type ThreadPendingWakeStoppers = {
  cancelPrWatch: (thread: PendingWakeThread, watchId: string) => Promise<StopResult>;
  cancelDependency: (thread: PendingWakeThread, dependencyId: string) => Promise<void>;
  stopMonitor: (thread: PendingWakeThread, monitorId: string) => Promise<void>;
  cancelScheduledAction: (actionId: string) => Promise<void>;
  stopBackendTask: (thread: PendingWakeThread, processId: string) => Promise<void>;
};

type StopResult = { ok: true } | { ok: false; code: ThreadPendingWakesErrorCode; message: string };

/**
 * Stops one wake through the cancel path its source already has. Auto-fix
 * is turned off through the thread's own setting, not here.
 */
export async function stopThreadPendingWake(
  stoppers: ThreadPendingWakeStoppers,
  thread: PendingWakeThread,
  key: string,
): Promise<ThreadPendingWakesResponse> {
  const parsed = parseThreadPendingWakeKey(key);
  if (!parsed) return failure("invalid_arguments", "That is not a pending wake.");
  try {
    switch (parsed.kind) {
      case "pr_watch": {
        const result = await stoppers.cancelPrWatch(thread, parsed.sourceId);
        return result.ok ? { ok: true, stopped: true } : failure(result.code, result.message);
      }
      case "dependency":
        await stoppers.cancelDependency(thread, parsed.sourceId);
        return { ok: true, stopped: true };
      case "monitor":
        await stoppers.stopMonitor(thread, parsed.sourceId);
        return { ok: true, stopped: true };
      case "scheduled_action":
        await stoppers.cancelScheduledAction(parsed.sourceId);
        return { ok: true, stopped: true };
      case "backend_task":
        await stoppers.stopBackendTask(thread, parsed.sourceId);
        return { ok: true, stopped: true };
      case "pr_auto_fix":
        return failure("invalid_arguments", "Turn Auto-fix off from the thread's own setting.");
    }
  } catch (error) {
    return failure("failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * A viewer's stop for a peer's thread, through the owner methods each source
 * already exposes. Dependencies stay on their own instance.
 */
export async function stopRemoteThreadPendingWake(
  remote: {
    cancelPrWatch: (watchId: string) => Promise<StopResult>;
    cancelScheduledAction: (actionId: string) => Promise<void>;
    stopMonitor: (monitorId: string) => Promise<void>;
    stopBackendTask: (processId: string) => Promise<void>;
  },
  key: string,
  ownerLabel = "the thread's own machine",
): Promise<ThreadPendingWakesResponse> {
  const parsed = parseThreadPendingWakeKey(key);
  if (!parsed) return failure("invalid_arguments", "That is not a pending wake.");
  try {
    switch (parsed.kind) {
      case "pr_watch": {
        const result = await remote.cancelPrWatch(parsed.sourceId);
        return result.ok ? { ok: true, stopped: true } : failure(result.code, result.message);
      }
      case "scheduled_action":
        await remote.cancelScheduledAction(parsed.sourceId);
        return { ok: true, stopped: true };
      case "monitor":
        await remote.stopMonitor(parsed.sourceId);
        return { ok: true, stopped: true };
      case "backend_task":
        await remote.stopBackendTask(parsed.sourceId);
        return { ok: true, stopped: true };
      case "dependency":
      case "pr_auto_fix":
        return failure("federation_unsupported", `This runs on ${ownerLabel}. Stop it there.`);
    }
  } catch (error) {
    return failure("failed", error instanceof Error ? error.message : String(error));
  }
}

function failure(code: ThreadPendingWakesErrorCode, message: string): ThreadPendingWakesResponse {
  return { ok: false, error: { code, message } };
}
