import { MANAGED_RUNTIME_PROGRESS_EVENT_CHANNEL } from "../shared/ipc";
import type { ManagedRuntimeProgress } from "../shared/managed-runtime-progress";
import { subscribeManagedRuntimeProgress } from "./managed-runtime-progress";
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

/**
 * A managed download runs behind whatever the operator was doing, so Settings
 * may open in the middle of one. Every window gets the events as they happen;
 * the settings IPC handlers answer the current state for a window that opens
 * mid-download.
 */
export function registerManagedRuntimeProgressBroadcast(): void {
  subscribeManagedRuntimeProgress(broadcastManagedRuntimeProgress);
}
