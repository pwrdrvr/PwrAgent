import { parseOwnedComposerScopeKey } from "@pwragent/shared";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "./federated-thread-events";
import { readRendererFederationTarget } from "./federation-window";
import {
  buildThreadComposerScopeKey,
  type ComposerDraftStore,
} from "../features/composer/useComposerDraftStore";

/** Draft text stays on this viewer. Chips use explicit owner identity and react only to presence changes. */
export function useThreadDraftIndicators(params: {
  composerDraftStore?: ComposerDraftStore;
  threads: NavigationThreadSummary[];
}): Record<string, boolean> {
  const { composerDraftStore, threads } = params;
  // Both callbacks are memoized against the store rather than written inline:
  // `useSyncExternalStore` re-subscribes whenever `subscribe` changes identity,
  // and an inline arrow changes on every render.
  const subscribe = useCallback(
    (listener: () => void) => composerDraftStore?.subscribeDraftPresence(listener) ?? (() => undefined),
    [composerDraftStore],
  );
  const getSnapshot = useCallback(
    () => composerDraftStore?.getDraftPresenceVersion() ?? 0,
    [composerDraftStore],
  );
  const version = useSyncExternalStore(subscribe, getSnapshot);

  return useMemo(() => {
    const indicators: Record<string, boolean> = {};
    for (const thread of threads) {
      if (
        composerDraftStore?.hasDraftContent(
          buildThreadComposerScopeKey(thread.source, thread.id, thread.federation?.ref.target ?? readRendererFederationTarget() ?? { scope: "local" }),
        )
      ) {
        indicators[threadSummaryIdentityKey(thread)] = true;
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
      draftThreadKeys[threadSummaryIdentityKey(thread)] === true,
  );
}

/** Legacy scopes remain recoverable, but a backend/thread id alone does not assign their owner. */
export function useUnassignedThreadDraftCount(store?: ComposerDraftStore): number {
  const version = useSyncExternalStore(
    useCallback((listener: () => void) => store?.subscribeDraftPresence?.(listener) ?? (() => undefined), [store]),
    useCallback(() => store?.getDraftPresenceVersion?.() ?? 0, [store]),
  );
  return useMemo(() => (store?.getDraftScopeKeys?.() ?? []).filter((scope) =>
    scope.startsWith("thread:") && !parseOwnedComposerScopeKey(scope)).length,
    // Presence versions track opaque scope membership rather than draft text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version]);
}
