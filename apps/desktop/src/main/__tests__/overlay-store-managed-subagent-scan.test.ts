import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
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

function write(threadId: string, fields: Record<string, unknown>, backend: "codex" | "acp:grok" = "codex"): void {
  store["putThread"](buildThreadIdentityKey(backend, threadId), {
    backend, threadId, executionMode: "default", extraLinkedDirectories: [], ...fields,
  });
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

function downgradeRelationshipSchema(): void {
  stateDb.raw.exec(`DROP TRIGGER thread_navigation_relationships_insert;
    DROP TRIGGER thread_navigation_relationships_update;
    DROP TRIGGER thread_navigation_relationships_delete;
    DROP VIEW thread_navigation_relationship_projection;
    DROP TABLE thread_navigation_relationships;`);
  stateDb.raw.pragma("user_version = 63");
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
  it("preserves malformed subagent entry isolation during nested projection", () => {
    seed("primitive-entries", {
      subAgents: ["not-json", 42, false, [], { monitorThreadId: "valid" }],
    });
    seed("null-entry", {
      subAgents: [{ monitorThreadId: "before-null" }, null, { monitorThreadId: "after-null" }],
    });
    seed("invalid-id", {
      subAgents: [{ monitorThreadId: 42 }, { monitorThreadId: "after-invalid-id" }],
    });
    seed("non-array", { subAgents: { monitorThreadId: "not-a-child" } });
    expect(keys()).toEqual(["codex:before-null", "codex:valid"]);
  });

  it("preserves identities, malformed-row isolation, and the grouped handoff exception", async () => {
    seed("parent", {
      subAgents: [
        { monitorThreadId: " child " },
        { monitorThreadId: "parent" },
        { monitorThreadId: "parent", backend: "acp:grok" },
        { monitorThreadId: "child" },
        { monitorThreadId: " " },
        { monitorThreadId: "grouped" },
        { monitorThreadId: "malformed-child" },
      ],
    });
    seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    seed("bad-subagents", { subAgents: { monitorThreadId: "not-an-array" } });
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

  it("reads compact relationships and detects local inserts, updates and deletes", () => {
    expect(keys()).toEqual([]);
    seed("parent", { subAgents: [{ monitorThreadId: "first" }] });
    expect(keys()).toEqual(["codex:first"]);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    expect(keys()).toEqual(["codex:first"]);
    expect(prepare.mock.calls.map(([sql]) => sql).some((sql) => sql.includes("FROM threads"))).toBe(false);
    seed("parent", { subAgents: [{ monitorThreadId: "second" }] });
    expect(keys()).toEqual(["codex:second"]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:parent");
    expect(keys()).toEqual([]);
  });

  it("does not rescan relationships after unrelated local writes", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
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
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
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
      expect(reads.filter((sql) => sql.includes("FROM thread_navigation_relationships"))).toHaveLength(30);
      expect(reads.some((sql) => /\bthreads\b|\bpayload\b/.test(sql))).toBe(false);
    } finally {
      other.close();
    }
  });

  it("backfills once and supports a legacy connection opened before migration", () => {
    const dbPath = useFileStateDb();
    downgradeRelationshipSchema();
    seed("parent", { subAgents: [{ monitorThreadId: "child" }, { monitorThreadId: "grouped" }] });
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
      seed("parent", { subAgents: [{ monitorThreadId: "legacy-child" }] }, legacy);
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
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
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
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
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

  it.each([false, true])("handles replacement, rekey and deletion with recursive triggers %s", (recursive) => {
    stateDb.raw.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    seed("other-parent", { subAgents: [{ monitorThreadId: "child" }] });
    seed("child", { handoffOrigin: { groupingMode: "subthread" } });
    expect(keys()).toEqual([]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:child");
    expect(keys()).toEqual(["codex:child"]);
    stateDb.raw.prepare("UPDATE threads SET thread_id = ? WHERE thread_id = ?").run("codex:renamed", "codex:parent");
    expect(stateDb.raw.prepare("SELECT thread_id FROM thread_navigation_relationships ORDER BY thread_id").all())
      .toEqual([{ thread_id: "codex:other-parent" }, { thread_id: "codex:renamed" }]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:renamed");
    expect(keys()).toEqual(["codex:child"]);
    stateDb.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:other-parent", "malformed");
    expect(keys()).toEqual([]);
  });

  it("maintains changed relationships in the existing overlay commits", async () => {
    useFileStateDb();
    const before = stateDb.raw.prepare("SELECT total_changes() AS n").get() as { n: number };
    const { writes } = await measureSqliteWrites(async () => {
      write("parent", { subAgents: [{ monitorThreadId: "first" }] });
      write("parent", { subAgents: [{ monitorThreadId: "second" }] });
      write("second", { handoffOrigin: { groupingMode: "subthread" } });
      expect(keys()).toEqual([]);
      write("second", {});
      expect(keys()).toEqual(["codex:second"]);
      write("parent", {});
      expect(keys()).toEqual([]);
    });
    const after = stateDb.raw.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(after.n - before.n).toBe(10); // Five overlay writes and five projection mutations.
    expectSqliteWriteBudget({ scenario: "managed-relationships-lifecycle",
      note: "5 overlay writes: add/replace parent child, group/ungroup child, clear parent; no separate relationship commits",
      writes });
  });

  it("does not mutate the projection across ordinary overlay and worker metadata writes", async () => {
    // A real file: this scenario's WAL byte figure is only measurable there.
    useFileStateDb();
    seed("parent", { subAgents: [{ monitorThreadId: "child" }, { monitorThreadId: "grouped" }] });
    seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    const original = store["listManagedSubAgentThreadKeys"]();
    expect([...original]).toEqual(["codex:child"]);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    write("ordinary", {});
    const before = stateDb.raw.prepare("SELECT total_changes() AS n").get() as { n: number };
    const { writes } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 20; i++) {
        write("parent", { immutableUsageActivities: [{ text: "history".repeat(100) }], subAgents: [
          { monitorThreadId: "child", status: String(i), title: String(i) },
          { monitorThreadId: "grouped", task: String(i) },
        ] });
        write("ordinary", { title: String(i) });
        write("grouped", { title: String(i), handoffOrigin: { groupingMode: "subthread" } });
        expect(store["listManagedSubAgentThreadKeys"]()).toEqual(original);
      }
    });
    const after = stateDb.raw.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(after.n - before.n).toBe(60); // Includes trigger writes: no projection rows changed.
    expect(prepare.mock.calls.some(([sql]) => /SELECT[\s\S]*FROM threads/.test(sql))).toBe(false);
    expectSqliteWriteBudget({
      scenario: "managed-subagent-metadata-writes",
      note: "20 parent metadata, 20 ordinary overlay, 20 grouped-child metadata updates and navigation reads; no relationship mutations or additional commits",
      writes,
    });
  });

  it("ignores identity-neutral ordering, duplicates, whitespace, explicit backend fallback and self references", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }, { monitorThreadId: "other" }] });
    const original = store["listManagedSubAgentThreadKeys"]();
    write("parent", { subAgents: [
      { backend: "codex", monitorThreadId: "other" },
      { monitorThreadId: "\u00a0child\u2029" },
      { monitorThreadId: "child" }, { monitorThreadId: "parent" },
    ] });
    expect(store["listManagedSubAgentThreadKeys"]()).toEqual(original);
  });

  it("invalidates for new, removed or redirected parent references and relevant child grouping changes", () => {
    expect(keys()).toEqual([]);
    write("parent", { subAgents: [{ monitorThreadId: "child" }] });
    expect(keys()).toEqual(["codex:child"]);
    write("parent", { subAgents: [{ backend: "acp:grok", monitorThreadId: "child" }] });
    expect(keys()).toEqual(["acp:grok:child"]);
    write("child", { handoffOrigin: { groupingMode: "subthread" } }, "acp:grok");
    expect(keys()).toEqual([]);
    write("child", {}, "acp:grok");
    expect(keys()).toEqual(["acp:grok:child"]);
    write("parent", { subAgents: [{ monitorThreadId: "grouped" }] });
    expect(keys()).toEqual(["codex:grouped"]);
    write("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    expect(keys()).toEqual([]);
    write("grouped", { handoffOrigin: { groupingMode: "none" } });
    expect(keys()).toEqual(["codex:grouped"]);
    write("second-parent", { subAgents: [{ monitorThreadId: "grouped" }] });
    expect(keys()).toEqual(["codex:grouped"]);
    write("parent", {});
    expect(keys()).toEqual(["codex:grouped"]);
    write("second-parent", {});
    expect(keys()).toEqual([]);
  });

  it("invalidates when parent identity changes backend fallback or self-reference filtering", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    expect(keys()).toEqual(["codex:child"]);
    write("parent", { threadId: "child", subAgents: [{ monitorThreadId: "child" }] });
    expect(keys()).toEqual([]);
    write("parent", { backend: "acp:grok", subAgents: [{ monitorThreadId: "child" }] });
    expect(keys()).toEqual(["acp:grok:child"]);
  });

  it("does not hide earlier raw or external changes behind a later known metadata write", () => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    expect(keys()).toEqual(["codex:child"]);
    seed("unknown-parent", { subAgents: [{ monitorThreadId: "raw-child" }] });
    write("parent", { subAgents: [{ monitorThreadId: "child", status: "success" }] });
    expect(keys()).toEqual(["codex:child", "codex:raw-child"]);
    const other = new Database(dbPath);
    try {
      seed("unknown-parent", { subAgents: [{ monitorThreadId: "external-child" }] }, other);
      write("parent", { subAgents: [{ monitorThreadId: "child", status: "failure" }] });
      expect(keys()).toEqual(["codex:child", "codex:external-child"]);
    } finally {
      other.close();
    }
  });

  it("reads transaction changes without leaking rolled-back relationships", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    const original = store["listManagedSubAgentThreadKeys"]();
    stateDb.raw.exec("BEGIN");
    write("parent", { subAgents: [{ monitorThreadId: "child", status: "success" }] });
    stateDb.raw.exec("ROLLBACK");
    expect(store["listManagedSubAgentThreadKeys"]()).toEqual(original);
    stateDb.raw.exec("BEGIN");
    write("parent", { subAgents: [{ monitorThreadId: "new-child" }] });
    write("ordinary", { title: "cannot hide that relationship change" });
    expect(keys()).toEqual(["codex:new-child"]);
    stateDb.raw.exec("SAVEPOINT nested");
    write("parent", { subAgents: [{ monitorThreadId: "nested-child" }] });
    expect(keys()).toEqual(["codex:nested-child"]);
    stateDb.raw.exec("ROLLBACK TO nested");
    expect(keys()).toEqual(["codex:new-child"]);
    stateDb.raw.exec("ROLLBACK");
    expect(keys()).toEqual(["codex:child"]);
    stateDb.raw.transaction(() => {
      write("parent", { subAgents: [{ monitorThreadId: "committed" }] });
      write("ordinary", {});
    })();
    expect(keys()).toEqual(["codex:committed"]);
  });

  it("keeps relationships consistent after failed writes and extra trigger writes", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    const original = store["listManagedSubAgentThreadKeys"]();
    stateDb.raw.exec(`CREATE TEMP TRIGGER reject_write BEFORE INSERT ON threads
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    expect(() => write("parent", { subAgents: [{ monitorThreadId: "child" }] })).toThrow("fixture failure");
    stateDb.raw.exec("DROP TRIGGER reject_write");
    expect(keys()).toEqual(["codex:child"]);
    stateDb.raw.exec(`CREATE TEMP TRIGGER extra_write AFTER INSERT ON threads WHEN NEW.thread_id = 'codex:ordinary'
      BEGIN INSERT OR REPLACE INTO threads(thread_id, payload) VALUES ('codex:extra',
        '{"backend":"codex","threadId":"extra","subAgents":[{"monitorThreadId":"extra-child"}]}'); END`);
    write("ordinary", {});
    expect(keys()).toEqual(["codex:child", "codex:extra-child"]);
    expect(store["listManagedSubAgentThreadKeys"]()).not.toEqual(original);
  });

  it("does not retain an empty set when malformed in-memory fields serialize into valid references", () => {
    expect(keys()).toEqual([]);
    write("parent", { subAgents: [{ monitorThreadId: Number.NaN }, { monitorThreadId: "valid" }] });
    // JSON serializes NaN to null: the durable traversal skips it, then sees valid.
    expect(keys()).toEqual(["codex:valid"]);
    write("parent", { subAgents: [null, { monitorThreadId: "after-null" }] });
    expect(keys()).toEqual([]);
    write("parent", { subAgents: [{ monitorThreadId: "restored" }] });
    expect(keys()).toEqual(["codex:restored"]);
  });

  it("sees shared-profile parent and child changes from another connection", () => {
    const dbPath = useFileStateDb();
    const other = new Database(dbPath);
    try {
      expect(keys()).toEqual([]);
      seed("parent", { subAgents: [{ monitorThreadId: "child" }] }, other);
      expect(keys()).toEqual(["codex:child"]);
      seed("child", { handoffOrigin: { groupingMode: "subthread" } }, other);
      expect(keys()).toEqual([]);
      seed("child", { handoffOrigin: { groupingMode: "none" } }, other);
      expect(keys()).toEqual(["codex:child"]);
      other.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:parent");
      expect(keys()).toEqual([]);
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
          subAgents: [{ monitorThreadId: "other-process-child" }] }));
      db.close();
    `, require.resolve("better-sqlite3"), dbPath]);
    expect(keys()).toEqual(["codex:other-process-child"]);
  });

  it("rolls back the first relationship write", () => {
    stateDb.raw.exec("BEGIN");
    seed("parent", { subAgents: [{ monitorThreadId: "rolled-back" }] });
    expect(keys()).toEqual(["codex:rolled-back"]);
    stateDb.raw.exec("ROLLBACK");
    expect(keys()).toEqual([]);
    seed("parent", { subAgents: [{ monitorThreadId: "committed" }] });
    expect(keys()).toEqual(["codex:committed"]);
  });

  it("does not publish transaction or savepoint results after rollback", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "committed" }] });
    expect(keys()).toEqual(["codex:committed"]);
    stateDb.raw.exec("BEGIN");
    try {
      seed("parent", { subAgents: [{ monitorThreadId: "uncommitted" }] });
      expect(keys()).toEqual(["codex:uncommitted"]);
      stateDb.raw.exec("SAVEPOINT nested");
      seed("parent", { subAgents: [{ monitorThreadId: "savepoint" }] });
      expect(keys()).toEqual(["codex:savepoint"]);
      stateDb.raw.exec("ROLLBACK TO nested");
      expect(keys()).toEqual(["codex:uncommitted"]);
    } finally {
      stateDb.raw.exec("ROLLBACK");
    }
    expect(keys()).toEqual(["codex:committed"]);
  });

  it("reads parent references and grouping flags in one statement snapshot", () => {
    const dbPath = useFileStateDb();
    seed("parent", { subAgents: [{ monitorThreadId: "first" }] });
    const other = new Database(dbPath);
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    let committed = false;
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM thread_navigation_relationships")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = all(...args);
          if (!committed) {
            committed = true;
            other.transaction(() => {
              seed("parent", { subAgents: [{ monitorThreadId: "second" }] }, other);
              seed("first", { handoffOrigin: { groupingMode: "subthread" } }, other);
            })();
          }
          return rows;
        });
      }
      return statement;
    });
    try {
      expect(keys()).toEqual(["codex:first"]);
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
      immutableUsageActivities: largeHistory,
      subAgents: [
        { monitorThreadId: "child", title: "x".repeat(2 * 1024 * 1024) },
        { monitorThreadId: "grouped" },
      ],
    });
    seed("child", { immutableUsageActivities: largeHistory });
    seed("grouped", { immutableUsageActivities: largeHistory, handoffOrigin: { groupingMode: "subthread" } });
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
