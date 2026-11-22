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
let launches: readonly ThreadTodoLaunch[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly ThreadTodoLaunch[]): void {
  launches = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ThreadTodoLaunch[] {
  return launches;
}

/** Puts a card in the tray as starting, then reports how its run ended. */
export function launchThreadTodo(
  params: { todo: ThreadTodo; threadKey: string; now?: number },
  run: () => Promise<ThreadTodo | undefined>,
): Promise<void> {
  const launch: ThreadTodoLaunch = {
    id: params.todo.id,
    threadKey: params.threadKey,
    title: params.todo.title,
    phase: "starting",
    startedAt: params.now ?? Date.now(),
    todo: params.todo,
  };
  publish([...launches.filter((entry) => entry.id !== launch.id), launch]);
  const settle = (outcome: Parameters<typeof settleThreadTodoLaunch>[1]): void => {
    // A row the operator closed meanwhile stays closed.
    const current = launches.find((entry) => entry.id === launch.id);
    if (!current || current.phase !== "starting") return;
    const settled = settleThreadTodoLaunch(current, outcome);
    publish(settled
      ? launches.map((entry) => (entry.id === launch.id ? settled : entry))
      : launches.filter((entry) => entry.id !== launch.id));
  };
  return run().then(
    (ended) => settle({ ended }),
    (error: unknown) => settle({ error }),
  );
}

/** Removes a settled row; a failed card goes back to the deck. */
export function dismissThreadTodoLaunch(id: string): void {
  if (!launches.some((entry) => entry.id === id && entry.phase !== "starting")) return;
  publish(launches.filter((entry) => entry.id !== id));
}

/** The tray rows of one thread, oldest start first. */
export function useThreadTodoLaunches(threadKey: string): readonly ThreadTodoLaunch[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => all.filter((entry) => entry.threadKey === threadKey), [all, threadKey]);
}

/** Test seam: forgets every start. */
export function resetThreadTodoLaunchesForTests(): void {
  publish([]);
}
