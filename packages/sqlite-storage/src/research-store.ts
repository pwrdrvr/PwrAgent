import type { ResearchStorage } from "@pwragent/owner-core/research-storage";
import { applyResearchItemEvent, normalizeResearchChangesCursor, normalizeResearchEventRange, normalizeResearchSearch, projectResearchRun, researchApproachOccupiesSlot,
  researchItemSearchText, researchSearchHit, RESEARCH_BOARD_DELIVERIES, RESEARCH_BOARD_FAILURES, RESEARCH_BOARD_PAGE, RESEARCH_CHANGES_PAGE, RESEARCH_MAP_LEAVES,
  type ResearchEvent, type ResearchRun, type ResearchThread, type ResearchRunHeader, type ResearchItem, type ResearchSearchQuery, type ResearchSearchPage,
  type ResearchRunSummary, type ResearchEventRange, type ResearchEventPage, type ResearchApproach, type ResearchDelivery, type ResearchSubmission,
  type ResearchBoardRange, type ResearchBoardPage, type ResearchChangesCursor, type ResearchChangePage, type ResearchRunState, type ResearchApproachLeaves,
  type ResearchFinding,
} from "@pwragent/shared/research";
import type { StateDb } from "./state-db";

export const RESEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_runs (
  run_id TEXT PRIMARY KEY,
  start_key TEXT NOT NULL UNIQUE,
  coordinator_backend TEXT NOT NULL,
  coordinator_thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  reason TEXT
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
  version INTEGER,
  occupies_slot INTEGER NOT NULL DEFAULT 0,
  worker_backend TEXT,
  worker_thread_id TEXT,
  PRIMARY KEY (run_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_research_items_order ON research_items(run_id, created_seq DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_type ON research_items(run_id, item_type, approach_id, created_seq DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_work ON research_items(run_id, work_state, created_seq DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_review ON research_items(run_id, kind, review_state, created_seq DESC, item_id);
`;

/**
 * Projections added after the first release of research. A database that
 * predates them gains the columns here, so their indexes are created after.
 * `version` is the seq of the item's last change: a delta read walks it.
 * `occupies_slot` and the worker columns are set on approaches only.
 * A delivery row holds the latest receipt for one revision delivery. The
 * table is its own primary-key tree, and one index orders both the open and
 * the settled deliveries of a run, so a receipt writes two trees, or three
 * when it names a queue entry.
 */
const RESEARCH_PROJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_deliveries (
  run_id TEXT NOT NULL REFERENCES research_runs(run_id),
  delivery_id TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  queue_entry_id TEXT,
  open INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, delivery_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_research_deliveries_state ON research_deliveries(run_id, open, created_seq);
CREATE INDEX IF NOT EXISTS idx_research_deliveries_queue ON research_deliveries(run_id, queue_entry_id) WHERE queue_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_items_version ON research_items(run_id, version, item_id);
CREATE INDEX IF NOT EXISTS idx_research_items_slot ON research_items(run_id, created_seq, item_id) WHERE occupies_slot = 1;
CREATE INDEX IF NOT EXISTS idx_research_items_worker ON research_items(worker_backend, worker_thread_id, run_id) WHERE worker_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_events_delivery_failed ON research_events(run_id, seq)
  WHERE json_extract(payload, '$.data.type') = 'delivery_failed';
`;

/** What every header read selects: the creation event, and the columns and counts that change after it. */
const HEADER_COLUMNS = `r.run_id, r.status, r.reason, e.payload,
  (SELECT MAX(seq) FROM research_events WHERE run_id = r.run_id) AS revision,
  (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND occupies_slot = 1) AS active_workers`;
/** A summary adds the review counts. Each is an index range, not a scan of item payloads. */
const SUMMARY_COLUMNS = HEADER_COLUMNS + `,
  (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND kind IS NULL AND review_state = 'unreviewed') AS unreviewed,
  (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND kind IS NULL AND review_state = 'accepted') AS accepted`;
const HEADER_FROM = "FROM research_runs r JOIN research_events e ON e.run_id = r.run_id AND e.seq = 1";
const SELECT_HEADERS = "SELECT " + HEADER_COLUMNS + " " + HEADER_FROM;
const SELECT_SUMMARIES = "SELECT " + SUMMARY_COLUMNS + " " + HEADER_FROM;

type HeaderRow = { run_id: string; status: ResearchRun["status"]; reason: string | null; payload: string; revision: number; active_workers: number };
type SummaryRow = HeaderRow & { unreviewed: number; accepted: number };
type Decision = NonNullable<ResearchSubmission["review"]>["decision"];

/** One commit per structured operation; no streamed tokens, polling writes, or copied transcripts. */
export class ResearchStore implements ResearchStorage {
  constructor(private readonly stateDb: StateDb) {}

  runIdForStartKey(key: string): string | undefined {
    const row = this.stateDb.raw.prepare("SELECT run_id FROM research_runs WHERE start_key = ?").get(key) as { run_id: string } | undefined;
    return row?.run_id;
  }
  get(id: string): ResearchRun | undefined {
    const rows = this.stateDb.raw.prepare("SELECT payload FROM research_events WHERE run_id = ? ORDER BY seq").all(id) as Array<{ payload: string }>;
    return rows.length ? projectResearchRun(id, rows.map((r) => JSON.parse(r.payload) as ResearchEvent)) : undefined;
  }
  header(id: string): ResearchRunHeader | undefined {
    const row = this.stateDb.raw.prepare(SELECT_HEADERS + " WHERE r.run_id = ?").get(id) as HeaderRow | undefined;
    return row ? headerFromRow(row) : undefined;
  }
  activeRuns(thread?: ResearchThread): ResearchRunHeader[] {
    const db = this.stateDb.raw;
    const rows = thread
      ? db.prepare(SELECT_HEADERS + ` WHERE r.status IN ('running', 'stopping') AND ((r.coordinator_backend = ? AND r.coordinator_thread_id = ?)
            OR r.run_id IN (SELECT run_id FROM research_workers WHERE backend = ? AND thread_id = ?))
          ORDER BY r.created_at DESC, r.run_id DESC`).all(thread.backend, thread.threadId, thread.backend, thread.threadId)
      : db.prepare(SELECT_HEADERS + " WHERE r.status IN ('running', 'stopping') ORDER BY r.created_at DESC, r.run_id DESC").all();
    return (rows as HeaderRow[]).map(headerFromRow);
  }
  isMember(id: string, thread: ResearchThread): boolean {
    return Boolean(this.stateDb.raw.prepare(`SELECT 1 FROM research_runs WHERE run_id = ? AND
      ((coordinator_backend = ? AND coordinator_thread_id = ?) OR EXISTS
        (SELECT 1 FROM research_workers WHERE run_id = ? AND backend = ? AND thread_id = ?))`)
      .get(id, thread.backend, thread.threadId, id, thread.backend, thread.threadId));
  }
  isApproachWorker(id: string, thread: ResearchThread): boolean {
    return Boolean(this.stateDb.raw.prepare("SELECT 1 FROM research_items WHERE worker_backend = ? AND worker_thread_id = ? AND run_id = ? LIMIT 1")
      .get(thread.backend, thread.threadId, id));
  }
  isActiveWorker(thread: ResearchThread): boolean {
    return Boolean(this.stateDb.raw.prepare(`SELECT 1 FROM research_items i JOIN research_runs r ON r.run_id = i.run_id
      WHERE i.worker_backend = ? AND i.worker_thread_id = ? AND r.status IN ('running', 'stopping') LIMIT 1`).get(thread.backend, thread.threadId));
  }
  summaries(thread: ResearchThread): ResearchRunHeader[] {
    return this.runSummaries(thread, 20).map(({ unreviewed: _unreviewed, accepted: _accepted, ...header }) => header);
  }
  /** One statement for the whole list. */
  runSummaries(thread: ResearchThread, limit: number, runId?: string): ResearchRunSummary[] {
    const db = this.stateDb.raw;
    const rows = runId === undefined
      ? db.prepare(SELECT_SUMMARIES + ` WHERE (r.coordinator_backend = ? AND r.coordinator_thread_id = ?)
            OR r.run_id IN (SELECT run_id FROM research_workers WHERE backend = ? AND thread_id = ?)
          ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?`).all(thread.backend, thread.threadId, thread.backend, thread.threadId, limit)
      : db.prepare(SELECT_SUMMARIES + ` WHERE r.run_id = ? AND ((r.coordinator_backend = ? AND r.coordinator_thread_id = ?) OR EXISTS
            (SELECT 1 FROM research_workers WHERE run_id = r.run_id AND backend = ? AND thread_id = ?))
          LIMIT ?`).all(runId, thread.backend, thread.threadId, thread.backend, thread.threadId, limit);
    return (rows as SummaryRow[]).map((row) => ({ ...headerFromRow(row), unreviewed: row.unreviewed, accepted: row.accepted }));
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
  members(id: string): ResearchThread[] {
    return this.stateDb.raw.prepare(`SELECT coordinator_backend AS backend, coordinator_thread_id AS threadId FROM research_runs WHERE run_id = ?
      UNION SELECT backend, thread_id AS threadId FROM research_workers WHERE run_id = ?`).all(id, id) as ResearchThread[];
  }
  readItem(id: string, itemId: string): ResearchItem | undefined {
    return readProjectedItem(this.stateDb.raw, id, itemId);
  }
  approaches(id: string, filter: { worker: ResearchThread } | { occupying: true }): ResearchApproach[] {
    const db = this.stateDb.raw;
    const rows = "worker" in filter
      ? db.prepare(`SELECT payload FROM research_items WHERE worker_backend = ? AND worker_thread_id = ? AND run_id = ?
          ORDER BY created_seq, item_id`).all(filter.worker.backend, filter.worker.threadId, id)
      : db.prepare("SELECT payload FROM research_items WHERE run_id = ? AND occupies_slot = 1 ORDER BY created_seq, item_id").all(id);
    return (rows as { payload: string }[]).flatMap((row) => {
      const item = JSON.parse(row.payload) as ResearchItem;
      return item.type === "approach" ? [item.record] : [];
    });
  }
  underwayItems(id: string): ResearchItem[] {
    const rows = this.stateDb.raw.prepare(`SELECT payload FROM research_items WHERE run_id = ?
      AND work_state IN ('assigned', 'claimed', 'in_progress', 'blocked') ORDER BY created_seq, item_id`).all(id) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as ResearchItem);
  }
  hasSubmission(id: string, decision?: Decision): boolean {
    const db = this.stateDb.raw;
    return Boolean(decision === undefined
      ? db.prepare("SELECT 1 FROM research_items WHERE run_id = ? AND item_type = 'submission' LIMIT 1").get(id)
      : db.prepare("SELECT 1 FROM research_items WHERE run_id = ? AND kind IS NULL AND review_state = ? LIMIT 1").get(id, decision));
  }
  delivery(id: string, deliveryId: string): ResearchDelivery | undefined {
    const row = this.stateDb.raw.prepare("SELECT payload FROM research_deliveries WHERE run_id = ? AND delivery_id = ?").get(id, deliveryId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ResearchDelivery : undefined;
  }
  deliveries(id: string, filter: { open: true } | { queueEntryId: string }): ResearchDelivery[] {
    const db = this.stateDb.raw;
    const rows = "queueEntryId" in filter
      ? db.prepare("SELECT payload FROM research_deliveries WHERE run_id = ? AND queue_entry_id = ? ORDER BY created_seq").all(id, filter.queueEntryId)
      : db.prepare("SELECT payload FROM research_deliveries WHERE run_id = ? AND open = 1 ORDER BY created_seq").all(id);
    return (rows as { payload: string }[]).map((row) => JSON.parse(row.payload) as ResearchDelivery);
  }
  board(id: string, range: ResearchBoardRange): ResearchBoardPage | undefined {
    const db = this.stateDb.raw;
    return db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM research_runs WHERE run_id = ?").get(id)) return undefined;
      const totals = new Map((db.prepare("SELECT item_type AS type, count(*) AS n FROM research_items WHERE run_id = ? GROUP BY item_type").all(id) as { type: string; n: number }[])
        .map((row) => [row.type, row.n]));
      // Order on the index alone, then read only the page's payloads.
      const page = db.prepare(`SELECT i.payload FROM (SELECT item_id, created_seq FROM research_items
          WHERE run_id = @id AND item_type = @type ORDER BY created_seq, item_id LIMIT @limit OFFSET @offset) page
        JOIN research_items i ON i.run_id = @id AND i.item_id = page.item_id ORDER BY page.created_seq, page.item_id`);
      const records = <T,>(type: ResearchItem["type"], offset: number) => (page.all({ id, type, limit: RESEARCH_BOARD_PAGE, offset }) as { payload: string }[])
        .map((row) => (JSON.parse(row.payload) as ResearchItem).record as T);
      const latest = db.prepare(`SELECT item_id FROM research_items WHERE run_id = ? AND item_type = 'submission'
        ORDER BY created_seq DESC, item_id LIMIT 1`).get(id) as { item_id: string } | undefined;
      // The newest few of the settled and of the open deliveries, each read from the end of its index range.
      const newest = db.prepare("SELECT created_seq AS seq, payload FROM research_deliveries WHERE run_id = ? AND open = ? ORDER BY created_seq DESC LIMIT ?");
      const deliveries = [0, 1].flatMap((open) => newest.all(id, open, RESEARCH_BOARD_DELIVERIES) as { seq: number; payload: string }[])
        .sort((a, b) => b.seq - a.seq).slice(0, RESEARCH_BOARD_DELIVERIES);
      const failures = db.prepare(`SELECT payload FROM research_events WHERE run_id = ? AND json_extract(payload, '$.data.type') = 'delivery_failed'
        ORDER BY seq DESC LIMIT ?`).all(id, RESEARCH_BOARD_FAILURES) as { payload: string }[];
      return {
        approaches: records<ResearchApproach>("approach", range.approachOffset), totalApproaches: totals.get("approach") ?? 0,
        findings: records<ResearchFinding>("finding", range.findingOffset), totalFindings: totals.get("finding") ?? 0,
        submissions: records<ResearchSubmission>("submission", range.submissionOffset), totalSubmissions: totals.get("submission") ?? 0,
        ...(latest ? { latestSubmissionId: latest.item_id } : {}),
        deliveries: deliveries.reverse().map((row) => JSON.parse(row.payload) as ResearchDelivery),
        deliveryFailures: failures.reverse().flatMap((row) => {
          const event = JSON.parse(row.payload) as ResearchEvent;
          return event.data.type === "delivery_failed" ? [event.data.reason] : [];
        }),
      };
    }).deferred();
  }
  changes(id: string, sinceRevision?: number, after?: ResearchChangesCursor, limit = RESEARCH_CHANGES_PAGE): ResearchChangePage | undefined {
    const cursor = normalizeResearchChangesCursor(sinceRevision, after);
    const db = this.stateDb.raw;
    return db.transaction(() => {
      const state = this.state(id);
      if (!state) return undefined;
      const reset = cursor.sinceRevision > state.revision;
      const since = reset ? 0 : cursor.sinceRevision;
      const position = reset ? undefined : cursor.after;
      // One extra row says whether changed items remain.
      const rows = (position
        ? db.prepare(`SELECT payload FROM research_items WHERE run_id = ? AND version > ? AND (version, item_id) > (?, ?)
            ORDER BY version, item_id LIMIT ?`).all(id, since, position.version, position.id, limit + 1)
        : db.prepare("SELECT payload FROM research_items WHERE run_id = ? AND version > ? ORDER BY version, item_id LIMIT ?").all(id, since, limit + 1)) as { payload: string }[];
      const items = rows.slice(0, limit).map((row) => JSON.parse(row.payload) as ResearchItem);
      const last = items.at(-1);
      return { runId: id, revision: state.revision, state, items,
        ...(rows.length > limit && last ? { next: { version: last.version, id: last.id } } : { approaches: this.approachLeaves(id, since) }),
        ...(reset ? { reset: true } : {}) };
    }).deferred();
  }
  private state(id: string): ResearchRunState | undefined {
    const db = this.stateDb.raw;
    const row = db.prepare(`SELECT r.status, r.reason,
      (SELECT MAX(seq) FROM research_events WHERE run_id = r.run_id) AS revision,
      (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND occupies_slot = 1) AS active_workers,
      (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND kind IS NULL AND review_state = 'unreviewed') AS unreviewed,
      (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND kind IS NULL AND review_state = 'accepted') AS accepted,
      (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND item_type = 'finding') AS findings,
      (SELECT count(*) FROM research_items WHERE run_id = r.run_id AND item_type = 'submission') AS candidates
      FROM research_runs r WHERE r.run_id = ?`).get(id) as { status: ResearchRun["status"]; reason: string | null; revision: number | null; active_workers: number;
        unreviewed: number; accepted: number; findings: number; candidates: number } | undefined;
    if (!row || row.revision === null) return undefined;
    return { revision: row.revision, status: row.status, ...(row.reason !== null ? { reason: row.reason } : {}), activeWorkers: row.active_workers,
      unreviewed: row.unreviewed, accepted: row.accepted, findings: row.findings, candidates: row.candidates };
  }
  /** The Map entry of each approach an item changed under after `since`, or of every approach when `since` is 0. */
  private approachLeaves(id: string, since: number): ResearchApproachLeaves[] {
    const db = this.stateDb.raw;
    const approaches = (since === 0
      ? db.prepare("SELECT item_id FROM research_items WHERE run_id = ? AND item_type = 'approach' ORDER BY created_seq, item_id").all(id)
      : db.prepare(`SELECT item_id FROM research_items WHERE run_id = ? AND item_type = 'approach'
          AND item_id IN (SELECT approach_id FROM research_items WHERE run_id = ? AND version > ?) ORDER BY created_seq, item_id`).all(id, id, since)) as { item_id: string }[];
    const count = db.prepare("SELECT count(*) AS n FROM research_items WHERE run_id = ? AND item_type = ? AND approach_id = ?");
    const newest = db.prepare(`SELECT item_id AS id, created_seq AS seq FROM research_items WHERE run_id = ? AND item_type = ? AND approach_id = ?
      ORDER BY created_seq DESC, item_id LIMIT ?`);
    return approaches.map(({ item_id: approachId }) => {
      const leaves = (["finding", "submission"] as const).flatMap((type) => newest.all(id, type, approachId, RESEARCH_MAP_LEAVES) as { id: string; seq: number }[])
        .sort((a, b) => b.seq - a.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { approachId, findings: (count.get(id, "finding", approachId) as { n: number }).n, candidates: (count.get(id, "submission", approachId) as { n: number }).n,
        leafIds: leaves.slice(0, RESEARCH_MAP_LEAVES).map((leaf) => leaf.id) };
    });
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
  append(id: string, revision: number, event: ResearchEvent): boolean {
    const db = this.stateDb.raw;
    return db.transaction(() => {
      const duplicate = db.prepare("SELECT payload FROM research_events WHERE run_id = ? AND command_id = ?").get(id, event.commandId) as { payload: string } | undefined;
      if (duplicate) {
        const previous = JSON.parse(duplicate.payload) as ResearchEvent;
        if (previous.signature !== event.signature || JSON.stringify(previous.actor) !== JSON.stringify(event.actor)) throw new Error("Research command key was reused");
        return false;
      }
      const row = db.prepare("SELECT MAX(seq) AS revision FROM research_events WHERE run_id = ?").get(id) as { revision: number | null };
      if (row.revision !== revision || event.seq !== revision + 1) throw new Error("Research run changed; read its current state before retrying");
      this.insertEvent(id, event);
      this.projectEvent(id, event);
      if (event.data.type === "status") db.prepare("UPDATE research_runs SET status = ?, reason = ? WHERE run_id = ?").run(event.data.status, event.data.reason, id);
      if (event.data.type === "worker" && event.data.worker) {
        db.prepare("INSERT OR IGNORE INTO research_workers (run_id, backend, thread_id) VALUES (?, ?, ?)")
          .run(id, event.data.worker.backend, event.data.worker.threadId);
      }
      return true;
    }).immediate();
  }
  private insertEvent(id: string, event: ResearchEvent): void {
    this.stateDb.raw.prepare("INSERT INTO research_events (run_id, seq, command_id, payload) VALUES (?, ?, ?, ?)")
      .run(id, event.seq, event.commandId, JSON.stringify(event));
  }
  private projectEvent(id: string, event: ResearchEvent): void {
    // What the event read is what it changes, so each write can name only the columns that differ.
    const before = new Map<string, ResearchItem>();
    const read = (key: string) => { const item = this.readItem(id, key); if (item) before.set(key, item); return item; };
    for (const item of applyResearchItemEvent(read, event)) writeProjectedItem(this.stateDb.raw, id, item, before.get(item.id));
    if (event.data.type === "delivery") writeProjectedDelivery(this.stateDb.raw, id, event.seq, event.data.delivery);
  }
}

function headerFromRow(row: HeaderRow): ResearchRunHeader {
  const event = JSON.parse(row.payload) as ResearchEvent;
  if (event.data.type !== "created") throw new Error("Invalid research header");
  const data = event.data;
  return { id: row.run_id, revision: row.revision, objective: data.objective, coordinator: data.coordinator, ownerId: data.ownerId, ownerPid: data.ownerPid,
    ownerStartedAt: data.ownerStartedAt, createdAt: event.at, deadlineAt: data.deadlineAt, workspaceMode: data.workspaceMode, status: row.status,
    ...(row.reason !== null ? { reason: row.reason } : {}), workerLimit: data.approaches.length, activeWorkers: row.active_workers };
}

function readProjectedItem(db: StateDb["raw"], runId: string, itemId: string): ResearchItem | undefined {
  const row = db.prepare("SELECT payload FROM research_items WHERE run_id = ? AND item_id = ?").get(runId, itemId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as ResearchItem : undefined;
}

/** The item columns an index covers and an event can change. */
function projectedItemIndexed(item: ResearchItem) {
  const worker = item.type === "approach" ? item.record.worker : undefined;
  return {
    kind: item.type === "finding" ? item.record.kind : null,
    reviewState: item.type === "submission" ? item.record.review?.decision ?? "unreviewed" : null,
    workState: item.work.state,
    occupiesSlot: item.type === "approach" && researchApproachOccupiesSlot(item.record) ? 1 : 0,
    workerBackend: worker?.backend ?? null,
    workerThreadId: worker?.threadId ?? null,
  };
}

type ProjectedItemIndexed = ReturnType<typeof projectedItemIndexed>;

const ITEM_UPDATE_ALWAYS = "search_text = @searchText, payload = @payload, version = @version, assignee_backend = @assigneeBackend, assignee_thread_id = @assigneeThreadId";
/** Each group is the changeable columns of one index, with the SET clause that writes them. */
const ITEM_UPDATE_GROUPS: readonly (readonly [columns: readonly (keyof ProjectedItemIndexed)[], set: string])[] = [
  [["workState"], "work_state = @workState"],
  [["kind", "reviewState"], "kind = @kind, review_state = @reviewState"],
  [["occupiesSlot"], "occupies_slot = @occupiesSlot"],
  [["workerBackend", "workerThreadId"], "worker_backend = @workerBackend, worker_thread_id = @workerThreadId"],
];

/**
 * Write one item's row. SQLite rewrites every index that covers a column in
 * an UPDATE's SET list, whether or not the value changed, so an item whose
 * earlier state is known is updated by a statement that names only the index
 * groups that differ: a worker event then leaves the review index alone. An
 * item that is new, or whose earlier state is not known, is written whole.
 */
function writeProjectedItem(db: StateDb["raw"], runId: string, item: ResearchItem, previous?: ResearchItem): void {
  const indexed = projectedItemIndexed(item);
  const row = {
    runId, itemId: item.id, itemType: item.type, approachId: item.approachId, createdSeq: item.createdSeq, ...indexed,
    assigneeBackend: item.work.assignee?.backend ?? null, assigneeThreadId: item.work.assignee?.threadId ?? null,
    searchText: researchItemSearchText(item), payload: JSON.stringify(item), version: item.version,
  };
  if (previous && previous.type === item.type && previous.approachId === item.approachId && previous.createdSeq === item.createdSeq) {
    const last = projectedItemIndexed(previous);
    const sets = [ITEM_UPDATE_ALWAYS, ...ITEM_UPDATE_GROUPS.filter(([columns]) => columns.some((column) => indexed[column] !== last[column])).map(([, set]) => set)];
    db.prepare("UPDATE research_items SET " + sets.join(", ") + " WHERE run_id = @runId AND item_id = @itemId").run(row);
    return;
  }
  db.prepare(`INSERT INTO research_items (run_id, item_id, item_type, approach_id, created_seq, kind, review_state,
    work_state, assignee_backend, assignee_thread_id, search_text, payload, version, occupies_slot, worker_backend, worker_thread_id)
    VALUES (@runId, @itemId, @itemType, @approachId, @createdSeq, @kind, @reviewState,
    @workState, @assigneeBackend, @assigneeThreadId, @searchText, @payload, @version, @occupiesSlot, @workerBackend, @workerThreadId)
    ON CONFLICT(run_id, item_id) DO UPDATE SET item_type = excluded.item_type, approach_id = excluded.approach_id,
      kind = excluded.kind, review_state = excluded.review_state, work_state = excluded.work_state,
      assignee_backend = excluded.assignee_backend, assignee_thread_id = excluded.assignee_thread_id,
      search_text = excluded.search_text, payload = excluded.payload, version = excluded.version, occupies_slot = excluded.occupies_slot,
      worker_backend = excluded.worker_backend, worker_thread_id = excluded.worker_thread_id`).run(row);
}

/**
 * The first receipt fixes a delivery's place; later receipts replace what it
 * says. A later receipt names `open` and the queue entry only when they
 * change, for the reason `writeProjectedItem` gives.
 */
function writeProjectedDelivery(db: StateDb["raw"], runId: string, seq: number, delivery: ResearchDelivery): void {
  const row = { runId, deliveryId: delivery.id, seq, queueEntryId: delivery.queueEntryId ?? null, open: ["cancelled", "ended"].includes(delivery.state) ? 0 : 1, payload: JSON.stringify(delivery) };
  const last = db.prepare("SELECT queue_entry_id AS queueEntryId, open FROM research_deliveries WHERE run_id = ? AND delivery_id = ?").get(runId, delivery.id) as { queueEntryId: string | null; open: number } | undefined;
  if (!last) {
    db.prepare("INSERT INTO research_deliveries (run_id, delivery_id, created_seq, queue_entry_id, open, payload) VALUES (@runId, @deliveryId, @seq, @queueEntryId, @open, @payload)").run(row);
    return;
  }
  const sets = ["payload = @payload", ...(last.open !== row.open ? ["open = @open"] : []), ...(last.queueEntryId !== row.queueEntryId ? ["queue_entry_id = @queueEntryId"] : [])];
  db.prepare("UPDATE research_deliveries SET " + sets.join(", ") + " WHERE run_id = @runId AND delivery_id = @deliveryId").run(row);
}

function tableColumns(db: StateDb["raw"], table: "research_runs" | "research_items"): Set<string> {
  return new Set((db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((row) => row.name));
}

/**
 * Additive migrations for databases created before a projection existed. Each
 * backfill runs once, in the open that adds its column or table, and commits
 * with it: a projection either does not exist or is complete. Normal reads
 * never repair or write projections.
 */
export function ensureResearchProjections(db: StateDb["raw"]): void {
  const missing = () => ({
    reason: !tableColumns(db, "research_runs").has("reason"),
    itemColumns: !tableColumns(db, "research_items").has("version"),
    deliveries: !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'research_deliveries'").get(),
  });
  const before = missing();
  if (before.reason || before.itemColumns || before.deliveries) {
    db.transaction(() => {
      // Another instance of the profile may have migrated between the check and this write lock.
      const now = missing();
      if (now.reason) backfillRunReasons(db);
      if (now.itemColumns) backfillItemColumns(db);
      db.exec(RESEARCH_PROJECTION_SCHEMA);
      if (now.deliveries) backfillDeliveries(db);
    }).immediate();
  } else db.exec(RESEARCH_PROJECTION_SCHEMA);
  backfillResearchItems(db);
}

function backfillRunReasons(db: StateDb["raw"]): void {
  db.exec("ALTER TABLE research_runs ADD COLUMN reason TEXT");
  const reasons = new Map<string, string>();
  const events = db.prepare("SELECT run_id, payload FROM research_events WHERE json_extract(payload, '$.data.type') = 'status' ORDER BY run_id, seq").all() as { run_id: string; payload: string }[];
  for (const row of events) {
    const event = JSON.parse(row.payload) as ResearchEvent;
    if (event.data.type === "status") reasons.set(row.run_id, event.data.reason);
  }
  const update = db.prepare("UPDATE research_runs SET reason = ? WHERE run_id = ?");
  for (const [runId, reason] of reasons) update.run(reason, runId);
}

function backfillItemColumns(db: StateDb["raw"]): void {
  db.exec(`ALTER TABLE research_items ADD COLUMN version INTEGER;
    ALTER TABLE research_items ADD COLUMN occupies_slot INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE research_items ADD COLUMN worker_backend TEXT;
    ALTER TABLE research_items ADD COLUMN worker_thread_id TEXT;`);
  const rows = db.prepare("SELECT run_id, payload FROM research_items").all() as { run_id: string; payload: string }[];
  const update = db.prepare("UPDATE research_items SET version = ?, occupies_slot = ?, worker_backend = ?, worker_thread_id = ? WHERE run_id = ? AND item_id = ?");
  for (const row of rows) {
    const item = JSON.parse(row.payload) as ResearchItem;
    const indexed = projectedItemIndexed(item);
    update.run(item.version, indexed.occupiesSlot, indexed.workerBackend, indexed.workerThreadId, row.run_id, item.id);
  }
}

function backfillDeliveries(db: StateDb["raw"]): void {
  const events = db.prepare("SELECT run_id, payload FROM research_events WHERE json_extract(payload, '$.data.type') = 'delivery' ORDER BY run_id, seq").all() as { run_id: string; payload: string }[];
  for (const row of events) {
    const event = JSON.parse(row.payload) as ResearchEvent;
    if (event.data.type === "delivery") writeProjectedDelivery(db, row.run_id, event.seq, event.data.delivery);
  }
}

/** Rebuilds the item projection of a journal that has none. One commit per run, so a run is never left partly rebuilt. */
function backfillResearchItems(db: StateDb["raw"]): void {
  const runs = db.prepare("SELECT run_id FROM research_runs r WHERE NOT EXISTS (SELECT 1 FROM research_items i WHERE i.run_id = r.run_id)").all() as { run_id: string }[];
  for (const run of runs) {
    db.transaction(() => {
      const events = db.prepare("SELECT payload FROM research_events WHERE run_id = ? ORDER BY seq").all(run.run_id) as { payload: string }[];
      const items = new Map<string, ResearchItem>();
      for (const row of events) for (const item of applyResearchItemEvent((key) => items.get(key), JSON.parse(row.payload) as ResearchEvent)) items.set(item.id, item);
      for (const item of items.values()) writeProjectedItem(db, run.run_id, item);
    }).immediate();
  }
}
