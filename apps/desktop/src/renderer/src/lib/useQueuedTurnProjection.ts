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
  composerDraftStore?: ComposerDraftStore;
  snapshotFetchedAt?: number;
  snapshotFetchedAtForThread?: (
    thread: NavigationThreadSummary,
  ) => number | undefined;
  threads: readonly NavigationThreadSummary[];
}): void {
  const {
    composerDraftStore,
    snapshotFetchedAt,
    snapshotFetchedAtForThread,
    threads,
  } = params;
  useEffect(() => {
    if (!composerDraftStore) {
      return;
    }
    for (const thread of threads) {
      const threadSnapshotFetchedAt =
        snapshotFetchedAtForThread?.(thread) ?? snapshotFetchedAt;
      const scopeKey = `thread:${thread.source}:${thread.id}`;
      const snapshotEntries = thread.queuedTurns ?? [];
      const snapshotIds = new Set(
        snapshotEntries.map((entry) => entry.queueEntryId),
      );
      const snapshotsById = new Map(
        snapshotEntries.map((entry) => [entry.queueEntryId, entry]),
      );
      const current = composerDraftStore.getQueuedTurns(scopeKey);
      const knownIds = new Set(
        current
          .map((entry) => entry.queueEntryId)
          .filter((id): id is string => Boolean(id)),
      );

      const kept = current
        .filter(
          (entry) =>
            // Local-only entries (no backend id yet) and in-flight
            // submissions are this window's own state — never prune from
            // a snapshot that may predate them.
            !entry.queueEntryId
            || entry.backendQueuePending
            || snapshotIds.has(entry.queueEntryId)
            || typeof entry.queueEntryCreatedAt !== "number"
            || typeof threadSnapshotFetchedAt !== "number"
            // Millisecond equality is ambiguous: the snapshot may have read the
            // FIFO just before creation within the same clock tick.
            || threadSnapshotFetchedAt <= entry.queueEntryCreatedAt,
        )
        .map((entry) => {
          const snapshot = entry.queueEntryId
            ? snapshotsById.get(entry.queueEntryId)
            : undefined;
          return snapshot
            ? {
                ...entry,
                manualReleaseRequired: snapshot.manualReleaseRequired,
                holdReason: snapshot.holdReason,
              }
            : entry;
        });
      const additions: ComposerQueuedTurnSnapshot[] = snapshotEntries
        .filter((entry) => !knownIds.has(entry.queueEntryId))
        .map((entry) => ({
          id: `backend-queued:${entry.queueEntryId}`,
          queueEntryId: entry.queueEntryId,
          queueEntryCreatedAt: entry.createdAt,
          manualReleaseRequired: entry.manualReleaseRequired,
          holdReason: entry.holdReason,
          text: entry.displayText,
          imageAttachments: [],
          fileAttachments: [],
        }));
      const firstMirroredIndex = kept.findIndex(
        (entry) => entry.queueEntryId && snapshotIds.has(entry.queueEntryId),
      );
      const next = firstMirroredIndex < 0
        ? [...kept, ...additions]
        : (() => {
            const mirroredById = new Map(
              [...kept, ...additions]
                .filter((entry) => entry.queueEntryId)
                .map((entry) => [entry.queueEntryId, entry]),
            );
            const orderedMirrors = snapshotEntries
              .map((entry) => mirroredById.get(entry.queueEntryId))
              .filter((entry): entry is ComposerQueuedTurnSnapshot => Boolean(entry));
            const withoutMirrors = kept.filter(
              (entry) => !entry.queueEntryId || !snapshotIds.has(entry.queueEntryId),
            );
            return [
              ...withoutMirrors.slice(0, firstMirroredIndex),
              ...orderedMirrors,
              ...withoutMirrors.slice(firstMirroredIndex),
            ];
          })();
      const queueStateChanged = next.some((entry, index) =>
        entry.id !== current[index]?.id
        || entry.manualReleaseRequired !== current[index]?.manualReleaseRequired
        || entry.holdReason !== current[index]?.holdReason
      );

      if (
        next.length !== current.length
        || queueStateChanged
      ) {
        composerDraftStore.setQueuedTurns(scopeKey, next);
      }
    }
  }, [
    composerDraftStore,
    snapshotFetchedAt,
    snapshotFetchedAtForThread,
    threads,
  ]);
}
