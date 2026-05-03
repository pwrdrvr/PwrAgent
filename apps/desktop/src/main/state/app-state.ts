import {
  ensureProfileExists,
  resolveActiveProfilePath,
  updateLastUsed,
} from "../profile";
import { migrateIfNeeded } from "./migration.js";
import { SqliteMessagingStore } from "./messaging-store-sqlite.js";
import { SqliteOverlayStore } from "./overlay-store-sqlite.js";
import { StateDb } from "./state-db.js";

let stateDb: StateDb | null = null;
let messagingStore: SqliteMessagingStore | null = null;
let overlayStore: SqliteOverlayStore | null = null;

export function initializeAppState(): {
  stateDb: StateDb;
  messagingStore: SqliteMessagingStore;
  overlayStore: SqliteOverlayStore;
} {
  if (stateDb) {
    return { stateDb, messagingStore: messagingStore!, overlayStore: overlayStore! };
  }

  const { profileName } = ensureProfileExists();
  migrateIfNeeded();

  const dbPath = resolveActiveProfilePath("state/state.db");
  stateDb = StateDb.open(dbPath, { profileName });
  stateDb.startGc();

  updateLastUsed(profileName);

  messagingStore = new SqliteMessagingStore(stateDb);
  overlayStore = new SqliteOverlayStore(stateDb);

  return { stateDb, messagingStore, overlayStore };
}

export function getAppStateDb(): StateDb {
  if (!stateDb) throw new Error("App state not initialized. Call initializeAppState() first.");
  return stateDb;
}

export function getAppMessagingStore(): SqliteMessagingStore {
  if (!messagingStore) throw new Error("App state not initialized. Call initializeAppState() first.");
  return messagingStore;
}

export function getAppOverlayStore(): SqliteOverlayStore {
  if (!overlayStore) throw new Error("App state not initialized. Call initializeAppState() first.");
  return overlayStore;
}

export function disposeAppState(): void {
  if (stateDb) {
    stateDb.close();
    stateDb = null;
    messagingStore = null;
    overlayStore = null;
  }
}

export function resetAppStateForTests(): void {
  stateDb = null;
  messagingStore = null;
  overlayStore = null;
}
