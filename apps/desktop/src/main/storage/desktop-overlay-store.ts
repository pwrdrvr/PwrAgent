import type { NavigationPreferencesStorage } from "@pwragent/owner-core/navigation-preferences-storage";
import type { OwnerThreadRegistry } from "@pwragent/owner-core/thread-storage";
import type { SqliteOverlayStore } from "./overlay-store-sqlite";
import { getAppOverlayStore } from "../state/app-state";

export type DesktopOwnerStorage = OwnerThreadRegistry & Pick<SqliteOverlayStore, keyof SqliteOverlayStore>;

// Desktop-only projections extend the shared owner metadata port. The mapped
// public API excludes the concrete adapter's private database and caches.
export type {
  OverlayStoreLike,
  ArchivedThreadAutomationRetirement,
  WorktreeGitWorkingStateCacheEntry,
  DirectoryGitStatusCacheEntry,
  PrAutoDispatchCandidateChange,
  PrLookupCacheEntry,
  PrStatusCacheEntry,
} from "./overlay-store-sqlite";

let overlayStoreOverride: DesktopOwnerStorage | null = null;

export function getDesktopOverlayStore(): DesktopOwnerStorage {
  return overlayStoreOverride ?? getAppOverlayStore();
}

export function resetDesktopOverlayStoreForTests(): void {
  overlayStoreOverride = null;
}

export function setDesktopOverlayStoreForTests(store: DesktopOwnerStorage): void {
  overlayStoreOverride = store;
}

/** Read the active profile on each bootstrap read; do not capture its handle. */
export function getDesktopNavigationPreferencesStorage(): NavigationPreferencesStorage {
  return getAppOverlayStore();
}
