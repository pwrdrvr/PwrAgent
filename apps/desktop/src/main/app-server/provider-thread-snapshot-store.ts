import type {
  AppServerBackendKind,
  AppServerThreadSummary,
} from "@pwragent/shared";
import type { StateDb } from "../state/state-db";

export const PROVIDER_THREAD_SNAPSHOT_SCHEMA_VERSION = 1;

export type ProviderThreadSnapshot = Readonly<{
  backend: AppServerBackendKind;
  observedAt: number;
  threads: readonly AppServerThreadSummary[];
}>;

export interface ProviderThreadSnapshotStoreLike {
  list(): ProviderThreadSnapshot[];
  replace(snapshot: ProviderThreadSnapshot): void;
}

export class ProviderThreadSnapshotStore
implements ProviderThreadSnapshotStoreLike {
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
      return [{
        backend: row.backend,
        observedAt: row.observed_at,
        threads,
      }];
    });
  }

  replace(snapshot: ProviderThreadSnapshot): void {
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
        JSON.stringify(snapshot.threads),
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
  return value === "codex"
    || (typeof value === "string" && value.startsWith("acp:"));
}
