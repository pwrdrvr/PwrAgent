import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { storageHistoryPolicy, setStorageHistoryPreference, claimStorageMaintenance, compactStorage, eligibleStorageThreads, fenceStorageRetention, observeStorageArchive, readStorageMaintenance, STORAGE_GRACE_MS, STORAGE_INTERVAL_MS, STORAGE_MIN_BYTES, storageDetailStatements, storageMaintenanceDue, writeStorageMaintenance } from "../state/storage-maintenance";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

afterEach(() => vi.unstubAllEnvs());

it("admits only established, onboarded, large profiles once a day", () => {
  const input = { existingDatabase: true, onboardingCompleted: true, bytes: STORAGE_MIN_BYTES, now: 2 * STORAGE_INTERVAL_MS };
  expect(storageMaintenanceDue(input)).toBe(true);
  expect(storageMaintenanceDue({ ...input, existingDatabase: false })).toBe(false);
  expect(storageMaintenanceDue({ ...input, onboardingCompleted: false })).toBe(false);
  expect(storageMaintenanceDue({ ...input, bytes: STORAGE_MIN_BYTES - 1 })).toBe(false);
  expect(storageMaintenanceDue({ ...input, attemptedAt: input.now - STORAGE_INTERVAL_MS + 1 })).toBe(false);
  expect(storageMaintenanceDue({ ...input, attemptedAt: input.now - STORAGE_INTERVAL_MS })).toBe(true);
  expect(storageMaintenanceDue({ ...input, attemptedAt: input.now + 1 })).toBe(false);
});

it("requires positive archived evidence and seven days, resetting on restore", () => {
  const state = StateDb.open(":memory:");
  const identity = { backend: "codex", threadId: "fixture" };
  try {
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 100);
    expect(eligibleStorageThreads(state.raw, [identity], 100 + STORAGE_GRACE_MS - 1)).toEqual([]);
    expect(eligibleStorageThreads(state.raw, [identity], 100 + STORAGE_GRACE_MS)).toEqual([identity]);
    expect(eligibleStorageThreads(state.raw, [], 100 + STORAGE_GRACE_MS)).toEqual([]);
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 100 + STORAGE_GRACE_MS, true);
    expect(eligibleStorageThreads(state.raw, [identity], 101 + STORAGE_GRACE_MS)).toEqual([]);
    observeStorageArchive(state.raw, identity.backend, identity.threadId, false);
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 200 + STORAGE_GRACE_MS);
    expect(eligibleStorageThreads(state.raw, [identity], 201 + STORAGE_GRACE_MS)).toEqual([]);
  } finally { state.close(); }
});

it("preserves metadata, unknown threads and oversized objects across resumable slices", () => {
  const fixture = createTempStateDb("storage-maintenance-");
  let state = StateDb.open(fixture.dbPath);
  try {
    state.raw.prepare("INSERT INTO threads(thread_id,payload) VALUES (?,?)").run("codex:fixture", '{"backend":"codex","threadId":"fixture","worktreeSnapshots":[{"fixture":true}]}');
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)");
    state.raw.transaction(() => {
      for (let i = 0; i < 300; i++) insert.run(String(i), "fixture", 0, "small");
      insert.run("other", "other", 0, "keep");
      insert.run("giant", "fixture", 0, "x".repeat(300000));
    })();
    const runSlice = () => {
      const op = storageDetailStatements(state.raw, { backend: "codex", threadId: "fixture" }).find((entry) => entry.statement.source.includes("token_miser_objects"))!;
      return state.raw.transaction(() => op.statement.run(...op.parameters).changes).immediate();
    };
    expect(runSlice()).toBe(128);
    state.close();
    state = StateDb.open(fixture.dbPath);
    expect(runSlice()).toBe(128);
    expect(runSlice()).toBe(44);
    expect(runSlice()).toBe(0);
    expect(state.raw.prepare("SELECT object_id FROM token_miser_objects ORDER BY object_id").all()).toEqual([{ object_id: "giant" }, { object_id: "other" }]);
    expect(state.raw.prepare("SELECT count(*) n FROM threads").get()).toEqual({ n: 1 });
    expect(state.raw.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); }
});

