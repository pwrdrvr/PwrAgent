/**
 * Synchronous navigation browse-mode read for the main BrowserWindow.
 *
 * The thread lens must be correct before React's first visible render.
 * Reading the active profile's sqlite-backed overlay store here lets the
 * renderer initialize from the same profile-scoped value it later updates
 * through IPC, avoiding an "Inbox first, then jump" startup path.
 */

import type { NavigationBrowseMode } from "@pwragent/shared";
import { getAppOverlayStore } from "./state/app-state";
import { normalizeNavigationBrowseMode } from "./state/overlay-store-sqlite";

export type BootstrapNavigationPreferences = {
  browseMode: NavigationBrowseMode;
};

export const BOOTSTRAP_NAVIGATION_ARG_PREFIX =
  "--pwragent-navigation-preferences=";

export function readBootstrapNavigationPreferences(): BootstrapNavigationPreferences {
  try {
    return {
      browseMode: getAppOverlayStore().getNavigationBrowseModeSync(),
    };
  } catch {
    return { browseMode: "inbox" };
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
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
