import type { NavigationBrowseMode, NavigationResumeState } from "@pwragent/shared";

/** Synchronous profile preferences needed before the first visible frame. */
export interface NavigationPreferencesStorage {
  getNavigationBrowseModeSync(): NavigationBrowseMode;
  getNavigationResumeStateSync(): NavigationResumeState | undefined;
  getPinnedGroupCollapsedSync(): boolean;
}
