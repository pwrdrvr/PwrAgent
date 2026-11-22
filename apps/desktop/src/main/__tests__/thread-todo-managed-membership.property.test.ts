import Database from "better-sqlite3";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { ThreadTodo, ThreadTodoFeedDelta } from "@pwragent/shared/contracts/thread-todos";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { ThreadTodoFeed } from "../thread-todos/thread-todo-feed";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const owner = { backend: "codex", threadId: "requested" } as const;
const card: ThreadTodo = {
  ...owner, id: "todo", kind: "reminder", status: "open", title: "Contrived card", createdAt: 1, updatedAt: 1,
};

it("keeps membership reads for one To-dos owner independent of unrelated managed children", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-todo-membership-");
  const state = StateDb.open(dbPath);
  const writer = new Database(dbPath);
  try {
    const store = new SqliteOverlayStore(state);
    const upsert = writer.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)");
    function writeParent(i: number, child: string): void {
      const threadId = `parent-${i}`;
      upsert.run(`codex:${threadId}`, JSON.stringify({
        backend: "codex", threadId, subAgents: [{ monitorId: "worker", monitorThreadId: child }],
      }));
    }
    let rowsRead = 0;
    let plan: string[] = [];
    const prepare = state.raw.prepare.bind(state.raw);
    vi.spyOn(state.raw, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (/FROM thread_(?:navigation_relationships|sub_agents)\b/.test(sql)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          if (args.length > 0 && plan.length === 0) {
            plan = (prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as Array<{ detail: string }>)
              .map(({ detail }) => detail);
          }
          const rows = all(...args);
          rowsRead += rows.length;
          return rows;
        });
      }
      return statement;
    });
    const deltas: ThreadTodoFeedDelta[] = [];
    const feed = new ThreadTodoFeed({
      readOpenCards: () => [card],
      loadOwners: async () => [{ id: owner.threadId, source: owner.backend, title: "Requested" }],
      managedThreadKeys: (keys) => keys === undefined
        ? store.readManagedSubAgentThreadKeys()
        : store.readManagedSubAgentThreadKeysForOwners(keys),
      withDispatchDefaults: async (todos) => todos,
      mergeMethods: () => ({ defaultMethod: "squash", byProject: {} }),
    }, (delta) => deltas.push(delta));
    await feed.snapshot();
    const legacy = writer.prepare(`INSERT INTO thread_navigation_relationships(thread_id, managed_children, grouped_subthread)
      VALUES (?, ?, 0)`);
    async function check(unrelated: number): Promise<void> {
      writer.transaction(() => {
        writer.exec("DELETE FROM thread_sub_agents; DELETE FROM thread_navigation_relationships;");
        for (let i = 1; i <= unrelated; i++) {
          writeParent(i, `unrelated-${i}`);
          legacy.run(`codex:legacy-${i}`, JSON.stringify(["codex", `legacy-${i}`, [
            { monitorThreadId: `unrelated-legacy-${i}` },
          ]]));
        }
      })();
      deltas.length = 0;
      writeParent(0, owner.threadId);
      rowsRead = 0;
      feed.cardsChanged(owner);
      await feed.idle();
      expect((await feed.snapshot()).todos).toEqual([]);
      expect(rowsRead).toBe(1);
      writeParent(0, "other");
      rowsRead = 0;
      feed.cardsChanged(owner);
      await feed.idle();
      expect((await feed.snapshot()).todos.map((todo) => todo.id)).toEqual([card.id]);
      expect(rowsRead).toBe(0);
      expect(deltas).toMatchObject([{ removedIds: [card.id] }, { upserts: [{ id: card.id }] }]);
    }
    // The smallest counterexample on main also pins the plain case.
    await check(2);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 40 }), check), { numRuns: 25 });
    for (const index of ["thread_sub_agents_child", "thread_sub_agents_padded_child",
      "sqlite_autoindex_thread_navigation_relationships_1"]) {
      expect(plan.some((detail) => detail.startsWith("SEARCH ") && detail.includes(index)), plan.join("\n")).toBe(true);
    }
    expect(plan.some((detail) => /thread_managed_legacy_search VIRTUAL TABLE INDEX .*:M/.test(detail)), plan.join("\n"))
      .toBe(true);
  } finally {
    vi.restoreAllMocks();
    writer.close();
    state.close();
    removeTempStateDbDir(tempDir);
  }
});

