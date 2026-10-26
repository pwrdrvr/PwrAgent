import type BetterSqlite3 from "better-sqlite3";
import {
  buildThreadIdentityKey,
  parseThreadIdentityKey,
  type ThreadSubAgentSummary,
} from "@pwragent/shared";

/**
 * Durable sub-agent and Token Miser gate cards, one row per card.
 *
 * Cards used to live in the parent's `threads.payload.subAgents` array, which
 * grew without bound (thousands of gate cards on busy threads) and made every
 * overlay read parse, and every overlay write rewrite, all of them. Here a
 * card write touches its own row and an overlay read touches none.
 *
 * `thread_id` is the parent's `threads.thread_id` storage key. The card body
 * stays JSON because its shape keeps changing; only fields a query filters or
 * orders on are columns.
 *
 * Older PwrAgent builds that share the profile still write the whole payload,
 * including any `subAgents` array they hold. The capture triggers move such an
 * array into this table inside the writer's own transaction, so an older
 * build can add or update cards but never erase them. They cannot delete
 * cards either; only this build's code removes card rows.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS thread_sub_agents (
  thread_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL,
  backend TEXT,
  monitor_thread_id TEXT,
  card TEXT NOT NULL,
  PRIMARY KEY (thread_id, monitor_id)
);
CREATE INDEX IF NOT EXISTS thread_sub_agents_by_created
  ON thread_sub_agents(thread_id, created_at DESC, monitor_id);
CREATE INDEX IF NOT EXISTS thread_sub_agents_child
  ON thread_sub_agents(monitor_thread_id, thread_id, backend)
  WHERE monitor_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thread_sub_agents_attention
  ON thread_sub_agents(thread_id)
  WHERE completed_at IS NULL OR status IN ('failed', 'failure');
CREATE TABLE IF NOT EXISTS thread_sub_agent_revisions (
  thread_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  card_count INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS thread_sub_agent_revisions_insert
AFTER INSERT ON thread_sub_agents BEGIN
  INSERT INTO thread_sub_agent_revisions(thread_id, revision, card_count) VALUES (NEW.thread_id, 1, 1)
    ON CONFLICT(thread_id) DO UPDATE SET revision = revision + 1, card_count = card_count + 1;
END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agent_revisions_update
AFTER UPDATE ON thread_sub_agents BEGIN
  UPDATE thread_sub_agent_revisions SET revision = revision + 1,
    card_count = card_count - (OLD.thread_id IS NOT NEW.thread_id)
    WHERE thread_id = OLD.thread_id;
  -- A rekeyed card moves its count to the new parent.
  INSERT INTO thread_sub_agent_revisions(thread_id, revision, card_count)
    SELECT NEW.thread_id, 1, 1 WHERE OLD.thread_id IS NOT NEW.thread_id
    ON CONFLICT(thread_id) DO UPDATE SET revision = revision + 1, card_count = card_count + 1;
END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agent_revisions_delete
AFTER DELETE ON thread_sub_agents BEGIN
  UPDATE thread_sub_agent_revisions SET revision = revision + 1, card_count = card_count - 1
    WHERE thread_id = OLD.thread_id;
END;
`;

/** One statement shared by both capture triggers; NEW is the `threads` row. */
const CAPTURE_BODY = `
  INSERT INTO thread_sub_agents(thread_id, monitor_id, created_at, updated_at, completed_at, status, backend, monitor_thread_id, card)
  SELECT NEW.thread_id, json_extract(value, '$.monitorId'),
    coalesce(json_extract(value, '$.createdAt'), 0), coalesce(json_extract(value, '$.updatedAt'), 0),
    json_extract(value, '$.completedAt'), coalesce(json_extract(value, '$.status'), ''),
    json_extract(value, '$.backend'),
    CASE WHEN json_type(value, '$.monitorThreadId') = 'text' THEN json_extract(value, '$.monitorThreadId') END, value
  FROM json_each(NEW.payload, '$.subAgents')
  WHERE type = 'object' AND json_type(value, '$.monitorId') = 'text'
  ON CONFLICT(thread_id, monitor_id) DO UPDATE SET
    created_at = excluded.created_at, updated_at = excluded.updated_at, completed_at = excluded.completed_at,
    status = excluded.status, backend = excluded.backend, monitor_thread_id = excluded.monitor_thread_id, card = excluded.card
  WHERE excluded.updated_at >= thread_sub_agents.updated_at AND thread_sub_agents.card IS NOT excluded.card;
  UPDATE threads SET payload = json_remove(payload, '$.subAgents') WHERE thread_id = NEW.thread_id;
`;

