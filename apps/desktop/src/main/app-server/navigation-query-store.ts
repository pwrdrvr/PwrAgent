import { NavigationQueryStore as OwnerNavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";

export { fingerprintNavigationMaterialization, NavigationQueryError } from "@pwragent/owner-core/navigation-query-store";
export type { NavigationQueryErrorCode } from "@pwragent/owner-core/navigation-query-store";

/** Desktop attaches its process diagnostics to the shared owner store. */
export class NavigationQueryStore extends OwnerNavigationQueryStore {
  constructor(options: { now?: () => number } = {}) {
    super({
      ...options,
      onCursorHit: () => { listingDiagnostics.record("owner-page", "cursor-hit"); },
      onOvertakenRead: () => { listingDiagnostics.record("owner-read", "overtaken", { reason: "owner-invalidated" }); },
    });
  }
}

const desktopNavigationQueryStore = new NavigationQueryStore();

export function getDesktopNavigationQueryStore(): NavigationQueryStore {
  return desktopNavigationQueryStore;
}
