import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadIdentityKey, type ThreadOverlayState } from "@pwragent/shared";
import { AcpSessionStore } from "../storage/acp-session-store";
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
    const providers = ["codex", "claude", "acp:kimi"] as const;
    const records = Array.from({ length: 100 }, (_, i) => ({ backend: providers[i % providers.length]!, threadId: `archive-${i}` }));
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
    expectSqliteWriteBudget({ scenario: "archive-retention-delete-batch", note: "One transaction releases 100 overlays after permanent provider deletion, plus one statement each clearing their sub-agent cards and card counters.", writes: deleted.writes });
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
    const { writes } = await measureSqliteWrites(() => store.setThreadArchiveTombstone({ ...identity, restoredAt: 2000 }));
    expectSqliteWriteBudget({ scenario: "archive-retention-restore", writes,
      note: "One restore boundary clears archive markers and records the restore watermark in one commit (~0.012 MB); 10 restores/day cost ~0.12 MB/day. No recurring writes." });
    expect((await store.getThreadOverlayState(identity))?.archiveRetentionStartedAt).toBeUndefined();
    await store.observeArchivedThreads([identity], 3000);
    expect((await store.getThreadOverlayState(identity))?.archiveRetentionStartedAt).toBe(3000);
  });

  it("fails closed when retained snapshot metadata is malformed", async () => {
    db.raw.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)").run("codex:bad", '{"worktreeSnapshots":invalid}');
    await expect(store.listThreadArchiveStates()).rejects.toThrow();
  });

  it("re-reads every archive state that names the threads or shares a ref, and reads nothing else", async () => {
    // Oracle: the full listing, filtered by field. The narrowed read may
    // return more, never less, and only rows of the full listing.
    const ids = ["a", "b", "c", "d", "e"];
    // SQL wildcards, a quote, a backslash and non-ASCII text must match
    // literally, or fall back to the full listing.
    const refs = ["refs/s/1", "refs/s/10", "refs/s/%", "refs/s/_x", "refs/s/\"q\"", "refs/s/back\\slash", "refs/s/é"];
    const backends = ["codex", "claude"] as const;
    const identity = (state: { backend: ThreadOverlayState["backend"]; threadId: string }) => buildThreadIdentityKey(state.backend, state.threadId);
    const row = fc.record({
      backend: fc.constantFrom(...backends), threadId: fc.constantFrom(...ids),
      retained: fc.boolean(), pinned: fc.boolean(), rewritten: fc.boolean(),
      snapshots: fc.array(fc.record({ repo: fc.constantFrom("/r1", "/r2"), ref: fc.constantFrom(...refs) }), { maxLength: 2 }),
    });
    await fc.assert(fc.asyncProperty(
      fc.array(row, { maxLength: 8 }),
      fc.array(fc.record({ backend: fc.constantFrom(...backends), threadId: fc.constantFrom(...ids, "missing") }), { maxLength: 3 }),
      fc.array(fc.constantFrom(...refs), { maxLength: 3 }),
      async (rows, victims, wanted) => {
        db.raw.prepare("DELETE FROM threads").run();
        for (const item of rows) {
          const thread = { backend: item.backend, threadId: item.threadId };
          if (item.retained) await store.observeArchivedThreads([thread], 1000);
          if (item.pinned) await store.setThreadPin({ ...thread, pinned: true });
          for (const [index, snapshot] of item.snapshots.entries()) await store.upsertWorktreeSnapshot({ ...thread, snapshot: {
            id: `${index}`, backend: item.backend, threadId: item.threadId, worktreePath: `${snapshot.repo}/${index}`,
            repositoryPath: snapshot.repo, snapshotRef: snapshot.ref, snapshotCommit: "abc", createdAt: 1, state: "archived",
            ignoredFilesExcluded: true } });
          // SQLite rewrites some payloads in place, in its own JSON spelling.
          if (item.rewritten) db.raw.prepare("UPDATE threads SET payload = json_remove(payload, '$.absent')").run();
        }
        const all = await store.listThreadArchiveStates();
        const keys = new Set(victims.map(identity));
        const expected = all.filter((state: ThreadOverlayState) => keys.has(identity(state))
          || (state.worktreeSnapshots ?? []).some((snapshot) => wanted.includes(snapshot.snapshotRef)));
        const actual = await store.listThreadArchiveStatesFor(victims, wanted);
        const byIdentity = new Map(actual.map((state) => [identity(state), state]));
        for (const state of expected) expect(byIdentity.get(identity(state))).toEqual(state);
        const listed = new Map(all.map((state) => [identity(state), state]));
        for (const state of actual) expect(listed.get(identity(state))).toEqual(state);
      },
    ), { numRuns: 300 });
  });

  it("re-reads only the matching archive states and makes no writes", async () => {
    for (let index = 0; index < 40; index++) await store.upsertWorktreeSnapshot({ backend: "codex", threadId: `t${index}`, snapshot: {
      id: "s", backend: "codex", threadId: `t${index}`, worktreePath: `/w/${index}`, repositoryPath: "/repo",
      snapshotRef: `refs/s/${index}`, snapshotCommit: "abc", createdAt: 1, state: "archived", ignoredFilesExcluded: true } });
    const { writes, result } = await measureSqliteWrites(async () =>
      await store.listThreadArchiveStatesFor([{ backend: "codex", threadId: "t3" }], ["refs/s/7"]));
    expect(writes.commits).toBe(0);
    expect(result.map((state) => state.threadId).sort()).toEqual(["t3", "t7"]);
  });
});
