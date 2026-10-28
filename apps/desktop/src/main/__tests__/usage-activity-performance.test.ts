import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

// Opt-in measurements, not timing assertions. Run the same committed harness
// against the baseline, verified PR and candidate. Never use an operator DB.
const directory = process.env.PWRAGENT_USAGE_PERF_DIR;
const start = Date.UTC(2026, 9, 27, 15);
const iterations = 120;
const repetitions = 5;

function cpuMs(before: NodeJS.CpuUsage): number {
  const delta = process.cpuUsage(before);
  return (delta.user + delta.system) / 1000;
}

function line(id: string, helper: boolean, now: number, tokens: number): ThreadUsageLineRecord {
  return {
    usageLineId: id, backend: "codex", provider: "openai", threadId: helper ? id : "live-thread",
    ...(helper ? { parentThreadId: "parent-thread" } : {}),
    scope: helper ? "monitor" : "turn", status: helper ? "finalized" : "pending",
    source: helper ? "monitor" : "live", sourceItemId: helper ? `system:title:${id}` : id,
    createdAt: helper ? now : start - 1000, model: "fixture-unknown",
    inputTokens: 10, cachedInputTokens: 2, uncachedInputTokens: 8, outputTokens: tokens,
    reasoningOutputTokens: 1, totalTokens: 10 + tokens, currency: "USD", priceStatus: "unpriced",
    uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
  };
}

it.skipIf(!directory)("measures contrived closed and moving-window workloads", async () => {
  mkdirSync(directory!, { recursive: true });
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "0");
  const variant = process.env.PWRAGENT_USAGE_PERF_VARIANT ?? "unlabelled";
  let now = start;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (const shape of ["past", "two-sided", "dense"] as const) {
      for (const workload of ["raw-fast", "raw-minute", "ledger-live", "helper"] as const) {
        for (const readEvery of [0, 1, 60]) {
          for (let repetition = 0; repetition < repetitions; repetition++) {
            now = start;
            const temp = createTempStateDb("pwragent-usage-perf-");
            const db = StateDb.open(temp.dbPath);
            const store = new SqliteOverlayStore(db);
            const insert = db.raw.prepare(`INSERT INTO thread_usage_lines
              (usage_line_id, backend, thread_id, parent_thread_id, provider, source, source_item_id,
               scope, status, created_at, completed_at, updated_at, input_tokens, cached_input_tokens,
               uncached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
               price_status, currency, uncached_input_cost_micros, cached_input_cost_micros,
               output_cost_micros, total_cost_micros)
              VALUES (?, 'codex', ?, ?, 'openai', 'live', ?, ?, ?, ?, ?, ?,
                10, 2, 8, 3, 1, 13, 'priced', 'USD', 8, 2, 3, 13)`);
            try {
              db.raw.pragma("wal_autocheckpoint = 0");
              db.raw.transaction(() => {
                for (let index = 0; index < 20_000; index++) {
                  const time = start + (shape === "two-sided" && index % 2 ? 1 : -1)
                    * (index + 14_400) * 60_000;
                  insert.run(`history-${index}`, `history-thread-${index}`, null, `history-${index}`,
                    "turn", "finalized", time, time + 1000, time + 1000);
                }
                if (shape === "dense") {
                  for (let index = 0; index < 6000; index++) insert.run(`dense-${index}`,
                    `dense-thread-${index}`, "dense-parent", `system:title:${index}`,
                    "monitor", "finalized", start - 1000, null, start - 1000);
                }
                insert.run("raw-live", "raw-thread", null, "raw-live", "turn", "pending",
                  start - 1000, null, start);
                // Old line timestamp, authoritative turn completion inside the window.
                db.raw.prepare(`INSERT INTO thread_usage_turns
                  (usage_turn_id, provider, backend, thread_id, started_at, completed_at, observed_at, updated_at)
                  VALUES ('span-turn', 'openai', 'codex', 'span-thread', ?, ?, ?, ?)`)
                  .run(start - 86_400_000, start + 86_400_000, start, start);
                insert.run("span", "span-thread", null, "span", "turn", "pending",
                  start - 86_400_000, start - 86_400_000, start - 86_400_000);
                db.raw.prepare("UPDATE thread_usage_lines SET usage_turn_id = 'span-turn' WHERE usage_line_id = 'span'").run();
              })();
              const rawUpdate = db.raw.prepare(`UPDATE thread_usage_lines SET updated_at = ?,
                output_tokens = ? WHERE usage_line_id = 'raw-live'`);
              const stride = workload === "raw-fast" ? 100 : workload === "raw-minute" ? 60_000 : 1000;
              const write = async (index: number) => {
                now = start + index * stride;
                if (workload.startsWith("raw")) rawUpdate.run(now, index);
                else await store.upsertThreadUsageLine({ line: line(workload === "helper"
                  ? `helper-${index}` : "ledger-live", workload === "helper", now, index) });
              };
              // Warm SQL, JS and store paths before measuring; setup is excluded.
              for (let index = -20; index < 0; index++) await write(index);
              await store.readUsageActivity({ from: start - 10_000, to: start });
              db.raw.pragma("wal_checkpoint(TRUNCATE)");
              let materializations = 0;
              const prepare = db.raw.prepare.bind(db.raw);
              const observation = vi.spyOn(db.raw, "prepare").mockImplementation((sql) => {
                if (/LIMIT 5001/.test(sql)) materializations++;
                return prepare(sql);
              });
              let writeCpuMs = 0;
              let readCpuMs = 0;
              let readCount = 0;
              let outputRows = 0;
              let missingSpans = 0;
              const began = process.cpuUsage();
              for (let index = 1; index <= iterations; index++) {
                let phase = process.cpuUsage();
                await write(index);
                writeCpuMs += cpuMs(phase);
                if (readEvery && index % readEvery === 0) {
                  phase = process.cpuUsage();
                  const result = await store.readUsageActivity({
                    from: now - (shape === "dense" ? 5 * 3_600_000 : 10_000), to: now + 1,
                  });
                  readCpuMs += cpuMs(phase);
                  readCount++;
                  outputRows += result.rows.length;
                  if (!result.rows.some((row) => row.line.usageLineId === "span")) missingSpans++;
                }
              }
              const totalCpuMs = cpuMs(began);
              expect(missingSpans).toBe(0);
              observation.mockRestore();
              const walBytes = statSync(`${temp.dbPath}-wal`).size;
              appendFileSync(path.join(directory!, `${variant}.jsonl`), `${JSON.stringify({
                variant, shape, workload, readEvery, repetition, iterations, stride,
                writeCpuMs, readCpuMs, totalCpuMs, walBytes, readCount,
                materializations, cacheHits: readCount - materializations, outputRows,
                sqlite: db.raw.prepare("SELECT sqlite_version() AS version").get(),
              })}\n`);
            } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
          }
        }
      }
    }
  } finally { clock.mockRestore(); vi.unstubAllEnvs(); }
}, 600_000);
