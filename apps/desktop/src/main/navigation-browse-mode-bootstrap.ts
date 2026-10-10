/**
 * Synchronous navigation browse-mode read for the main BrowserWindow.
 *
 * The thread lens must be correct before React's first visible render.
 * Reading the active profile's sqlite-backed overlay store here lets the
 * renderer initialize from the same profile-scoped value it later updates
 * through IPC, avoiding an "Inbox first, then jump" startup path.
 */

import type { NavigationBrowseMode } from "@pwragent/shared";
import { getExistingDesktopConfigStore } from "./settings/config-store/desktop-config-store-singleton";
import { getAppOverlayStore } from "./state/app-state";
import { normalizeNavigationBrowseMode } from "./state/overlay-store-sqlite";

export type BootstrapNavigationPreferences = {
  browseMode: NavigationBrowseMode;
  /** The Pinned group's saved disclosure, so it paints closed on frame one. */
  pinnedGroupCollapsed: boolean;
  /**
   * `general.pinned_threads_on_top`, so Updated and Created request the right
   * pages on frame one instead of re-splitting when the settings snapshot lands.
   */
  pinnedThreadsOnTop: boolean;
};

export const BOOTSTRAP_NAVIGATION_ARG_PREFIX =
  "--pwragent-navigation-preferences=";

export function readBootstrapNavigationPreferences(): BootstrapNavigationPreferences {
  const pinnedThreadsOnTop = readPinnedThreadsOnTop();
  try {
    const store = getAppOverlayStore();
    return {
      browseMode: store.getNavigationBrowseModeSync(),
      pinnedGroupCollapsed: store.getPinnedGroupCollapsedSync(),
      pinnedThreadsOnTop,
    };
  } catch {
    return { browseMode: "inbox", pinnedGroupCollapsed: false, pinnedThreadsOnTop };
  }
}

function readPinnedThreadsOnTop(): boolean {
  try {
    return getExistingDesktopConfigStore()?.read("general").settings?.pinnedThreadsOnTop ?? true;
  } catch {
    return true;
  }
}

export function navigationPreferencesAdditionalArguments(
  preferences: BootstrapNavigationPreferences,
): string[] {
  return [serializeBootstrapNavigationPreferences(preferences)];
}

export function serializeBootstrapNavigationPreferences(
  preferences: BootstrapNavigationPreferences,
): string {
  return `${BOOTSTRAP_NAVIGATION_ARG_PREFIX}${JSON.stringify(preferences)}`;
}

export function parseBootstrapNavigationPreferencesArg(
  argv: readonly string[],
): BootstrapNavigationPreferences | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(BOOTSTRAP_NAVIGATION_ARG_PREFIX)) continue;
    try {
      const raw = JSON.parse(arg.slice(BOOTSTRAP_NAVIGATION_ARG_PREFIX.length));
      return {
        browseMode: normalizeNavigationBrowseMode(raw?.browseMode),
        pinnedGroupCollapsed: raw?.pinnedGroupCollapsed === true,
        pinnedThreadsOnTop: raw?.pinnedThreadsOnTop !== false,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
