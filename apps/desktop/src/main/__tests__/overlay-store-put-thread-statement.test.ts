import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteThreadChangeVersion } from "@pwragent/sqlite-storage/sqlite-thread-change-version";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

describe("overlay thread upsert statement", () => {
  let db: StateDb;
  let store: SqliteOverlayStore;
  let tempDir: string;
  beforeEach(() => {
    const temp = createTempStateDb("pwragent-put-thread-statement-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(db);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); removeTempStateDbDir(tempDir); });

  it("compiles the upsert once per store, not once per write", async () => {
    // Compiling it costs about 0.3 ms against the triggers on `threads`;
    // re-preparing per write made a 300-run property miss its timeout.
    const prepare = vi.spyOn(db.raw, "prepare");
    for (let index = 0; index < 20; index++) {
      await store.setThreadPin({ backend: "codex", threadId: `t${index}`, pinned: true });
    }
    const upserts = prepare.mock.calls.filter(([sql]) => sql.trimStart().startsWith("INSERT INTO threads("));
    expect(upserts).toHaveLength(1);
  });

  it("fires a temp trigger created after the upsert was compiled", async () => {
    // The thread change counter installs its triggers lazily, so the cached
    // upsert can predate them. SQLite must re-prepare it on the schema change.
    await store.setThreadPin({ backend: "codex", threadId: "before", pinned: true });
    const installed = sqliteThreadChangeVersion(db.raw);
    await store.setThreadPin({ backend: "codex", threadId: "after", pinned: true });
    expect(sqliteThreadChangeVersion(db.raw)).toBe(installed + 1);
  });

  it("counts its writes when write metrics attach after the first write", async () => {
    // Metrics wrap `prepare`, so a copy compiled before they attach would
    // run unseen and every write budget measured after it would read zero.
    await store.setThreadPin({ backend: "codex", threadId: "before", pinned: true });
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      await store.setThreadPin({ backend: "codex", threadId: "after", pinned: true });
    });
    expect(writes.statements).toBeGreaterThan(0);
  });
});
