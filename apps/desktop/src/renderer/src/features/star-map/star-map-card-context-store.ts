import { useCallback, useSyncExternalStore } from "react";
import type {
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import type { EditedFileGroup } from "../thread-detail/edited-file-groups";

/**
 * Session-derived context data for one chat card, handed from the card to
 * its context satellite.
 *
 * Everything here comes out of the card's own `useThreadSessionState` — the
 * thread read's pricing rows, and the edited-file groups collected from the
 * transcript. Neither can be derived from a `NavigationThreadSummary`, which
 * is all the satellite is otherwise given.
 */
export type StarMapCardContextSnapshot = {
  activeTurnId?: string;
  editedFileGroups?: EditedFileGroup[];
  pricing?: {
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
};

/**
 * The hand-off between a star map chat card and its context satellite.
 *
 * The two are siblings, not parent and child: satellites are rendered by
 * `StarMapScreen` (which owns their dock geometry and stacking), while the
 * thread session lives in the card. So the data cannot simply be a prop, and
 * the two obvious alternatives are both worse:
 *
 * - Lifting the session data into the screen re-renders the entire map on
 *   every pricing and transcript update, for every open card.
 * - Mounting a second `useThreadSessionState` in the satellite re-reads the
 *   whole thread over the bridge and subscribes a second listener to the
 *   same live turn.
 *
 * A per-card store keyed the same way the cards are keyed keeps the update
 * local: publishing wakes the one satellite subscribed to that card and
 * nothing else on the map.
 */
const EMPTY_SNAPSHOT: StarMapCardContextSnapshot = {};

const snapshots = new Map<string, StarMapCardContextSnapshot>();
const listeners = new Map<string, Set<() => void>>();

function notify(cardKey: string): void {
  for (const listener of listeners.get(cardKey) ?? []) listener();
}

export function publishStarMapCardContext(
  cardKey: string,
  snapshot: StarMapCardContextSnapshot,
): void {
  snapshots.set(cardKey, snapshot);
  notify(cardKey);
}

/** Called when a card unmounts, so a reopened card starts empty rather than
    showing the previous session's rows until its first publish. */
export function clearStarMapCardContext(cardKey: string): void {
  if (!snapshots.delete(cardKey)) return;
  notify(cardKey);
}

export function useStarMapCardContext(
  cardKey: string,
): StarMapCardContextSnapshot {
  // Both memoized against the key: `useSyncExternalStore` re-subscribes when
  // `subscribe` changes identity, and an inline arrow changes every render.
  const subscribe = useCallback(
    (listener: () => void) => {
      let keyListeners = listeners.get(cardKey);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(cardKey, keyListeners);
      }
      keyListeners.add(listener);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(cardKey);
      };
    },
    [cardKey],
  );
  // Returns the stored object by reference, never a fresh one: a new object
  // per call makes `useSyncExternalStore` loop forever.
  const getSnapshot = useCallback(
    () => snapshots.get(cardKey) ?? EMPTY_SNAPSHOT,
    [cardKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
