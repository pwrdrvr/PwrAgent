import type Database from "better-sqlite3";
import { isAppServerBackendKind, type AppServerBackendKind } from "@pwragent/shared";
import { storageProcessAlive } from "./storage-maintenance";

export type ArchiveCleanupIntent = {
  backend: AppServerBackendKind;
  threadId: string;
  archivedAt: number;
  codexRolloutMissing: boolean;
  preserveWorktrees?: boolean;
  messagingCleanup: { error?: string };
};

const PREFIX = "archive_cleanup_checkpoint_v1:";

function parseCheckpoint(value: string): { ownerPid: number; intents: ArchiveCleanupIntent[] } {
  const record = JSON.parse(value) as { version?: unknown; ownerPid?: unknown; intents?: unknown };
  if (record?.version !== 1 || !Array.isArray(record.intents)
    || typeof record.ownerPid !== "number" || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0) {
    throw new Error("Invalid archive cleanup checkpoint.");
  }
  for (const item of record.intents) {
    if (!item || typeof item !== "object" || typeof item.backend !== "string" || !isAppServerBackendKind(item.backend)
      || typeof item.threadId !== "string" || !item.threadId.trim()
      || typeof item.archivedAt !== "number" || !Number.isFinite(item.archivedAt)
      || typeof item.codexRolloutMissing !== "boolean"
      || (item.preserveWorktrees !== undefined && typeof item.preserveWorktrees !== "boolean")
      || !item.messagingCleanup || typeof item.messagingCleanup !== "object"
      || (item.messagingCleanup.error !== undefined && typeof item.messagingCleanup.error !== "string")) {
      throw new Error("Invalid archive cleanup intent.");
    }
  }
  return { ownerPid: record.ownerPid, intents: record.intents as ArchiveCleanupIntent[] };
}

/** Boundary checkpoints only: one transaction at quit and one recovery claim.
 * Live profile instances retain their own work; no per-job or heartbeat writes. */
export class ArchiveCleanupCheckpointStore {
  constructor(private readonly db: Database.Database, private readonly options: {
    processId?: number;
    processAlive?: (pid: number) => boolean;
  } = {}) {}

  save(instanceId: string, intents: ArchiveCleanupIntent[]): void {
    const key = PREFIX + instanceId;
    const current = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    if (intents.length === 0) {
      if (current) {
        this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
      }
      return;
    }
    const value = JSON.stringify({ version: 1, ownerPid: this.options.processId ?? process.pid, intents });
    if (current?.value === value) return;
    this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  recover(instanceId: string, liveOwners: () => readonly string[]): ArchiveCleanupIntent[] {
    const read = () => this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'archive_cleanup_checkpoint_v1:*'")
      .all() as { key: string; value: string }[];
    const candidates = () => {
      const live = new Set([...liveOwners(), instanceId]);
      return read().filter((row) => !live.has(row.key.slice(PREFIX.length)))
        .map((row) => ({ ...row, checkpoint: parseCheckpoint(row.value) }))
        // A missing/expired marker is not permission to race a process that
        // may still be draining a physical snapshot during shutdown.
        .filter((row) => !(this.options.processAlive ?? storageProcessAlive)(row.checkpoint.ownerPid));
    };
    if (candidates().length === 0) return [];
    return this.db.transaction(() => {
      const rows = candidates();
      const intents = rows.flatMap((row) => row.checkpoint.intents);
      // Claim before dispatch. A crash during replay retains the claim for a
      // later process; live-owner checks prevent a sibling from replaying it.
      if (intents.length > 0) this.save(instanceId, intents);
      for (const row of rows) this.db.prepare("DELETE FROM meta WHERE key = ?").run(row.key);
      return intents;
    }).immediate();
  }
}
