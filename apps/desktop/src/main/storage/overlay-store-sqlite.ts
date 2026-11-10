export * from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { SqliteOverlayStore as SharedSqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { canReclaimPrWatchLease } from "../pr-status/pr-watch-owner";
import type { StateDb } from "./state-db";

export class SqliteOverlayStore extends SharedSqliteOverlayStore {
  constructor(stateDb: StateDb) {
    super(stateDb, { canReclaimPrWatchLease });
  }
}
