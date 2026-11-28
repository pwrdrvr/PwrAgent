import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { storageHistoryPolicy, setStorageHistoryPreference, claimStorageMaintenance, compactStorage, createTokenMiserGateSlice, eligibleStorageThreads, fenceStorageRetention, observeStorageArchive, readStorageMaintenance, STORAGE_GRACE_MS, STORAGE_INTERVAL_MS, STORAGE_MIN_BYTES, storageDetailSlices, storageMaintenanceDue, writeStorageMaintenance } from "../state/storage-maintenance";
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
    state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)").run("object", identity.threadId, 0, "history");
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

it("skips old archives without inspection history, even when metadata is retained", () => {
  const state = StateDb.open(":memory:");
  const identity = { backend: "codex", threadId: "empty" };
  try {
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 0);
    fenceStorageRetention(state.raw, identity);
    state.raw.prepare("INSERT INTO threads(thread_id,payload) VALUES (?,?)").run("codex:empty", "{}");
    expect(eligibleStorageThreads(state.raw, [identity], STORAGE_GRACE_MS)).toEqual([]);
  } finally { state.close(); }
});

it("preserves the last record of a helper charge during archive cleanup", () => {
  const state = StateDb.open(":memory:");
  const identity = { backend: "codex", threadId: "fixture" };
  try {
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 0);
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?, ?, 0, ?)");
    insert.run("unsettled", identity.threadId, JSON.stringify({ helperUsage: { tokenUsage: { inputTokens: 100 } } }));
    insert.run("policy", identity.threadId, "{}");
    const cleanup = () => {
      for (const op of storageDetailSlices(state.raw, identity)) op.run();
    };
    const gates = () => state.raw.prepare("SELECT object_id FROM token_miser_objects").pluck().all();
    cleanup();
    expect(gates()).toEqual(["unsettled"]);
    expect(eligibleStorageThreads(state.raw, [identity], STORAGE_GRACE_MS)).toEqual([]);
    state.raw.prepare(`INSERT INTO thread_usage_lines (
      usage_line_id, backend, thread_id, parent_thread_id, source, scope, status, created_at, updated_at,
      source_item_id, input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
      reasoning_output_tokens, total_tokens, price_status, currency, uncached_input_cost_micros,
      cached_input_cost_micros, output_cost_micros, total_cost_micros
    ) VALUES ('settled-line', 'codex', 'helper', ?, 'monitor', 'monitor', 'finalized', 0, 0,
      'system:token-miser:unsettled', 100, 0, 100, 0, 0, 100, 'priced', 'USD', 1, 0, 0, 1)`).run(identity.threadId);
    expect(eligibleStorageThreads(state.raw, [identity], STORAGE_GRACE_MS)).toEqual([identity]);
    cleanup();
    expect(gates()).toEqual([]);
    expect(state.raw.prepare("SELECT usage_line_id FROM thread_usage_lines").pluck().all()).toEqual(["settled-line"]);
  } finally { state.close(); }
});

