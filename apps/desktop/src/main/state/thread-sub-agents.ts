import type BetterSqlite3 from "better-sqlite3";
import {
  buildThreadIdentityKey,
  parseThreadIdentityKey,
  type SubAgentLens,
  type ThreadSubAgentSummary,
  type TokenMiserGateAccountingTotals,
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

/**
 * The sub-agents panel's lens, from the monitor id alone. This is
 * `subAgentLens` in `@pwragent/shared` (subagent-kind.ts) restated in SQL, so
 * every writer, including an older build's statements and the capture
 * triggers, gets it without knowing the column exists. A generated column
 * reads no card; the index stores it at write time.
 */
const LENS_COLUMN = `ALTER TABLE thread_sub_agents ADD COLUMN lens TEXT GENERATED ALWAYS AS (CASE
  WHEN substr(monitor_id, 1, 19) = 'system:token-miser:' THEN 'token-miser'
  WHEN substr(monitor_id, 1, 13) = 'codex-native:' THEN 'harness'
  ELSE 'pwragent' END) VIRTUAL`;
const LENS_INDEX = `CREATE INDEX IF NOT EXISTS thread_sub_agents_by_lens
  ON thread_sub_agents(thread_id, lens, created_at DESC, monitor_id)`;

/**
 * `isThreadSubAgentVisibleInPanel` (subagent-visibility.ts) for a harness
 * card, in SQL: a finished native worker leaves the panel a day after it last
 * moved. The one parameter is the oldest activity time still shown.
 */
const HARNESS_VISIBLE = `NOT (
  (status IN ('success', 'failure', 'cancelled')
    OR json_type(card, '$.completedAt') IS NOT NULL
    OR json_type(card, '$.outcome') IS NOT NULL
    OR json_type(card, '$.completionSource') IS NOT NULL)
  AND coalesce(completed_at, updated_at) < ?)`;

/**
 * Per-thread sums over the Token Miser gate cards, for the Pricing savings
 * fallback (`TokenMiserGateAccountingTotals`), so it never reads the cards.
 * They live on the revision row, which every card write already rewrites, so
 * keeping them adds no page to a write.
 */
const GATE_TOTAL_COLUMNS = [
  "gate_count", "gate_priced", "gate_disposition", "gate_passed_through", "gate_summarized",
  "gate_decision_source", "gate_helper", "gate_without_micros", "gate_cost_micros",
  "gate_revealed_micros", "gate_savings_micros", "gate_avoided_tokens",
] as const;

/** One card's share of each `GATE_TOTAL_COLUMNS` entry, in order. `row` is a card row alias. */
function gateShares(row: string): string[] {
  const accounting = (field: string) => `coalesce(json_extract(${row}.card, '$.tokenMiserAccounting.${field}'), 0)`;
  const priced = `(json_type(${row}.card, '$.tokenMiserAccounting') = 'object')`;
  const field = (name: string) => `json_extract(${row}.card, '$.tokenMiserAccounting.${name}')`;
  const ifPriced = (expression: string) => `CASE WHEN ${priced} THEN ${expression} ELSE 0 END`;
  return [
    "1",
    ifPriced("1"),
    ifPriced(`(json_type(${row}.card, '$.tokenMiserAccounting.disposition') IS NOT NULL)`),
    ifPriced(`(${field("disposition")} IS 'passed_through')`),
    ifPriced(`(${field("disposition")} IS 'summarized')`),
    ifPriced(`(json_type(${row}.card, '$.tokenMiserAccounting.decisionSource') IS NOT NULL)`),
    ifPriced(`(${field("decisionSource")} IS 'helper')`),
    ifPriced(`${accounting("baselineParentCostMicros")} + ${accounting("cachedBaselineCostMicros")}`),
    ifPriced(accounting("gateCostMicros")),
    ifPriced(`${accounting("revealedParentCostMicros")} + ${accounting("cachedRevealedCostMicros")}`),
    ifPriced(accounting("savingsMicros")),
    ifPriced(`${accounting("baselineParentTokens")} - ${accounting("revealedParentTokens")}`),
  ];
}

const IS_GATE = (row: string) => `substr(${row}.monitor_id, 1, 19) = 'system:token-miser:'`;

function addGateShares(row: "NEW" | "OLD"): string {
  return `INSERT INTO thread_sub_agent_revisions(thread_id, revision, card_count, ${GATE_TOTAL_COLUMNS.join(", ")})
    SELECT ${row}.thread_id, 0, 0, ${gateShares(row).join(", ")} WHERE ${IS_GATE(row)}
    ON CONFLICT(thread_id) DO UPDATE SET ${GATE_TOTAL_COLUMNS.map((column) => `${column} = ${column} + excluded.${column}`).join(", ")};`;
}

function removeGateShares(row: "NEW" | "OLD"): string {
  const shares = gateShares(row);
  return `UPDATE thread_sub_agent_revisions SET ${GATE_TOTAL_COLUMNS.map((column, index) => `${column} = ${column} - (${shares[index]})`).join(", ")}
    WHERE thread_id = ${row}.thread_id AND ${IS_GATE(row)};`;
}

const GATE_TOTAL_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS thread_sub_agent_gate_totals_insert
AFTER INSERT ON thread_sub_agents WHEN ${IS_GATE("NEW")} BEGIN ${addGateShares("NEW")} END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agent_gate_totals_update
AFTER UPDATE ON thread_sub_agents WHEN ${IS_GATE("OLD")} OR ${IS_GATE("NEW")} BEGIN
  ${removeGateShares("OLD")}
  ${addGateShares("NEW")}
END;
CREATE TRIGGER IF NOT EXISTS thread_sub_agent_gate_totals_delete
AFTER DELETE ON thread_sub_agents WHEN ${IS_GATE("OLD")} BEGIN ${removeGateShares("OLD")} END;
`;

/** The same sums, recomputed from the cards; once per thread that predates the columns. */
const RECOMPUTE_GATE_TOTALS = `UPDATE thread_sub_agent_revisions SET (${GATE_TOTAL_COLUMNS.join(", ")}) = (
    SELECT ${gateShares("c").map((share, index) => index === 0 ? "count(*)" : `coalesce(sum(${share}), 0)`).join(", ")}
    FROM thread_sub_agents AS c
    WHERE c.thread_id = thread_sub_agent_revisions.thread_id
      AND c.monitor_id >= 'system:token-miser:' AND c.monitor_id < 'system:token-miser;'
  ), gate_totals_ready = 1
  WHERE thread_id = ? AND gate_totals_ready = 0`;

function columnNames(db: BetterSqlite3.Database, table: string): Set<string> {
  return new Set((db.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table) as Array<{ name: string }>)
    .map((row) => row.name));
}

/**
 * The lens column and index and the gate totals, added once. Later opens read
 * two table infos and write nothing. Adding the columns builds the index over
 * the card rows' leading columns, which never touches a card body, and marks
 * every existing thread's totals stale; `ThreadSubAgentTable.gateTotals`
 * recomputes one thread's on its first read. Rows created afterwards start
 * fresh, and the triggers keep them current whichever build writes the card.
 */
export function ensureThreadSubAgentPanelSchema(db: BetterSqlite3.Database): void {
  if (!tableExists(db, "thread_sub_agents") || !tableExists(db, "thread_sub_agent_revisions")) return;
  const isCurrent = () => columnNames(db, "thread_sub_agents").has("lens")
    && columnNames(db, "thread_sub_agent_revisions").has("gate_totals_ready");
  if (isCurrent()) return;
  db.transaction(() => {
    // Another opener may have added them while this connection waited.
    if (isCurrent()) return;
    if (!columnNames(db, "thread_sub_agents").has("lens")) db.exec(LENS_COLUMN);
    db.exec(LENS_INDEX);
    const revisionColumns = columnNames(db, "thread_sub_agent_revisions");
    for (const column of GATE_TOTAL_COLUMNS) {
      if (!revisionColumns.has(column)) {
        db.exec(`ALTER TABLE thread_sub_agent_revisions ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    db.exec("ALTER TABLE thread_sub_agent_revisions ADD COLUMN gate_totals_ready INTEGER NOT NULL DEFAULT 1");
    db.exec("UPDATE thread_sub_agent_revisions SET gate_totals_ready = 0");
    db.exec(GATE_TOTAL_TRIGGERS);
  }).immediate();
}

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

  /** The named cards that exist, in no particular order. */
  getMany(storageKey: string, monitorIds: readonly string[]): ThreadSubAgentSummary[] {
    if (monitorIds.length === 0) return [];
    return parseCards(this.db.prepare(`SELECT card FROM thread_sub_agents
      WHERE thread_id = ? AND monitor_id IN (SELECT value FROM json_each(?))`)
      .all(storageKey, JSON.stringify([...new Set(monitorIds)])) as CardRow[]);
  }

  /**
   * Cards per panel lens, as `isThreadSubAgentVisibleInPanel` filters them at
   * `visibleSince` (the oldest activity a finished native worker may have).
   * The other two lenses count from the lens index alone; only harness rows
   * are read, to test their age.
   */
  lensCounts(storageKey: string, visibleSince: number, excludeMonitorIds: readonly string[] = []): Record<SubAgentLens, number> {
    const counts: Record<SubAgentLens, number> = { harness: 0, "token-miser": 0, pwragent: 0 };
    const excluded = JSON.stringify([...new Set(excludeMonitorIds)]);
    const rows = this.db.prepare(`SELECT lens, count(*) AS count FROM thread_sub_agents INDEXED BY thread_sub_agents_by_lens
      WHERE thread_id = ? AND lens IN ('token-miser', 'pwragent')
        AND monitor_id NOT IN (SELECT value FROM json_each(?))
      GROUP BY lens`).all(storageKey, excluded) as Array<{ lens: SubAgentLens; count: number }>;
    for (const row of rows) counts[row.lens] = row.count;
    counts.harness = (this.db.prepare(`SELECT count(*) AS count FROM thread_sub_agents INDEXED BY thread_sub_agents_by_lens
      WHERE thread_id = ? AND lens = 'harness'
        AND monitor_id NOT IN (SELECT value FROM json_each(?)) AND ${HARNESS_VISIBLE}`)
      .get(storageKey, excluded, visibleSince) as { count: number }).count;
    return counts;
  }

  /** One page of a lens, newest first, read from the lens index; only the page's cards are parsed. */
  lensPage(params: {
    storageKey: string;
    lens: SubAgentLens;
    visibleSince: number;
    excludeMonitorIds?: readonly string[];
    offset: number;
    limit: number;
  }): ThreadSubAgentSummary[] {
    const excluded = JSON.stringify([...new Set(params.excludeMonitorIds ?? [])]);
    const rows = params.lens === "harness"
      ? this.db.prepare(`SELECT card FROM thread_sub_agents INDEXED BY thread_sub_agents_by_lens
          WHERE thread_id = ? AND lens = 'harness'
            AND monitor_id NOT IN (SELECT value FROM json_each(?)) AND ${HARNESS_VISIBLE}
          ORDER BY created_at DESC, monitor_id LIMIT ? OFFSET ?`)
        .all(params.storageKey, excluded, params.visibleSince, params.limit, params.offset)
      : this.db.prepare(`SELECT card FROM thread_sub_agents INDEXED BY thread_sub_agents_by_lens
          WHERE thread_id = ? AND lens = ?
            AND monitor_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY created_at DESC, monitor_id LIMIT ? OFFSET ?`)
        .all(params.storageKey, params.lens, excluded, params.limit, params.offset);
    return parseCards(rows as CardRow[]);
  }

  /**
   * The thread's stored gate totals. A thread that predates the columns has
   * its totals summed from its gate cards once, on this first read.
   */
  gateTotals(storageKey: string): TokenMiserGateAccountingTotals {
    const read = () => this.db.prepare(`SELECT ${GATE_TOTAL_COLUMNS.join(", ")}, gate_totals_ready
      FROM thread_sub_agent_revisions WHERE thread_id = ?`).get(storageKey) as
      (Record<typeof GATE_TOTAL_COLUMNS[number], number> & { gate_totals_ready: number }) | undefined;
    let row = read();
    if (row && row.gate_totals_ready === 0) {
      row = this.db.transaction(() => {
        this.db.prepare(RECOMPUTE_GATE_TOTALS).run(storageKey);
        return read();
      }).immediate();
    }
    return {
      gateCount: row?.gate_count ?? 0,
      pricedCount: row?.gate_priced ?? 0,
      dispositionCount: row?.gate_disposition ?? 0,
      passedThroughCount: row?.gate_passed_through ?? 0,
      summarizedCount: row?.gate_summarized ?? 0,
      decisionSourceCount: row?.gate_decision_source ?? 0,
      helperCount: row?.gate_helper ?? 0,
      terms: {
        withoutGateCostMicros: row?.gate_without_micros ?? 0,
        gateCostMicros: row?.gate_cost_micros ?? 0,
        revealedCostMicros: row?.gate_revealed_micros ?? 0,
        savingsMicros: row?.gate_savings_micros ?? 0,
      },
      avoidedParentTokens: row?.gate_avoided_tokens ?? 0,
    };
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
