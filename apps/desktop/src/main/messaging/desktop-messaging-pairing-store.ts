import type { MessagingPairingStorage } from "@pwragent/owner-core/messaging-pairing-storage";
import { createMessagingPairingStorage } from "../storage/desktop-messaging-storage";

let storeOverride: MessagingPairingStorage | null = null;

export function getDesktopMessagingPairingStore(): MessagingPairingStorage {
  return storeOverride ?? createMessagingPairingStorage();
}

export function setDesktopMessagingPairingStoreForTests(
  store: MessagingPairingStorage | null,
): void {
  storeOverride = store;
}
