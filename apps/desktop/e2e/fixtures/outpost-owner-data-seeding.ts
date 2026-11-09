import type { AppServerThreadSummary } from "@pwragent/shared";
import type { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";

export function seedRetainedOutpostUnreadThread(db: StateDb, thread: AppServerThreadSummary): void {
  // This scenario starts with a retained provider thread. Navigation can
  // render it before the independent startup provider refresh finishes.
  new ProviderThreadSnapshotStore(db).replace({ backend: "codex", observedAt: 0, threads: [thread] });
  const overlay = new SqliteOverlayStore(db);
  overlay.initializeNavigationUnreadBaseline(
    overlay.readNavigationQueryIndex({ backend: "codex", threads: [thread] }).threads,
  );
}