it.each([
  ["invocations", `INSERT INTO thread_tool_invocations (
    invocation_id,backend,thread_id,item_id,tool_name,category,status,observed_at,updated_at,
    output_chars,output_lines,estimated_output_tokens,warning_lines,error_lines,info_lines,debug_lines,output_truncated,noisy
  ) VALUES ('invocation',?,?,'item','tool','other','completed',0,0,0,0,0,0,0,0,0,0,0)`, false],
  ["alerts", `INSERT INTO thread_tool_invocation_alerts (
    alert_id,backend,thread_id,kind,severity,tool_name,first_observed_at,last_observed_at,invocation_count,
    total_output_chars,estimated_output_tokens,message,suggested_prompt,created_at,updated_at
  ) VALUES ('alert',?,?,'kind','warning','tool',0,0,1,0,0,'message','prompt',0,0)`, false],
  ["analysis", `INSERT INTO thread_tool_analysis (
    backend,thread_id,analyzer_version,analyzed_at,completeness,entry_count,invocation_count,missing_output_count,page_count
  ) VALUES (?,?,'v1',0,'complete',0,0,0,0)`, false],
  ["objects", "INSERT INTO token_miser_objects VALUES ('object',?,0,'history')", true],
  ["observations", "INSERT INTO token_miser_observations VALUES ('observation',?,0,'history')", true],
] as const)("counts remaining %s only for the matching archived backend and thread", (_kind, sql, codexOnly) => {
  const state = StateDb.open(":memory:");
  const codex = { backend: "codex", threadId: "shared-id" };
  const acp = { backend: "acp:grok", threadId: "shared-id" };
  const empty = { backend: "codex", threadId: "empty" };
  const identities = [codex, acp, empty];
  try {
    for (const id of identities) observeStorageArchive(state.raw, id.backend, id.threadId, true, 0);
    state.raw.prepare(sql).run(...(codexOnly ? [codex.threadId] : [acp.backend, acp.threadId]));
    const owner = codexOnly ? codex : acp;
    expect(eligibleStorageThreads(state.raw, identities, STORAGE_GRACE_MS)).toEqual([owner]);
    expect(eligibleStorageThreads(state.raw, identities.filter((id) => id !== owner), STORAGE_GRACE_MS)).toEqual([]);
    for (const op of storageDetailSlices(state.raw, owner)) op.run();
    expect(eligibleStorageThreads(state.raw, identities, STORAGE_GRACE_MS)).toEqual([]);
  } finally { state.close(); }
});

it("resumes remaining history, then excludes cleaned archives across restarts without losing their archive age", () => {
  const fixture = createTempStateDb("storage-eligibility-");
  let state = StateDb.open(fixture.dbPath);
  const identity = { backend: "codex", threadId: "fixture" };
  const now = STORAGE_GRACE_MS;
  try {
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 0);
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)");
    state.raw.transaction(() => {
      for (let i = 0; i < 129; i++) insert.run(String(i), identity.threadId, 0, "history");
    })();
    const slice = createTokenMiserGateSlice(state.raw, identity.threadId);
    expect(slice.run().changes).toBe(128);
    state.close();
    state = StateDb.open(fixture.dbPath);
    expect(eligibleStorageThreads(state.raw, [identity], now)).toEqual([identity]);
    for (const op of storageDetailSlices(state.raw, identity)) op.run();
    state.close();
    state = StateDb.open(fixture.dbPath);
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, now);
    expect(eligibleStorageThreads(state.raw, [identity], now + STORAGE_INTERVAL_MS)).toEqual([]);
    // A late observation is cleanup work again, without another seven-day wait.
    state.raw.prepare("INSERT INTO token_miser_observations VALUES (?,?,?,?)").run("late", identity.threadId, 0, "history");
    expect(eligibleStorageThreads(state.raw, [identity], now + STORAGE_INTERVAL_MS)).toEqual([identity]);
    expect(eligibleStorageThreads(state.raw, [{ backend: "acp:grok", threadId: identity.threadId }], now + STORAGE_INTERVAL_MS)).toEqual([]);
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); }
});