it("budgets archive lifecycle, daily bookkeeping and row-sliced deletion separately", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("storage-write-budget-");
  const state = StateDb.open(fixture.dbPath);
  try {
    const { writes: lifecycle } = await measureSqliteWrites(() => {
      observeStorageArchive(state.raw, "codex", "fixture", true, 0);
      observeStorageArchive(state.raw, "codex", "fixture", true, 0);
      observeStorageArchive(state.raw, "codex", "fixture", false, 1);
    });
    expectSqliteWriteBudget({ scenario: "storage-maintenance-archive-lifecycle", note: "Archive receipt, duplicate observation and restore; duplicate writes no pages", writes: lifecycle });
    const { writes: bookkeeping } = await measureSqliteWrites(() => {
      expect(claimStorageMaintenance(state.raw, 100)).toBe(true);
      writeStorageMaintenance(state.raw, { ...readStorageMaintenance(state.raw), completedAt: 101 });
    });
    expectSqliteWriteBudget({ scenario: "storage-maintenance-daily-bookkeeping", note: "Daily admission and completion; no timer heartbeat", writes: bookkeeping });
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)");
    state.raw.transaction(() => { for (let i = 0; i < 128; i++) insert.run(String(i), "fixture", 0, "x".repeat(1024)); })();
    state.raw.pragma("wal_autocheckpoint=0");
    state.raw.pragma("wal_checkpoint(TRUNCATE)");
    const op = storageDetailStatements(state.raw, { backend: "codex", threadId: "fixture" }).find((entry) => entry.statement.source.includes("token_miser_objects"))!;
    const { writes: deletion } = await measureSqliteWrites(() => state.raw.transaction(() => {
      fenceStorageRetention(state.raw, { backend: "codex", threadId: "fixture" });
      return op.statement.run(...op.parameters);
    }).immediate());
    const wal = readFileSync(fixture.dbPath + "-wal");
    // The generic counter sees file growth, which truncation can hide. Read the
    // fresh WAL directly, including repeated page writes and commit markers.
    expectSqliteWriteBudget({ scenario: "storage-maintenance-detail-slice", note: "128 synthetic 1 KiB objects plus retention fence, one bounded transaction; WAL measured after explicit truncation", writes: { ...deletion, walBytes: wal.length } });
    expect(deletion.commits).toBe(1);
    state.raw.pragma("wal_checkpoint(TRUNCATE)");
    let vacuumWal = Buffer.alloc(0);
    const execute = state.raw.exec.bind(state.raw);
    const spy = vi.spyOn(state.raw, "exec").mockImplementation((sql) => {
      const result = execute(sql);
      if (sql === "VACUUM") vacuumWal = readFileSync(fixture.dbPath + "-wal");
      return result;
    });
    try { compactStorage(state.raw); } finally { spy.mockRestore(); }
    const measure = (bytes: Buffer) => {
      const pageSize = bytes.readUInt32BE(8);
      const pages = new Set<number>();
      let frames = 0; let commits = 0;
      for (let offset = 32; offset < bytes.length; offset += pageSize + 24) {
        frames++; pages.add(bytes.readUInt32BE(offset));
        if (bytes.readUInt32BE(offset + 4) !== 0) commits++;
      }
      return { frames, uniquePages: pages.size, commits, bytes: bytes.length };
    };
    const measured = { deletion: measure(wal), vacuum: measure(vacuumWal) };
    const budgetPath = new URL("./fixtures/storage-maintenance-page-budgets.json", import.meta.url);
    if (process.env.UPDATE_SQLITE_WRITE_BUDGETS) writeFileSync(budgetPath, JSON.stringify(measured, null, 2) + "\n");
    expect(measured).toEqual(JSON.parse(readFileSync(budgetPath, "utf8")));
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); }
});

it("caps logical bytes within a slice, not only record count", () => {
  const state = StateDb.open(":memory:");
  try {
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)");
    for (let i = 0; i < 10; i++) insert.run(String(i), "fixture", 0, "x".repeat(100000));
    const op = storageDetailStatements(state.raw, { backend: "codex", threadId: "fixture" }).find((entry) => entry.statement.source.includes("token_miser_objects"))!;
    expect(op.statement.run(...op.parameters).changes).toBe(2);
  } finally { state.close(); }
});

