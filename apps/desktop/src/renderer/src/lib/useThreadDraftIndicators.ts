import { useMemo, useSyncExternalStore } from "react";
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
 * A draft belongs to whoever typed it. It lives in this window's composer
 * store, is persisted to this machine's `composer_draft_latest` table, and is
 * re-hydrated on the next launch — it is never sent to the thread's owning
 * instance. That is what makes the affordance work unchanged in a federation
 * viewer window: a reply half-written against a peer's thread is the viewer's
 * own unsent work, keyed by the same `thread:<backend>:<id>` scope key the
 * composer wrote it under, so it surfaces on the row the operator was
 * looking at. Nothing about it needs to cross the wire, and federating it
 * would publish an operator's unsent text to another machine.
 *
 * Keyed by `buildThreadIdentityKey` to match how ThreadRow and the Star Map
 * card look their state up, and how the scope key itself is built.
 *
 * Reacts to *presence* changes only (see `subscribeDraftPresence`), so typing
 * into the composer re-renders the thread list once — when the draft appears —
 * rather than on every keystroke.
 */
export function useThreadDraftIndicators(params: {
  composerDraftStore: ComposerDraftStore;
  threads: NavigationThreadSummary[];
}): Record<string, boolean> {
  const { composerDraftStore, threads } = params;
  const version = useSyncExternalStore(
    (listener) => composerDraftStore.subscribeDraftPresence(listener),
    () => composerDraftStore.getDraftPresenceVersion(),
  );

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