const HAS_CARD_ARRAY = `CASE WHEN json_valid(NEW.payload) THEN json_type(NEW.payload, '$.subAgents') = 'array' ELSE 0 END`;

const CAPTURE_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS thread_sub_agents_capture_insert
AFTER INSERT ON threads WHEN ${HAS_CARD_ARRAY} BEGIN ${CAPTURE_BODY} END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agents_capture_update
AFTER UPDATE OF payload ON threads WHEN ${HAS_CARD_ARRAY} BEGIN ${CAPTURE_BODY} END;
`;

/**
 * Managed-child membership is cached by the navigation relationship
 * generation. Card rows now carry that membership, so they bump it too.
 */
const GENERATION_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS thread_sub_agents_generation_insert
AFTER INSERT ON thread_sub_agents WHEN NEW.monitor_thread_id IS NOT NULL BEGIN
  UPDATE thread_navigation_relationship_generation SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agents_generation_update
AFTER UPDATE ON thread_sub_agents
WHEN OLD.monitor_thread_id IS NOT NEW.monitor_thread_id
  OR OLD.backend IS NOT NEW.backend
  OR OLD.thread_id IS NOT NEW.thread_id BEGIN
  UPDATE thread_navigation_relationship_generation SET generation = generation + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agents_generation_delete
AFTER DELETE ON thread_sub_agents WHEN OLD.monitor_thread_id IS NOT NULL BEGIN
  UPDATE thread_navigation_relationship_generation SET generation = generation + 1 WHERE singleton = 1;
END;
`;

/** Set once every legacy payload array has been moved; later opens skip all scanning. */
export const THREAD_SUB_AGENTS_MOVED_META_KEY = "thread_sub_agents_moved_v1";

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Idempotent. Runs from the versioned step and again after the ladder, so a
 * profile that another branch stamped with the same `user_version` converges.
 * Creates no rows and moves no data.
 */
export function ensureThreadSubAgentSchema(db: BetterSqlite3.Database): void {
  if (!tableExists(db, "threads")) return;
  db.exec(TABLES);
  db.exec(CAPTURE_TRIGGERS);
  if (tableExists(db, "thread_navigation_relationship_generation")) db.exec(GENERATION_TRIGGERS);
}

type CardRow = { card: string };

function parseCard(row: CardRow | undefined): ThreadSubAgentSummary | undefined {
  if (!row) return undefined;
  try {
    return JSON.parse(row.card) as ThreadSubAgentSummary;
  } catch {
    return undefined;
  }
}

function parseCards(rows: CardRow[]): ThreadSubAgentSummary[] {
  return rows.flatMap((row) => {
    const card = parseCard(row);
    return card ? [card] : [];
  });
}

/**
 * The child thread key a card names, with the legacy projection's rules: the
 * card's backend falls back to the parent's, ids are trimmed, and a card
 * naming its own parent is ignored. `parentStorageKey` is the card's `thread_id`.
 */
export function managedChildKeyFromCard(
  parentStorageKey: string,
  backend: string | null,
  monitorThreadId: unknown,
): string | undefined {
  const parent = parseThreadIdentityKey(parentStorageKey);
  const childId = typeof monitorThreadId === "string" ? monitorThreadId.trim() : "";
  if (!parent || !childId) return undefined;
  const childBackend = (backend ?? parent.backend) as typeof parent.backend;
  if (childBackend === parent.backend && childId === parent.threadId) return undefined;
  return buildThreadIdentityKey(childBackend, childId);
}

