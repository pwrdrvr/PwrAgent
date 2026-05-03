import type { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { getAppOverlayStore } from "../state/app-state";

let overlayStoreOverride: SqliteOverlayStore | null = null;

export function getDesktopOverlayStore(): SqliteOverlayStore {
  return overlayStoreOverride ?? getAppOverlayStore();
}

export function resetDesktopOverlayStoreForTests(): void {
  overlayStoreOverride = null;
}

export function setDesktopOverlayStoreForTests(store: SqliteOverlayStore): void {
  overlayStoreOverride = store;
}
