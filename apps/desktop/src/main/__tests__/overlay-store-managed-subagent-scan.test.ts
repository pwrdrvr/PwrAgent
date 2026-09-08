import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
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
    const snapshot = await store.reconcileNavigationSnapshot({
      backend: "all", fetchedAt: 1, partial: true,
      threads: ["child", "grouped"].map((id) => ({
        id, title: id, titleSource: "explicit", source: "codex", linkedDirectories: [],
      })),
    });
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(["grouped"]);
  });

  it("reuses only unchanged reads and detects local inserts, updates and deletes", () => {
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

  it("does not certify a scan with a concurrent commit's newer generation", () => {
    seed("parent", { subAgents: [{ monitorThreadId: "first" }] });
    const other = new Database(dbPath);
    const prepare = stateDb.raw.prepare.bind(stateDb.raw);
    let committed = false;
    vi.spyOn(stateDb.raw, "prepare").mockImplementation((sql) => {
      // Commit after the parent query but before the child query. That first
      // result may reflect the prior snapshot, but it must not remain cached.
      if (!committed && sql.includes("WHERE thread_id IN")) {
        committed = true;
        seed("parent", { subAgents: [{ monitorThreadId: "second" }] }, other);
      }
      return prepare(sql);
    });
    try {
      expect(keys()).toEqual(["codex:first"]);
      expect(keys()).toEqual(["codex:second"]);
    } finally {
      other.close();
    }
  });

  it("bounds materialization for both parent and candidate queries and adds no writes", async () => {
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