it("matches fleet visibility across legacy and migrated rows, shared writers, and savepoint rollback", () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-todo-membership-legacy-");
  let state = StateDb.open(dbPath);
  const writer = new Database(dbPath);
  try {
    // Simulate a profile with relationships still awaiting the v79 payload
    // move and no capture into the legacy search index. Reopening backfills
    // that index. The other connection never registers new SQL functions.
    writer.exec(`DROP TRIGGER thread_sub_agents_capture_insert;
      DROP TRIGGER thread_sub_agents_capture_update;
      DROP TRIGGER thread_managed_legacy_children_insert;
      DROP TRIGGER thread_managed_legacy_children_update;
      DROP TRIGGER thread_managed_legacy_children_delete;`);
    const overlay = writer.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)");
    const legacy = writer.prepare(`INSERT OR REPLACE INTO thread_navigation_relationships(
      thread_id, managed_children, grouped_subthread) VALUES (?, ?, 0)`);
    overlay.run("codex:parent", JSON.stringify({
      backend: "codex", threadId: "parent", subAgents: [
        { monitorThreadId: "\tshared\u00a0" },
        { monitorThreadId: "parent", backend: "claude" },
        { monitorThreadId: "child", backend: "codex:opaque" },
        { monitorThreadId: "parent" },
        { monitorThreadId: "x\0x" },
        null,
        { monitorThreadId: "after-malformed" },
      ],
    }));
    legacy.run("codex:broken", "{bad json");
    legacy.run("codex:duplicate", '["codex","duplicate",[{"monitorThreadId":"other","monitorThreadId":"duplicate-child"}]]');
    state.close();
    state = StateDb.open(dbPath);
    const store = new SqliteOverlayStore(state);
    const keys = ["codex:shared", "acp:grok:shared", "claude:shared", "codex:parent",
      "claude:parent", "codex:opaque:child", "codex:x\0x", "codex:after-malformed", "codex:duplicate-child"];
    const read = () => store.readManagedSubAgentThreadKeysForOwners(keys);
    const compare = () => {
      const fleet = store.readManagedSubAgentThreadKeys();
      expect(read()).toEqual(new Set(keys.filter((key) => fleet.has(key))));
    };
    expect(read()).toEqual(new Set(["codex:shared", "claude:parent", "codex:opaque:child", "codex:x\0x",
      "codex:duplicate-child"]));
    compare();
    // A malformed parent key cannot lend its identity to a migrated card.
    overlay.run("not-a-thread", JSON.stringify({ subAgents: [{ monitorId: "ignored", monitorThreadId: "after-malformed" }] }));
    overlay.run("acp%3Agrok:parent", JSON.stringify({ subAgents: [{ monitorId: "acp", monitorThreadId: "\ufeffshared\u2029" }] }));
    overlay.run("claude:parent", JSON.stringify({ subAgents: [{ monitorId: "anthropic", monitorThreadId: "shared" }] }));
    const grouped = JSON.stringify({ handoffOrigin: { groupingMode: "subthread" } });
    const rollback = new Error("roll back fixture");
    state.raw.transaction(() => {
      state.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("acp%3Agrok:shared", grouped);
      expect(read().has("acp:grok:shared")).toBe(false);
      expect(read().has("claude:shared")).toBe(true);
      compare();
      expect(() => state.raw.transaction(() => {
        state.raw.prepare("DELETE FROM thread_navigation_relationships WHERE thread_id = ?").run("codex:parent");
        expect(read().has("codex:shared")).toBe(false);
        compare();
        throw rollback;
      })()).toThrow(rollback);
      expect(read().has("codex:shared")).toBe(true);
    })();
    writer.prepare("DELETE FROM threads WHERE thread_id = ?").run("acp%3Agrok:shared");
    expect(read().has("acp:grok:shared")).toBe(true);
    compare();
    writer.exec("VACUUM");
    compare();
    legacy.run("codex:duplicate", null);
    expect(read().has("codex:duplicate-child")).toBe(false);
    compare();
  } finally {
    writer.close();
    state.close();
    removeTempStateDbDir(tempDir);
  }
});

it("maintains candidate indexes in each writer's existing transaction", async () => {
  const { dbPath, tempDir } = createTempStateDb("pwragent-todo-membership-writes-");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const state = StateDb.open(dbPath);
  try {
    const db = state.raw;
    db.exec(`DROP TRIGGER thread_sub_agents_capture_insert; DROP TRIGGER thread_sub_agents_capture_update;`);
    const payload = JSON.stringify({
      backend: "codex", threadId: "legacy",
      subAgents: [{ monitorId: "worker", monitorThreadId: "\u2000requested\t" }],
    });
    db.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:legacy", payload);
    // Reinstall the capture triggers and drive the same update as the lazy
    // payload move. The reverse entry disappears as the padded index gains one.
    state.close();
    const reopened = StateDb.open(dbPath);
    try {
      const store = new SqliteOverlayStore(reopened);
      const keys = ["codex:requested"];
      expect(store.readManagedSubAgentThreadKeysForOwners(keys)).toEqual(new Set(keys));
      const { writes } = await measureSqliteWrites(async () => {
        reopened.raw.prepare("UPDATE threads SET payload = payload WHERE thread_id = ?").run("codex:legacy");
        expect(store.readManagedSubAgentThreadKeysForOwners(keys)).toEqual(new Set(keys));
      });
      expectSqliteWriteBudget({
        scenario: "todo-managed-membership-legacy-move",
        note: "Move one padded legacy child into the card table and read membership. Both indexes change in the existing migration commit."
          + " At 100 qualifying legacy moves/day, the measured 24,720 bytes per move is about 2.5 MB/day. The reads commit nothing.",
        writes,
      });
    } finally {
      reopened.close();
    }
  } finally {
    if (state.raw.open) state.close();
    vi.unstubAllEnvs();
    removeTempStateDbDir(tempDir);
  }
});
