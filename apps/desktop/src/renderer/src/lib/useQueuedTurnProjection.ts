import { useEffect, useRef } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type {
  ComposerDraftStore,
  ComposerQueuedTurnSnapshot,
} from "../features/composer/useComposerDraftStore";

/**
 * Reconciles the owning instance's turn-FIFO read projection
 * (`NavigationThreadSummary.queuedTurns`, sourced from the registry's
 * getQueuedTurnsSnapshot) into this window's composer chip store.
 *
 * This is what makes a queued message visible beyond the window that
 * submitted it: the owner's own window, other local windows, federated
 * viewers, and a reloaded viewer all rehydrate chips from the snapshot
 * instead of relying on renderer-local memory. Entries this window
 * already tracks (matching queueEntryId, or still backendQueuePending
 * in-flight) are left alone so live submissions keep their richer local
 * state (attachments, review commands). A backend-owned entry is pruned
 * after its id was positively observed in a snapshot and then vanished —
 * the FIFO dispatched or cancelled it. Requiring that positive observation
 * prevents an older navigation snapshot from pruning a just-acknowledged
 * local submission before its queue lifecycle notification arrives.
 */
export function useQueuedTurnProjection(params: {
  composerDraftStore: ComposerDraftStore;
  threads: readonly NavigationThreadSummary[];
}): void {
  const { composerDraftStore, threads } = params;
  const snapshotObservedQueueEntryKeysRef = useRef(new Set<string>());
  useEffect(() => {
    for (const thread of threads) {
      const scopeKey = `thread:${thread.source}:${thread.id}`;
      const snapshotEntries = thread.queuedTurns ?? [];
      const snapshotIds = new Set(
        snapshotEntries.map((entry) => entry.queueEntryId),
      );
      for (const queueEntryId of snapshotIds) {
        snapshotObservedQueueEntryKeysRef.current.add(
          `${scopeKey}:${queueEntryId}`,
        );
      }
      const current = composerDraftStore.getQueuedTurns(scopeKey);
      const knownIds = new Set(
        current
          .map((entry) => entry.queueEntryId)
          .filter((id): id is string => Boolean(id)),
      );

      const kept = current.filter(
        (entry) =>
          // Local-only entries (no backend id yet) and in-flight
          // submissions are this window's own state — never prune from
          // a snapshot that may predate them.
          !entry.queueEntryId
          || entry.backendQueuePending
          || snapshotIds.has(entry.queueEntryId)
          || !snapshotObservedQueueEntryKeysRef.current.has(
            `${scopeKey}:${entry.queueEntryId}`,
          ),
      );
      const additions: ComposerQueuedTurnSnapshot[] = snapshotEntries
        .filter((entry) => !knownIds.has(entry.queueEntryId))
        .map((entry) => ({
          id: `backend-queued:${entry.queueEntryId}`,
          queueEntryId: entry.queueEntryId,
          text: entry.displayText,
          imageAttachments: [],
          fileAttachments: [],
        }));

      if (
        additions.length > 0
        || kept.length !== current.length
      ) {
        composerDraftStore.setQueuedTurns(scopeKey, [...kept, ...additions]);
      }
      for (const entry of current) {
        if (
          entry.queueEntryId
          && !snapshotIds.has(entry.queueEntryId)
          && !kept.includes(entry)
        ) {
          snapshotObservedQueueEntryKeysRef.current.delete(
            `${scopeKey}:${entry.queueEntryId}`,
          );
        }
      }
    }
  }, [composerDraftStore, threads]);
}
