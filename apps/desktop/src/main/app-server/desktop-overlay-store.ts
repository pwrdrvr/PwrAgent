import { OverlayStore } from "@pwragnt/agent-core";
import { resolveDesktopOverlayStorePath } from "./desktop-state-root";

let overlayStore: OverlayStore | null = null;

export function getDesktopOverlayStore(): OverlayStore {
  if (!overlayStore) {
    overlayStore = new OverlayStore(resolveDesktopOverlayStorePath());
  }

  return overlayStore;
}

export function resetDesktopOverlayStoreForTests(): void {
  overlayStore = null;
}
