import type Database from "better-sqlite3";
import { buildThreadIdentityKey, isAppServerBackendKind, type AppServerBackendKind, type WorktreeSnapshotSummary } from "@pwragent/shared";
import { storageProcessAlive } from "./storage-maintenance";

export type ArchiveCleanupIntent = {
  backend: AppServerBackendKind;
  threadId: string;
  archivedAt: number;
  codexRolloutMissing: boolean;
  preserveWorktrees?: boolean;
  messagingCleanup: { error?: string };
  /** Managed checkouts still awaiting reference release or a successful retry. */
  deferredWorktrees?: Array<{
    repositoryPath?: string;
    worktreePath: string;
    blockers: string[];
    snapshot?: WorktreeSnapshotSummary;
  }>;
};

/** Single-row form from earlier builds: all of one instance's intents. Still
 * recovered; a save rewrites this instance's row in the per-intent form. */
const PREFIX = "archive_cleanup_checkpoint_v1:";
/** One row per intent, keyed by JSON `[instanceId, identityKey]`. */
const INTENT_PREFIX = "archive_cleanup_checkpoint_v2:";
type Row = { key: string; value: string };

function validateIntent(item: ArchiveCleanupIntent): void {
  if (!item || typeof item !== "object" || typeof item.backend !== "string" || !isAppServerBackendKind(item.backend)
    || typeof item.threadId !== "string" || !item.threadId.trim()
    || typeof item.archivedAt !== "number" || !Number.isFinite(item.archivedAt)
    || typeof item.codexRolloutMissing !== "boolean"
    || (item.preserveWorktrees !== undefined && typeof item.preserveWorktrees !== "boolean")
    || (item.deferredWorktrees !== undefined && (!Array.isArray(item.deferredWorktrees)
      || item.deferredWorktrees.some((worktree: NonNullable<ArchiveCleanupIntent["deferredWorktrees"]>[number]) =>
        !worktree || typeof worktree.worktreePath !== "string" || !worktree.worktreePath.trim()
        || (worktree.repositoryPath !== undefined && typeof worktree.repositoryPath !== "string")
        || !Array.isArray(worktree.blockers) || worktree.blockers.some((key: unknown) => typeof key !== "string" || !key)
        || (worktree.snapshot !== undefined && (!worktree.snapshot || worktree.snapshot.backend !== item.backend
          || worktree.snapshot.threadId !== item.threadId || worktree.snapshot.state !== "archived"
          || ![worktree.snapshot.id, worktree.snapshot.worktreePath, worktree.snapshot.repositoryPath,
            worktree.snapshot.snapshotRef, worktree.snapshot.snapshotCommit].every((value) => typeof value === "string" && value.length > 0))))))
    || !item.messagingCleanup || typeof item.messagingCleanup !== "object"
    || (item.messagingCleanup.error !== undefined && typeof item.messagingCleanup.error !== "string")) {
    throw new Error("Invalid archive cleanup intent.");
  }
}

function validOwnerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseCheckpoint(value: string): { ownerPid: number; intents: ArchiveCleanupIntent[] } {
  const record = JSON.parse(value) as { version?: unknown; ownerPid?: unknown; intents?: unknown };
  if (record?.version !== 1 || !Array.isArray(record.intents) || !validOwnerPid(record.ownerPid)) {
    throw new Error("Invalid archive cleanup checkpoint.");
  }
  for (const item of record.intents) validateIntent(item as ArchiveCleanupIntent);
  return { ownerPid: record.ownerPid, intents: record.intents as ArchiveCleanupIntent[] };
}

function parseIntentRow(value: string): { ownerPid: number; intent: ArchiveCleanupIntent } {
  const record = JSON.parse(value) as { version?: unknown; ownerPid?: unknown; intent?: unknown };
  if (record?.version !== 2 || !validOwnerPid(record.ownerPid)) throw new Error("Invalid archive cleanup checkpoint.");
  validateIntent(record.intent as ArchiveCleanupIntent);
  return { ownerPid: record.ownerPid, intent: record.intent as ArchiveCleanupIntent };
}

function intentKey(instanceId: string, intent: ArchiveCleanupIntent): string {
  return INTENT_PREFIX + JSON.stringify([instanceId, buildThreadIdentityKey(intent.backend, intent.threadId)]);
}

function instancePrefix(instanceId: string): string {
  // The JSON array's opening, through the instance id and its comma.
  return INTENT_PREFIX + JSON.stringify([instanceId, ""]).slice(0, -3);
}

