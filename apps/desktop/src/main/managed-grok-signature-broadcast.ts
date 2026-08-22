import { ipcMain } from "electron";
import {
  MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL,
  MANAGED_GROK_SIGNATURE_REJECTION_ACKNOWLEDGE_CHANNEL,
  MANAGED_GROK_SIGNATURE_REJECTIONS_READ_CHANNEL,
} from "../shared/ipc";
import type { ManagedGrokSignatureRejectedEvent } from "../shared/managed-grok-signature";
import { setManagedGrokSignatureRejectionReporter } from "./acp/grok-managed-runtime";
import { subscribersForChannel } from "./window-channels";

const pendingRejections = new Map<string, ManagedGrokSignatureRejectedEvent>();

export function broadcastManagedGrokSignatureRejection(
  event: ManagedGrokSignatureRejectedEvent,
): void {
  pendingRejections.set(event.id, event);
  for (const webContents of subscribersForChannel(
    MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL,
  )) {
    if (!webContents.isDestroyed()) {
      webContents.send(MANAGED_GROK_SIGNATURE_REJECTED_EVENT_CHANNEL, event);
    }
  }
}

export function readPendingManagedGrokSignatureRejections():
  ManagedGrokSignatureRejectedEvent[] {
  return Array.from(pendingRejections.values());
}

export function acknowledgeManagedGrokSignatureRejection(id: string): void {
  pendingRejections.delete(id);
}

/**
 * Managed Grok downloads run behind whatever the operator was doing — opening
 * Settings, picking a backend, finishing onboarding — and the surface that
 * triggered one is often gone by the time it resolves. Report a rejection to
 * every window instead, where it becomes a durable notice that survives the
 * triggering screen closing.
 */
export function registerManagedGrokSignatureRejectionBroadcast(): void {
  ipcMain.removeHandler(MANAGED_GROK_SIGNATURE_REJECTIONS_READ_CHANNEL);
  ipcMain.handle(
    MANAGED_GROK_SIGNATURE_REJECTIONS_READ_CHANNEL,
    (): ManagedGrokSignatureRejectedEvent[] =>
      readPendingManagedGrokSignatureRejections(),
  );
  ipcMain.removeHandler(MANAGED_GROK_SIGNATURE_REJECTION_ACKNOWLEDGE_CHANNEL);
  ipcMain.handle(
    MANAGED_GROK_SIGNATURE_REJECTION_ACKNOWLEDGE_CHANNEL,
    (_event, id: unknown): void => {
      if (typeof id === "string") {
        acknowledgeManagedGrokSignatureRejection(id);
      }
    },
  );
  setManagedGrokSignatureRejectionReporter(
    broadcastManagedGrokSignatureRejection,
  );
}

export function _resetPendingManagedGrokSignatureRejectionsForTests(): void {
  pendingRejections.clear();
}
