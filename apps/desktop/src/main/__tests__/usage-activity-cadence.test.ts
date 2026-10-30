import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const start = Date.UTC(2026, 9, 27, 15);
// The opt-in report rebuilds 20,000-row fixtures for five samples per case.
const reportTimeout = process.env.PWRAGENT_USAGE_CADENCE_DIR ? 120_000 : undefined;
const scenarios = [
  { name: "request-boundaries", steps: 12, interval: 5000, threads: 1, flushes: 12 },
  { name: "steady-10hz", steps: 600, interval: 100, threads: 1, flushes: 60 },
  { name: "duplicate-10hz", steps: 600, interval: 100, threads: 1, flushes: 60, duplicate: true },
  { name: "ten-turns-10hz", steps: 600, interval: 100, threads: 10, flushes: 60 },
  { name: "burst", steps: 500, interval: 0, threads: 1, flushes: 1 },
  { name: "terminal-burst", steps: 20, interval: 50, threads: 1, flushes: 20, terminalEach: true },
  { name: "steady-with-focus", steps: 600, interval: 100, threads: 1, flushes: 60, focus: true },
];
// Six flush boundaries are enough to check ten-thread coalescing in the unit
// suite. Keep all 6,000 observations in the opt-in performance measurement.
const unitScenarios = scenarios.map((scenario) =>
  !process.env.PWRAGENT_USAGE_CADENCE_DIR && scenario.name === "ten-turns-10hz"
    ? { ...scenario, steps: 60, flushes: 6 }
    : scenario);

function usage(thread: string, turn: string, input: number): AgentEvent {
  return { backend: "codex", notification: { method: "thread/tokenUsage/updated", params: {
    threadId: thread, turnId: turn, model: "gpt-5.5",
    tokenUsage: { total: { inputTokens: input, cachedInputTokens: 100, outputTokens: 100 },
      last: { inputTokens: input, cachedInputTokens: 100, outputTokens: 100 } },
  } } } as AgentEvent;
}

function terminal(thread: string, turn: string): AgentEvent {
  return { backend: "codex", notification: { method: "turn/completed", params: {
    threadId: thread, turnId: turn, turn: { id: turn, status: "completed", output: [] },
  } } } as AgentEvent;
}

function cpuMs(before: NodeJS.CpuUsage): number {
  const delta = process.cpuUsage(before);
  return (delta.user + delta.system) / 1000;
}

