// Run from the repository root with PWRAGENT_BENCH_STARTUP_LEDGER=1:
// node --expose-gc node_modules/vitest/vitest.mjs run --config vitest.workspace.mts startup-ledger-benchmark --maxWorkers=1 --silent=false --reporter=verbose
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { createHook } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { getHeapStatistics } from "node:v8";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { DESKTOP_SPEND_ALERT_POLICY_DEFAULT } from "@pwragent/shared/contracts/settings";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import { ThreadUsageLedger, type ThreadUsageLedgerHost } from "../app-server/thread-usage-ledger";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { SqliteTokenMiserStorage } from "../storage/token-miser-storage-sqlite";
import { TokenMiserStore } from "../token-miser/token-miser-store";
import type { TokenMiserCodeModeObservation, TokenMiserObjectMetadata } from "../token-miser/token-miser-types";

const THREAD = "synthetic-long-thread";
const AT = Date.UTC(2026, 10, 1);

function seed(db: StateDb): void {
  const seq = "WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM series WHERE i < ?)";
  db.raw.transaction(() => {
    db.raw.prepare(seq + `
      INSERT INTO thread_tool_invocations (invocation_id, backend, thread_id, turn_id, item_id,
        tool_name, normalized_command, category, status, observed_at, updated_at, output_chars,
        output_lines, estimated_output_tokens, warning_lines, error_lines, info_lines, debug_lines,
        output_truncated, noisy)
      SELECT 'inv-' || i, 'codex', ?, 'turn-' || ((i-1)/20), 'tool-' || ((i-1)%20),
        'exec_command', ?, 'command', 'completed', i, i, 100, 1, 25, 0, 0, 0, 0, 0, 0
      FROM series`).run(197_000, THREAD, "synthetic argument ".repeat(220));
    db.raw.prepare(seq + `
      INSERT INTO thread_usage_lines (usage_line_id, backend, thread_id, turn_id, source, scope,
        status, created_at, model, input_tokens, cached_input_tokens, uncached_input_tokens,
        output_tokens, reasoning_output_tokens, total_tokens, price_status, currency,
        uncached_input_cost_micros, cached_input_cost_micros, output_cost_micros, total_cost_micros, updated_at)
      SELECT 'line-' || i, 'codex', ?, 'turn-' || ((i-1)/10), 'live', 'turn', 'finalized',
        i, 'gpt-5.5', 100, 0, 100, 10, 0, 110, 'priced', 'USD', 0, 0, 0, 0, i
      FROM series`).run(95_000, THREAD);
    db.raw.prepare(seq + `
      INSERT INTO thread_sub_agents (thread_id, monitor_id, created_at, updated_at, completed_at, status, card)
      SELECT ?, 'fixture-card-' || i, i, i, i, 'completed',
        json_object('monitorId', 'fixture-card-' || i, 'task', ?)
      FROM series`).run(84_000, `codex:${THREAD}`, "Synthetic task details. ".repeat(130));
    db.raw.prepare(seq + `
      INSERT INTO threads (thread_id, payload)
      SELECT 'codex:archive-' || i, json_object('backend', 'codex', 'threadId', 'archive-' || i,
        'executionMode', 'default', 'extraLinkedDirectories', json('[]'),
        'archiveRetentionStartedAt', 1, 'title', ?)
      FROM series`).run(6_000, "Synthetic title ".repeat(250));
    db.raw.prepare(seq + `
      INSERT INTO pr_auto_dispatch_claims
      SELECT 'codex', 'unrelated-' || i, '', 'repair-' || i, 'pending', i, i, i, '{}'
      FROM series`).run(2_000);
  })();
  db.raw.pragma("wal_checkpoint(TRUNCATE)");
}

async function measure(db: StateDb, name: string, run: () => Promise<unknown>): Promise<void> {
  global.gc?.();
  const startHeap = getHeapStatistics().used_heap_size;
  let peakHeap = startHeap;
  let peakTransferredRows = 0;
  const original = db.raw.prepare;
  const sample = () => { peakHeap = Math.max(peakHeap, getHeapStatistics().used_heap_size); };
  db.raw.prepare = ((sql: string) => {
    const statement = original.call(db.raw, sql);
    const all = statement.all.bind(statement);
    statement.all = (...args: unknown[]) => {
      const rows = Reflect.apply(all, undefined, args) as unknown[];
      peakTransferredRows = Math.max(peakTransferredRows, rows.length);
      sample();
      return rows;
    };
    return statement;
  }) as typeof original;
  const sampler = setInterval(sample, 1);
  const start = performance.now();
  const cpu = process.cpuUsage();
  try {
    await run();
    sample();
    const elapsedCpu = process.cpuUsage(cpu);
    console.log(JSON.stringify({
      name, elapsedMs: Math.round(performance.now() - start),
      cpuMs: Math.round((elapsedCpu.user + elapsedCpu.system) / 1_000),
      heapGrowthMiB: Math.round((peakHeap - startHeap) / 1024 ** 2), peakTransferredRows,
    }));
  } finally {
    clearInterval(sampler);
    db.raw.prepare = original;
  }
}

