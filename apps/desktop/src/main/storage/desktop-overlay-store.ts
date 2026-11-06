import type { OwnerThreadRegistry } from "@pwragent/owner-core/thread-storage";
import type { SqliteOverlayStore } from "../state/overlay-store-sqlite";
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
} from "../state/overlay-store-sqlite";

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
