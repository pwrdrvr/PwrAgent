import type Database from "better-sqlite3";
import {
  isAppServerBackendKind,
  type AppServerBackendKind,
  type AppServerThreadMessageOrigin,
  type AppServerTurnInputItem,
} from "@pwragent/shared";
import { storageProcessAlive } from "./storage-maintenance";

/**
 * Turns a quiet restart stopped, to continue after the next launch. A row is
 * written before the quit interrupts its turn and deleted when the
 * continuation starts or is discarded, so a second restart before then sends
 * it again rather than losing it.
 */
export const RESTART_CONTINUATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS restart_continuations (
  entry_id TEXT PRIMARY KEY,
  owner_instance_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
`;

export type StoredRestartContinuation = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  messageOrigin?: AppServerThreadMessageOrigin;
  input: AppServerTurnInputItem[];
  createdAt: number;
};

type Row = {
  entry_id: string;
  owner_instance_id: string;
  owner_pid: number;
  payload: string;
};

function parseContinuation(row: Row): StoredRestartContinuation | undefined {
  try {
    const value = JSON.parse(row.payload) as Partial<StoredRestartContinuation>;
    if (
      value.id !== row.entry_id
      || typeof value.backend !== "string" || !isAppServerBackendKind(value.backend)
      || typeof value.threadId !== "string" || !value.threadId
      || !Array.isArray(value.input)
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
    ) {
      return undefined;
    }
    return value as StoredRestartContinuation;
  } catch {
    return undefined;
  }
}

/**
 * One commit for each quiet restart, one per continuation that starts or is
 * discarded, and one startup claim. Nothing runs on a timer or per turn.
 */
export class RestartContinuationStore {
  constructor(private readonly db: Database.Database, private readonly options: {
    processId?: number;
    processAlive?: (pid: number) => boolean;
  } = {}) {}

  /**
   * Records every continuation of one quiet restart in one commit. A thread
   * that already has a stored continuation keeps it and gets no second one.
   * Returns the continuations written.
   */
  saveAll(
    instanceId: string,
    continuations: readonly StoredRestartContinuation[],
  ): StoredRestartContinuation[] {
    if (continuations.length === 0) return [];
    return this.db.transaction(() => {
      const existing = new Set((this.db.prepare(
        "SELECT payload FROM restart_continuations",
      ).all() as Array<{ payload: string }>).flatMap((row) => {
        try {
          const value = JSON.parse(row.payload) as Partial<StoredRestartContinuation>;
          return typeof value.backend === "string" && typeof value.threadId === "string"
            ? [`${value.backend}:${value.threadId}`] : [];
        } catch {
          return [];
        }
      }));
      const insert = this.db.prepare(
        "INSERT INTO restart_continuations(entry_id, owner_instance_id, owner_pid, created_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO NOTHING",
      );
      const saved: StoredRestartContinuation[] = [];
      for (const continuation of continuations) {
        const thread = `${continuation.backend}:${continuation.threadId}`;
        if (existing.has(thread)) continue;
        existing.add(thread);
        insert.run(
          continuation.id,
          instanceId,
          this.options.processId ?? process.pid,
          continuation.createdAt,
          JSON.stringify(continuation),
        );
        saved.push(continuation);
      }
      return saved;
    }).immediate();
  }

  remove(entryId: string): void {
    this.db.prepare("DELETE FROM restart_continuations WHERE entry_id = ?").run(entryId);
  }

  /**
   * Takes over the rows of instances that have exited, oldest first. Rows of
   * a live sibling instance on the same profile stay with it, so a
   * continuation is never sent twice. A row that no longer parses is dropped.
   */
  claimOrphaned(instanceId: string, liveOwners: () => readonly string[]): StoredRestartContinuation[] {
    const candidates = () => {
      const live = new Set([...liveOwners(), instanceId]);
      const alive = this.options.processAlive ?? storageProcessAlive;
      return (this.db.prepare(
        "SELECT entry_id, owner_instance_id, owner_pid, payload FROM restart_continuations ORDER BY created_at, entry_id",
      ).all() as Row[])
        .filter((row) => !live.has(row.owner_instance_id) && !alive(row.owner_pid));
    };
    if (candidates().length === 0) return [];
    return this.db.transaction(() => {
      const claimed: StoredRestartContinuation[] = [];
      const claim = this.db.prepare(
        "UPDATE restart_continuations SET owner_instance_id = ?, owner_pid = ? WHERE entry_id = ?",
      );
      const drop = this.db.prepare("DELETE FROM restart_continuations WHERE entry_id = ?");
      for (const row of candidates()) {
        const continuation = parseContinuation(row);
        if (!continuation) {
          drop.run(row.entry_id);
          continue;
        }
        claim.run(instanceId, this.options.processId ?? process.pid, row.entry_id);
        claimed.push(continuation);
      }
      return claimed;
    }).immediate();
  }
}