async function main(): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-startup-ledger-"));
  const dbPath = path.join(directory, "state.db");
  const db = StateDb.open(dbPath);
  try {
    seed(db);
    console.log(JSON.stringify({ databaseMiB: Math.round(statSync(dbPath).size / 1024 ** 2) }));
    await yieldToEventLoop();
    const store = new SqliteOverlayStore(db);
    const ledger = new ThreadUsageLedger(registryContextStandIn({ overlayStore: store }), {} as never, () => ({
      runtimeInstanceId: "fixture-owner", registrySessionId: "fixture-session", invalidateThreadListCache: () => {},
    }) as unknown as ThreadUsageLedgerHost);
    const gates = Array.from({ length: 512 }, (_, index): TokenMiserObjectMetadata => ({
      version: 1, objectId: `gate-${index}`, threadId: THREAD, turnId: `turn-${index}`,
      toolUseId: "tool-0", toolName: "exec_command", createdAt: AT + index,
      originalCharacters: 12_345, baselineParentTokens: 3_000, replacementCharacters: 400,
      retrievedCharacters: 0, parentModel: "gpt-5.5", disposition: "summarized",
      summary: { summary: "Synthetic fixture", usefulDetails: [], suggestedNextStep: "Read a range" },
    }));
    await measure(db, "writeTokenMiserLedgerEntries", () =>
      ledger["persistTokenMiserLedgerEntries"](gates, { publishPricing: false }));
    const archives = Array.from({ length: 6_000 }, (_, index) => ({
      backend: "codex" as const, threadId: `archive-${index + 1}`,
    }));
    await measure(db, "observeArchivedThreads", () => store.observeArchivedThreads(archives, AT));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

it.skipIf(process.env.PWRAGENT_BENCH_STARTUP_LEDGER !== "1")(
  "profiles Token Miser persistence and archive re-observation on a large synthetic state.db",
  { timeout: 120_000 },
  main,
);

function queryCaller(sql: string): string {
  if (sql.includes("token_miser_objects")) return "metadata";
  if (sql.includes("idx_thread_usage_lines_gate_usage_turn")) return "gatePricing";
  if (sql.includes("CROSS JOIN thread_usage_turns")) return "turnMetadata";
  if (sql.includes("SELECT card FROM thread_sub_agents")) return "cards";
  if (sql.includes("FROM thread_compactions")) return "compactions";
  if (sql.includes("FROM thread_tool_invocations")) return "legacyInvocations";
  if (sql.includes("idx_thread_usage_lines_unpriced_thread")) return "pricingRetry";
  return /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) ? "write" : "other";
}

function instrumentFleet(db: StateDb) {
  const stats = new Map<string, { prepares: number; prepareMs: number; reads: number; rows: number; maxRows: number }>();
  const prepare = db.raw.prepare;
  db.raw.prepare = ((sql: string) => {
    const caller = queryCaller(sql);
    const count = stats.get(caller) ?? { prepares: 0, prepareMs: 0, reads: 0, rows: 0, maxRows: 0 };
    stats.set(caller, count);
    count.prepares++;
    const started = performance.now();
    const statement = prepare.call(db.raw, sql);
    count.prepareMs += performance.now() - started;
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    const iterate = statement.iterate.bind(statement);
    const record = (rows: number) => {
      count.rows += rows;
      count.maxRows = Math.max(count.maxRows, rows);
    };
    statement.all = (...args: unknown[]) => {
      count.reads++;
      const rows = Reflect.apply(all, undefined, args) as unknown[];
      record(rows.length);
      return rows;
    };
    statement.get = (...args: unknown[]) => {
      count.reads++;
      const row: unknown = Reflect.apply(get, undefined, args);
      record(Number(row !== undefined));
      return row;
    };
    statement.iterate = function* (...args: unknown[]) {
      count.reads++;
      let rows = 0;
      try {
        for (const row of Reflect.apply(iterate, undefined, args) as Iterable<unknown>) {
          rows++;
          yield row;
        }
      } finally { record(rows); }
    } as typeof statement.iterate;
    return statement;
  }) as typeof prepare;
  return {
    stats,
    reset() {
      for (const count of stats.values()) {
        Object.assign(count, { prepares: 0, prepareMs: 0, reads: 0, rows: 0, maxRows: 0 });
      }
    },
    finish() { db.raw.prepare = prepare; },
  };
}

