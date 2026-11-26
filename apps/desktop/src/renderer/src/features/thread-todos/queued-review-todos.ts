import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  ComposerDraftStore,
  ComposerQueuedTurnSnapshot,
} from "../composer/useComposerDraftStore";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The review cards whose review is waiting in a thread's queue. A card
 * queued from Start review stays open until the review starts, and the owner
 * completes it then; meanwhile its Start review would queue a second review.
 * A failed entry no longer waits, so its card offers Start review again.
 */
export function queuedReviewTodoIds(
  queues: Iterable<readonly ComposerQueuedTurnSnapshot[]>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const queue of queues) {
    for (const entry of queue) {
      if (entry.reviewTodoId && !entry.failedScheduledActionId) ids.add(entry.reviewTodoId);
    }
  }
  return ids.size ? ids : EMPTY;
}

/**
 * `queuedReviewTodoIds` across every queue the store holds, kept current.
 * Every queue edit in any thread notifies, so the snapshot is the sorted ids
 * as one JSON string: React skips the render, and the set keeps its
 * identity, unless the ids themselves change. Ids are opaque, so no
 * separator character is safe to join them with.
 */
export function useQueuedReviewTodoIds(store: ComposerDraftStore | undefined): ReadonlySet<string> {
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribeQueuedTurns(listener) ?? (() => undefined),
    [store],
  );
  const getKey = useCallback(() => {
    if (!store) return "[]";
    const ids = queuedReviewTodoIds(store.getQueuedScopeKeys().map((scopeKey) => store.getQueuedTurns(scopeKey)));
    return JSON.stringify([...ids].sort());
  }, [store]);
  const key = useSyncExternalStore(subscribe, getKey);
  return useMemo(() => {
    const ids = JSON.parse(key) as string[];
    return ids.length ? new Set(ids) : EMPTY;
  }, [key]);
}
