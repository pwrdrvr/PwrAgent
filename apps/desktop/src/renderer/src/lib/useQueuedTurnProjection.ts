import { useEffect } from "react";
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
 * state (attachments, review commands). A backend-owned entry is pruned when
 * an owner snapshot taken after that entry was created omits it — the FIFO
 * dispatched or cancelled it. Ordering in the owner's clock domain prevents
 * an older navigation snapshot from pruning a just-acknowledged submission.
 */
export function useQueuedTurnProjection(params: {
  composerDraftStore: ComposerDraftStore;
  snapshotFetchedAt?: number;
  threads: readonly NavigationThreadSummary[];
}): void {
  const { composerDraftStore, snapshotFetchedAt, threads } = params;
  useEffect(() => {
    for (const thread of threads) {
      const scopeKey = `thread:${thread.source}:${thread.id}`;
      const snapshotEntries = thread.queuedTurns ?? [];
      const snapshotIds = new Set(
        snapshotEntries.map((entry) => entry.queueEntryId),
      );
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
          || typeof entry.queueEntryCreatedAt !== "number"
          || typeof snapshotFetchedAt !== "number"
          // Millisecond equality is ambiguous: the snapshot may have read the
          // FIFO just before creation within the same clock tick.
          || snapshotFetchedAt <= entry.queueEntryCreatedAt,
      );
      const additions: ComposerQueuedTurnSnapshot[] = snapshotEntries
        .filter((entry) => !knownIds.has(entry.queueEntryId))
        .map((entry) => ({
          id: `backend-queued:${entry.queueEntryId}`,
          queueEntryId: entry.queueEntryId,
          queueEntryCreatedAt: entry.createdAt,
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
    }
  }, [composerDraftStore, snapshotFetchedAt, threads]);
}
