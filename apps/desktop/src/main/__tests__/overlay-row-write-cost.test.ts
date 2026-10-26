import { appendFileSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  measureSqliteWrites,
  resetSqliteWriteMetrics,
  SQLITE_WRITE_METRICS_ENV,
} from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

type Page = { name: string; pageno: number; pagetype: string };

function pageOwners(stateDb: StateDb): Map<number, string> {
  return new Map((stateDb.raw.prepare("SELECT name, pageno, pagetype FROM dbstat").all() as Page[])
    .map((page) => [page.pageno, `${page.name}:${page.pagetype}`]));
}

// Attribute actual WAL frames, including newly allocated overflow pages, using
// both sides of the write. A page no longer in any btree is free space.
function walPages(dbPath: string, before: Map<number, string>, after: Map<number, string>) {
  const wal = readFileSync(`${dbPath}-wal`);
  const frameBytes = wal.readUInt32BE(8) + 24;
  const causes: Record<string, number> = {};
  for (let offset = 32; offset < wal.length; offset += frameBytes) {
    const page = wal.readUInt32BE(offset);
    const owner = page === 1 ? "header/freelist" : after.get(page) ?? (before.has(page) ? "freed-page" : "freelist");
    causes[owner] = (causes[owner] ?? 0) + 1;
  }
  return { bytes: wal.length, frames: (wal.length - 32) / frameBytes, causes };
}