it("only reads when selecting pending cleanup across repeated startups", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("storage-eligibility-writes-");
  const state = StateDb.open(fixture.dbPath);
  const identity = { backend: "codex", threadId: "fixture" };
  try {
    observeStorageArchive(state.raw, identity.backend, identity.threadId, true, 0);
    const { writes } = await measureSqliteWrites(() => {
      for (let i = 0; i < 10; i++) expect(eligibleStorageThreads(state.raw, [identity], STORAGE_GRACE_MS + i * STORAGE_INTERVAL_MS)).toEqual([]);
    });
    expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); }
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
      const op = createTokenMiserGateSlice(state.raw, "fixture");
      return state.raw.transaction(() => op.run().changes).immediate();
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
    const op = createTokenMiserGateSlice(state.raw, "fixture");
    const { writes: deletion } = await measureSqliteWrites(() => state.raw.transaction(() => {
      fenceStorageRetention(state.raw, { backend: "codex", threadId: "fixture" });
      return op.run();
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
    // v82's FTS mapping table/unique index and usage index add three VACUUM pages.
    // openai_decision_versions, its primary-key index and its active-name index add three more.
    // The compaction recovery guard table and its primary-key index add two more.
    // Research adds eleven table/index pages and one additional schema page:
    // twelve more VACUUM frames, with the same two commits and deletion budget.
    // The focused item projection and its five indexes add six more pages.
    // The research delivery projection and its two indexes, the three item indexes for versions,
    // worker slots and worker threads, and the delivery-failure index add seven more.
    // The Harness state and source-record indexes add two more VACUUM pages.
    // Main's thread_agent_follow_up_guards table and primary-key index add two more.
    // Each change separately budgeted 360 frames; their combined schema requires 362.
    // The automatic wake guard, admission and review tables and admission-window index add four pages.
    // The WITHOUT ROWID sub-agent dismissal table adds one VACUUM page.
    // The six operator-request scope indexes add six VACUUM frames.
    // The three pricing summary read indexes add three VACUUM frames.
    // The v83 gate pricing indexes add two VACUUM pages, with the same commit count.
    // v84's partial completion index adds one VACUUM page without adding a commit.
    // The v85 pricing summary triggers add two VACUUM frames on the combined fixture.
    // The v86 scheduled projection table, indexes and trigger SQL add nine frames.
    // The automation backend-turn index adds one VACUUM page to this fixture.
    // The partial PR watch retry and history indexes add one root page each.
    // The To-dos membership index and legacy search schema add eight vacuum frames.
    // The two sparse v87 subthread indexes add one root page each.
    // v88's pruned automation costs table and two indexes add three VACUUM pages.
    // The two app update notice tables add one root page each.
    // The three transcript accounting indexes add one vacuum page each.
    // The pending ACP compaction and v3 sub-agent lens indexes add one VACUUM page each.
    // The ACP idle compaction baseline index adds one more VACUUM page.
    // The thread and parent spend indexes add two VACUUM pages.
    // The retained owner job lookup index adds one root page to VACUUM.
    // The sidebar context-window index adds one root page to VACUUM.
    // The open replay gate index adds one root page to VACUUM.
    const budgetPath = new URL("./fixtures/storage-maintenance-page-budgets.json", import.meta.url);
    if (process.env.UPDATE_SQLITE_WRITE_BUDGETS) writeFileSync(budgetPath, JSON.stringify(measured, null, 2) + "\n");
    expect(measured).toEqual(JSON.parse(readFileSync(budgetPath, "utf8")));
  } finally { state.close(); removeTempStateDbDir(fixture.tempDir); }
});

it("counts protected gates against the candidate limit before reaching a later deletable gate", () => {
  const state = StateDb.open(":memory:");
  try {
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)");
    insert.run("protected", "fixture", 0, JSON.stringify({ helperUsage: { tokenUsage: {} } }));
    insert.run("deletable", "fixture", 0, "history");
    const op = createTokenMiserGateSlice(state.raw, "fixture");
    expect(state.raw.transaction(() => op.run(1)).immediate()).toEqual({ changes: 0, more: true });
    expect(state.raw.transaction(() => op.run(1)).immediate()).toEqual({ changes: 1, more: true });
    expect(state.raw.transaction(() => op.run(1)).immediate()).toEqual({ changes: 0, more: false });
    expect(state.raw.prepare("SELECT object_id FROM token_miser_objects").all()).toEqual([{ object_id: "protected" }]);
  } finally { state.close(); }
});

it("caps logical bytes within a slice, not only record count", () => {
  const state = StateDb.open(":memory:");
  try {
    const insert = state.raw.prepare("INSERT INTO token_miser_objects VALUES (?,?,?,?)");
    for (let i = 0; i < 10; i++) insert.run(String(i), "fixture", 0, "x".repeat(100000));
    const op = createTokenMiserGateSlice(state.raw, "fixture");
    expect(op.run().changes).toBe(2);
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