async function replayCadence(scenario: typeof scenarios[number], signal: AbortSignal): Promise<void> {
  const directory = process.env.PWRAGENT_USAGE_CADENCE_DIR;
  const variant = process.env.PWRAGENT_USAGE_CADENCE_VARIANT ?? "revision";
  const repetitions = directory ? 5 : 1;
  for (let repetition = 0; repetition < repetitions; repetition++) {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const temp = createTempStateDb("pwragent-usage-cadence-");
    const db = StateDb.open(temp.dbPath);
    const store = new SqliteOverlayStore(db);
    const registry = new DesktopBackendRegistry({
      overlayStore: store,
      codexClient: {
        close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
        listThreads: async () => [], listNativeSubAgentThreads: async () => [],
        onNotification: () => () => {}, onPendingRequest: () => () => {},
      } as never,
    });
    try {
      await (registry as unknown as { usageTurnStartupRepair: Promise<void> }).usageTurnStartupRepair;
      signal.throwIfAborted();
      db.raw.pragma("wal_autocheckpoint = 0");
      if (directory) {
        const insert = db.raw.prepare(`INSERT INTO thread_usage_lines
          (usage_line_id, backend, thread_id, provider, source, scope, status, created_at,
           completed_at, updated_at, input_tokens, cached_input_tokens, uncached_input_tokens,
           output_tokens, reasoning_output_tokens, total_tokens, price_status, currency,
           uncached_input_cost_micros, cached_input_cost_micros, output_cost_micros, total_cost_micros)
          VALUES (?, 'codex', ?, 'openai', 'live', 'turn', 'finalized', ?, ?, ?,
            10, 2, 8, 3, 1, 13, 'priced', 'USD', 8, 2, 3, 13)`);
        db.raw.transaction(() => {
          for (let index = 0; index < 20_000; index++) {
            const time = start - (index + 14400) * 60_000;
            insert.run(`history-${index}`, `history-thread-${index}`, time, time + 1000, time + 1000);
          }
        })();
      }
      db.raw.pragma("wal_checkpoint(TRUNCATE)");
      resetSqliteWriteMetrics();
      const emit = (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit.bind(registry);
      let flushCpuMs = 0;
      let activityReadCpuMs = 0;
      let activityReads = 0;
      const write = store.upsertThreadUsageLines.bind(store);
      const batches = vi.spyOn(store, "upsertThreadUsageLines").mockImplementation(async (params) => {
        const before = process.cpuUsage();
        try { return await write(params); }
        finally { flushCpuMs += cpuMs(before); }
      });
      const began = process.cpuUsage();
      const active = await measureSqliteWrites(async () => {
        for (let step = 0; step < scenario.steps; step++) {
          for (let thread = 0; thread < scenario.threads; thread++) {
            signal.throwIfAborted();
            const id = "terminalEach" in scenario ? `short-${step}` : `active-${thread}`;
            await emit(usage(id, id, "duplicate" in scenario ? 1000 : (step + 1) * 1000));
            if ("terminalEach" in scenario) await emit(terminal(id, id));
          }
          await vi.advanceTimersByTimeAsync(scenario.interval);
          signal.throwIfAborted();
        }
        await vi.advanceTimersByTimeAsync(1000);
        if ("focus" in scenario) {
          const before = process.cpuUsage();
          await store.readUsageActivity({ from: Date.now() - 5 * 3_600_000, to: Date.now() });
          activityReadCpuMs += cpuMs(before);
          activityReads++;
        }
      });
      const activeCpuMs = cpuMs(began);
      expect(batches).toHaveBeenCalledTimes(scenario.flushes);
      expect(batches.mock.calls.every(([params]) => params.lines.length === scenario.threads)).toBe(true);
      const ending = await measureSqliteWrites(async () => {
        if (!("terminalEach" in scenario)) {
          for (let thread = 0; thread < scenario.threads; thread++) {
            await emit(terminal(`active-${thread}`, `active-${thread}`));
          }
        }
      });
      const beforeIdle = batches.mock.calls.length;
      const idle = await measureSqliteWrites(() => vi.advanceTimersByTimeAsync(30 * 60_000));
      expect(batches).toHaveBeenCalledTimes(beforeIdle);
      expect(idle.writes).toMatchObject({ commits: 0, rowsChanged: 0, statements: 0, walBytes: 0 });
      const identity = "terminalEach" in scenario ? "short-19" : "active-0";
      const pricing = await store.readThreadPricing({ backend: "codex", threadId: identity });
      expect(pricing.lines).toHaveLength(1);
      expect(pricing.lines[0]).toMatchObject({
        inputTokens: "duplicate" in scenario ? 1000 : scenario.steps * 1000,
      });
      expect(db.raw.prepare("SELECT completed_at FROM thread_usage_turns WHERE turn_id = ?").get(identity))
        .toEqual({ completed_at: expect.any(Number) });
      if (!directory) {
        for (const [phase, measured] of [["active", active], ["terminal", ending], ["idle", idle]] as const) {
          expectSqliteWriteBudget({ scenario: `usage-cadence-${scenario.name}-${phase}`, writes: measured.writes,
            note: `Contrived ${scenario.name} protocol replay: ${scenario.steps * scenario.threads} observations, ${scenario.flushes} existing bulk flushes, ${phase} phase; idle is 30 minutes with zero writes; no persistence cadence change` });
        }
      } else {
        mkdirSync(directory, { recursive: true });
        appendFileSync(path.join(directory, `${variant}.jsonl`), `${JSON.stringify({
          variant, scenario: scenario.name, repetition, observations: scenario.steps * scenario.threads,
          activeDurationMs: scenario.steps * scenario.interval + 1000,
          batches: batches.mock.calls.length, activeCpuMs, flushCpuMs, activityReadCpuMs, activityReads,
          active: active.writes, terminal: ending.writes, idle: idle.writes,
        })}\n`);
      }
    } finally {
      try { await registry.close(); }
      finally {
        try { db.close(); removeTempStateDbDir(temp.tempDir); }
        finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); }
      }
    }
  }
}

it.each(unitScenarios)("replays active and idle usage cadence: $name", async (scenario) => {
  const controller = new AbortController();
  const replay = replayCadence(scenario, controller.signal);
  // Vitest may time out the test before its async body settles. Own that body
  // through teardown, so it cannot restore global timers during the next case.
  onTestFinished(async () => {
    controller.abort();
    await replay.catch(() => {});
  });
  await replay;
}, reportTimeout);

it.skipIf(Boolean(process.env.PWRAGENT_USAGE_CADENCE_DIR))(
  "drains an interrupted cadence replay before another case owns timers",
  async () => {
    const controller = new AbortController();
    const replay = replayCadence(scenarios[0], controller.signal);
    setTimeout(() => controller.abort(new Error("fixture interruption")), 100);
    await expect(replay).rejects.toThrow("fixture interruption");
    expect(vi.isFakeTimers()).toBe(false);
    await replayCadence(scenarios[0], new AbortController().signal);
    expect(vi.isFakeTimers()).toBe(false);
  },
);
