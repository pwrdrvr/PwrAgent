import type { DesktopMessagingStorage } from "./core/messaging-storage";
import { getMessagingStorage } from "../storage/desktop-messaging-storage";

let messagingStoreOverride: DesktopMessagingStorage | null = null;

export function getDesktopMessagingStore(): DesktopMessagingStorage {
  return messagingStoreOverride ?? getMessagingStorage();
}

export function resetDesktopMessagingStoreForTests(): void {
  messagingStoreOverride = null;
}

export function setDesktopMessagingStoreForTests(store: DesktopMessagingStorage): void {
  messagingStoreOverride = store;
}
