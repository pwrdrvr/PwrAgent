import { useMemo, useSyncExternalStore } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type { ComposerDraftStore } from "../features/composer/useComposerDraftStore";

/**
 * A thread's pending outbound-message state, in descending information
 * priority. `"scheduled"` (a message with a future send time) outranks
 * `"queued"` (a message waiting for the active turn to finish) so a thread
 * that has both surfaces the scheduled signal.
 */
export type ThreadQueuedMessageState = "scheduled" | "queued";

function getThreadScopeKey(
  thread: Pick<NavigationThreadSummary, "id" | "source">,
): string {
  return `thread:${thread.source}:${thread.id}`;
}

/**
 * Derives a per-thread map of pending outbound-message indicators from the
 * composer draft store's queued-turn Map. Queued/scheduled turns are
 * renderer-only, in-memory state keyed by `thread:<source>:<id>`; the store
 * lives at app root and is otherwise invisible to the sidebar. This hook
 * subscribes to the store's queued-turn version and recomputes a
 * `Record<threadIdentityKey, ThreadQueuedMessageState>` keyed the same way
 * ThreadRow reads `approvalRequestThreadKeys` — so a single map threads down
 * to every row.
 *
 * The classification is evaluated at compute time against `Date.now()`; a
 * scheduled turn whose send time has passed but hasn't been released yet
 * still reads as `"scheduled"` until the release mutates the store and bumps
 * the version. That's intentional — the chip clears the moment the turn
 * actually leaves the queue, and no per-second tick is needed for a static
 * label.
 */
export function useThreadQueuedMessageIndicators(params: {
  composerDraftStore: ComposerDraftStore;
  threads: NavigationThreadSummary[];
}): Record<string, ThreadQueuedMessageState> {
  const { composerDraftStore, threads } = params;
  const version = useSyncExternalStore(
    composerDraftStore.subscribeQueuedTurns,
    composerDraftStore.getQueuedTurnVersion,
  );

  return useMemo(() => {
    const indicators: Record<string, ThreadQueuedMessageState> = {};
    const now = Date.now();
    for (const thread of threads) {
      const queuedTurns = composerDraftStore.getQueuedTurns(
        getThreadScopeKey(thread),
      );
      if (queuedTurns.length === 0) {
        continue;
      }
      const hasScheduled = queuedTurns.some(
        (turn) =>
          typeof turn.scheduledSendAt === "number"
          && Number.isFinite(turn.scheduledSendAt)
          && turn.scheduledSendAt > now,
      );
      indicators[buildThreadIdentityKey(thread.source, thread.id)] = hasScheduled
        ? "scheduled"
        : "queued";
    }
    return indicators;
    // `version` is intentionally a dependency (not referenced in the body):
    // it forces recomputation when the queued-turn Map mutates, since the
    // Map itself is a ref whose identity never changes. exhaustive-deps
    // can't see that and flags it as unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerDraftStore, threads, version]);
}
