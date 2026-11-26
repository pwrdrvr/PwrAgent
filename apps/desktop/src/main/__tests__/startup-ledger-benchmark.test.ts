// Run from the repository root with PWRAGENT_BENCH_STARTUP_LEDGER=1:
// node --expose-gc node_modules/vitest/vitest.mjs run --config vitest.workspace.mts startup-ledger-benchmark --maxWorkers=1 --silent=false --reporter=verbose
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { getHeapStatistics } from "node:v8";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { ThreadUsageLedger, type ThreadUsageLedgerHost } from "../app-server/thread-usage-ledger";
import { registryContextStandIn } from "./helpers/registry-context-stand-in";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import type { TokenMiserObjectMetadata } from "../token-miser/token-miser-types";

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
