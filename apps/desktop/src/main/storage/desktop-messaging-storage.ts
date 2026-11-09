import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import type { MessagingPairingStorage } from "@pwragent/owner-core/messaging-pairing-storage";
import type { DesktopMessagingStorage, MessagingRequestStore } from "../messaging/core/messaging-storage";
import { getAppMessagingStore, getAppStateDb } from "../state/app-state";
import { SqliteMessagingRequestStore } from "./messaging-request-store";
import { MessagingActivityLog } from "./messaging-activity-log";
import { MessagingPairingStore } from "./messaging-pairing-store";

// Accessors bind at the caller's existing lifecycle boundary, with no cached database handle.
export function getMessagingStorage(): DesktopMessagingStorage {
  return getAppMessagingStore();
}

export function createMessagingActivityStorage(): MessagingActivityStorage {
  return new MessagingActivityLog(getAppStateDb());
}

export function createMessagingPairingStorage(): MessagingPairingStorage {
  return new MessagingPairingStore(getAppStateDb());
}

export function createMessagingRequestStorage(): MessagingRequestStore {
  return new SqliteMessagingRequestStore(getAppStateDb().raw);
}
