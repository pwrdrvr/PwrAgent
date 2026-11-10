import type {
  AppServerBackendKind,
  AppServerThreadSummary,
} from "@pwragent/shared";
import { isAppServerBackendKind } from "@pwragent/shared";
import { projectProviderThreadSummary as toDurableThreadSummary, type ProviderThreadSnapshot, type ProviderThreadSnapshotStorage } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import type { StateDb } from "./state-db";
import { SqliteOverlayStore } from "./overlay-store-sqlite";

export const PROVIDER_THREAD_SNAPSHOT_SCHEMA_VERSION = 1;

export class ProviderThreadSnapshotStore
implements ProviderThreadSnapshotStorage {
  constructor(private readonly stateDb: StateDb) {}

  list(): ProviderThreadSnapshot[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT backend, schema_version, observed_at, payload
         FROM provider_thread_snapshots
         ORDER BY backend COLLATE NOCASE`,
      )
      .all() as Array<{
        backend: string;
        schema_version: number;
        observed_at: number;
        payload: string;
      }>;

    return rows.flatMap((row) => {
      if (row.schema_version !== PROVIDER_THREAD_SNAPSHOT_SCHEMA_VERSION) {
        return [];
      }
      const threads = parseThreadSummaries(row.payload);
      if (
        !threads
        || !isBackendKind(row.backend)
        || threads.some((thread) => thread.source !== row.backend)
      ) {
        return [];
      }
      const durableThreads = threads.map(toDurableThreadSummary);
      const durablePayload = JSON.stringify(durableThreads);
      if (durablePayload !== row.payload) {
        this.stateDb.raw
          .prepare(
            `UPDATE provider_thread_snapshots
             SET payload = ?
             WHERE backend = ?`,
          )
          .run(durablePayload, row.backend);
      }
      return [{
        backend: row.backend,
        observedAt: row.observed_at,
        threads: durableThreads,
      }];
    });
  }

  replace(snapshot: ProviderThreadSnapshot, retiredThreadIds?: readonly string[]): void {
    if (retiredThreadIds?.length) {
      this.stateDb.raw.transaction(() => {
        const overlay = new SqliteOverlayStore(this.stateDb);
        for (const threadId of retiredThreadIds) overlay.mergeOwnerThreadMetadata({ backend: snapshot.backend, threadId }, { nativeMembershipRetired: true });
        this.replace(snapshot);
      })();
      return;
    }
    this.stateDb.raw
      .prepare(
        `INSERT INTO provider_thread_snapshots(
           backend,
           schema_version,
           observed_at,
           payload
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(backend) DO UPDATE SET
           schema_version = excluded.schema_version,
           observed_at = excluded.observed_at,
           payload = excluded.payload`,
      )
      .run(
        snapshot.backend,
        PROVIDER_THREAD_SNAPSHOT_SCHEMA_VERSION,
        snapshot.observedAt,
        JSON.stringify(snapshot.threads.map(toDurableThreadSummary)),
      );
  }
}


function parseThreadSummaries(payload: string): AppServerThreadSummary[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const threads: AppServerThreadSummary[] = [];
  for (const value of parsed) {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || typeof (value as Record<string, unknown>).id !== "string"
      || typeof (value as Record<string, unknown>).title !== "string"
      || !isBackendKind((value as Record<string, unknown>).source)
    ) {
      return undefined;
    }
    threads.push(value as AppServerThreadSummary);
  }
  return threads;
}

function isBackendKind(value: unknown): value is AppServerBackendKind {
  return typeof value === "string" && isAppServerBackendKind(value);
}
