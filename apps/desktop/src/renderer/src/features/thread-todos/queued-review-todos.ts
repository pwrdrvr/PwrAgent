import { useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  ComposerDraftStore,
  ComposerQueuedTurnSnapshot,
} from "../composer/useComposerDraftStore";

const NO_STORE_VERSION = 0;
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

/** `queuedReviewTodoIds` across every queue the store holds, kept current. */
export function useQueuedReviewTodoIds(store: ComposerDraftStore | undefined): ReadonlySet<string> {
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribeQueuedTurns(listener) ?? (() => undefined),
    [store],
  );
  const getVersion = useCallback(
    () => store?.getQueuedTurnVersion() ?? NO_STORE_VERSION,
    [store],
  );
  const version = useSyncExternalStore(subscribe, getVersion);
  return useMemo(() => {
    if (!store) return EMPTY;
    return queuedReviewTodoIds(store.getQueuedScopeKeys().map((scopeKey) => store.getQueuedTurns(scopeKey)));
    // The version names the queue contents this set was read from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);
}
