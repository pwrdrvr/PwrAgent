import type { ResearchStorage } from "@pwragent/owner-core/research-storage";
import { applyResearchItemEvent, normalizeResearchEventRange, normalizeResearchSearch, projectResearchRun, researchItemSearchText, researchSearchHit,
  type ResearchEvent, type ResearchRun, type ResearchThread, type ResearchRunHeader, type ResearchItem, type ResearchSearchQuery, type ResearchSearchPage,
  type ResearchRunSummary, type ResearchEventRange, type ResearchEventPage,
} from "@pwragent/shared/research";
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
CREATE TABLE IF NOT EXISTS research_items (
  run_id TEXT NOT NULL REFERENCES research_runs(run_id),
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  approach_id TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  kind TEXT,
  review_state TEXT,
  work_state TEXT NOT NULL,
  assignee_backend TEXT,
  assignee_thread_id TEXT,
  search_text TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_research_items_order ON research_items(run_id, created_seq DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_type ON research_items(run_id, item_type, approach_id, created_seq DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_work ON research_items(run_id, work_state, created_seq DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_review ON research_items(run_id, kind, review_state, created_seq DESC, item_id);
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
  header(id: string): ResearchRunHeader | undefined {
    const row = this.stateDb.raw.prepare(`SELECT r.status, e.payload,
      (SELECT MAX(seq) FROM research_events WHERE run_id = r.run_id) AS revision,
      (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND item_type = 'approach'
        AND (json_extract(payload, '$.record.state') NOT IN ('ended', 'failed', 'stopped')
          OR json_array_length(json_extract(payload, '$.record.revisionDeliveryIds')) > 0)) AS active_workers
      FROM research_runs r JOIN research_events e ON e.run_id = r.run_id AND e.seq = 1 WHERE r.run_id = ?`).get(id) as { status: ResearchRun["status"]; payload: string; revision: number; active_workers: number } | undefined;
    if (!row) return undefined;
    const event = JSON.parse(row.payload) as ResearchEvent;
    if (event.data.type !== "created") throw new Error("Invalid research header");
    const data = event.data;
    const latestHarness = data.harness ? this.stateDb.raw.prepare(`SELECT payload FROM research_events
      WHERE run_id = ? AND json_extract(payload, '$.data.type') = 'harness' ORDER BY seq DESC LIMIT 1`).get(id) as { payload: string } | undefined : undefined;
    const harnessEvent = latestHarness ? JSON.parse(latestHarness.payload) as ResearchEvent : undefined;
    return { id, revision: row.revision, objective: data.objective, coordinator: data.coordinator, ownerId: data.ownerId, ownerPid: data.ownerPid,
      ownerStartedAt: data.ownerStartedAt, createdAt: event.at, deadlineAt: data.deadlineAt, workspaceMode: data.workspaceMode, status: row.status, workerLimit: data.approaches.length, activeWorkers: row.active_workers,
      harness: harnessEvent?.data.type === "harness" ? harnessEvent.data.state : data.harness };
  }
  isMember(id: string, thread: ResearchThread): boolean {
    return Boolean(this.stateDb.raw.prepare(`SELECT 1 FROM research_runs WHERE run_id = ? AND
      ((coordinator_backend = ? AND coordinator_thread_id = ?) OR EXISTS
        (SELECT 1 FROM research_workers WHERE run_id = ? AND backend = ? AND thread_id = ?))`)
      .get(id, thread.backend, thread.threadId, id, thread.backend, thread.threadId));
  }
  summaries(thread: ResearchThread): ResearchRunHeader[] {
    return this.threadRunIds(thread, 20).map((id) => this.header(id)!).filter(Boolean);
  }
  runSummaries(thread: ResearchThread, limit: number): ResearchRunSummary[] {
    return this.stateDb.raw.transaction(() => this.threadRunIds(thread, limit).flatMap((id) => {
      const header = this.header(id);
      if (!header) return [];
      const { harness: _harness, ...summary } = header;
      const counts = this.stateDb.raw.prepare(`SELECT
        coalesce(sum(review_state = 'unreviewed'), 0) AS unreviewed, coalesce(sum(review_state = 'accepted'), 0) AS accepted
        FROM research_items WHERE run_id = ? AND item_type = 'submission'`).get(id) as { unreviewed: number; accepted: number };
      return [{ ...summary, ...counts }];
    })).deferred();
  }
  events(id: string, range: ResearchEventRange): ResearchEventPage {
    const r = normalizeResearchEventRange(range);
    return this.stateDb.raw.transaction(() => {
      const revision = (this.stateDb.raw.prepare("SELECT MAX(seq) AS revision FROM research_events WHERE run_id = ?").get(id) as { revision: number | null }).revision;
      if (revision === null) throw new Error("Research run not found");
      // One extra row says whether older events remain inside the range.
      const rows = this.stateDb.raw.prepare(`SELECT payload FROM research_events WHERE run_id = @id AND seq > @after
        AND (@before IS NULL OR seq < @before) ORDER BY seq DESC LIMIT @limit`)
        .all({ id, after: r.afterSeq, before: r.beforeSeq ?? null, limit: r.limit + 1 }) as Array<{ payload: string }>;
      const events = rows.slice(0, r.limit).map((row) => JSON.parse(row.payload) as ResearchEvent);
      const oldest = events.at(-1);
      return { runId: id, revision, events, ...(oldest && rows.length > r.limit ? { nextBeforeSeq: oldest.seq } : {}) };
    }).deferred();
  }
  private threadRunIds(thread: ResearchThread, limit: number): string[] {
    const rows = this.stateDb.raw.prepare(`SELECT run_id FROM research_runs
      WHERE (coordinator_backend = ? AND coordinator_thread_id = ?)
        OR run_id IN (SELECT run_id FROM research_workers WHERE backend = ? AND thread_id = ?)
      ORDER BY created_at DESC, run_id DESC LIMIT ?`).all(thread.backend, thread.threadId, thread.backend, thread.threadId, limit) as { run_id: string }[];
    return rows.map((row) => row.run_id);
  }
  members(id: string): ResearchThread[] {
    return this.stateDb.raw.prepare(`SELECT coordinator_backend AS backend, coordinator_thread_id AS threadId FROM research_runs WHERE run_id = ?
      UNION SELECT backend, thread_id AS threadId FROM research_workers WHERE run_id = ?`).all(id, id) as ResearchThread[];
  }
  readItem(id: string, itemId: string): ResearchItem | undefined {
    return readProjectedItem(this.stateDb.raw, id, itemId);
  }
  findCommand(id: string, commandId: string): ResearchEvent | undefined {
    const row = this.stateDb.raw.prepare("SELECT payload FROM research_events WHERE run_id = ? AND command_id = ?").get(id, commandId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ResearchEvent : undefined;
  }
  search(id: string, query: ResearchSearchQuery): ResearchSearchPage {
    return this.stateDb.raw.transaction(() => this.searchSnapshot(id, query)).deferred();
  }
  private searchSnapshot(id: string, query: ResearchSearchQuery): ResearchSearchPage {
    const header = this.header(id);
    if (!header) throw new Error("Research run not found");
    const q = normalizeResearchSearch(query, header.revision);
    const parameters = { runId: id, type: q.type ?? null, approach: q.approachId ?? null, kind: q.kind ?? null,
      review: q.review ?? null, state: q.state ?? null, backend: q.assignee?.backend ?? null,
      thread: q.assignee?.threadId ?? null, text: q.query ?? null, seq: q.cursor?.seq ?? null,
      after: q.cursor?.id ?? null, limit: q.limit + 1 };
    const total = (this.stateDb.raw.prepare(`SELECT count(*) AS n FROM research_items WHERE run_id = @runId
      AND (@type IS NULL OR item_type = @type) AND (@approach IS NULL OR approach_id = @approach)
      AND (@kind IS NULL OR kind = @kind) AND (@review IS NULL OR review_state = @review)
      AND (@state IS NULL OR work_state = @state) AND (@backend IS NULL OR assignee_backend = @backend)
      AND (@thread IS NULL OR assignee_thread_id = @thread) AND (@text IS NULL OR instr(search_text, @text) > 0)`)
      .get(parameters) as { n: number }).n;
    const rows = this.stateDb.raw.prepare(`SELECT payload FROM research_items WHERE run_id = @runId
      AND (@type IS NULL OR item_type = @type) AND (@approach IS NULL OR approach_id = @approach)
      AND (@kind IS NULL OR kind = @kind) AND (@review IS NULL OR review_state = @review)
      AND (@state IS NULL OR work_state = @state) AND (@backend IS NULL OR assignee_backend = @backend)
      AND (@thread IS NULL OR assignee_thread_id = @thread) AND (@text IS NULL OR instr(search_text, @text) > 0)
      AND (@seq IS NULL OR created_seq < @seq OR (created_seq = @seq AND item_id > @after))
      ORDER BY created_seq DESC, item_id LIMIT @limit`).all(parameters) as { payload: string }[];
    const items = rows.slice(0, q.limit).map((r) => JSON.parse(r.payload) as ResearchItem);
    const last = items.at(-1);
    return { runId: id, revision: header.revision, total, items: items.map(researchSearchHit),
      ...(last && rows.length > q.limit ? { nextCursor: { revision: header.revision, seq: last.createdSeq, id: last.id, filters: q.filters } } : {}) };
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
      this.projectEvent(id, event);
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
      this.projectEvent(id, event);
      if (event.data.type === "status") db.prepare("UPDATE research_runs SET status = ? WHERE run_id = ?").run(event.data.status, id);
      if (event.data.type === "worker" && event.data.worker) {
        db.prepare("INSERT OR IGNORE INTO research_workers (run_id, backend, thread_id) VALUES (?, ?, ?)")
          .run(id, event.data.worker.backend, event.data.worker.threadId);
      }
    }).immediate();
  }
  appendBatch(id: string, revision: number, events: ResearchEvent[]): void {
    this.stateDb.raw.transaction(() => {
      for (const event of events) this.append(id, revision++, event);
    }).immediate();
  }
  private insertEvent(id: string, event: ResearchEvent): void {
    this.stateDb.raw.prepare("INSERT INTO research_events (run_id, seq, command_id, payload) VALUES (?, ?, ?, ?)")
      .run(id, event.seq, event.commandId, JSON.stringify(event));
  }
  private projectEvent(id: string, event: ResearchEvent): void {
    for (const item of applyResearchItemEvent((key) => this.readItem(id, key), event)) writeProjectedItem(this.stateDb.raw, id, item);
  }
}

function readProjectedItem(db: StateDb["raw"], runId: string, itemId: string): ResearchItem | undefined {
  const row = db.prepare("SELECT payload FROM research_items WHERE run_id = ? AND item_id = ?").get(runId, itemId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as ResearchItem : undefined;
}

function writeProjectedItem(db: StateDb["raw"], runId: string, item: ResearchItem): void {
  db.prepare(`INSERT INTO research_items (run_id, item_id, item_type, approach_id, created_seq, kind, review_state,
    work_state, assignee_backend, assignee_thread_id, search_text, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, item_id) DO UPDATE SET item_type = excluded.item_type, approach_id = excluded.approach_id,
      kind = excluded.kind, review_state = excluded.review_state, work_state = excluded.work_state,
      assignee_backend = excluded.assignee_backend, assignee_thread_id = excluded.assignee_thread_id,
      search_text = excluded.search_text, payload = excluded.payload`).run(runId, item.id, item.type, item.approachId, item.createdSeq,
    item.type === "finding" ? item.record.kind : null, item.type === "submission" ? item.record.review?.decision ?? "unreviewed" : null,
    item.work.state, item.work.assignee?.backend ?? null, item.work.assignee?.threadId ?? null, researchItemSearchText(item), JSON.stringify(item));
}

/** One additive migration for old journals. Normal reads never repair or write projections. */
export function backfillResearchItems(db: StateDb["raw"]): void {
  const runs = db.prepare("SELECT run_id FROM research_runs r WHERE NOT EXISTS (SELECT 1 FROM research_items i WHERE i.run_id = r.run_id)").all() as { run_id: string }[];
  for (const run of runs) {
    const events = db.prepare("SELECT payload FROM research_events WHERE run_id = ? ORDER BY seq").all(run.run_id) as { payload: string }[];
    const items = new Map<string, ResearchItem>();
    for (const row of events) for (const item of applyResearchItemEvent((key) => items.get(key), JSON.parse(row.payload) as ResearchEvent)) items.set(item.id, item);
    for (const item of items.values()) writeProjectedItem(db, run.run_id, item);
  }
}
