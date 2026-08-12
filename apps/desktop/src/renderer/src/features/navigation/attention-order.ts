import { useMemo, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import { isThreadActive } from "./ThreadRowStatus";

/**
 * Turn-stable ordering for the Attention lens.
 *
 * The lens used to render in the snapshot's own most-recently-updated order,
 * which meant a running thread re-sorted on every streamed item, sub-agent
 * invocation, and tool result — two live turns were enough to make the queue
 * trade places under the pointer. A work queue whose rows move while you are
 * reading them is unusable, so position is pinned to the *turn* instead of to
 * the thread's `updatedAt`.
 *
 * Each lens member holds a rank drawn from a monotonic counter. The rank is
 * assigned once and then left alone; only two events mint a new one:
 *
 * - a turn starting on that thread (idle → live), which is the operator-visible
 *   event that deserves the top of the queue, and
 * - a turn finishing (live → idle), when `promoteOnTurnEnd` is on — one last
 *   move so freshly finished work surfaces for review.
 *
 * Everything in between — deltas, sub-agent traffic, item completions, PR
 * status, reactions — leaves the rank untouched, so a thread moves at most
 * twice per turn no matter how loud that turn is.
 *
 * Ranks are a counter rather than a clock so the order is a pure function of
 * the transitions observed, with no `Date.now()` in a render path and no ties
 * to break.
 */
type AttentionOrderEntry = {
  /** Live-turn state at the snapshot this entry was last written from. */
  active: boolean;
  /** Higher sorts first. Unique across entries by construction. */
  rank: number;
};

export type AttentionOrderState = {
  entries: Map<string, AttentionOrderEntry>;
  nextRank: number;
};

export function createAttentionOrderState(): AttentionOrderState {
  return { entries: new Map(), nextRank: 1 };
}

/**
 * State is scoped to current lens membership: a thread that leaves the lens
 * drops its entry and re-enters at the top. That is the right answer for the
 * way threads actually re-enter — a new turn, or a new unread message — both of
 * which are fresh activity. It also keeps the map from growing without bound.
 */
export function reconcileAttentionOrder(params: {
  previous: AttentionOrderState;
  /** Attention-lens members, in the snapshot's most-recently-updated order. */
  threads: NavigationThreadSummary[];
  thinkingThreadKeys?: Record<string, boolean>;
  promoteOnTurnEnd: boolean;
}): { state: AttentionOrderState; threads: NavigationThreadSummary[] } {
  const entries = new Map<string, AttentionOrderEntry>();
  const rankByThread = new Map<NavigationThreadSummary, number>();
  let nextRank = params.previous.nextRank;

  // Walk oldest-first so that when one snapshot carries several transitions at
  // once — the common case on the first render, where every member is new —
  // the freshest thread takes the highest rank and lands on top.
  for (let index = params.threads.length - 1; index >= 0; index -= 1) {
    const thread = params.threads[index];
    const key = threadSummaryIdentityKey(thread);
    const active = isThreadActive(thread, params.thinkingThreadKeys);
    const previousEntry = params.previous.entries.get(key);
    const turnStarted = active && previousEntry?.active === false;
    const turnEnded = !active && previousEntry?.active === true;
    const rank =
      !previousEntry || turnStarted || (turnEnded && params.promoteOnTurnEnd)
        ? nextRank++
        : previousEntry.rank;
    entries.set(key, { active, rank });
    rankByThread.set(thread, rank);
  }

  const ordered = [...params.threads].sort(
    (left, right) => (rankByThread.get(right) ?? 0) - (rankByThread.get(left) ?? 0),
  );

  return { state: { entries, nextRank }, threads: ordered };
}

/**
 * Sidebar-side wrapper. The ordering state lives in a ref rather than React
 * state because it is derived bookkeeping, not something to render on: writing
 * it during the memo keeps the ordered list available on the very render that
 * observed the transition. Re-running the memo against already-reconciled state
 * is a no-op — no transitions remain to detect — so a StrictMode double render
 * produces the same order.
 */
export function useAttentionOrderedThreads(params: {
  promoteOnTurnEnd: boolean;
  threads: NavigationThreadSummary[];
  thinkingThreadKeys?: Record<string, boolean>;
}): NavigationThreadSummary[] {
  const stateRef = useRef<AttentionOrderState>(createAttentionOrderState());
  const { promoteOnTurnEnd, threads, thinkingThreadKeys } = params;
  return useMemo(() => {
    const reconciled = reconcileAttentionOrder({
      previous: stateRef.current,
      promoteOnTurnEnd,
      threads,
      thinkingThreadKeys,
    });
    stateRef.current = reconciled.state;
    return reconciled.threads;
  }, [promoteOnTurnEnd, threads, thinkingThreadKeys]);
}
