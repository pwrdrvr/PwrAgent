import { useSyncExternalStore } from "react";
import {
  reduceThreadHandoffTransfers,
  type ThreadHandoffTransfer,
  type ThreadHandoffTransferEvent,
  type ThreadHandoffTransfers,
} from "./thread-handoff-transfer";

/**
 * What the window needs to place a handoff and show its outcome: whether it
 * runs, where it is drawn, and how it ended. None of it changes while bytes
 * move, so a component that reads only this does not re-render per tick.
 */
export type ThreadHandoffSummary = Pick<
  ThreadHandoffTransfer,
  | "handoffId"
  | "sourceThreadId"
  | "threadKey"
  | "title"
  | "targetLabel"
  | "choice"
  | "status"
  | "view"
  | "startedAt"
  | "result"
  | "error"
>;

export type ThreadHandoffSummaries = Readonly<Record<string, ThreadHandoffSummary>>;

const SUMMARY_KEYS = [
  "handoffId",
  "sourceThreadId",
  "threadKey",
  "title",
  "targetLabel",
  "choice",
  "status",
  "view",
  "startedAt",
  "result",
  "error",
] as const satisfies readonly (keyof ThreadHandoffSummary)[];

function summarize(transfer: ThreadHandoffTransfer): ThreadHandoffSummary {
  const summary = {} as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    if (transfer[key] !== undefined) summary[key] = transfer[key];
  }
  return summary as ThreadHandoffSummary;
}

function sameSummary(summary: ThreadHandoffSummary, transfer: ThreadHandoffTransfer): boolean {
  return SUMMARY_KEYS.every((key) => summary[key] === transfer[key]);
}

/** Keeps the previous record, and each previous entry, while nothing in them changed. */
function nextSummaries(
  previous: ThreadHandoffSummaries,
  transfers: ThreadHandoffTransfers,
): ThreadHandoffSummaries {
  const ids = Object.keys(transfers);
  let changed = ids.length !== Object.keys(previous).length;
  const next: Record<string, ThreadHandoffSummary> = {};
  for (const id of ids) {
    const transfer = transfers[id]!;
    const kept = previous[id];
    if (kept && sameSummary(kept, transfer)) {
      next[id] = kept;
    } else {
      next[id] = summarize(transfer);
      changed = true;
    }
  }
  return changed ? next : previous;
}

/**
 * The window's handoffs, outside React state. Main reports bytes several
 * times a second; held in the App's state, each report re-rendered the whole
 * window for as long as a send ran. Here a byte report notifies subscribers,
 * and only those whose selected value changed re-render: the step list, the
 * toast card and the composer band of that one handoff.
 */
export function createThreadHandoffStore() {
  let transfers: ThreadHandoffTransfers = {};
  let summaries: ThreadHandoffSummaries = {};
  const listeners = new Set<() => void>();
  return {
    getTransfers: (): ThreadHandoffTransfers => transfers,
    getSummaries: (): ThreadHandoffSummaries => summaries,
    // Arrow properties, not methods: React and callers take these unbound.
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (event: ThreadHandoffTransferEvent): void => {
      const next = reduceThreadHandoffTransfers(transfers, event);
      if (next === transfers) return;
      transfers = next;
      summaries = nextSummaries(summaries, transfers);
      for (const listener of [...listeners]) listener();
    },
  };
}

export type ThreadHandoffStore = ReturnType<typeof createThreadHandoffStore>;

/** One handoff with its live progress; re-renders only when that handoff changes. */
export function useThreadHandoffTransfer(
  store: ThreadHandoffStore | undefined,
  handoffId: string | undefined,
): ThreadHandoffTransfer | undefined {
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => (store && handoffId ? store.getTransfers()[handoffId] : undefined),
  );
}

/** The running handoff of one source thread, if any. */
export function useRunningThreadHandoff(
  store: ThreadHandoffStore | undefined,
  threadKey: string | undefined,
): ThreadHandoffTransfer | undefined {
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store && threadKey
      ? Object.values(store.getTransfers()).find((transfer) =>
        transfer.threadKey === threadKey && transfer.status === "running")
      : undefined,
  );
}

function noSubscription(): () => void {
  return () => {};
}
