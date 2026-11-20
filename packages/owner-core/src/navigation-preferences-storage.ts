import type { NavigationBrowseMode } from "@pwragent/shared/contracts/navigation";
import type { NavigationResumeState } from "@pwragent/shared/navigation-resume-state";

/** Synchronous profile preferences needed before the first visible frame. */
export interface NavigationPreferencesStorage {
  getNavigationBrowseModeSync(): NavigationBrowseMode;
  getNavigationResumeStateSync(): NavigationResumeState | undefined;
  getPinnedGroupCollapsedSync(): boolean;
}
