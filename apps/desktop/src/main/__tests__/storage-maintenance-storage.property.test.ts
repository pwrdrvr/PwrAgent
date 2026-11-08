import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { StorageMaintenanceStorage } from "@pwragent/owner-core/storage-maintenance-storage";
import { getDesktopStorageMaintenanceStorage } from "../storage/desktop-storage-maintenance";
import type { StateDb } from "../state/state-db";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { observeStorageArchive, readStorageMaintenance, setStorageHistoryPreference, writeStorageMaintenance } from "../state/storage-maintenance";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => {
    if (!active.db) throw new Error("App state not initialized");
    return active.db;
  },
}));
afterEach(() => { active.db = undefined; vi.unstubAllEnvs(); });

it("matches existing maintenance SQL and commit costs while retaining the startup profile binding", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  expectTypeOf<ReturnType<typeof getDesktopStorageMaintenanceStorage>>().toEqualTypeOf<StorageMaintenanceStorage>();
  expect(() => getDesktopStorageMaintenanceStorage()).toThrow("App state not initialized");
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }),
    kind: fc.constantFrom("read", "preference", "attempt", "archive", "unarchive"),
    enabled: fc.boolean(), now: fc.integer({ min: 1, max: 100000 }),
    backend: fc.constantFrom("codex", "claude"), threadId: fc.string({ minLength: 1, maxLength: 20 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const databases = Array.from({ length: 4 }, () => openInMemoryStateDb());
    try {
      for (const [index, db] of databases.entries()) {
        const instances = new AppRuntimeInstanceStore(db);
        for (const actor of [0, 1]) {
          instances.recordInstanceStart({
            instanceId: `instance-${actor}`, processId: 100 + actor, profileName: `fixture-${index % 2}`,
            startedAt: 1, desiredMessagingEnabled: false,
          });
        }
        instances.markInstanceExited({ instanceId: "instance-1", now: 2 });
      }
      const construction = await measureSqliteWrites(() => databases.slice(0, 2).map(db => {
        active.db = db;
        return getDesktopStorageMaintenanceStorage();
      }));
      expect(construction.writes.commits).toBe(0);
      for (const op of operations) {
        active.db = op.enabled ? databases[1 - op.profile] : undefined;
        const port = construction.result[op.profile]!;
        const oracle = databases[op.profile + 2]!.raw;
        const actual = await measureSqliteWrites(() => {
          if (op.kind === "preference") port.setHistoryPreference(op.enabled);
          if (op.kind === "attempt") port.write({ ...port.read(), attemptedAt: op.now });
          if (op.kind === "archive" || op.kind === "unarchive") port.observeArchive(op.backend, op.threadId, op.kind === "archive", op.now);
          return port.read();
        });
        const expected = await measureSqliteWrites(() => {
          if (op.kind === "preference") setStorageHistoryPreference(oracle, op.enabled);
          if (op.kind === "attempt") writeStorageMaintenance(oracle, { ...readStorageMaintenance(oracle), attemptedAt: op.now });
          if (op.kind === "archive" || op.kind === "unarchive") observeStorageArchive(oracle, op.backend, op.threadId, op.kind === "archive", op.now);
          return readStorageMaintenance(oracle);
        });
        expect(actual.result).toEqual(expected.result);
        expect([actual.writes.commits, actual.writes.statements, actual.writes.rowsChanged])
          .toEqual([expected.writes.commits, expected.writes.statements, expected.writes.rowsChanged]);
        if (op.kind === "read") expect(actual.writes.commits).toBe(0);
        for (const profile of [0, 1]) {
          expect(construction.result[profile]!.listRunningProcessIds()).toEqual([100]);
          const db = databases[profile]!.raw;
          const bytes = (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
          expect(construction.result[profile]!.readBytes()).toBe(bytes);
          expect(databases[profile]!.raw.prepare("SELECT * FROM thread_storage_retention ORDER BY backend, thread_id").all())
            .toEqual(databases[profile + 2]!.raw.prepare("SELECT * FROM thread_storage_retention ORDER BY backend, thread_id").all());
          expect(construction.result[profile]!.read()).toEqual(readStorageMaintenance(databases[profile + 2]!.raw));
        }
      }
    } finally {
      active.db = undefined;
      for (const db of databases) db.close();
    }
  }), { numRuns: 25 });
});