describe("overlay row write cost", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.unstubAllEnvs();
  });

  function open() {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("overlay-row-cost-");
    const stateDb = StateDb.open(temp.dbPath);
    cleanups.push(() => removeTempStateDbDir(temp.tempDir), () => stateDb.close());
    stateDb.raw.pragma("wal_autocheckpoint = 0");
    return { stateDb, dbPath: temp.dbPath, store: new SqliteOverlayStore(stateDb) };
  }

  it.each([11_000, 25_000])("updates an existing %i-byte row without reallocating it", async (size) => {
    const results = [];
    for (const recursive of [false, true]) for (const pending of [false, true]) for (const replace of [true, false]) {
      const { stateDb, dbPath, store } = open();
      const db = stateDb.raw;
      db.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
      const state = {
        backend: "codex", threadId: "existing", executionMode: "default", extraLinkedDirectories: [],
        directoryPath: "/contrived/project", lastSeenAt: 1_800_000_000_000, lastSeenUpdatedAt: 1_800_000_000_000,
        handoffOrigin: { groupingMode: "subthread", sourceBackend: "codex", sourceThreadId: "parent" },
        ...(pending ? { threadSpendAlertPending: { alertId: "contrived", kind: "thread-spend" } } : {}),
        padding: "",
      };
      state.padding = "x".repeat(size - Buffer.byteLength(JSON.stringify(state)));
      // A neighboring row means a REPLACE cannot simply recycle its old rowid.
      db.prepare("INSERT INTO threads(thread_id, directory_path, last_seen_at, payload) VALUES (?, ?, ?, ?)")
        .run("codex:existing", state.directoryPath, state.lastSeenAt, JSON.stringify(state));
      await store.setThreadReaction({ backend: "codex", threadId: "neighbor", emoji: "x", present: true });
      const rowid = () => db.prepare("SELECT rowid FROM threads WHERE thread_id = ?").get("codex:existing");
      const initialRowid = rowid();
      const generation = () => db.prepare("SELECT generation FROM thread_navigation_relationship_generation").get();
      const initialGeneration = generation();
      const before = pageOwners(stateDb);
      const overflowBefore = [...before].filter(([, owner]) => owner === "threads:overflow").map(([page]) => page);
      db.pragma("wal_checkpoint(TRUNCATE)");
      resetSqliteWriteMetrics();
      const { writes } = await measureSqliteWrites(async () => {
        if (replace) {
          state.lastSeenAt += 1;
          state.lastSeenUpdatedAt += 1;
          db.prepare(`INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, payload)
            VALUES (?, ?, ?, ?)`).run("codex:existing", state.directoryPath, state.lastSeenAt, JSON.stringify(state));
        } else {
          await store.markThreadSeen({ backend: "codex", threadId: "existing", seenAt: state.lastSeenAt + 1, seenUpdatedAt: state.lastSeenUpdatedAt + 1 });
        }
      });
      const after = pageOwners(stateDb);
      const wal = walPages(dbPath, before, after);
      expect(writes.walBytes).toBe(wal.bytes);
      expect(writes.commits).toBe(1);
      if (!replace) {
        expect(rowid()).toEqual(initialRowid);
        expect(generation()).toEqual(initialGeneration);
        expect([...after].filter(([, owner]) => owner === "threads:overflow").map(([page]) => page)).toEqual(overflowBefore);
        expect(wal.frames).toBeLessThanOrEqual(4);
        expect(wal.causes["header/freelist"]).toBeUndefined();
        expect(wal.causes["sqlite_autoindex_threads_1:leaf"]).toBeUndefined();
        expect(wal.causes["thread_navigation_relationships:leaf"]).toBeUndefined();
        expectSqliteWriteBudget({
          scenario: `overlay-row-update-${size}${pending ? "-pending" : ""}`,
          note: `one seen-watermark write on an existing ${size}-byte overlay${pending ? " with a pending spend alert" : ""}; rowid and overflow chain retained, at most four WAL frames including unchanged index entries`,
          writes,
        });
      } else {
        expect(rowid()).not.toEqual(initialRowid);
      }
      results.push({ replace, recursive, pending, size, ...wal });
    }
    for (let index = 0; index < results.length; index += 2) {
      expect(results[index + 1].frames).toBeLessThan(results[index].frames);
    }
    const report = process.env.PWRAGENT_OVERLAY_ROW_COST_REPORT;
    if (report) appendFileSync(report, `${JSON.stringify(results)}\n`);
  });

  it.each([false, true])("preserves all capture and navigation triggers with recursive_triggers=%s", async (recursive) => {
    const { stateDb, store } = open();
    const db = stateDb.raw;
    db.pragma(`recursive_triggers = ${recursive ? "ON" : "OFF"}`);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'threads' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "thread_navigation_relationships_delete", "thread_navigation_relationships_insert", "thread_navigation_relationships_update",
      "thread_sub_agents_capture_insert", "thread_sub_agents_capture_update",
      "thread_usage_activities_capture_insert", "thread_usage_activities_capture_update",
    ]);
    const payload = (id: string) => JSON.stringify({
      backend: "codex", threadId: id, executionMode: "default", extraLinkedDirectories: [],
      subAgents: [{ monitorId: "monitor", monitorThreadId: "child", backend: "codex", createdAt: 1, updatedAt: 2, status: "completed" }],
      immutableUsageActivities: [{ id: "activity", type: "activity", turn: { id: "turn" } }],
      handoffOrigin: { groupingMode: "subthread", sourceBackend: "codex", sourceThreadId: "parent" },
    });
    // Exercise both capture-insert and capture-update with BOTH arrays present:
    // their internal payload UPDATEs can recursively invoke each other.
    db.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:inserted", payload("inserted"));
    await store.setThreadReaction({ backend: "codex", threadId: "updated", emoji: "x", present: true });
    db.prepare("UPDATE threads SET payload = ? WHERE thread_id = ?").run(payload("updated"), "codex:updated");
    const generation = () => db.prepare("SELECT generation FROM thread_navigation_relationship_generation").get();
    const initialGeneration = generation();
    for (const threadId of ["inserted", "updated"]) {
      const key = `codex:${threadId}`;
      const before = db.prepare("SELECT rowid FROM threads WHERE thread_id = ?").get(key);
      // Actual putThread path: scalar writes must retain captured rows and the
      // grouped relationship without firing DELETE or incrementing its stamp.
      await store.markThreadSeen({ backend: "codex", threadId, seenAt: 5_000, seenUpdatedAt: 5_000 });
      expect(db.prepare("SELECT rowid FROM threads WHERE thread_id = ?").get(key)).toEqual(before);
      const stored = db.prepare("SELECT payload FROM threads WHERE thread_id = ?").get(key) as { payload: string };
      expect(JSON.parse(stored.payload)).not.toHaveProperty("subAgents");
      expect(JSON.parse(stored.payload)).not.toHaveProperty("immutableUsageActivities");
      expect(db.prepare("SELECT monitor_id FROM thread_sub_agents WHERE thread_id = ?").all(key)).toEqual([{ monitor_id: "monitor" }]);
      expect(db.prepare("SELECT activity_id FROM thread_usage_activities WHERE thread_id = ?").all(key)).toEqual([{ activity_id: "activity" }]);
      expect(db.prepare("SELECT grouped_subthread FROM thread_navigation_relationships WHERE thread_id = ?").get(key)).toEqual({ grouped_subthread: 1 });
    }
    expect(generation()).toEqual(initialGeneration);
    await store.setThreadHandoffOrigin({ backend: "codex", threadId: "updated", handoffOrigin: null });
    expect(db.prepare("SELECT 1 FROM thread_navigation_relationships WHERE thread_id = ?").get("codex:updated")).toBeUndefined();
    expect(generation()).not.toEqual(initialGeneration);
    await store.forgetThreadArchiveStates([{ backend: "codex", threadId: "inserted" }]);
    expect(db.prepare("SELECT 1 FROM thread_navigation_relationships WHERE thread_id = ?").get("codex:inserted")).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM thread_sub_agents WHERE thread_id = ?").get("codex:inserted")).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM thread_usage_activities WHERE thread_id = ?").get("codex:inserted")).toBeUndefined();
  });

  it("inserts new rows and updates all indexed columns in place", async () => {
    const { stateDb, store } = open();
    await store.markThreadSeen({ backend: "codex", threadId: "new", seenAt: 1, seenUpdatedAt: 1 });
    const row = () => stateDb.raw.prepare("SELECT rowid, directory_path, last_seen_at, dismissed_at, snoozed_until FROM threads WHERE thread_id = ?").get("codex:new") as Record<string, unknown>;
    const initial = row();
    // Existing setters own the serialized state; inject legacy column values
    // to verify that the conflict arm replaces every indexed scalar as before.
    stateDb.raw.prepare("UPDATE threads SET directory_path = ?, dismissed_at = ?, snoozed_until = ? WHERE thread_id = ?")
      .run("/stale", 10, 20, "codex:new");
    await store.markThreadSeen({ backend: "codex", threadId: "new", seenAt: 2, seenUpdatedAt: 2 });
    expect(row()).toEqual({ rowid: initial.rowid, directory_path: null, last_seen_at: 2, dismissed_at: null, snoozed_until: null });
  });
});
