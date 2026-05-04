import type { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { getAppMessagingStore } from "../state/app-state";

let messagingStoreOverride: SqliteMessagingStore | null = null;

export function getDesktopMessagingStore(): SqliteMessagingStore {
  return messagingStoreOverride ?? getAppMessagingStore();
}

export function resetDesktopMessagingStoreForTests(): void {
  messagingStoreOverride = null;
}

export function setDesktopMessagingStoreForTests(store: SqliteMessagingStore): void {
  messagingStoreOverride = store;
}
