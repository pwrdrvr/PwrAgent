import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import { AppUpdateNoticeStore } from "@pwragent/sqlite-storage/app-update-notice-store";
import type { MessagingPairingStorage } from "@pwragent/owner-core/messaging-pairing-storage";
import type { DesktopMessagingStorage, MessagingRequestStore } from "../messaging/core/messaging-storage";
import { getAppMessagingStore, getAppStateDb } from "../state/app-state";
import { resolveActiveProfilePath } from "../profile";
import { StateDb } from "./state-db";
import { SqliteMessagingStore } from "./messaging-store-sqlite";
import { SqliteMessagingRequestStore } from "./messaging-request-store";
import { MessagingActivityLog } from "./messaging-activity-log";
import { MessagingPairingStore } from "./messaging-pairing-store";

// Accessors bind at the caller's existing lifecycle boundary, with no cached database handle.
export function getMessagingStorage(): DesktopMessagingStorage {
  return getAppMessagingStore();
}

export function createAppUpdateNoticeStore(): AppUpdateNoticeStore {
  return new AppUpdateNoticeStore(getAppStateDb());
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

export function openMessagingConnectionStorage(connectionId: string) {
  if (!/^mc_[a-f0-9]{32}$/.test(connectionId)) throw new Error("Invalid messaging connection ID.");
  // Legacy clients only open state/state.db. No renamed binding or handle is
  // projected into their data, even when their provider identifiers coincide.
  const db = StateDb.open(resolveActiveProfilePath(`state/messaging-connections/${connectionId}.db`));
  return {
    bindings: new SqliteMessagingStore(db),
    pairing: new MessagingPairingStore(db),
    requests: new SqliteMessagingRequestStore(db.raw),
    close: () => db.close(),
  };
}
