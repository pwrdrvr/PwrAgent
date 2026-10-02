import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSessionStore } from "../acp/acp-session-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

describe("archive retention persistence", () => {
  let db: StateDb;
  let store: SqliteOverlayStore;
  let tempDir: string;
  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-archive-retention-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new SqliteOverlayStore(db);
  });
  afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

  it("observes 100 existing archives in one commit and makes zero writes on 24 idle sweeps", async () => {
    const records = Array.from({ length: 100 }, (_, i) => ({ backend: "codex" as const, threadId: `archive-${i}` }));
    const { writes } = await measureSqliteWrites(async () => { await store.observeArchivedThreads(records, 1000); });
    expectSqliteWriteBudget({ scenario: "archive-retention-initial-batch", note: "One discovery transaction for 100 existing archives; no per-item commits.", writes });
    const idle = await measureSqliteWrites(async () => {
      for (let hour = 0; hour < 24; hour++) {
        await store.observeArchivedThreads(records, 1000 + hour * 3_600_000);
        expect((await store.listThreadArchiveStates()).every((state) => state.archiveRetentionStartedAt === 1000)).toBe(true);
      }
    });
    expectSqliteWriteBudget({ scenario: "archive-retention-idle-day", note: "24 hourly retention observations and reads after initial discovery: zero commits, 0 MB/day.", writes: idle.writes });
    const deleted = await measureSqliteWrites(async () => { await store.forgetThreadArchiveStates(records); });
    expectSqliteWriteBudget({ scenario: "archive-retention-delete-batch", note: "One transaction releases 100 overlays after permanent provider deletion.", writes: deleted.writes });
    expect(await store.listThreadArchiveStates()).toEqual([]);
  });

  it("deletes only the expired ACP metadata in one boundary commit", async () => {
    const sessions = new AcpSessionStore(db);
    for (const sessionId of ["expired", "retained"]) sessions.upsertSession({ backendId: "acp:kimi", sessionId,
      title: sessionId, createdAt: 1, updatedAt: 2, executionMode: "default", status: "idle", archivedAt: 2 });
    const { writes } = await measureSqliteWrites(async () => { sessions.deleteSession("acp:kimi", "expired"); });
    expectSqliteWriteBudget({ scenario: "archive-retention-acp-delete", note: "One permanent ACP deletion removes one metadata row; no recurring writes.", writes });
    expect(sessions.getSession("acp:kimi", "expired")).toBeUndefined();
    expect(sessions.getSession("acp:kimi", "retained")?.title).toBe("retained");
  });

  it("clears the deadline on restore and records a new period on the next archive", async () => {
    const identity = { backend: "codex" as const, threadId: "restored" };
    await store.observeArchivedThreads([identity], 1000);
    await store.setThreadArchiveTombstone({ ...identity, restoredAt: 2000 });
    expect((await store.getThreadOverlayState(identity))?.archiveRetentionStartedAt).toBeUndefined();
    await store.observeArchivedThreads([identity], 3000);
    expect((await store.getThreadOverlayState(identity))?.archiveRetentionStartedAt).toBe(3000);
  });

  it("fails closed when retained snapshot metadata is malformed", async () => {
    db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:bad", '{"worktreeSnapshots":invalid}');
    await expect(store.listThreadArchiveStates()).rejects.toThrow();
  });
});
