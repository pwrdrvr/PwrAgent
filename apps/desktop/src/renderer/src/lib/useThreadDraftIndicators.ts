import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import {
  buildThreadComposerScopeKey,
  type ComposerDraftStore,
} from "../features/composer/useComposerDraftStore";

/**
 * Derives the per-thread "has an unsent draft" map the sidebar, the Drafts
 * lens, and the Star Map all read.
 *
 * A draft belongs to whoever typed it, and is never sent to the thread's
 * owning instance. That is what makes the affordance work unchanged in a
 * federation viewer window: a reply half-written against a peer's thread is
 * the viewer's own unsent work, keyed by the same `thread:<backend>:<id>`
 * scope key the composer wrote it under, so it surfaces on the row the
 * operator was looking at. Nothing about it needs to cross the wire, and
 * federating it would publish an operator's unsent text to another machine.
 *
 * Keyed by `buildThreadIdentityKey` to match how ThreadRow and the Star Map
 * card look their state up, and how the scope key itself is built.
 *
 * Reacts to *presence* changes only (see `subscribeDraftPresence`), so typing
 * into the composer re-renders the thread list once — when the draft appears —
 * rather than on every keystroke.
 *
 * Three known limits, none of them silent-by-accident:
 *
 * 1. **The storage is machine-wide; this view is per-window.** Drafts persist
 *    to `composer_draft_latest`, which every window on the profile shares, but
 *    a window only reads it once at mount (`useDurableComposerDraftStore`
 *    hydration) and there is no main -> renderer change event. So a draft typed
 *    in one window does not light up a row in another already-open window
 *    until that window restarts. Fixing it means broadcasting on draft
 *    save/clear, which fires up to ~5/s per typing operator against every open
 *    window; that trade is worth making deliberately, not as a side effect of
 *    this chip.
 * 2. **Only threads in the current navigation snapshot can be marked.** A
 *    draft on an archived thread, or on a remote thread that is not pinned
 *    into the snapshot, has no row to carry a chip and no slot in the Drafts
 *    lens. Nothing deletes its `composer_draft_latest` row when a thread is
 *    archived either, so it is unreachable rather than merely hidden.
 * 3. **Launchpad drafts are out of scope.** `launchpad:<directoryKey>` text is
 *    equally unsent, but it belongs to a directory rather than a thread and
 *    has no row to hang a chip on. The lens copy says "replies" for that
 *    reason — do not widen it to "drafts" without giving launchpad text a home.
 */
export function useThreadDraftIndicators(params: {
  composerDraftStore: ComposerDraftStore;
  threads: NavigationThreadSummary[];
}): Record<string, boolean> {
  const { composerDraftStore, threads } = params;
  // Both callbacks are memoized against the store rather than written inline:
  // `useSyncExternalStore` re-subscribes whenever `subscribe` changes identity,
  // and an inline arrow changes on every render.
  const subscribe = useCallback(
    (listener: () => void) => composerDraftStore.subscribeDraftPresence(listener),
    [composerDraftStore],
  );
  const getSnapshot = useCallback(
    () => composerDraftStore.getDraftPresenceVersion(),
    [composerDraftStore],
  );
  const version = useSyncExternalStore(subscribe, getSnapshot);

  return useMemo(() => {
    const indicators: Record<string, boolean> = {};
    for (const thread of threads) {
      if (
        composerDraftStore.hasDraftContent(
          buildThreadComposerScopeKey(thread.source, thread.id),
        )
      ) {
        indicators[buildThreadIdentityKey(thread.source, thread.id)] = true;
      }
    }
    return indicators;
    // `version` is intentionally a dependency (not referenced in the body):
    // it forces recomputation when draft presence changes, since the store's
    // backing Set is a ref whose identity never changes. exhaustive-deps
    // can't see that and flags it as unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerDraftStore, threads, version]);
}

/**
 * Threads with an unsent draft, in the order they were given. The Drafts lens
 * renders this directly, so the tab's count and the list can never disagree.
 */
export function selectThreadsWithDrafts(
  threads: NavigationThreadSummary[],
  draftThreadKeys: Record<string, boolean> | undefined,
): NavigationThreadSummary[] {
  if (!draftThreadKeys) {
    return [];
  }
  return threads.filter(
    (thread) =>
      draftThreadKeys[buildThreadIdentityKey(thread.source, thread.id)] === true,
  );
}
