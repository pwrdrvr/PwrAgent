import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey, encodeLegacyThreadIdentityKey } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { THREAD_SUB_AGENTS_MOVED_META_KEY } from "../state/thread-sub-agents";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let tempDir: string | undefined;
let stateDb: StateDb;
let store: SqliteOverlayStore;

function seed(threadId: string, fields: Record<string, unknown>, db = stateDb.raw): void {
  db.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)")
    .run(`codex:${threadId}`, JSON.stringify({ backend: "codex", threadId, ...fields }));
}

/**
 * A card running its worker in `monitorThreadId`. Cards are keyed rows: a
 * later card with the same `monitorId` updates this one, a new id adds one.
 */
function card(monitorThreadId: unknown, fields: Record<string, unknown> = {}, monitorId = "worker") {
  return { monitorId, monitorThreadId, ...fields };
}

/** This build's write path: the overlay row, then any cards to their own table. */
function write(threadId: string, fields: Record<string, unknown>, backend: "codex" | "acp:grok" = "codex"): void {
  const { subAgents, ...overlay } = fields;
  const key = buildThreadIdentityKey(backend, threadId);
  store["putThread"](key, {
    backend, threadId, executionMode: "default", extraLinkedDirectories: [], ...overlay,
  });
  if (Array.isArray(subAgents)) {
    store["subAgentTable"].upsert(encodeLegacyThreadIdentityKey(key) ?? key, subAgents);
  }
}

function forget(...threadIds: string[]): Promise<void> {
  return store.forgetThreadArchiveStates(threadIds.map((threadId) => ({ backend: "codex", threadId })));
}

function keys(target = store): string[] {
  return [...target["listManagedSubAgentThreadKeys"]()].sort();
}

/**
 * Move this test onto a real database file and return its path. Two kinds of
 * test here need one: those opening a second connection — another `Database`,
 * or another process — which `:memory:` cannot have, and those asserting a
 * write budget, whose WAL byte figure is only measurable against a file.
 *
 * The path is returned rather than published module-wide so a test cannot
 * reach for it without first claiming a file.
 */
function useFileStateDb(): string {
  stateDb.close();
  const temp = createTempStateDb("pwragent-managed-scan-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new SqliteOverlayStore(stateDb);
  return temp.dbPath;
}

/** A v63 profile: no relationship projection, and no card table either. */
function downgradeRelationshipSchema(): void {
  stateDb.raw.exec(`DROP TRIGGER thread_sub_agents_capture_insert;
    DROP TRIGGER thread_sub_agents_capture_update;
    DROP TABLE thread_sub_agents;
    DROP TABLE thread_sub_agent_revisions;
    DROP TABLE thread_navigation_relationship_generation;
    DROP TRIGGER thread_navigation_relationships_insert;
    DROP TRIGGER thread_navigation_relationships_update;
    DROP TRIGGER thread_navigation_relationships_delete;
    DROP VIEW thread_navigation_relationship_projection;
    DROP TABLE thread_navigation_relationships;`);
  stateDb.raw.prepare("DELETE FROM meta WHERE key = ?").run(THREAD_SUB_AGENTS_MOVED_META_KEY);
  stateDb.raw.pragma("user_version = 63");
}

function downgradeRelationshipGeneration(): void {
  stateDb.raw.exec(`DROP TRIGGER thread_navigation_relationship_generation_insert;
    DROP TRIGGER thread_navigation_relationship_generation_update;
    DROP TRIGGER thread_navigation_relationship_generation_delete;
    DROP TABLE thread_navigation_relationship_generation;`);
  stateDb.raw.pragma("user_version = 75");
}

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  tempDir = undefined;
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  stateDb.close();
  if (tempDir !== undefined) {
    removeTempStateDbDir(tempDir);
  }
});

