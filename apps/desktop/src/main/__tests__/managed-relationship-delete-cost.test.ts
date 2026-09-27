import { appendFileSync, readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

// Count WAL frames, including repeat writes to the same page, rather than
// inferring disk cost from commits or statement.changes (which omits triggers).
function readWal(path: string): { frames: number; uniquePages: number; commits: number; bytes: number } {
  const wal = readFileSync(path);
  if (wal.length === 0) return { frames: 0, uniquePages: 0, commits: 0, bytes: 0 };
  const pageSize = wal.readUInt32BE(8);
  const frameSize = 24 + pageSize;
  expect((wal.length - 32) % frameSize).toBe(0);
  const pages = new Set<number>();
  let commits = 0;
  for (let offset = 32; offset < wal.length; offset += frameSize) {
    pages.add(wal.readUInt32BE(offset));
    if (wal.readUInt32BE(offset + 4) !== 0) commits++;
  }
  return { frames: (wal.length - 32) / frameSize, uniquePages: pages.size, commits, bytes: wal.length };
}

const scenarios = [
  { name: "parent", ids: ["parent-1024"], transaction: false, maxFrames: 64 },
  { name: "shared-child", ids: ["shared"], transaction: false, maxFrames: 64 },
  { name: "wide-parent", ids: ["wide"], transaction: false, reclaim: true, maxFrames: 64 },
  { name: "random-batch", ids: Array.from({ length: 512 }, (_, i) => `parent-${(i * 1543) % 2048}`), transaction: true, reclaim: true, maxFrames: 1024 },
  { name: "random-autocommit", ids: Array.from({ length: 512 }, (_, i) => `parent-${(i * 1543) % 2048}`), transaction: false, maxFrames: 6144 },
  { name: "random-small-cache", ids: Array.from({ length: 512 }, (_, i) => `parent-${(i * 1543) % 2048}`), transaction: true, cacheKiB: 32, maxFrames: 1024 },
  { name: "wide-secure-delete", ids: ["wide"], transaction: false, secureDelete: true, maxFrames: 2048 },
];

afterEach(() => vi.unstubAllEnvs());

it.each(scenarios)("bounds cleanup pages for $name", async (scenario) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const measurements = [];
  for (const projectionCleanup of [false, true]) {
    const fixture = createTempStateDb("relationship-delete-cost-");
    const stateDb = StateDb.open(fixture.dbPath);
    const db = stateDb.raw;
    try {
      db.transaction(() => {
        const insert = db.prepare("INSERT INTO threads(thread_id, payload) VALUES (?, ?)");
        for (let i = 0; i < 2048; i++) {
          insert.run(`codex:parent-${i}`, JSON.stringify({
            backend: "codex", threadId: `parent-${i}`, history: "synthetic history ".repeat(60),
            subAgents: [{ monitorThreadId: "shared" }, ...Array.from({ length: 3 }, (_, j) => ({ monitorThreadId: `child-${i}-${j}` }))],
          }));
        }
        insert.run("codex:shared", JSON.stringify({ backend: "codex", threadId: "shared", handoffOrigin: { groupingMode: "subthread" } }));
        insert.run("codex:wide", JSON.stringify({ backend: "codex", threadId: "wide",
          subAgents: Array.from({ length: 10000 }, (_, i) => ({ monitorThreadId: `child-${i}-${"x".repeat(256)}` })),
        }));
      })();
      // Same database layout in each pair. Disable only the new delete trigger
      // in the baseline, leaving the projection allocated but deliberately stale.
      if (!projectionCleanup) db.exec("DROP TRIGGER thread_navigation_relationships_delete");
      if (scenario.cacheKiB) db.pragma(`cache_size = -${scenario.cacheKiB}`);
      if (scenario.secureDelete) db.pragma("secure_delete = ON");
      const settings = {
        pageSize: db.pragma("page_size", { simple: true }),
        cacheSize: db.pragma("cache_size", { simple: true }),
        cacheSpill: db.pragma("cache_spill", { simple: true }),
        secureDelete: db.pragma("secure_delete", { simple: true }),
        autoVacuum: db.pragma("auto_vacuum", { simple: true }),
      };
      // Observation only: retain every frame, including cache-spill duplicates.
      // Production auto-checkpoint and cache settings are not changed.
      db.pragma("wal_autocheckpoint = 0");
      db.pragma("wal_checkpoint(TRUNCATE)");
      const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
      const remove = db.prepare("DELETE FROM threads WHERE thread_id = ?");
      const deleteRows = () => { for (const id of scenario.ids) remove.run(`codex:${id}`); };
      const { writes } = await measureSqliteWrites(() => {
        if (scenario.transaction) db.transaction(deleteRows)();
        else deleteRows();
      });
      const wal = readWal(`${fixture.dbPath}-wal`);
      const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
      expect(after.n - before.n).toBe(scenario.ids.length * (projectionCleanup ? 2 : 1));
      expect(wal.commits).toBe(scenario.transaction ? 1 : scenario.ids.length);
      expect(wal.commits).toBe(writes.commits);
      if (projectionCleanup) {
        expect(wal.frames).toBeLessThanOrEqual(scenario.maxFrames);
        expectSqliteWriteBudget({ scenario: `managed-relationship-delete-${scenario.name}`,
          note: `${scenario.ids.length} thread deletions; ${scenario.transaction ? "one transaction" : "autocommit"}; page frames separately bounded including trigger writes`,
          writes });
        if (scenario.name === "shared-child") {
          // Deleting one child must not rewrite its 2,048 parent references.
          expect(db.prepare("SELECT count(*) AS n FROM thread_navigation_relationships WHERE managed_children IS NOT NULL").get()).toEqual({ n: 2049 });
        }
      }
      let reclamation: ReturnType<typeof readWal> | undefined;
      if (scenario.reclaim) {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.pragma("incremental_vacuum");
        reclamation = readWal(`${fixture.dbPath}-wal`);
        // Reclamation is a separate write phase, not free space bookkeeping.
        expect(reclamation.frames).toBeLessThanOrEqual(1024);
        expect(reclamation.commits).toBe(1);
      }
      measurements.push({ projectionCleanup, ...settings, ...wal, reclamation });
    } finally {
      stateDb.close();
      removeTempStateDbDir(fixture.tempDir);
    }
  }
  const reportPath = process.env.PWRAGENT_DELETE_COST_REPORT;
  if (reportPath) appendFileSync(reportPath, `${JSON.stringify({ scenario: scenario.name, measurements })}\n`);
});
