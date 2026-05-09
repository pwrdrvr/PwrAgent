import { getAppStateDb } from "../state/app-state";
import { MessagingPairingStore } from "./messaging-pairing-store";

let storeOverride: MessagingPairingStore | null = null;

export function getDesktopMessagingPairingStore(): MessagingPairingStore {
  return storeOverride ?? new MessagingPairingStore(getAppStateDb());
}

export function setDesktopMessagingPairingStoreForTests(
  store: MessagingPairingStore | null,
): void {
  storeOverride = store;
}
