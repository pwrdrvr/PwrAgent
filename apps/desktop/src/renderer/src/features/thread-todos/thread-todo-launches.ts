import { useSyncExternalStore } from "react";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";

/** How long a successful start stays in the tray, while nothing pauses it. */
export const THREAD_TODO_LAUNCH_DISMISS_MS = 6_000;

/**
 * A start-thread card the operator started from the stack. The card leaves
 * the deck at once and its start is reported in the tray below it, so the
 * operator can go on to the next card while worktree and setup run.
 */
export type ThreadTodoLaunchPhase = "starting" | "started" | "setup_failed" | "failed";

export type ThreadTodoLaunch = {
  /** The card's id. */
  id: string;
  /** The thread whose stack started it; the tray shows only that thread's. */
  threadKey: string;
  title: string;
  phase: ThreadTodoLaunchPhase;
  startedAt: number;
  /** The card as it ended. Carries the started thread for Open thread. */
  todo: ThreadTodo;
  /** The setup failure or the owner's refusal. */
  message?: string;
};

/**
 * What a settled start shows. Undefined returns the card to the deck: the
 * run ended without starting anything and without an error to report.
 */
export function settleThreadTodoLaunch(
  launch: ThreadTodoLaunch,
  outcome: { ended: ThreadTodo | undefined } | { error: unknown },
): ThreadTodoLaunch | undefined {
  if ("error" in outcome) {
    const { error } = outcome;
    return { ...launch, phase: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const { ended } = outcome;
  if (!ended) {
    return { ...launch, phase: "failed", message: "Starting a thread is not available in this window." };
  }
  if (ended.status === "done") {
    const setupFailure = ended.startedThread?.setupFailure;
    return setupFailure
      ? { ...launch, todo: ended, phase: "setup_failed", message: setupFailure }
      : { ...launch, todo: ended, phase: "started" };
  }
  if (ended.status === "open" && ended.error) {
    return { ...launch, todo: ended, phase: "failed", message: ended.error };
  }
  return undefined;
}

/**
 * The card the deck shows once the shown card has left it: the first card
 * that was after it and is still there, else the nearest one before it.
 * Undefined keeps the deck's default, its first card. The operator paged
 * past the earlier cards on purpose, so the deck never falls back to them
 * while a later card is left.
 */
export function followDeckSelection(
  previous: readonly string[],
  next: readonly string[],
  selectedId: string | undefined,
): string | undefined {
  if (selectedId === undefined) return undefined;
  if (next.includes(selectedId)) return selectedId;
  const index = previous.indexOf(selectedId);
  if (index < 0) return undefined;
  const remaining = new Set(next);
  for (let after = index + 1; after < previous.length; after += 1) {
    if (remaining.has(previous[after]!)) return previous[after];
  }
  for (let before = index - 1; before >= 0; before -= 1) {
    if (remaining.has(previous[before]!)) return previous[before];
  }
  return undefined;
}

type DismissCountdown = {
  remainingMs: number;
  scheduled?: { timer: ReturnType<typeof setTimeout>; expiresAt: number };
};
type TrackedLaunch = {
  launch: ThreadTodoLaunch;
  returnedToDeck?: true;
  countdown?: DismissCountdown;
};

// A start and its dismissal deadline outlive the stack that began it.
let launches: readonly TrackedLaunch[] = [];
const listeners = new Set<() => void>();
const EMPTY_LAUNCH_VIEW = { launches: [], returnedIds: new Set<string>() };

function publish(next: readonly TrackedLaunch[]): void {
  launches = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly TrackedLaunch[] {
  return launches;
}

function scheduleDismissal(entry: TrackedLaunch, countdown: DismissCountdown): void {
  countdown.scheduled = {
    timer: setTimeout(() => dismissThreadTodoLaunch(entry.launch.id), countdown.remainingMs),
    expiresAt: Date.now() + countdown.remainingMs,
  };
}

function remainingDismissMs(countdown: DismissCountdown, now: number): number {
  return countdown.scheduled
    ? Math.max(0, countdown.scheduled.expiresAt - now)
    : countdown.remainingMs;
}

function stopDismissal(countdown: DismissCountdown | undefined, now = Date.now()): void {
  if (!countdown?.scheduled) return;
  clearTimeout(countdown.scheduled.timer);
  countdown.remainingMs = remainingDismissMs(countdown, now);
  countdown.scheduled = undefined;
}

/** Pauses a success while the tray has pointer or keyboard focus. */
export function pauseThreadTodoLaunchDismissal(launch: ThreadTodoLaunch): (() => void) | undefined {
  const entry = launches.find((entry) => entry.launch === launch);
  const countdown = entry?.countdown;
  if (!entry || !countdown?.scheduled) return undefined;
  const now = Date.now();
  if (remainingDismissMs(countdown, now) === 0) {
    dismissThreadTodoLaunch(launch.id);
    return undefined;
  }
  stopDismissal(countdown, now);
  return () => {
    if (launches.includes(entry)) scheduleDismissal(entry, countdown);
  };
}

/** Time left when the visual countdown mounts or remounts. */
export function threadTodoLaunchDismissRemainingMs(launch: ThreadTodoLaunch): number {
  const countdown = launches.find((entry) => entry.launch === launch)?.countdown;
  return countdown ? remainingDismissMs(countdown, Date.now()) : 0;
}

/**
 * Puts a card in the tray as starting once its run begins, then reports how
 * the run ended. The run calls `begin` when it goes to the owner: at once,
 * or after the operator confirms Full Access. A start cancelled at that
 * prompt never begins, so its card stays in the deck.
 */
export function launchThreadTodo(
  params: { todo: ThreadTodo; threadKey: string },
  run: (begin: () => void) => Promise<ThreadTodo | undefined>,
): Promise<void> {
  const id = params.todo.id;
  let started: ThreadTodoLaunch | undefined;
  const begin = (): void => {
    if (started) return;
    started = {
      id,
      threadKey: params.threadKey,
      title: params.todo.title,
      phase: "starting",
      startedAt: Date.now(),
      todo: params.todo,
    };
    const previous = launches.find((entry) => entry.launch.id === id);
    stopDismissal(previous?.countdown);
    publish([...launches.filter((entry) => entry !== previous), { launch: started }]);
  };
  const settle = (outcome: Parameters<typeof settleThreadTodoLaunch>[1]): void => {
    // A run that ended without reporting its start still reports how it ended.
    begin();
    // Match this run even if its pending row was hidden by Show card.
    const current = launches.find((entry) => entry.launch === started);
    if (!current) return;
    const settled = settleThreadTodoLaunch(current.launch, outcome);
    if (!settled) {
      publish(launches.filter((entry) => entry !== current));
      return;
    }
    const next: TrackedLaunch = { launch: settled };
    if (settled.phase === "started") {
      next.countdown = { remainingMs: THREAD_TODO_LAUNCH_DISMISS_MS };
      scheduleDismissal(next, next.countdown);
    }
    publish(launches.map((entry) => (entry === current ? next : entry)));
  };
  let pending: Promise<ThreadTodo | undefined>;
  try {
    pending = run(begin);
  } catch (error) {
    // A throw before the run's promise exists must not strand the row.
    pending = Promise.reject(error);
  }
  return pending.then(
    (ended) => settle({ ended }),
    (error: unknown) => settle({ error }),
  );
}

/** Hides a pending row while keeping its run tracked until the owner replies. */
export function showStartingThreadTodoCard(id: string): void {
  publish(launches.map((entry) => (entry.launch.id === id && entry.launch.phase === "starting"
    ? { launch: entry.launch, returnedToDeck: true }
    : entry)));
}

/** Removes a settled row; a failed card goes back to the deck. */
export function dismissThreadTodoLaunch(id: string): void {
  const entry = launches.find(({ launch }) => launch.id === id && launch.phase !== "starting");
  if (!entry) return;
  stopDismissal(entry.countdown);
  publish(launches.filter((current) => current !== entry));
}

/** The tray rows (oldest first) and pending cards returned to the deck. */
export function useThreadTodoLaunches(threadKey: string): {
  launches: readonly ThreadTodoLaunch[];
  returnedIds: ReadonlySet<string>;
} {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (all.length === 0) return EMPTY_LAUNCH_VIEW;
  // A render can beat the dismissal callback after the deadline.
  const now = Date.now();
  const launches: ThreadTodoLaunch[] = [];
  const returnedIds = new Set<string>();
  for (const { launch, returnedToDeck, countdown } of all) {
    if (launch.threadKey !== threadKey || (countdown && remainingDismissMs(countdown, now) === 0)) continue;
    if (returnedToDeck) returnedIds.add(launch.id);
    else launches.push(launch);
  }
  return { launches, returnedIds };
}

/** Test seam: forgets every start. */
export function resetThreadTodoLaunchesForTests(): void {
  for (const { countdown } of launches) stopDismissal(countdown);
  publish([]);
}
