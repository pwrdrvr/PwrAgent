import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const directory = process.env.PWRAGENT_USAGE_PERF_DIR;
const start = Date.UTC(2026, 9, 27, 15);

it.skipIf(!directory)("measures authoritative turn updates and fixed/moving cache controls", async () => {
  mkdirSync(directory!, { recursive: true });
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "0");
  let now = start;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const variant = process.env.PWRAGENT_USAGE_PERF_VARIANT ?? "unlabelled";
  try {
    for (const workload of ["turn-live", "turn-complete", "read-moving", "read-fixed"] as const) {
      for (const readEvery of workload.startsWith("read") ? [1] : [0, 1, 60]) {
        for (let repetition = 0; repetition < 5; repetition++) {
          now = start;
          const temp = createTempStateDb("pwragent-usage-turn-perf-");
          const db = StateDb.open(temp.dbPath);
          const store = new SqliteOverlayStore(db);
          try {
            db.raw.pragma("wal_autocheckpoint = 0");
            const insert = db.raw.prepare(`INSERT INTO thread_usage_lines
              (usage_line_id, backend, thread_id, provider, source, scope, status, created_at, completed_at,
               updated_at, input_tokens, cached_input_tokens, uncached_input_tokens, output_tokens,
               reasoning_output_tokens, total_tokens, price_status, currency, uncached_input_cost_micros,
               cached_input_cost_micros, output_cost_micros, total_cost_micros)
              VALUES (?, 'codex', ?, 'openai', 'live', 'turn', 'finalized', ?, ?, ?,
                10, 2, 8, 3, 1, 13, 'priced', 'USD', 8, 2, 3, 13)`);
            db.raw.transaction(() => {
              for (let index = 0; index < 20_000; index++) {
                const time = start - (index + 14_400) * 60_000;
                insert.run(`history-${index}`, `history-thread-${index}`, time, time + 1000, time + 1000);
              }
            })();
            const write = async (index: number) => {
              now = start + index * 1000;
              if (workload.startsWith("read")) return;
              const id = workload === "turn-complete" ? `turn-${index}` : "live-turn";
              const line: ThreadUsageLineRecord = {
                usageLineId: id, backend: "codex", provider: "openai", threadId: id, turnId: id,
                scope: "turn", status: "pending", source: "live", sourceItemId: id,
                createdAt: workload === "turn-complete" ? now : start - 1000, model: "fixture-unknown",
                inputTokens: 10, cachedInputTokens: 2, uncachedInputTokens: 8, outputTokens: index + 30,
                reasoningOutputTokens: 1, totalTokens: index + 40, currency: "USD", priceStatus: "unpriced",
                uncachedInputCostMicros: 0, cachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
              };
              await store.upsertThreadUsageLine({ line });
              if (workload === "turn-complete") await store.completeThreadUsageTurn({
                backend: "codex", threadId: id, turnId: id, completedAt: now + 100,
              });
            };
            for (let index = -20; index < 0; index++) await write(index);
            await store.readUsageActivity({ from: start - 10_000, to: start + 1 });
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
            const began = process.cpuUsage();
            for (let index = 1; index <= 120; index++) {
              let phase = process.cpuUsage();
              await write(index);
              const writeDelta = process.cpuUsage(phase);
              writeCpuMs += (writeDelta.user + writeDelta.system) / 1000;
              if (readEvery && index % readEvery === 0) {
                phase = process.cpuUsage();
                const end = workload === "read-fixed" ? start + 1 : now + 1;
                await store.readUsageActivity({ from: end - 10_000, to: end });
                const delta = process.cpuUsage(phase);
                readCpuMs += (delta.user + delta.system) / 1000;
                readCount++;
              }
            }
            const delta = process.cpuUsage(began);
            observation.mockRestore();
            appendFileSync(path.join(directory!, `${variant}-turns.jsonl`), `${JSON.stringify({
              variant, shape: "past", workload, readEvery, repetition, iterations: 120, stride: 1000,
              writeCpuMs, readCpuMs, totalCpuMs: (delta.user + delta.system) / 1000,
              walBytes: statSync(`${temp.dbPath}-wal`).size, readCount, materializations,
              cacheHits: readCount - materializations,
            })}\n`);
          } finally { db.close(); removeTempStateDbDir(temp.tempDir); }
        }
      }
    }
  } finally { clock.mockRestore(); vi.unstubAllEnvs(); }
}, 300_000);
