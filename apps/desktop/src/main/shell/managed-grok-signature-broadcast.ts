import { MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL } from "../../shared/ipc";
import type { ManagedGrokSignatureRejectedEvent } from "../../shared/managed-grok-signature";
import { subscribersForChannel } from "./window-channels";

export function broadcastManagedGrokSignatureRejection(
  event: ManagedGrokSignatureRejectedEvent,
): void {
  for (const webContents of subscribersForChannel(
    MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL,
  )) {
    if (!webContents.isDestroyed()) {
      webContents.send(MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL, event);
    }
  }
}
