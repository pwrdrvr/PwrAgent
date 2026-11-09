import type { AppServerThreadSummary } from "@pwragent/shared";
import type { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";

export function seedRetainedOutpostUnreadThread(db: StateDb, thread: AppServerThreadSummary): void {
  const overlay = new SqliteOverlayStore(db);
  overlay.initializeNavigationUnreadBaseline(
    overlay.readNavigationQueryIndex({ backend: "codex", threads: [thread] }).threads,
  );
}
