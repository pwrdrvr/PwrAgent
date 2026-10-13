import { afterEach, describe, expect, it, vi } from "vitest";
import { StateDb } from "../state/state-db";
import { ARCHIVED_WORKTREE_REPAIR_KEY, runOneTimeArchivedWorktreeRepair } from "../state/archived-worktree-repair";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import type { ArchivedWorktreeRepairReport } from "../app-server/backend-registry";

const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach(removeTempStateDbDir);
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const { dbPath, tempDir } = createTempStateDb("pwragent-worktree-repair-");
  roots.push(tempDir);
  const db = StateDb.open(dbPath);
  databases.push(db);
  const report: ArchivedWorktreeRepairReport = { archivedThreads: 501, discoveredWorktrees: 501, missingWorktrees: 0,
    protectedWorktrees: 0, protectedWorktreeDetails: [], candidates: [], cleanup: [], emptyContainerCandidates: [], containerCleanup: [] };
  const repair = vi.fn(async () => report);
  return { db, repair, report };
}

describe("one-time archived worktree repair", () => {
  it("writes one claim and one completion for the whole pass, then performs no provider discovery or writes on another startup", async () => {
    const { db, repair, report } = fixture();
    const { writes } = await measureSqliteWrites(async () => {
      expect(await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair })).toBe(report);
      expect(await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair })).toBeUndefined();
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expectSqliteWriteBudget({ scenario: "archived-worktree-repair-once-marker", note: "One claim and one completion for a 501-thread pass plus a completed-startup no-op: 2 commits total, no per-item or timer writes; about 0.02 MB once and 0 MB/day afterward.", writes });
  });

  it("defers to a live owner and resumes a dead owner's interrupted pass", async () => {
    const { db, repair } = fixture();
    db.raw.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(ARCHIVED_WORKTREE_REPAIR_KEY, JSON.stringify({ ownerPid: 123, attemptedAt: 1 }));
    expect(await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair, processAlive: () => true })).toBeUndefined();
    expect(repair).not.toHaveBeenCalled();
    await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair, processAlive: () => false });
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("does not mark incomplete discovery as completed or retry it in the same invocation", async () => {
    const { db, report } = fixture();
    const repair = vi.fn<() => Promise<ArchivedWorktreeRepairReport>>(async () => { throw new Error("Provider inventory unavailable"); });
    await expect(runOneTimeArchivedWorktreeRepair({ db: db.raw, repair })).rejects.toThrow("Provider inventory unavailable");
    expect(repair).toHaveBeenCalledTimes(1);
    repair.mockImplementation(async () => report);
    await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair });
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it("consumes a complete pass containing retained failures rather than retrying them at every startup", async () => {
    const { db, report, repair } = fixture();
    repair.mockResolvedValue({ ...report, cleanup: [{ removedWorktree: false, deletedBranch: false, error: "Protected checkout" }] });
    await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair });
    await runOneTimeArchivedWorktreeRepair({ db: db.raw, repair });
    expect(repair).toHaveBeenCalledTimes(1);
  });
});
