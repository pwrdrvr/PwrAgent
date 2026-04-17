import { app } from "electron";
import path from "node:path";
import { OverlayStore } from "@pwragnt/agent-core";

let overlayStore: OverlayStore | null = null;

export function getDesktopOverlayStore(): OverlayStore {
  if (!overlayStore) {
    overlayStore = new OverlayStore(
      path.join(app.getPath("userData"), "overlay-state.json"),
    );
  }

  return overlayStore;
}

export function resetDesktopOverlayStoreForTests(): void {
  overlayStore = null;
}