/** The exclusive upper bound of the ids that start with `prefix`, for a primary-key range. */
function monitorIdPrefixEnd(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/** The range of monitor ids reserved for Token Miser gate cards. */
export const TOKEN_MISER_MONITOR_ID_PREFIX = "system:token-miser:";
const TOKEN_MISER_MONITOR_ID_END = monitorIdPrefixEnd(TOKEN_MISER_MONITOR_ID_PREFIX);

export class ThreadSubAgentTable {
  private moved: boolean | undefined;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly meta: { get(key: string): string | undefined; set(key: string, value: string): void },
  ) {}

  /** True once no legacy payload array can remain, apart from an older writer's (which the triggers capture). */
  isMoveComplete(): boolean {
    this.moved ??= this.meta.get(THREAD_SUB_AGENTS_MOVED_META_KEY) === "1";
    return this.moved;
  }

  /**
   * Move one thread's legacy array, if it still has one. A no-op payload
   * update fires the capture trigger, so this, the background sweep, and an
   * older writer all take the same path.
   */
  moveLegacyCards(storageKey: string): void {
    if (this.isMoveComplete()) return;
    // Read first, so a row with nothing to move costs no write lock or commit.
    const legacy = this.db.prepare(`SELECT 1 FROM threads WHERE thread_id = ?
      AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.subAgents') = 'array' ELSE 0 END`).get(storageKey);
    if (!legacy) return;
    this.db.prepare("UPDATE threads SET payload = payload WHERE thread_id = ?").run(storageKey);
  }

  /**
   * One bounded slice of the one-time move, in one immediate transaction: the
   * next threads by rowid until about `byteBudget` payload bytes (always at
   * least one row). `octet_length` reads the stored size without loading the
   * payload. Returns the cursor for the next slice, or `undefined` once every
   * row has been visited and the marker is set.
   */
  moveLegacyCardsSlice(afterRowid: number, byteBudget: number): number | undefined {
    if (this.isMoveComplete()) return undefined;
    return this.db.transaction(() => {
      const candidates = this.db.prepare(`SELECT rowid AS id, thread_id, octet_length(payload) AS bytes
        FROM threads WHERE rowid > ? ORDER BY rowid LIMIT 500`).all(afterRowid) as Array<{
        id: number; thread_id: string; bytes: number;
      }>;
      if (candidates.length === 0) {
        this.meta.set(THREAD_SUB_AGENTS_MOVED_META_KEY, "1");
        this.moved = true;
        return undefined;
      }
      const move = this.db.prepare(`UPDATE threads SET payload = payload WHERE thread_id = ?
        AND instr(payload, '"subAgents"') > 0
        AND CASE WHEN json_valid(payload) THEN json_type(payload, '$.subAgents') = 'array' ELSE 0 END`);
      let bytes = 0;
      let last = afterRowid;
      for (const row of candidates) {
        if (last !== afterRowid && bytes + row.bytes > byteBudget) break;
        move.run(row.thread_id);
        bytes += row.bytes;
        last = row.id;
      }
      return last;
    }).immediate();
  }

  /** Per-card upsert. An unchanged card writes nothing; the parent row is never touched. */
  upsert(storageKey: string, cards: readonly ThreadSubAgentSummary[]): void {
    if (cards.length === 0) return;
    const statement = this.db.prepare(`INSERT INTO thread_sub_agents(thread_id, monitor_id, created_at, updated_at,
        completed_at, status, backend, monitor_thread_id, card)
      VALUES (@threadId, @monitorId, @createdAt, @updatedAt, @completedAt, @status, @backend, @monitorThreadId, @card)
      ON CONFLICT(thread_id, monitor_id) DO UPDATE SET
        created_at = excluded.created_at, updated_at = excluded.updated_at, completed_at = excluded.completed_at,
        status = excluded.status, backend = excluded.backend, monitor_thread_id = excluded.monitor_thread_id,
        card = excluded.card
      WHERE thread_sub_agents.card IS NOT excluded.card`);
    const write = () => {
      for (const card of cards) {
        statement.run({
          threadId: storageKey,
          monitorId: card.monitorId,
          createdAt: card.createdAt ?? 0,
          updatedAt: card.updatedAt ?? 0,
          completedAt: card.completedAt ?? null,
          status: card.status ?? "",
          backend: card.backend ?? null,
          monitorThreadId: typeof card.monitorThreadId === "string" ? card.monitorThreadId : null,
          card: JSON.stringify(card),
        });
      }
    };
    if (cards.length === 1 || this.db.inTransaction) write();
    else this.db.transaction(write)();
  }

  get(storageKey: string, monitorId: string): ThreadSubAgentSummary | undefined {
    return parseCard(this.db.prepare(
      "SELECT card FROM thread_sub_agents WHERE thread_id = ? AND monitor_id = ?",
    ).get(storageKey, monitorId) as CardRow | undefined);
  }

  /** Every card, newest first. Reserve for consumers that genuinely need the whole set. */
  list(storageKey: string, options?: { excludeTokenMiser?: boolean }): ThreadSubAgentSummary[] {
    const rows = options?.excludeTokenMiser
      ? this.db.prepare(`SELECT card FROM thread_sub_agents WHERE thread_id = ?
          AND NOT (monitor_id >= ? AND monitor_id < ?)
          ORDER BY created_at DESC, monitor_id`).all(storageKey, TOKEN_MISER_MONITOR_ID_PREFIX, TOKEN_MISER_MONITOR_ID_END)
      : this.db.prepare(`SELECT card FROM thread_sub_agents WHERE thread_id = ?
          ORDER BY created_at DESC, monitor_id`).all(storageKey);
    return parseCards(rows as CardRow[]);
  }

  /** Cards whose `monitorId` starts with `prefix`, per thread, from the primary-key range. */
  listByMonitorIdPrefix(storageKeys: readonly string[], prefix: string): Map<string, ThreadSubAgentSummary[]> {
    const end = monitorIdPrefixEnd(prefix);
    const statement = this.db.prepare(`SELECT card FROM thread_sub_agents
      WHERE thread_id = ? AND monitor_id >= ? AND monitor_id < ?
      ORDER BY created_at DESC, monitor_id`);
    const result = new Map<string, ThreadSubAgentSummary[]>();
    for (const key of storageKeys) {
      const cards = parseCards(statement.all(key, prefix, end) as CardRow[]);
      if (cards.length > 0) result.set(key, cards);
    }
    return result;
  }

  /** Unfinished cards and failures: what the composer strip and stop controls need. */
  listAttention(storageKey: string): ThreadSubAgentSummary[] {
    return parseCards(this.db.prepare(`SELECT card FROM thread_sub_agents INDEXED BY thread_sub_agents_attention
      WHERE thread_id = ? AND (completed_at IS NULL OR status IN ('failed', 'failure'))
      ORDER BY created_at DESC, monitor_id`).all(storageKey) as CardRow[]);
  }

  /** Unfinished cards across every thread, for startup orphan repair. */
  listIncomplete(): Array<{ storageKey: string; card: ThreadSubAgentSummary }> {
    const rows = this.db.prepare(`SELECT thread_id, card FROM thread_sub_agents INDEXED BY thread_sub_agents_attention
      WHERE completed_at IS NULL`).all() as Array<{ thread_id: string; card: string }>;
    return rows.flatMap((row) => {
      const card = parseCard(row);
      return card ? [{ storageKey: row.thread_id, card }] : [];
    });
  }

  revision(storageKey: string): { revision: number; count: number } {
    const row = this.db.prepare(
      "SELECT revision, card_count FROM thread_sub_agent_revisions WHERE thread_id = ?",
    ).get(storageKey) as { revision: number; card_count: number } | undefined;
    return { revision: row?.revision ?? 0, count: row?.card_count ?? 0 };
  }

  /** One statement per table for the whole batch, however many threads it names. */
  deleteForThreads(storageKeys: readonly string[]): void {
    if (storageKeys.length === 0) return;
    const keys = JSON.stringify(storageKeys);
    this.db.prepare("DELETE FROM thread_sub_agents WHERE thread_id IN (SELECT value FROM json_each(?))").run(keys);
    this.db.prepare("DELETE FROM thread_sub_agent_revisions WHERE thread_id IN (SELECT value FROM json_each(?))").run(keys);
  }
}