it("does not steal a living maintenance owner even after the daily interval", () => {
  const state = StateDb.open(":memory:");
  try {
    expect(claimStorageMaintenance(state.raw, 0)).toBe(true);
    expect(claimStorageMaintenance(state.raw, 2 * STORAGE_INTERVAL_MS)).toBe(false);
    writeStorageMaintenance(state.raw, { attemptedAt: 0, ownerPid: -1 });
    expect(claimStorageMaintenance(state.raw, 2 * STORAGE_INTERVAL_MS)).toBe(true);
  } finally { state.close(); }
});

it("sweeps expiry on the next timer turn even when a small profile skips maintenance", () => {
  vi.useFakeTimers();
  const state = StateDb.open(":memory:");
  const cleanup = vi.spyOn(state, "cleanupExpired");
  const convert = vi.spyOn(state, "ensureIncrementalAutoVacuum");
  try {
    const bytes = Number(state.raw.pragma("page_count", { simple: true })) * Number(state.raw.pragma("page_size", { simple: true }));
    expect(storageMaintenanceDue({ existingDatabase: true, onboardingCompleted: true, bytes, now: Date.now() })).toBe(false);
    state.raw.prepare("INSERT INTO browse_sessions VALUES (?,NULL,0,0,'{}')").run("expired");
    state.startDeferredGc(1000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(state.raw.prepare("SELECT count(*) n FROM browse_sessions").get()).toEqual({ n: 0 });
    expect(convert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledWith(expect.any(Number), 256);
  } finally { state.close(); vi.useRealTimers(); }
});

it("cancels deferred expiry when the database closes before its first sweep", () => {
  vi.useFakeTimers();
  const state = StateDb.open(":memory:");
  const cleanup = vi.spyOn(state, "cleanupExpired");
  state.startDeferredGc();
  state.close();
  try {
    vi.runAllTimers();
    expect(cleanup).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("budgets the independent initial expiry sweep", async () => {
  vi.useFakeTimers();
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("storage-initial-expiry-");
  const state = StateDb.open(fixture.dbPath);
  try {
    state.raw.prepare("INSERT INTO browse_sessions VALUES (?,NULL,0,0,'{}')").run("expired");
    const { writes } = await measureSqliteWrites(() => {
      state.startDeferredGc();
      vi.advanceTimersByTime(0);
      state.stopGc();
    });
    expectSqliteWriteBudget({ scenario: "storage-maintenance-initial-expiry", note: "One deferred ordinary expiry transaction and capped reclamation per startup, including profiles that skip maintenance", writes });
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); vi.useRealTimers(); }
});

it("daily claim and completion preserve an unset history override", () => {
  const state = StateDb.open(":memory:");
  try {
    expect(claimStorageMaintenance(state.raw, 100)).toBe(true);
    writeStorageMaintenance(state.raw, { ...readStorageMaintenance(state.raw), completedAt: 101, ownerPid: undefined });
    const record = readStorageMaintenance(state.raw);
    expect(record.historyEnabled).toBeUndefined();
    expect(storageHistoryPolicy(record, false)).toEqual({ historyEnabled: false, automatic: true });
    expect(storageHistoryPolicy(record, true)).toEqual({ historyEnabled: true, automatic: true });
  } finally { state.close(); }
});

it("budgets explicit preference changes without writing repeated values", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("storage-preference-");
  const state = StateDb.open(fixture.dbPath);
  try {
    const { writes } = await measureSqliteWrites(() => {
      setStorageHistoryPreference(state.raw, true);
      setStorageHistoryPreference(state.raw, false);
      setStorageHistoryPreference(state.raw, false);
    });
    expect(readStorageMaintenance(state.raw).historyEnabled).toBe(false);
    expect(storageHistoryPolicy(readStorageMaintenance(state.raw), true).historyEnabled).toBe(false);
    expectSqliteWriteBudget({ scenario: "storage-maintenance-explicit-preference", note: "Explicit on/off choices persist; duplicate choice does not write", writes });
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); }
});
