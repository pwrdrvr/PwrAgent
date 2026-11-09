import type Database from "better-sqlite3";
import {
  isAppServerBackendKind,
  type AppServerBackendKind,
  type AppServerThreadMessageOrigin,
  type AppServerTurnInputItem,
  type ProjectHeldWakeupSource,
} from "@pwragent/shared";
import { storageProcessAlive } from "./storage-maintenance";

/**
 * Wake-ups a paused project holds: a finished monitor or a Continue After
 * dependency. Their sources are consumed when they are held, so this row is
 * the only copy that outlives the process. It lives from the hold until the
 * entry leaves the queue (started, failed, or discarded).
 */
export { PROJECT_HELD_WAKEUP_SCHEMA } from "@pwragent/sqlite-storage/state-schema";

export type StoredProjectHeldWakeup = {
  id: string;
  backend: AppServerBackendKind;
  threadId: string;
  origin: string;
  messageOrigin?: AppServerThreadMessageOrigin;
  input: AppServerTurnInputItem[];
  createdAt: number;
  holdReason: string;
  projectHold: {
    directoryKey: string;
    source: ProjectHeldWakeupSource;
    summary: string;
  };
};

type Row = {
  entry_id: string;
  owner_instance_id: string;
  owner_pid: number;
  payload: string;
};

const SOURCES: readonly string[] = ["monitor", "dependency", "other"] satisfies ProjectHeldWakeupSource[];

function parseWakeup(row: Row): StoredProjectHeldWakeup | undefined {
  try {
    const value = JSON.parse(row.payload) as Partial<StoredProjectHeldWakeup>;
    const hold = value.projectHold;
    if (
      value.id !== row.entry_id
      || typeof value.backend !== "string" || !isAppServerBackendKind(value.backend)
      || typeof value.threadId !== "string" || !value.threadId
      || typeof value.origin !== "string"
      || !Array.isArray(value.input)
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
      || typeof value.holdReason !== "string"
      || !hold || typeof hold.directoryKey !== "string" || typeof hold.summary !== "string"
      || typeof hold.source !== "string" || !SOURCES.includes(hold.source)
    ) {
      return undefined;
    }
    return value as StoredProjectHeldWakeup;
  } catch {
    return undefined;
  }
}

/**
 * One commit per hold, one per edit, one per release, and one startup claim
 * when an exited instance left rows behind. Nothing runs on a timer or per
 * turn.
 */
export class ProjectHeldWakeupStore {
  constructor(private readonly db: Database.Database, private readonly options: {
    processId?: number;
    processAlive?: (pid: number) => boolean;
  } = {}) {}

  /** Records a new hold. A row already stored under this id is kept. */
  save(instanceId: string, wakeup: StoredProjectHeldWakeup): void {
    this.db.prepare(
      "INSERT INTO project_held_wakeups(entry_id, owner_instance_id, owner_pid, directory_key, created_at, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO NOTHING",
    ).run(
      wakeup.id,
      instanceId,
      this.options.processId ?? process.pid,
      wakeup.projectHold.directoryKey,
      wakeup.createdAt,
      JSON.stringify(wakeup),
    );
  }

  /** Rewrites a held wake-up the operator edited. */
  update(wakeup: StoredProjectHeldWakeup): void {
    this.db.prepare("UPDATE project_held_wakeups SET payload = ? WHERE entry_id = ?")
      .run(JSON.stringify(wakeup), wakeup.id);
  }

  remove(entryId: string): void {
    this.db.prepare("DELETE FROM project_held_wakeups WHERE entry_id = ?").run(entryId);
  }

  /**
   * Takes over the rows of instances that have exited, oldest first. Rows of
   * a live sibling instance on the same profile stay with it, so a wake-up
   * is never held, and sent, twice. A row that no longer parses is dropped.
   */
  claimOrphaned(instanceId: string, liveOwners: () => readonly string[]): StoredProjectHeldWakeup[] {
    const candidates = () => {
      const live = new Set([...liveOwners(), instanceId]);
      const alive = this.options.processAlive ?? storageProcessAlive;
      return (this.db.prepare(
        "SELECT entry_id, owner_instance_id, owner_pid, payload FROM project_held_wakeups ORDER BY created_at, entry_id",
      ).all() as Row[])
        // A missing marker alone is not enough: the owner may still be
        // shutting down and able to send what it holds.
        .filter((row) => !live.has(row.owner_instance_id) && !alive(row.owner_pid));
    };
    if (candidates().length === 0) return [];
    return this.db.transaction(() => {
      const claimed: StoredProjectHeldWakeup[] = [];
      const claim = this.db.prepare(
        "UPDATE project_held_wakeups SET owner_instance_id = ?, owner_pid = ? WHERE entry_id = ?",
      );
      const drop = this.db.prepare("DELETE FROM project_held_wakeups WHERE entry_id = ?");
      for (const row of candidates()) {
        const wakeup = parseWakeup(row);
        if (!wakeup) {
          drop.run(row.entry_id);
          continue;
        }
        claim.run(instanceId, this.options.processId ?? process.pid, row.entry_id);
        claimed.push(wakeup);
      }
      return claimed;
    }).immediate();
  }
}
