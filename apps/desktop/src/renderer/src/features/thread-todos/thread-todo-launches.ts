import { useMemo, useSyncExternalStore } from "react";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";

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

// Module scope, like the stack's collapse memory: a start outlives the
// stack that began it (thread switches, a search that unmounts the view),
// and its row is there again when the operator comes back.
type TrackedLaunch = { launch: ThreadTodoLaunch; returnedToDeck?: true };

let launches: readonly TrackedLaunch[] = [];
const listeners = new Set<() => void>();

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
    publish([...launches.filter((entry) => entry.launch.id !== id), { launch: started }]);
  };
  const settle = (outcome: Parameters<typeof settleThreadTodoLaunch>[1]): void => {
    // A run that ended without reporting its start still reports how it ended.
    begin();
    // Match this run even if its pending row was hidden by Show card.
    const current = launches.find((entry) => entry.launch === started);
    if (!current) return;
    const settled = settleThreadTodoLaunch(current.launch, outcome);
    publish(settled
      ? launches.map((entry) => (entry === current ? { launch: settled } : entry))
      : launches.filter((entry) => entry !== current));
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
  if (!launches.some(({ launch }) => launch.id === id && launch.phase !== "starting")) return;
  publish(launches.filter(({ launch }) => launch.id !== id));
}

/** The tray rows (oldest first) and pending cards returned to the deck. */
export function useThreadTodoLaunches(threadKey: string): {
  launches: readonly ThreadTodoLaunch[];
  returnedIds: ReadonlySet<string>;
} {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    const launches: ThreadTodoLaunch[] = [];
    const returnedIds = new Set<string>();
    for (const { launch, returnedToDeck } of all) {
      if (launch.threadKey !== threadKey) continue;
      if (returnedToDeck) returnedIds.add(launch.id);
      else launches.push(launch);
    }
    return { launches, returnedIds };
  }, [all, threadKey]);
}

/** Test seam: forgets every start. */
export function resetThreadTodoLaunchesForTests(): void {
  publish([]);
}