async function measureFleet(probe: ReturnType<typeof instrumentFleet>, phase: string, run: () => Promise<void>): Promise<void> {
  global.gc?.();
  const profileDir = process.env.PWRAGENT_BENCH_STARTUP_PROFILE_DIR;
  const profiler = profileDir ? new Session() : undefined;
  profiler?.connect();
  if (profiler) {
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", { interval: 250 });
    await profiler.post("Profiler.start");
  }
  probe.reset();
  const yields: Record<string, number> = {};
  const hook = createHook({ init(_id, type) {
    if (type !== "Immediate") return;
    const caller = new Error().stack?.match(/\b(reconcileTokenMiserLedger|writeTokenMiserLedgerEntries|repriceThreadUsageHistory|materializeThreadPricing)\b/)?.[1] ?? "other";
    yields[caller] = (yields[caller] ?? 0) + 1;
  } });
  hook.enable();
  const start = performance.now();
  const cpu = process.cpuUsage();
  try {
    const { writes } = await measureSqliteWrites(run);
    const elapsedCpu = process.cpuUsage(cpu);
    console.log(JSON.stringify({
      phase, wallMs: Math.round(performance.now() - start),
      cpuMs: Math.round((elapsedCpu.user + elapsedCpu.system) / 1_000),
      sqlite: Object.fromEntries([...probe.stats].filter(([, count]) => count.prepares > 0 || count.reads > 0)),
      writes, yields,
    }));
    if (phase !== "mixed") expect(writes.commits).toBe(0);
  } finally {
    hook.disable();
    if (profiler && profileDir) {
      try {
        const { profile } = await profiler.post("Profiler.stop");
        writeFileSync(path.join(profileDir, `${phase}.cpuprofile`), JSON.stringify(profile));
      } finally { profiler.disconnect(); }
    }
  }
}

const FLEET_SIZE = 4_096;

function fleetGate(index: number): TokenMiserObjectMetadata {
  // Exercise full 64-gate batches, interleaved histories, and distinct threads.
  const key = index < 512 ? 4 * Math.floor(index / 128) : index < 1_024 ? (index % 32) & ~3 : index;
  const threadId = `fleet-${key}`;
  return {
    version: 1, objectId: `gate-${String(index).padStart(5, "0")}`, threadId, turnId: `turn-${index}`,
    toolUseId: `tool-${index}`, toolName: "exec_command", createdAt: AT + index,
    originalCharacters: 12_345, baselineParentTokens: 3_000, replacementCharacters: 400,
    retrievedCharacters: 0, parentModel: "gpt-5.5", disposition: "summarized",
    ...((index % 31 === 0) ? {} : { replayTrackingVersion: 2, cachedReplayCount: 0 }),
    summary: { summary: "Synthetic fixture", usefulDetails: [] },
    helperUsage: {
      model: "gpt-5.6-luna", helperThreadId: `helper-${index}`, helperTurnId: `helper-turn-${index}`,
      tokenUsage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, totalTokens: 110 },
    },
  };
}

function fleetParent(entry: TokenMiserObjectMetadata): ThreadUsageLineRecord {
  return {
    backend: "codex", threadId: entry.threadId, turnId: entry.turnId, usageTurnId: entry.turnId,
    usageLineId: `line-${entry.objectId}`, createdAt: entry.createdAt, provider: "openai",
    scope: "turn", source: "hydration", status: "finalized", model: "gpt-5.5", currency: "USD",
    priceStatus: "priced", totalCostMicros: 100, inputTokens: 1_000, uncachedInputTokens: 1_000,
    cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0, totalTokens: 1_100,
    uncachedInputCostMicros: 90, cachedInputCostMicros: 0, outputCostMicros: 10,
    startedAt: entry.createdAt - 20, completedAt: entry.createdAt + 20,
  };
}

function fleetLedger(db: StateDb, root: string) {
  const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(db);
  const tokenMiserStore = new TokenMiserStore(root, { storage });
  const store = new SqliteOverlayStore(db);
  const ledger = new ThreadUsageLedger(registryContextStandIn({ overlayStore: store }), {
    liveCodexNativeSubAgentUsageRecords: new Map(),
  } as never, () => ({
    runtimeInstanceId: "fixture-owner", registrySessionId: "fixture-session", invalidateThreadListCache: () => {},
    tokenMiserStore, spendAlertPolicy: DESKTOP_SPEND_ALERT_POLICY_DEFAULT, resolveCodexLocalModelIdsFn: () => [],
  }) as unknown as ThreadUsageLedgerHost);
  return { ledger, storage, store };
}

