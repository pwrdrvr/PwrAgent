import type Database from "better-sqlite3";

/**
 * Sandboxes a thread created through PwrAgent's Sandboxer connection, so
 * PwrAgent can release exactly those once the thread's PRs merge or close.
 *
 * A row is written when the gateway observes a successful `create_sandbox`
 * result, and again for each cleanup outcome: one commit per sandbox per
 * event, never per poll. `backend` is null for rows observed through a
 * thread's native MCP bridge, whose grant carries only the thread id.
 *
 * Status:
 * - `active`: created and not yet released.
 * - `stopped`: PwrAgent stopped it because the connection had no delete
 *   tool. Deletion is still pending; a later cleanup deletes it once the
 *   connection lists one.
 * - `deleted`: deleted, or the connection reported it no longer exists.
 */
export const THREAD_SANDBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_sandboxes (
  connection_id TEXT NOT NULL,
  sandbox_id    TEXT NOT NULL,
  backend       TEXT,
  thread_id     TEXT NOT NULL,
  name          TEXT,
  status        TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (connection_id, sandbox_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_sandboxes_pending
  ON thread_sandboxes(thread_id) WHERE status IN ('active', 'stopped');
`;

export type ThreadSandboxStatus = "active" | "stopped" | "deleted";

export type ThreadSandboxRecord = {
  connectionId: string;
  sandboxId: string;
  backend?: string;
  threadId: string;
  name?: string;
  status: ThreadSandboxStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  connection_id: string;
  sandbox_id: string;
  backend: string | null;
  thread_id: string;
  name: string | null;
  status: string;
  note: string | null;
  created_at: number;
  updated_at: number;
};

function decode(row: Row): ThreadSandboxRecord {
  return {
    connectionId: row.connection_id,
    sandboxId: row.sandbox_id,
    ...(row.backend ? { backend: row.backend } : {}),
    threadId: row.thread_id,
    ...(row.name ? { name: row.name } : {}),
    status: row.status === "stopped" || row.status === "deleted"
      ? row.status
      : "active",
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ThreadSandboxStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record a created sandbox. The first thread to create an id owns it: a
   * repeated observation never moves a sandbox to another thread.
   */
  recordCreated(params: {
    connectionId: string;
    sandboxId: string;
    backend?: string;
    threadId: string;
    name?: string;
    now: number;
  }): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO thread_sandboxes(
         connection_id, sandbox_id, backend, thread_id, name, status, note,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).run(
      params.connectionId,
      params.sandboxId,
      params.backend ?? null,
      params.threadId,
      params.name ?? null,
      params.now,
      params.now,
    );
    return result.changes > 0;
  }

  /** Sandboxes this thread still holds (active, or stopped awaiting deletion). */
  pendingForThread(params: {
    backend: string;
    threadId: string;
  }): ThreadSandboxRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM thread_sandboxes
       WHERE thread_id = ? AND (backend IS NULL OR backend = ?)
         AND status IN ('active', 'stopped')
       ORDER BY created_at ASC, sandbox_id ASC`,
    ).all(params.threadId, params.backend) as Row[];
    return rows.map(decode);
  }

  /** Thread ids that still hold a sandbox, for the startup sweep. */
  threadIdsWithPending(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT thread_id FROM thread_sandboxes
       WHERE status IN ('active', 'stopped')`,
    ).all() as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  /** Changes only a row still pending, so a stale outcome cannot revive one. */
  markOutcome(params: {
    connectionId: string;
    sandboxId: string;
    status: "stopped" | "deleted";
    note?: string;
    now: number;
  }): void {
    this.db.prepare(
      `UPDATE thread_sandboxes
       SET status = ?, note = ?, updated_at = ?
       WHERE connection_id = ? AND sandbox_id = ?
         AND status IN ('active', 'stopped')`,
    ).run(
      params.status,
      params.note ?? null,
      params.now,
      params.connectionId,
      params.sandboxId,
    );
  }

  all(): ThreadSandboxRecord[] {
    return (this.db.prepare(
      "SELECT * FROM thread_sandboxes ORDER BY created_at ASC, sandbox_id ASC",
    ).all() as Row[]).map(decode);
  }
}
