import { SqliteMessagingStore as SharedSqliteMessagingStore } from "@pwragent/sqlite-storage/messaging-store-sqlite";
import type { DesktopMessagingStorageRecords } from "../messaging/core/messaging-storage.js";
import { messagingSqlitePolicy } from "./messaging-sqlite-policy.js";
import type { StateDb } from "./state-db.js";

export class SqliteMessagingStore extends SharedSqliteMessagingStore<DesktopMessagingStorageRecords> {
  constructor(stateDb: StateDb) {
    super(stateDb, messagingSqlitePolicy);
  }
}
