import type Database from "better-sqlite3";
import {
  isAppServerBackendKind,
  type AppServerBackendKind,
  type AppServerThreadMessageOrigin,
  type AppServerTurnInputItem,
} from "@pwragent/shared";
import type { ThreadTurnQueueEntry } from "@pwragent/owner-core/thread-turn-queue";
import { storageProcessAlive } from "./storage-maintenance";

/**
 * What a quiet restart carries to the next launch: a continuation for each
 * turn it stopped, and each message that was waiting in a thread's queue.
 * A row is written before the quit interrupts anything and deleted when its
 * entry starts or is discarded, so a second restart before then brings it
 * back again rather than losing it.
 */
export { RESTART_CONTINUATION_SCHEMA } from "@pwragent/sqlite-storage/state-schema";

/** Queue settings a saved queued message keeps across the restart. */
export type StoredRestartQueuedFields = Partial<Pick<ThreadTurnQueueEntry,
  | "origin" | "delivery" | "agentMessages" | "agentMessageOrigins" | "executionMode"
  | "approvalPolicy" | "sandbox" | "model" | "collaborationMode" | "serviceTier"
  | "reasoningEffort" | "fastMode" | "automationRunId" | "automationName" | "title"
>> & {
  /** Paused, or held for the operator: it comes back paused, never sent. */
  paused?: true;
  /**
   * Its place among the queued messages saved together. Restore follows
   * it, so messages queued in the same millisecond, or reordered by the
   * operator, come back in the order they waited.
   */
  position?: number;
};

export type StoredRestartContinuation = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  messageOrigin?: AppServerThreadMessageOrigin;
  input: AppServerTurnInputItem[];
  createdAt: number;
  /** Absent: the thread's continuation. `queued`: a message from its queue. */
  kind?: "queued";
  queued?: StoredRestartQueuedFields;
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
      || (value.kind !== undefined && value.kind !== "queued")
      || (value.queued !== undefined && (typeof value.queued !== "object" || value.queued === null))
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
   * Records what one quiet restart carries, in one commit. A thread that
   * already has a stored continuation keeps it and gets no second one. A
   * queued message replaces its earlier copy when it changed, so the latest
   * edit wins and an unchanged one costs no write.
   * Returns the continuations written.
   */
  saveAll(
    instanceId: string,
    continuations: readonly StoredRestartContinuation[],
  ): StoredRestartContinuation[] {
    if (continuations.length === 0) return [];
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT entry_id, payload FROM restart_continuations",
      ).all() as Array<{ entry_id: string; payload: string }>;
      const payloads = new Map(rows.map((row) => [row.entry_id, row.payload]));
      const existing = new Set(rows.flatMap((row) => {
        try {
          const value = JSON.parse(row.payload) as Partial<StoredRestartContinuation>;
          return value.kind === undefined
            && typeof value.backend === "string" && typeof value.threadId === "string"
            ? [`${value.backend}:${value.threadId}`] : [];
        } catch {
          return [];
        }
      }));
      const insert = this.db.prepare(
        "INSERT INTO restart_continuations(entry_id, owner_instance_id, owner_pid, created_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO NOTHING",
      );
      const upsert = this.db.prepare(
        "INSERT INTO restart_continuations(entry_id, owner_instance_id, owner_pid, created_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET payload = excluded.payload",
      );
      const saved: StoredRestartContinuation[] = [];
      for (const continuation of continuations) {
        if (continuation.kind === "queued") {
          const payload = JSON.stringify(continuation);
          // A message saved unchanged by an earlier pass costs no write.
          if (payloads.get(continuation.id) === payload) continue;
          upsert.run(
            continuation.id,
            instanceId,
            this.options.processId ?? process.pid,
            continuation.createdAt,
            payload,
          );
          continue;
        }
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
