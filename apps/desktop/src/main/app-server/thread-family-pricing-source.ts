import type { NavigationIdentity, ReadThreadFamilyPricingResponse } from "@pwragent/shared";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import type { NavigationQueryIndex } from "./navigation-query-projection";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";
import { readThreadFamilyPricing } from "./thread-family-pricing";

/**
 * This machine's threads plus its saved pins of other instances' threads. A
 * sub-thread started on another machine is pinned here under its parent, so
 * the pins carry the family's cross-machine edges. Only the saved rows are
 * read: the relationship is all this needs, and it never waits on a peer.
 */
async function loadThreadFamilyPricingIndex(localInstanceId: string | undefined): Promise<NavigationQueryIndex> {
  const index = await loadLocalNavigationQueryIndex({ callerReason: "thread-family-pricing" });
  const store = getDesktopOverlayStore();
  const pins = (await store.readRemoteThreadPinNavigationRows?.() ?? [])
    .filter((pin) => pin.archivedAt === undefined);
  if (!pins.length) return localInstanceId ? { ...index, localInstanceId } : index;
  return { ...index, ...(localInstanceId ? { localInstanceId } : {}), threads: [...index.threads, ...pins] };
}

/**
 * Reads this machine's part of a thread family, with referrals to the rest.
 * One family read can ask about several roots; they share one index load.
 */
export function createLocalThreadFamilyPricingReader(
  localInstanceId: string | undefined,
): (root: NavigationIdentity) => Promise<ReadThreadFamilyPricingResponse> {
  let index: Promise<NavigationQueryIndex> | undefined;
  return async (root) => await readThreadFamilyPricing({
    root,
    loadIndex: () => index ??= loadThreadFamilyPricingIndex(localInstanceId),
    readSummaries: (threads) => getDesktopOverlayStore().readThreadPricingSummaries(threads),
  });
}