async function runFleet(): Promise<void> {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-reconciled-fleet-"));
  const dbPath = path.join(directory, "state.db");
  const root = path.join(directory, "objects");
  const gates = Array.from({ length: FLEET_SIZE }, (_, index) => fleetGate(index));
  let db = StateDb.open(dbPath);
  try {
    const seed = fleetLedger(db, root);
    db.raw.transaction(() => { for (const gate of gates) seed.storage.writeMetadata(gate); })();
    await seed.store.upsertThreadUsageLines({ lines: gates.map(fleetParent) });
    const legacy = gates.filter((entry) => entry.replayTrackingVersion !== 2);
    db.raw.transaction(() => {
      const invoke = db.raw.prepare(`INSERT INTO thread_tool_invocations (invocation_id, backend, thread_id,
        turn_id, item_id, tool_name, normalized_command, category, status, observed_at, updated_at, output_chars,
        output_lines, estimated_output_tokens, warning_lines, error_lines, info_lines, debug_lines,
        output_truncated, noisy)
        VALUES (?, 'codex', ?, ?, ?, 'exec_command', 'synthetic', 'command', 'completed', ?, ?,
          100, 1, 25, 0, 0, 0, 0, 0, 0)`);
      for (const entry of legacy) {
        for (let index = 0; index < 6; index++) {
          invoke.run(`${entry.objectId}-${index}`, entry.threadId, entry.turnId,
            index === 0 ? entry.toolUseId : `later-${index}`, AT + index, AT + index);
        }
      }
      const marker = db.raw.prepare(`INSERT INTO thread_compactions
        (compaction_id, backend, thread_id, observed_at, updated_at) VALUES (?, 'codex', ?, ?, ?)`);
      for (let index = 0; index < 1_024; index++) {
        marker.run(`historical-${index}`, `fleet-${(index % 8) * 4}`, AT - 1 - index, AT - 1 - index);
      }
    })();
    await seed.ledger.initializeTokenMiserLedger();
    db.raw.pragma("wal_checkpoint(TRUNCATE)");
    const profileDir = process.env.PWRAGENT_BENCH_STARTUP_PROFILE_DIR;
    if (profileDir) db.raw.prepare("VACUUM INTO ?").run(path.join(profileDir, "reconciled-fixture.db"));
    db.close();
    db = StateDb.open(dbPath);
    const { ledger, storage, store } = fleetLedger(db, root);
    const probe = instrumentFleet(db);
    await measureFleet(probe, "cold", () => ledger.initializeTokenMiserLedger());
    await measureFleet(probe, "warm", () => ledger.initializeTokenMiserLedger());

    const missing = gates[1]!;
    const stale = { ...gates[2]!, retrievedCharacters: 400 };
    const changedByPeer = { ...gates[129]!, retrievedCharacters: 800 };
    const needsReprice = gates[4]!;
    db.raw.prepare("DELETE FROM thread_sub_agents WHERE thread_id = ? AND monitor_id = ?")
      .run(`codex:${missing.threadId}`, `system:token-miser:${missing.objectId}`);
    db.raw.prepare("DELETE FROM thread_usage_lines WHERE parent_thread_id = ? AND source_item_id = ?")
      .run(missing.threadId, `system:token-miser:${missing.objectId}`);
    storage.writeMetadata(stale);
    db.raw.prepare("UPDATE thread_usage_lines SET price_status = 'unpriced' WHERE thread_id = ? AND scope = 'turn'")
      .run(needsReprice.threadId);
    const peer = StateDb.open(dbPath);
    try {
      const peerStorage = fleetLedger(peer, root).storage;
      const readPage = storage.readMetadataPage.bind(storage);
      vi.spyOn(storage, "readMetadataPage").mockImplementation((after, limit) => {
        if (after === gates[63]!.objectId) peerStorage.writeMetadata(changedByPeer);
        return readPage(after, limit);
      });
      await measureFleet(probe, "mixed", () => ledger.initializeTokenMiserLedger());
    } finally {
      probe.finish();
      peer.close();
    }
    for (const gate of [missing, stale, changedByPeer]) {
      const card = await store.getThreadSubAgent({
        backend: "codex", threadId: gate.threadId, monitorId: `system:token-miser:${gate.objectId}`,
      });
      expect(card?.tokenMiserAccounting?.revealedParentTokens).toBe((400 + gate.retrievedCharacters) / 4);
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}

it.skipIf(process.env.PWRAGENT_BENCH_STARTUP_LEDGER !== "1")(
  "profiles reconciled Token Miser fleet startup, repeat, and mixed peer repair",
  { timeout: 120_000 },
  runFleet,
);
