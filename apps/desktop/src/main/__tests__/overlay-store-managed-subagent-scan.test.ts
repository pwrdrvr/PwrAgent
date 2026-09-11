import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let dbPath: string;
let tempDir: string;
let stateDb: StateDb;
let store: SqliteOverlayStore;

function seed(threadId: string, fields: Record<string, unknown>, db = stateDb.raw): void {
  db.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)")
    .run(`codex:${threadId}`, JSON.stringify({ backend: "codex", threadId, ...fields }));
}

function keys(target = store): string[] {
  return [...target["listManagedSubAgentThreadKeys"]()].sort();
}

beforeEach(() => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  ({ dbPath, tempDir } = createTempStateDb("pwragent-managed-scan-"));
  stateDb = StateDb.open(dbPath);
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  stateDb.close();
  removeTempStateDbDir(tempDir);
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
    const candidates = ["child", "grouped"].map((id) => ({
      id, title: id, titleSource: "explicit" as const, source: "codex" as const, linkedDirectories: [],
    }));
    const index = store.readNavigationQueryIndex({ backend: "all", threads: candidates });
    expect(index.threads.map((thread) => thread.id)).toEqual(["grouped"]);
    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all", fetchedAt: 1, partial: true,
      threads: ["child", "grouped"].map((id) => ({
        id, title: id, titleSource: "explicit", source: "codex", linkedDirectories: [],
      })),
    });
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["grouped"]);
  });

  it("reads only relationships and detects local inserts, replacements, updates and deletes", () => {
    expect(keys()).toEqual([]);
    seed("parent", { subAgents: [{ monitorThreadId: "first" }] });
    expect(keys()).toEqual(["codex:first"]);
    const prepare = vi.spyOn(stateDb.raw, "prepare");
    expect(keys()).toEqual(["codex:first"]);
    expect(prepare.mock.calls.map(([sql]) => sql).some((sql) => sql.includes("FROM threads"))).toBe(false);
    stateDb.raw.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?")
      .run(JSON.stringify({ backend: "codex", threadId: "parent", subAgents: [{ monitorThreadId: "second" }] }), "codex:parent");
    expect(keys()).toEqual(["codex:second"]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:parent");
    expect(keys()).toEqual([]);
  });

  it("reads a sparse table after unrelated overlay updates, with no payload query", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    for (let i = 0; i < 100; i++) seed(`ordinary-${i}`, { title: "unrelated" });
    expect(stateDb.raw.prepare("SELECT count(*) AS count FROM thread_navigation_relationships").get()).toEqual({ count: 1 });
    for (let i = 0; i < 15; i++) {
      seed(`ordinary-${i}`, { title: "changed" });
      seed("parent", { title: String(i), subAgents: [{ monitorThreadId: "child", task: String(i) }] });
      const prepare = vi.spyOn(stateDb.raw, "prepare");
      expect(keys()).toEqual(["codex:child"]);
      expect(prepare.mock.calls.map(([sql]) => sql)).toEqual([
        "SELECT thread_id, managed_children AS projection, grouped_subthread FROM thread_navigation_relationships",
      ]);
      prepare.mockRestore();
    }
    const plan = stateDb.raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM thread_navigation_relationships").all();
    expect(plan).toEqual([expect.objectContaining({ detail: "SCAN thread_navigation_relationships" })]);
  });

  it("preserves multiple parents, missing children, Unicode trim and ACP identity storage", () => {
    seed("first-parent", { subAgents: [{ backend: "acp:grok", monitorThreadId: "\u00a0shared\u2029" }] });
    seed("second-parent", { subAgents: [{ backend: "acp:grok", monitorThreadId: "shared" }] });
    expect(keys()).toEqual(["acp:grok:shared"]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:first-parent");
    expect(keys()).toEqual(["acp:grok:shared"]);
    stateDb.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run(
      "acp%3Agrok:shared", JSON.stringify({ handoffOrigin: { groupingMode: "subthread" } }),
    );
    expect(keys()).toEqual([]);
    stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("acp%3Agrok:shared");
    expect(keys()).toEqual(["acp:grok:shared"]);
    seed("second-parent", {});
    expect(keys()).toEqual([]);
    expect(stateDb.raw.prepare("SELECT count(*) AS count FROM thread_navigation_relationships").get()).toEqual({ count: 0 });
  });

  it("does not rewrite relationships for status, title, history or unrelated-table writes", async () => {
    seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
    seed("ordinary", {});
    // A trigger-side assertion observes actual projection mutations; the write
    // metrics wrapper's statement.changes cannot count rows written by triggers.
    stateDb.raw.exec(`CREATE TEMP TRIGGER forbid_relationship_update BEFORE UPDATE ON thread_navigation_relationships
      BEGIN SELECT RAISE(ABORT, 'unrelated update wrote relationships'); END`);
    const beforeChanges = stateDb.raw.prepare("SELECT total_changes() AS count").get() as { count: number };
    const { writes } = await measureSqliteWrites(async () => {
      for (let i = 0; i < 20; i++) {
        seed("parent", { immutableUsageActivities: [{ text: "history".repeat(100) }], subAgents: [
          { monitorThreadId: "child", status: String(i), title: String(i) },
        ] });
        seed("ordinary", { title: String(i) });
        stateDb.raw.prepare("INSERT OR REPLACE INTO backends(scope, payload) VALUES (?, ?)").run("all", String(i));
        expect(keys()).toEqual(["codex:child"]);
      }
    });
    const afterChanges = stateDb.raw.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(afterChanges.count - beforeChanges.count).toBe(60);
    expectSqliteWriteBudget({ scenario: "managed-relationships-unrelated-writes",
      note: "20 parent metadata, 20 ordinary overlay, 20 backend updates; zero relationship mutations or additional commits",
      writes });
  });

  it("backfills existing overlays atomically and does not rebuild on reopen", () => {
    stateDb.raw.exec(`DROP TRIGGER thread_navigation_relationships_insert;
      DROP TRIGGER thread_navigation_relationships_update;
      DROP TRIGGER thread_navigation_relationships_delete;
      DROP VIEW thread_navigation_relationship_projection;
      DROP TABLE thread_navigation_relationships;`);
    stateDb.raw.pragma("user_version = 61");
    seed("parent", { subAgents: [{ monitorThreadId: "managed" }, { monitorThreadId: "grouped" }] });
    seed("grouped", { handoffOrigin: { groupingMode: "subthread" } });
    stateDb.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:broken", "not json");
    const payloads = stateDb.raw.prepare("SELECT thread_id, payload FROM threads ORDER BY thread_id").all();
    stateDb.close();
    // An already-open legacy writer learns persistent triggers when the schema
    // changes; it does not need to reopen or register application functions.
    const legacy = new Database(dbPath);
    try {
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(CURRENT_STATE_DB_USER_VERSION);
      expect(keys()).toEqual(["codex:managed"]);
      expect(stateDb.raw.prepare("SELECT thread_id, payload FROM threads ORDER BY thread_id").all()).toEqual(payloads);
      seed("parent", { subAgents: [{ monitorThreadId: "new-child" }] }, legacy);
      expect(keys()).toEqual(["codex:new-child"]);
      stateDb.close();
      const exec = vi.spyOn(Database.prototype, "exec");
      stateDb = StateDb.open(dbPath);
      store = new SqliteOverlayStore(stateDb);
      expect(keys()).toEqual(["codex:new-child"]);
      expect(exec.mock.calls.some(([sql]) => sql.includes("thread_navigation_relationship_projection"))).toBe(false);
    } finally {
      legacy.close();
    }
  });

  it("cleans up a renamed or replaced parent with recursive triggers enabled or disabled", () => {
    for (const recursive of [false, true]) {
      stateDb.raw.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
      seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
      stateDb.raw.prepare("UPDATE threads SET thread_id = ? WHERE thread_id = ?").run("codex:renamed", "codex:parent");
      expect(keys()).toEqual(["codex:child"]);
      stateDb.raw.prepare("DELETE FROM threads WHERE thread_id = ?").run("codex:renamed");
      expect(keys()).toEqual([]);
      seed("parent", { subAgents: [{ monitorThreadId: "child" }] });
      stateDb.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:parent", "malformed");
      expect(keys()).toEqual([]);
    }
  });

  it("maintains changed relationships in the existing overlay commit", async () => {
    seed("parent", {});
    const beforeChanges = stateDb.raw.prepare("SELECT total_changes() AS count").get() as { count: number };
    const { writes } = await measureSqliteWrites(async () => {
      seed("parent", { subAgents: [{ monitorThreadId: "first" }] });
      seed("parent", { subAgents: [{ monitorThreadId: "second" }] });
      seed("second", { handoffOrigin: { groupingMode: "subthread" } });
      expect(keys()).toEqual([]);
      seed("second", {});
      expect(keys()).toEqual(["codex:second"]);
      seed("parent", {});
      expect(keys()).toEqual([]);
    });
    const afterChanges = stateDb.raw.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(afterChanges.count - beforeChanges.count).toBe(10); // 5 overlays + 5 relationship changes.
    expectSqliteWriteBudget({ scenario: "managed-relationships-lifecycle",
      note: "5 overlay writes: add/replace parent child, group/ungroup child, clear parent; no separate relationship commits",
      writes });
  });

  it("sees shared-profile parent and child changes from another connection", () => {
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

  it("reads a first-read transaction without retaining its rolled-back relationships", () => {
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

  it("reads parent and child facts from one snapshot across a concurrent external commit", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "first" }] });
    const other = new Database(dbPath);
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    let committed = false;
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("FROM thread_navigation_relationships")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...params: unknown[]) => {
          const rows = all(...params);
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

  it("bounds relationship materialization independently of overlay size and adds no writes", async () => {
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
    // Neither parent nor child payload is read. This is deterministic, not a clock.
    expect(Math.max(...parse.mock.calls.map(([text]) => text.length))).toBeLessThan(1_024);
    expect(largestResultBytes).toBeLessThan(1_024);
    expectSqliteWriteBudget({
      scenario: "managed-subagent-navigation-reads",
      note: "10 cold and 10 warm managed-child/backend reads, with large parent and child overlays",
      writes,
    });
  });

  it("normalizes backend keys once per identical payload while observing replacements and deletion", () => {
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
