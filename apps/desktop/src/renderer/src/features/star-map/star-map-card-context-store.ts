import { useCallback, useSyncExternalStore } from "react";
import type { AppServerReadThreadResponse } from "@pwragent/shared";
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
  pricing?: AppServerReadThreadResponse["pricing"];
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
/**
 * Woken when any card's subscriber set opens or empties, so a card can stop
 * deriving data nobody is going to read. One global set rather than one per
 * card: demand changes when a rail opens, closes, or leaves the zoom level
 * that renders it, which is operator-paced, while the data it gates is
 * per-streamed-entry.
 */
const demandListeners = new Set<() => void>();

function notify(cardKey: string): void {
  for (const listener of listeners.get(cardKey) ?? []) listener();
}

function notifyDemand(): void {
  for (const listener of demandListeners) listener();
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
      notifyDemand();
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(cardKey);
        notifyDemand();
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

/**
 * Whether anything is currently reading this card's context.
 *
 * The card derives edited-file groups by walking its whole transcript, which
 * it would otherwise redo on every streamed entry whether or not the result
 * can be seen. `contextOpen` is not that question: the star map drops every
 * satellite at overview zoom while leaving the flag set, so a card whose rail
 * is "open" can have no rail mounted at all. Subscription is the honest
 * signal — no subscriber, no work.
 */
export function useStarMapCardContextDemand(cardKey: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    demandListeners.add(listener);
    return () => {
      demandListeners.delete(listener);
    };
  }, []);
  // A boolean, so repeated calls compare equal and cannot loop the store.
  const getSnapshot = useCallback(
    () => (listeners.get(cardKey)?.size ?? 0) > 0,
    [cardKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
