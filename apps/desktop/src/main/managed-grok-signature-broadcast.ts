import { MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL } from "../shared/ipc";
import type { ManagedGrokSignatureRejectedEvent } from "../shared/managed-grok-signature";
import { setManagedGrokSignatureRejectionReporter } from "./acp/grok-managed-runtime";
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

/**
 * Managed Grok downloads run behind whatever the operator was doing — opening
 * Settings, picking a backend, finishing onboarding — and the surface that
 * triggered one is often gone by the time it resolves. Report a rejection to
 * every window instead, where it becomes a durable notice that survives the
 * triggering screen closing.
 */
export function registerManagedGrokSignatureRejectionBroadcast(): void {
  setManagedGrokSignatureRejectionReporter(
    broadcastManagedGrokSignatureRejection,
  );
}
