/**
 * The quiet-restart gate: one state machine for the stretch between the
 * operator choosing "Quiet & Continue After Restart" and every interrupted
 * thread having its turn again.
 *
 *   open ──quiet──▶ quieting ──(process exits)
 *     ▲                ▲
 *     │              quiet
 *     │                │
 *     └──settled/deadline── resuming ◀──restore── open (next launch)
 *
 * - `quieting`: this process is shutting down for a restart. Nothing in the
 *   turn queue starts or steers. The quiet sequence speaks to running turns
 *   directly, not through the queue.
 * - `resuming`: the next launch put each continuation at the top of its
 *   thread's queue. A continuation waits for its own dispatch time, and
 *   every other queue entry, on every thread, waits until no continuation is
 *   still waiting to start. A deadline bounds that wait, so a continuation
 *   that cannot start never holds the rest of the app for long.
 *
 * Pure: the registry owns the timers and the queue, and asks this module.
 */

export type RestartContinuationSchedule = {
  entryId: string;
  /** `buildThreadIdentityKey(backend, threadId)`. */
  threadKey: string;
  dispatchAt: number;
};

export type RestartGateState =
  | { phase: "open" }
  | { phase: "quieting"; startedAt: number }
  | {
      phase: "resuming";
      /** Continuations not yet started, by entry id. */
      pending: ReadonlyMap<string, RestartContinuationSchedule>;
      /** The gate opens by this time even if a continuation is still waiting. */
      releaseBy: number;
    };

export type RestartGateEvent =
  | { type: "quiet"; at: number }
  | { type: "restore"; schedule: readonly RestartContinuationSchedule[]; releaseBy: number }
  /** A continuation started, was discarded, failed, or was blocked. */
  | { type: "settled"; entryId: string }
  | { type: "deadline"; at: number };

export const OPEN_RESTART_GATE: RestartGateState = { phase: "open" };

export function transitionRestartGate(
  current: RestartGateState,
  event: RestartGateEvent,
): RestartGateState {
  switch (event.type) {
    case "quiet":
      return current.phase === "quieting" ? current : { phase: "quieting", startedAt: event.at };
    case "restore": {
      // A restart already under way keeps everything shut.
      if (current.phase === "quieting") return current;
      const pending = new Map(current.phase === "resuming" ? current.pending : []);
      for (const item of event.schedule) pending.set(item.entryId, item);
      if (pending.size === 0) return OPEN_RESTART_GATE;
      return {
        phase: "resuming",
        pending,
        releaseBy: current.phase === "resuming"
          ? Math.max(current.releaseBy, event.releaseBy)
          : event.releaseBy,
      };
    }
    case "settled": {
      if (current.phase !== "resuming" || !current.pending.has(event.entryId)) return current;
      const pending = new Map(current.pending);
      pending.delete(event.entryId);
      return pending.size === 0 ? OPEN_RESTART_GATE : { ...current, pending };
    }
    case "deadline":
      return current.phase === "resuming" && event.at >= current.releaseBy
        ? OPEN_RESTART_GATE
        : current;
  }
}

/**
 * Whether the gate keeps a queue entry from starting now. `restartEntryId`
 * is set only for a restart continuation's own entry.
 */
export function restartGateHolds(
  state: RestartGateState,
  entry: { restartEntryId?: string },
  now: number,
): boolean {
  if (state.phase === "open") return false;
  if (state.phase === "quieting") return true;
  if (entry.restartEntryId === undefined) return true;
  const scheduled = state.pending.get(entry.restartEntryId);
  return scheduled !== undefined && now < scheduled.dispatchAt;
}

export type RestartDispatchPlanOptions = {
  now: number;
  /** Threads that start together. */
  batchSize?: number;
  /** Before the first batch, so backends finish starting. */
  firstDelayMs?: number;
  /** Between batches. */
  intervalMs?: number;
  /** Random spread added to each continuation's time. */
  jitterMs?: number;
  /** After the last dispatch time, the gate opens regardless. */
  releaseGraceMs?: number;
  random?: () => number;
};

export const RESTART_DISPATCH_DEFAULTS = {
  batchSize: 4,
  firstDelayMs: 20_000,
  intervalMs: 45_000,
  jitterMs: 15_000,
  releaseGraceMs: 180_000,
} as const;

/**
 * Staggers continuations so a restart does not start every thread at once:
 * `batchSize` threads per batch, `intervalMs` apart, each with its own
 * jitter. Order is kept, so the oldest stopped turn goes first.
 */
export function planRestartDispatch(
  entries: ReadonlyArray<{ entryId: string; threadKey: string }>,
  options: RestartDispatchPlanOptions,
): { schedule: RestartContinuationSchedule[]; releaseBy: number } {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? RESTART_DISPATCH_DEFAULTS.batchSize));
  const firstDelayMs = Math.max(0, options.firstDelayMs ?? RESTART_DISPATCH_DEFAULTS.firstDelayMs);
  const intervalMs = Math.max(0, options.intervalMs ?? RESTART_DISPATCH_DEFAULTS.intervalMs);
  const jitterMs = Math.max(0, options.jitterMs ?? RESTART_DISPATCH_DEFAULTS.jitterMs);
  const releaseGraceMs = Math.max(0, options.releaseGraceMs ?? RESTART_DISPATCH_DEFAULTS.releaseGraceMs);
  const random = options.random ?? Math.random;
  const schedule = entries.map((entry, index) => ({
    entryId: entry.entryId,
    threadKey: entry.threadKey,
    dispatchAt: Math.round(
      options.now
      + firstDelayMs
      + Math.floor(index / batchSize) * intervalMs
      + Math.min(1, Math.max(0, random())) * jitterMs,
    ),
  }));
  const last = schedule.reduce((latest, item) => Math.max(latest, item.dispatchAt), options.now);
  return { schedule, releaseBy: last + releaseGraceMs };
}
