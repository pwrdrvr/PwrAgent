import type { ResearchStorage } from "@pwragent/owner-core/research-storage";
import { projectResearchRun, type ResearchEvent, type ResearchRun, type ResearchThread } from "@pwragent/shared/research";
import type { StateDb } from "./state-db";

export const RESEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_runs (
  run_id TEXT PRIMARY KEY,
  start_key TEXT NOT NULL UNIQUE,
  coordinator_backend TEXT NOT NULL,
  coordinator_thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS idx_research_runs_coordinator
  ON research_runs(coordinator_backend, coordinator_thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_active
  ON research_runs(status) WHERE status IN ('running', 'stopping');
CREATE TABLE IF NOT EXISTS research_events (
  run_id TEXT NOT NULL REFERENCES research_runs(run_id),
  seq INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, command_id)
);
CREATE TABLE IF NOT EXISTS research_workers (
  run_id TEXT NOT NULL REFERENCES research_runs(run_id),
  backend TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (run_id, backend, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_research_workers_thread
  ON research_workers(backend, thread_id);
`;

/** One commit per structured operation; no streamed tokens, polling writes, or copied transcripts. */
export class ResearchStore implements ResearchStorage {
  constructor(private readonly stateDb: StateDb) {}

  findByStartKey(key: string): ResearchRun | undefined {
    const row = this.stateDb.raw.prepare("SELECT run_id FROM research_runs WHERE start_key = ?").get(key) as { run_id: string } | undefined;
    return row ? this.get(row.run_id) : undefined;
  }
  get(id: string): ResearchRun | undefined {
    const rows = this.stateDb.raw.prepare("SELECT payload FROM research_events WHERE run_id = ? ORDER BY seq").all(id) as Array<{ payload: string }>;
    return rows.length ? projectResearchRun(id, rows.map((r) => JSON.parse(r.payload) as ResearchEvent)) : undefined;
  }
  list(thread?: ResearchThread): ResearchRun[] {
    const db = this.stateDb.raw;
    const rows = thread
      ? db.prepare(`SELECT run_id FROM research_runs
          WHERE (coordinator_backend = ? AND coordinator_thread_id = ?)
            OR run_id IN (SELECT run_id FROM research_workers WHERE backend = ? AND thread_id = ?)
          ORDER BY created_at DESC, run_id DESC LIMIT 50`).all(thread.backend, thread.threadId, thread.backend, thread.threadId)
      : db.prepare("SELECT run_id FROM research_runs WHERE status IN ('running', 'stopping') ORDER BY created_at DESC, run_id DESC").all();
    return (rows as Array<{ run_id: string }>).map((r) => this.get(r.run_id)!).filter(Boolean);
  }
  create(id: string, startKey: string, event: ResearchEvent): void {
    if (event.data.type !== "created" || event.seq !== 1) throw new Error("Invalid research creation event");
    const data = event.data;
    this.stateDb.raw.transaction(() => {
      this.stateDb.raw.prepare(`INSERT INTO research_runs
        (run_id, start_key, coordinator_backend, coordinator_thread_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        id, startKey, data.coordinator.backend, data.coordinator.threadId, event.at,
      );
      this.insertEvent(id, event);
    }).immediate();
  }
  append(id: string, revision: number, event: ResearchEvent): void {
    const db = this.stateDb.raw;
    db.transaction(() => {
      const duplicate = db.prepare("SELECT payload FROM research_events WHERE run_id = ? AND command_id = ?").get(id, event.commandId) as { payload: string } | undefined;
      if (duplicate) {
        const previous = JSON.parse(duplicate.payload) as ResearchEvent;
        if (previous.signature !== event.signature || JSON.stringify(previous.actor) !== JSON.stringify(event.actor)) throw new Error("Research command key was reused");
        return;
      }
      const row = db.prepare("SELECT MAX(seq) AS revision FROM research_events WHERE run_id = ?").get(id) as { revision: number | null };
      if (row.revision !== revision || event.seq !== revision + 1) throw new Error("Research run changed; read its current state before retrying");
      this.insertEvent(id, event);
      if (event.data.type === "status") db.prepare("UPDATE research_runs SET status = ? WHERE run_id = ?").run(event.data.status, id);
      if (event.data.type === "worker" && event.data.worker) {
        db.prepare("INSERT OR IGNORE INTO research_workers (run_id, backend, thread_id) VALUES (?, ?, ?)")
          .run(id, event.data.worker.backend, event.data.worker.threadId);
      }
    }).immediate();
  }
  private insertEvent(id: string, event: ResearchEvent): void {
    this.stateDb.raw.prepare("INSERT INTO research_events (run_id, seq, command_id, payload) VALUES (?, ?, ?, ?)")
      .run(id, event.seq, event.commandId, JSON.stringify(event));
  }
}