/** Boundary checkpoints only: one transaction at quit and one recovery claim.
 * Live profile instances retain their own work; no per-job or heartbeat writes.
 * Each save writes only the intents that changed since this store's last save,
 * so a long sequence of reference releases costs bytes in proportion to what
 * it changed rather than rewriting the whole backlog each time. */
export class ArchiveCleanupCheckpointStore {
  /** Instance id -> intent row key -> value this store last wrote. */
  private readonly written = new Map<string, Map<string, string>>();

  constructor(private readonly db: Database.Database, private readonly options: {
    processId?: number;
    processAlive?: (pid: number) => boolean;
  } = {}) {}

  private rangeRows(prefix: string): Row[] {
    return this.db.prepare("SELECT key,value FROM meta WHERE key >= ? AND key < ?").all(prefix, prefix + "\uffff") as Row[];
  }

  save(instanceId: string, intents: ArchiveCleanupIntent[]): void {
    const legacyKey = PREFIX + instanceId;
    const legacy = this.db.prepare("SELECT 1 FROM meta WHERE key = ?").get(legacyKey) !== undefined;
    let written = this.written.get(instanceId);
    if (!written) {
      written = new Map(this.rangeRows(instancePrefix(instanceId)).map((row) => [row.key, row.value]));
      this.written.set(instanceId, written);
    }
    const ownerPid = this.options.processId ?? process.pid;
    const next = new Map(intents.map((intent) => [intentKey(instanceId, intent), JSON.stringify({ version: 2, ownerPid, intent })]));
    const deletes = [...written.keys()].filter((key) => !next.has(key));
    const upserts = [...next].filter(([key, value]) => written!.get(key) !== value);
    if (!legacy && !deletes.length && !upserts.length) return;
    this.db.transaction(() => {
      const remove = this.db.prepare("DELETE FROM meta WHERE key = ?");
      if (legacy) remove.run(legacyKey);
      for (const key of deletes) remove.run(key);
      const upsert = this.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      for (const [key, value] of upserts) upsert.run(key, value);
    })();
    for (const key of deletes) written.delete(key);
    for (const [key, value] of upserts) written.set(key, value);
  }

  recover(instanceId: string, liveOwners: () => readonly string[]): ArchiveCleanupIntent[] {
    const candidates = () => {
      const live = new Set([...liveOwners(), instanceId]);
      const alive = this.options.processAlive ?? storageProcessAlive;
      const rows: Array<Row & { instance: string; ownerPid: number; intents: ArchiveCleanupIntent[] }> = [];
      const legacy = this.db.prepare("SELECT key,value FROM meta WHERE key GLOB 'archive_cleanup_checkpoint_v1:*'").all() as Row[];
      for (const row of legacy) {
        const instance = row.key.slice(PREFIX.length);
        if (live.has(instance)) continue;
        const checkpoint = parseCheckpoint(row.value);
        rows.push({ ...row, instance, ownerPid: checkpoint.ownerPid, intents: checkpoint.intents });
      }
      for (const row of this.rangeRows(INTENT_PREFIX)) {
        const [instance] = JSON.parse(row.key.slice(INTENT_PREFIX.length)) as [string, string];
        if (typeof instance !== "string" || live.has(instance)) continue;
        const parsed = parseIntentRow(row.value);
        rows.push({ ...row, instance, ownerPid: parsed.ownerPid, intents: [parsed.intent] });
      }
      // A missing/expired marker is not permission to race a process that
      // may still be draining a physical snapshot during shutdown.
      return rows.filter((row) => !alive(row.ownerPid));
    };
    if (candidates().length === 0) return [];
    return this.db.transaction(() => {
      const rows = candidates();
      // Rows come back in key order; replay the oldest archive first.
      const intents = rows.flatMap((row) => row.intents)
        .map((intent, order) => ({ intent, order }))
        .sort((left, right) => left.intent.archivedAt - right.intent.archivedAt || left.order - right.order)
        .map(({ intent }) => intent);
      // Claim before dispatch. A crash during replay retains the claim for a
      // later process; live-owner checks prevent a sibling from replaying it.
      if (intents.length > 0) this.save(instanceId, intents);
      const remove = this.db.prepare("DELETE FROM meta WHERE key = ?");
      for (const row of rows) {
        remove.run(row.key);
        this.written.delete(row.instance);
      }
      return intents;
    }).immediate();
  }
}