describe("managed subagent navigation reads", () => {
  it.each([10, 1_000].flatMap((count) =>
    ["unchanged", "local", "external"].map((changes) => ({ count, changes })),
  ))("budgets $changes reads with $count parents", ({ count, changes }) => {
    const dbPath = useFileStateDb();
    stateDb.raw.transaction(() => {
      for (let i = 0; i < count; i++) {
        seed(`parent-${i}`, { subAgents: [card(`child-${i}`)] });
      }
      seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    })();
    const other = new Database(dbPath);
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    let scans = 0;
    let rowsRead = 0;
    let scalarReads = 0;
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM thread_navigation_relationship_generation")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
          scalarReads++;
          return get(...args);
        });
      }
      if (sql.includes("FROM thread_navigation_relationships")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = all(...args);
          scans++;
          rowsRead += rows.length;
          return rows;
        });
      }
      return statement;
    });
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(keys()).toHaveLength(count);
      // One row per card and one for the grouped child, read as columns: no
      // card or payload JSON is parsed to find a parent's children.
      expect({ scans, rowsRead, parses: parse.mock.calls.length })
        .toEqual({ scans: 1, rowsRead: count + 1, parses: 0 });
      const writer = changes === "local" ? stateDb.raw : changes === "external" ? other : undefined;
      scans = 0;
      rowsRead = 0;
      scalarReads = 0;
      let parses = 0;
      for (let i = 0; i < 8; i++) {
        if (writer) {
          seed("ordinary", { title: String(i) }, writer);
          seed("parent-0", { title: String(i), subAgents: [card("child-0", { status: String(i) })] }, writer);
          seed("grouped", { title: String(i), handoffOrigin: { groupingMode: "subthread" } }, writer);
        }
        parse.mockClear();
        expect(keys()).toHaveLength(count);
        parses += parse.mock.calls.length;
      }
      expect({ scans, rowsRead, parses }).toEqual({ scans: 0, rowsRead: 0, parses: 0 });
      expect(scalarReads).toBe(8);
    } finally {
      other.close();
    }
  });

  it("isolates returned set mutations from later reads and other store instances", () => {
    seed("parent", { subAgents: [card("child")] });
    const returned = store["listManagedSubAgentThreadKeys"]();
    returned.clear();
    returned.add("codex:invented");
    expect(keys()).toEqual(["codex:child"]);
    expect(keys(new SqliteOverlayStore(stateDb))).toEqual(["codex:child"]);
  });

  it("migrates a v75 projection without backfilling it and retains its generation on reopen", () => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [card("child")] });
    downgradeRelationshipGeneration();
    const rows = stateDb.raw.prepare("SELECT * FROM thread_navigation_relationships").all();
    stateDb.close();
    const legacy = new Database(dbPath);
    try {
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      expect(stateDb.raw.prepare("SELECT * FROM thread_navigation_relationships").all()).toEqual(rows);
      expect(keys()).toEqual(["codex:child"]);
      seed("parent", { subAgents: [card("new-child")] }, legacy);
      expect(keys()).toEqual(["codex:new-child"]);
      const stamp = stateDb.raw.prepare("SELECT generation FROM thread_navigation_relationship_generation").get();
      expect(stamp).toEqual({ generation: 1 });
      stateDb.close();
      stateDb = StateDb.open(dbPath);
      expect(stateDb.raw.prepare("SELECT generation FROM thread_navigation_relationship_generation").get()).toEqual(stamp);
    } finally {
      legacy.close();
    }
  });

  it("rolls back interrupted generation migration and retries", () => {
    const dbPath = useFileStateDb();
    downgradeRelationshipGeneration();
    stateDb.close();
    const exec = Database.prototype.exec;
    const failedConnections: Database.Database[] = [];
    const spy = vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql) {
      const result = exec.call(this, sql);
      if (sql.includes("CREATE TABLE IF NOT EXISTS thread_navigation_relationship_generation")) {
        failedConnections.push(this);
        throw new Error("interrupted generation migration");
      }
      return result;
    });
    try {
      expect(() => StateDb.open(dbPath)).toThrow("interrupted generation migration");
      expect(failedConnections[0]!.pragma("user_version", { simple: true })).toBe(75);
      expect(failedConnections[0]!.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'thread_navigation_relationship_generation%'").all()).toEqual([]);
    } finally {
      spy.mockRestore();
      for (const connection of failedConnections) connection.close();
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
    }
    expect(keys()).toEqual([]);
    seed("parent", { subAgents: [card("child")] });
    expect(keys()).toEqual(["codex:child"]);
  });

  it.each([false, true])("tracks direct projection writes and rekeys with recursive triggers %s", (recursive) => {
    const dbPath = useFileStateDb();
    const other = new Database(dbPath);
    try {
      for (const writer of [stateDb.raw, other]) {
        writer.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
        expect(keys()).toEqual([]);
        writer.prepare("INSERT INTO thread_navigation_relationships VALUES (?, ?, 0)")
          .run("codex:parent", JSON.stringify(["acp:grok", "parent", [card("child")]]));
        expect(keys()).toEqual(["acp:grok:child"]);
        writer.prepare("INSERT INTO thread_navigation_relationships VALUES (?, NULL, 1)").run("acp%3Agrok:child");
        expect(keys()).toEqual([]);
        writer.prepare("UPDATE thread_navigation_relationships SET thread_id = ? WHERE thread_id = ?")
          .run("acp%3Agrok:other", "acp%3Agrok:child");
        expect(keys()).toEqual(["acp:grok:child"]);
        writer.prepare("UPDATE thread_navigation_relationships SET managed_children = ? WHERE thread_id = ?")
          .run("malformed", "codex:parent");
        expect(keys()).toEqual([]);
        writer.prepare("INSERT OR REPLACE INTO thread_navigation_relationships VALUES (?, ?, 0)")
          .run("codex:parent", JSON.stringify(["codex", "parent", [card("restored")]]));
        expect(keys()).toEqual(["codex:restored"]);
        writer.exec("DELETE FROM thread_navigation_relationships");
        expect(keys()).toEqual([]);
      }
    } finally {
      other.close();
    }
  });

  it("does not reuse a rolled-back generation after a different commit", () => {
    seed("parent", { subAgents: [card("original")] });
    expect(keys()).toEqual(["codex:original"]);
    stateDb.raw.exec("BEGIN");
    seed("parent", { subAgents: [card("rolled-back")] });
    expect(keys()).toEqual(["codex:rolled-back"]);
    stateDb.raw.exec("ROLLBACK");
    seed("parent", { subAgents: [card("committed")] });
    expect(keys()).toEqual(["codex:committed"]);
  });

  it("respects WAL reader snapshots and external uncommitted changes", () => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [card("original")] });
    expect(keys()).toEqual(["codex:original"]);
    const other = new Database(dbPath);
    try {
      other.exec("BEGIN");
      seed("parent", { subAgents: [card("uncommitted")] }, other);
      expect(keys()).toEqual(["codex:original"]);
      other.exec("ROLLBACK");
      stateDb.raw.exec("BEGIN");
      expect(keys()).toEqual(["codex:original"]); // Pin the reader's WAL snapshot.
      seed("parent", { subAgents: [card("committed")] }, other);
      expect(keys()).toEqual(["codex:original"]);
      stateDb.raw.exec("COMMIT");
      expect(keys()).toEqual(["codex:committed"]);
    } finally {
      if (stateDb.raw.inTransaction) stateDb.raw.exec("ROLLBACK");
      if (other.inTransaction) other.exec("ROLLBACK");
      other.close();
    }
  });

  it("isolates malformed card entries from their neighbours", () => {
    seed("primitive-entries", {
      subAgents: ["not-json", 42, false, [], card("valid")],
    });
    seed("null-entry", {
      subAgents: [card("before-null", {}, "a"), null, card("after-null", {}, "b")],
    });
    seed("invalid-id", {
      subAgents: [card(42, {}, "a"), card("after-invalid-id", {}, "b"), { monitorThreadId: "no-monitor-id" }],
    });
    seed("non-array", { subAgents: card("not-a-child") });
    // Each card is its own row, so one bad entry no longer hides the rest.
    expect(keys()).toEqual([
      "codex:after-invalid-id", "codex:after-null", "codex:before-null", "codex:valid",
    ]);
  });

  it("preserves identities, malformed-row isolation, and the grouped handoff exception", async () => {
    seed("parent", {
      subAgents: [
        card(" child ", {}, "a"),
        card("parent", {}, "b"),
        card("parent", { backend: "acp:grok" }, "c"),
        card("child", {}, "d"),
        card(" ", {}, "e"),
        card("grouped", {}, "f"),
        card("malformed-child", {}, "g"),
      ],
    });
    seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    seed("bad-subagents", { subAgents: card("not-an-array") });
    stateDb.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)")
      .run("codex:malformed-parent", '{"monitorThreadId":');
    stateDb.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)")
      .run("codex:malformed-child", "not json");
    expect(keys()).toEqual([
      buildThreadIdentityKey("acp:grok", "parent"), "codex:child", "codex:malformed-child",
    ]);
    const index = store.readNavigationQueryIndex({
      backend: "all",
      threads: ["child", "grouped"].map((id) => ({
        id, title: id, titleSource: "explicit", source: "codex", linkedDirectories: [],
      })),
    });
    expect(index.threads.map((thread) => thread.id)).toEqual(["grouped"]);
    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all", fetchedAt: 1, partial: true,
      threads: ["child", "grouped"].map((id) => ({
        id, title: id, titleSource: "explicit", source: "codex", linkedDirectories: [],
      })),
    });
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["grouped"]);
  });

  it("reads compact relationships and detects local inserts, updates and deletes", async () => {
    expect(keys()).toEqual([]);
    seed("parent", { subAgents: [card("first")] });
    expect(keys()).toEqual(["codex:first"]);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    expect(keys()).toEqual(["codex:first"]);
    expect(prepare.mock.calls.map(([sql]) => sql).some((sql) => sql.includes("FROM threads"))).toBe(false);
    seed("parent", { subAgents: [card("second")] });
    expect(keys()).toEqual(["codex:second"]);
    await forget("parent");
    expect(keys()).toEqual([]);
  });

  it("does not rescan relationships after unrelated local writes", () => {
    seed("parent", { subAgents: [card("child")] });
    expect(keys()).toEqual(["codex:child"]);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    for (let i = 0; i < 15; i++) {
      stateDb.raw.prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)").run("all", String(i));
      expect(keys()).toEqual(["codex:child"]);
    }
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("AS projection FROM threads"))).toHaveLength(0);
  });

  it("never reads overlay payloads after unrelated external commits, including cold and transaction reads", () => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [card("child")] });
    for (let i = 0; i < 100; i++) seed(`ordinary-${i}`, { title: "unrelated".repeat(1000) });
    const other = new Database(dbPath);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    try {
      for (let i = 0; i < 10; i++) {
        other.prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)").run("all", String(i));
        expect(keys()).toEqual(["codex:child"]);
        expect(keys(new SqliteOverlayStore(stateDb))).toEqual(["codex:child"]);
        stateDb.raw.transaction(() => expect(keys()).toEqual(["codex:child"]))();
      }
      const reads = prepare.mock.calls.map(([sql]) => sql);
      expect(reads.filter((sql) => sql.includes("FROM thread_navigation_relationships"))).toHaveLength(21);
      expect(reads.some((sql) => /\bthreads\b|\bpayload\b/.test(sql))).toBe(false);
    } finally {
      other.close();
    }
  });

  it("backfills once and supports a legacy connection opened before migration", () => {
    const dbPath = useFileStateDb();
    downgradeRelationshipSchema();
    seed("parent", { subAgents: [card("child"), card("grouped", {}, "grouped-worker")] });
    seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    stateDb.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:broken", "not json");
    const payloads = stateDb.raw.prepare("SELECT thread_id, payload FROM threads ORDER BY thread_id").all();
    stateDb.close();
    const legacy = new Database(dbPath);
    try {
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
      expect(keys()).toEqual(["codex:child"]);
      expect(stateDb.raw.prepare("SELECT thread_id, payload FROM threads ORDER BY thread_id").all()).toEqual(payloads);
      seed("parent", { subAgents: [card("legacy-child")] }, legacy);
      expect(keys()).toEqual(["codex:legacy-child"]);
      stateDb.close();
      const exec = vi.spyOn(Database.prototype, "exec");
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      expect(exec.mock.calls.some(([sql]) => sql.includes("CREATE TABLE thread_navigation_relationships"))).toBe(false);
      expect(keys()).toEqual(["codex:legacy-child"]);
    } finally {
      legacy.close();
    }
  });

  it("rolls back interrupted backfill and retries without changing authoritative payloads", () => {
    const dbPath = useFileStateDb();
    downgradeRelationshipSchema();
    seed("parent", { subAgents: [card("child")] });
    stateDb.close();
    const exec = Database.prototype.exec;
    const failedConnections: Database.Database[] = [];
    const spy = vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql) {
      const result = exec.call(this, sql);
      if (sql.includes("CREATE TABLE thread_navigation_relationships")) {
        failedConnections.push(this);
        throw new Error("interrupted backfill");
      }
      return result;
    });
    try {
      expect(() => StateDb.open(dbPath)).toThrow("interrupted backfill");
      expect(failedConnections[0]!.pragma("user_version", { simple: true })).toBe(63);
      expect(failedConnections[0]!.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'thread_navigation_relationship%'").all()).toEqual([]);
    } finally {
      spy.mockRestore();
      for (const connection of failedConnections) connection.close();
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
    }
    expect(keys()).toEqual(["codex:child"]);
  });

  it("rechecks schema version after a competing opener finishes migration", () => {
    const dbPath = useFileStateDb();
    downgradeRelationshipSchema();
    seed("parent", { subAgents: [card("child")] });
    stateDb.close();
    const transaction = Database.prototype.transaction;
    let competed = false;
    const spy = vi.spyOn(Database.prototype, "transaction").mockImplementation(function(this: Database.Database, callback) {
      const result = transaction.call(this, callback);
      const immediate = result.immediate;
      const wrapped = (...args: unknown[]) => result(...args);
      Object.defineProperties(wrapped, {
        ...Object.getOwnPropertyDescriptors(result),
        immediate: { value: (...args: unknown[]) => {
          if (!competed) {
            competed = true;
            const other = StateDb.open(dbPath);
            other.close();
          }
          return immediate(...args);
        } },
      });
      return wrapped as typeof result;
    });
    try {
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      expect(competed).toBe(true);
      expect(keys()).toEqual(["codex:child"]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])("keeps cards through older-writer replacement and deletion with recursive triggers %s", async (recursive) => {
    stateDb.raw.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
    seed("parent", { subAgents: [card("child")] });
    seed("other-parent", { subAgents: [card("child")] });
    seed("child", { handoffOrigin: { groupingMode: "subthread" } });
    expect(keys()).toEqual([]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:child");
    expect(keys()).toEqual(["codex:child"]);
    // An older build replaces the whole row from a copy that no longer holds
    // the cards. With recursive triggers on, the replace fires delete
    // triggers; neither path may erase them.
    seed("parent", { title: "rewritten" });
    stateDb.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:other-parent", "malformed");
    expect(keys()).toEqual(["codex:child"]);
    await forget("parent");
    expect(keys()).toEqual(["codex:child"]);
    await forget("other-parent");
    expect(keys()).toEqual([]);
  });

  it("maintains changed relationships in the existing overlay commits", async () => {
    useFileStateDb();
    const { writes } = await measureSqliteWrites(async () => {
      write("parent", { subAgents: [card("first")] });
      write("parent", { subAgents: [card("second")] });
      write("second", { handoffOrigin: { groupingMode: "subthread" } });
      expect(keys()).toEqual([]);
      write("second", {});
      expect(keys()).toEqual(["codex:second"]);
      await forget("parent");
      expect(keys()).toEqual([]);
    });
    expectSqliteWriteBudget({ scenario: "managed-relationships-lifecycle",
      note: "add a parent's card, redirect it, group/ungroup the child, forget the parent: each overlay or card write is one commit, and the projection, revision and generation rows share it",
      writes });
  });

  it("does not mutate the projection across ordinary overlay and worker metadata writes", async () => {
    // A real file: this scenario's WAL byte figure is only measurable there.
    useFileStateDb();
    seed("parent", { subAgents: [card("child"), card("grouped", {}, "grouped-worker")] });
    seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    const original = store["listManagedSubAgentThreadKeys"]();
    expect([...original]).toEqual(["codex:child"]);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    write("ordinary", {});
    const before = stateDb.raw.prepare("SELECT total_changes() AS n").get() as { n: number };
    const { writes } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 20; i++) {
        write("parent", { managedReviewEntries: [{ text: "history".repeat(100) }], subAgents: [
          card("child", { status: String(i), title: String(i) }),
          card("grouped", { task: String(i) }, "grouped-worker"),
        ] });
        write("ordinary", { title: String(i) });
        write("grouped", { title: String(i), handoffOrigin: { groupingMode: "subthread" } });
        expect(store["listManagedSubAgentThreadKeys"]()).toEqual(original);
      }
    });
    const after = stateDb.raw.prepare("SELECT total_changes() AS n").get() as { n: number };
    // Per round: three overlay rows, two changed cards and their revision
    // counter. No projection or generation row changes.
    expect(after.n - before.n).toBe(20 * 7);
    expect(prepare.mock.calls.some(([sql]) => /SELECT[\s\S]*FROM threads/.test(sql))).toBe(false);
    expectSqliteWriteBudget({
      scenario: "managed-subagent-metadata-writes",
      note: "20 rounds of parent metadata with two changed cards, an ordinary overlay and a grouped-child update, with navigation reads; no relationship mutations",
      writes,
    });
  });

  it("ignores identity-neutral ordering, duplicates, whitespace, explicit backend fallback and self references", () => {
    seed("parent", { subAgents: [card("child", {}, "a"), card("other", {}, "b")] });
    const original = store["listManagedSubAgentThreadKeys"]();
    write("parent", { subAgents: [
      card("other", { backend: "codex" }, "b"),
      card("\u00a0child\u2029", {}, "a"),
      card("child", {}, "c"), card("parent", {}, "d"),
    ] });
    expect(store["listManagedSubAgentThreadKeys"]()).toEqual(original);
  });

  it("invalidates for new, removed or redirected parent references and relevant child grouping changes", async () => {
    expect(keys()).toEqual([]);
    write("parent", { subAgents: [card("child")] });
    expect(keys()).toEqual(["codex:child"]);
    write("parent", { subAgents: [card("child", { backend: "acp:grok" })] });
    expect(keys()).toEqual(["acp:grok:child"]);
    write("child", { handoffOrigin: { groupingMode: "subthread" } }, "acp:grok");
    expect(keys()).toEqual([]);
    write("child", {}, "acp:grok");
    expect(keys()).toEqual(["acp:grok:child"]);
    write("parent", { subAgents: [card("grouped")] });
    expect(keys()).toEqual(["codex:grouped"]);
    write("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    expect(keys()).toEqual([]);
    write("grouped", { handoffOrigin: { groupingMode: "none" } });
    expect(keys()).toEqual(["codex:grouped"]);
    write("second-parent", { subAgents: [card("grouped")] });
    expect(keys()).toEqual(["codex:grouped"]);
    await forget("parent");
    expect(keys()).toEqual(["codex:grouped"]);
    await forget("second-parent");
    expect(keys()).toEqual([]);
  });

  it("takes the parent identity from the row key for backend fallback and self references", () => {
    write("loop", { subAgents: [card("loop")] });
    expect(keys()).toEqual([]);
    write("loop", { subAgents: [card("loop", { backend: "acp:grok" })] });
    expect(keys()).toEqual(["acp:grok:loop"]);
    write("parent", { subAgents: [card("child")] }, "acp:grok");
    expect(keys()).toEqual(["acp:grok:child", "acp:grok:loop"]);
  });

  it("does not hide earlier raw or external changes behind a later known metadata write", () => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [card("child")] });
    expect(keys()).toEqual(["codex:child"]);
    seed("unknown-parent", { subAgents: [card("raw-child")] });
    write("parent", { subAgents: [card("child", { status: "success" })] });
    expect(keys()).toEqual(["codex:child", "codex:raw-child"]);
    const other = new Database(dbPath);
    try {
      seed("unknown-parent", { subAgents: [card("external-child")] }, other);
      write("parent", { subAgents: [card("child", { status: "failure" })] });
      expect(keys()).toEqual(["codex:child", "codex:external-child"]);
    } finally {
      other.close();
    }
  });

  it("reads transaction changes without leaking rolled-back relationships", () => {
    seed("parent", { subAgents: [card("child")] });
    const original = store["listManagedSubAgentThreadKeys"]();
    stateDb.raw.exec("BEGIN");
    write("parent", { subAgents: [card("child", { status: "success" })] });
    stateDb.raw.exec("ROLLBACK");
    expect(store["listManagedSubAgentThreadKeys"]()).toEqual(original);
    stateDb.raw.exec("BEGIN");
    write("parent", { subAgents: [card("new-child")] });
    write("ordinary", { title: "cannot hide that relationship change" });
    expect(keys()).toEqual(["codex:new-child"]);
    stateDb.raw.exec("SAVEPOINT nested");
    write("parent", { subAgents: [card("nested-child")] });
    expect(keys()).toEqual(["codex:nested-child"]);
    stateDb.raw.exec("ROLLBACK TO nested");
    expect(keys()).toEqual(["codex:new-child"]);
    stateDb.raw.exec("ROLLBACK");
    expect(keys()).toEqual(["codex:child"]);
    stateDb.raw.transaction(() => {
      write("parent", { subAgents: [card("committed")] });
      write("ordinary", {});
    })();
    expect(keys()).toEqual(["codex:committed"]);
  });

  it("keeps relationships consistent after failed writes and extra trigger writes", () => {
    seed("parent", { subAgents: [card("child")] });
    const original = store["listManagedSubAgentThreadKeys"]();
    stateDb.raw.exec(`CREATE TEMP TRIGGER reject_write BEFORE INSERT ON threads
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    expect(() => write("parent", { subAgents: [card("child")] })).toThrow("fixture failure");
    stateDb.raw.exec("DROP TRIGGER reject_write");
    expect(keys()).toEqual(["codex:child"]);
    stateDb.raw.exec(`CREATE TEMP TRIGGER extra_write AFTER INSERT ON threads WHEN NEW.thread_id = 'codex:ordinary'
      BEGIN INSERT OR REPLACE INTO threads(thread_id, payload) VALUES ('codex:extra',
        '{"backend":"codex","threadId":"extra","subAgents":[{"monitorId":"worker","monitorThreadId":"extra-child"}]}'); END`);
    write("ordinary", {});
    expect(keys()).toEqual(["codex:child", "codex:extra-child"]);
    expect(store["listManagedSubAgentThreadKeys"]()).not.toEqual(original);
  });

  it("skips and invalidates cards whose worker id is not a string", () => {
    expect(keys()).toEqual([]);
    write("parent", { subAgents: [card(Number.NaN, {}, "a"), card("valid", {}, "b")] });
    expect(keys()).toEqual(["codex:valid"]);
    write("parent", { subAgents: [card(Number.NaN, {}, "b")] });
    expect(keys()).toEqual([]);
    write("parent", { subAgents: [card("restored", {}, "b")] });
    expect(keys()).toEqual(["codex:restored"]);
  });

  it("sees shared-profile parent and child changes from another connection", () => {
    const dbPath = useFileStateDb();
    const other = new Database(dbPath);
    try {
      expect(keys()).toEqual([]);
      seed("parent", { subAgents: [card("child")] }, other);
      expect(keys()).toEqual(["codex:child"]);
      seed("child", { handoffOrigin: { groupingMode: "subthread" } }, other);
      expect(keys()).toEqual([]);
      seed("child", { handoffOrigin: { groupingMode: "none" } }, other);
      expect(keys()).toEqual(["codex:child"]);
      seed("parent", { subAgents: [card("redirected")] }, other);
      expect(keys()).toEqual(["codex:redirected"]);
    } finally {
      other.close();
    }
  });

  it("sees a commit from an independent profile process on the very next read", () => {
    const dbPath = useFileStateDb();
    expect(keys()).toEqual([]);
    const require = createRequire(import.meta.url);
    execFileSync(process.execPath, ["-e", `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2]);
      db.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(
        "codex:parent", JSON.stringify({ backend: "codex", threadId: "parent",
          subAgents: [{ monitorId: "worker", monitorThreadId: "other-process-child" }] }));
      db.close();
    `, require.resolve("better-sqlite3"), dbPath]);
    expect(keys()).toEqual(["codex:other-process-child"]);
  });

  it("rolls back the first relationship write", () => {
    stateDb.raw.exec("BEGIN");
    seed("parent", { subAgents: [card("rolled-back")] });
    expect(keys()).toEqual(["codex:rolled-back"]);
    stateDb.raw.exec("ROLLBACK");
    expect(keys()).toEqual([]);
    seed("parent", { subAgents: [card("committed")] });
    expect(keys()).toEqual(["codex:committed"]);
  });

  it("does not publish transaction or savepoint results after rollback", () => {
    seed("parent", { subAgents: [card("committed")] });
    expect(keys()).toEqual(["codex:committed"]);
    stateDb.raw.exec("BEGIN");
    try {
      seed("parent", { subAgents: [card("uncommitted")] });
      expect(keys()).toEqual(["codex:uncommitted"]);
      stateDb.raw.exec("SAVEPOINT nested");
      seed("parent", { subAgents: [card("savepoint")] });
      expect(keys()).toEqual(["codex:savepoint"]);
      stateDb.raw.exec("ROLLBACK TO nested");
      expect(keys()).toEqual(["codex:uncommitted"]);
    } finally {
      stateDb.raw.exec("ROLLBACK");
    }
    expect(keys()).toEqual(["codex:committed"]);
  });

  it.each(["before", "after"])("reads one relationship snapshot when an external writer commits %s the row read", (timing) => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [card("first")] });
    const other = new Database(dbPath);
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    let committed = false;
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM thread_navigation_relationships")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = timing === "after" ? all(...args) : undefined;
          if (!committed) {
            committed = true;
            other.transaction(() => {
              seed("parent", { subAgents: [card("second")] }, other);
              seed("first", { handoffOrigin: { groupingMode: "subthread" } }, other);
            })();
          }
          return rows ?? all(...args);
        });
      }
      return statement;
    });
    try {
      expect(keys()).toEqual([timing === "after" ? "codex:first" : "codex:second"]);
      expect(keys()).toEqual(["codex:second"]);
    } finally {
      other.close();
    }
  });

  it("bounds relationship materialization and adds no writes", async () => {
    // A real file: this scenario's WAL byte figure is only measurable there.
    useFileStateDb();
    const largeHistory = Array.from({ length: 2_000 }, (_, id) => ({ id, text: "fixture".repeat(40) }));
    seed("parent", {
      managedReviewEntries: largeHistory,
      subAgents: [
        card("child", { title: "x".repeat(2 * 1024 * 1024) }),
        card("grouped", {}, "grouped-worker"),
      ],
    });
    seed("child", { managedReviewEntries: largeHistory });
    seed("grouped", { managedReviewEntries: largeHistory, handoffOrigin: { groupingMode: "subthread" } });
    stateDb.raw.prepare("INSERT INTO backends(scope, payload) VALUES (?, ?)").run("all", JSON.stringify({
      knownThreadKeys: ["acp%3Agrok:child"], lastSnapshotHash: "hash",
    }));
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    let largestResultBytes = 0;
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
        const rows = all(...params);
        largestResultBytes = Math.max(largestResultBytes, Buffer.byteLength(JSON.stringify(rows)));
        return rows;
      });
      return statement;
    });
    const parse = vi.spyOn(JSON, "parse");
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 10; index += 1) {
        const fresh = new SqliteOverlayStore(stateDb);
        expect(keys(fresh)).toEqual(["codex:child"]);
        expect(keys(fresh)).toEqual(["codex:child"]);
        expect(fresh["getBackend"]("all")?.knownThreadKeys).toEqual(["acp:grok:child"]);
        fresh["getBackend"]("all");
      }
    });
    // Neither child payload may cross into JSON.parse, and the parent only
    // supplies its relationship projection. This is deterministic, not a clock.
    expect(Math.max(...parse.mock.calls.map(([text]) => text.length))).toBeLessThan(1_024);
    expect(largestResultBytes).toBeLessThan(1_024);
    expectSqliteWriteBudget({
      scenario: "managed-subagent-navigation-reads",
      note: "10 cold and 10 warm managed-child/backend reads, with large parent and child overlays",
      writes,
    });
  });

  it("normalizes backend keys once per identical payload while observing replacements and deletion", () => {
    const dbPath = useFileStateDb();
    const other = new Database(dbPath);
    const write = (scope: string, key: string) => other.prepare(
      "INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)",
    ).run(scope, JSON.stringify({ knownThreadKeys: [key], lastSnapshotHash: scope }));
    try {
      write("all", "acp%3Agrok:first");
      expect(store["getBackend"]("all")?.knownThreadKeys).toEqual(["acp:grok:first"]);
      const parse = vi.spyOn(JSON, "parse");
      expect(store["getBackend"]("all")?.knownThreadKeys).toEqual(["acp:grok:first"]);
      expect(parse).not.toHaveBeenCalled();
      write("all", "acp%3Agrok:second");
      expect(store["getBackend"]("all")?.knownThreadKeys).toEqual(["acp:grok:second"]);
      write("codex", "codex:third");
      expect(store["getBackend"]("codex")?.knownThreadKeys).toEqual(["codex:third"]);
      other.prepare("DELETE FROM backends WHERE scope = ?").run("all");
      expect(store["getBackend"]("all")).toBeUndefined();
    } finally {
      other.close();
    }
  });
});
