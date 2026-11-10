import { MANAGED_RUNTIME_PROGRESS_EVENT_CHANNEL } from "../../shared/ipc";
import type { ManagedRuntimeProgress } from "../../shared/managed-runtime-progress";
import { subscribersForChannel } from "./window-channels";

export function broadcastManagedRuntimeProgress(
  event: ManagedRuntimeProgress,
): void {
  for (const webContents of subscribersForChannel(
    MANAGED_RUNTIME_PROGRESS_EVENT_CHANNEL,
  )) {
    if (!webContents.isDestroyed()) {
      webContents.send(MANAGED_RUNTIME_PROGRESS_EVENT_CHANNEL, event);
    }
  }
}
