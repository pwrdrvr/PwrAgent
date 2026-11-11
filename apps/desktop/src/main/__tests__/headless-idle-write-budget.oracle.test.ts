import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import type { startHeadlessHost } from "../headless";
import type { SqliteWriteDelta, measureSqliteWrites } from "../state/sqlite-write-metrics";
import type { StateDb } from "../state/state-db";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

it("the built Node owner's boot, one idle hour and shutdown stay within the lifecycle write budget", async () => {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/pa-idle-budget-"));
  const directory = path.join(root, "bundle");
  for (const name of ["workspace", "fixture", "profiles/t/state"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  await buildOwnerFixture(directory, "headless", `
    export { measureSqliteWrites, resetSqliteWriteMetrics } from "../state/sqlite-write-metrics";
    export { StateDb } from "../state/state-db";
  `);
  type Runtime = {
    StateDb: typeof StateDb;
    startHeadlessHost: typeof startHeadlessHost;
    shutdownHeadlessHost(source: string): Promise<void>;
    measureSqliteWrites: typeof measureSqliteWrites;
    resetSqliteWriteMetrics(): void;
  };
  const runtime = createRequire(import.meta.url)(path.join(directory, "dist/index.js")) as Runtime;
  vi.stubEnv("PWRAGENT_HOME", root);
  vi.stubEnv("PWRAGENT_PROFILE", "t");
  vi.stubEnv("PWRAGENT_CODEX_COMMAND", process.execPath);
  vi.stubEnv("PWRAGENT_TEST_DATA", path.join(root, "fixture"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  // Schema creation is fixture setup; every owner lifecycle write is measured.
  const db = runtime.StateDb.open(path.join(root, "profiles/t/state/state.db"));
  db.close();
  runtime.resetSqliteWriteMetrics();
  vi.useFakeTimers();
  let idle: SqliteWriteDelta | undefined;
  try {
    const { writes } = await runtime.measureSqliteWrites(async () => {
      const services = await runtime.startHeadlessHost(undefined, { manageSignals: false });
      await services.registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false });
      ({ writes: idle } = await runtime.measureSqliteWrites(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      }));
      await runtime.shutdownHeadlessHost("idle-budget");
    });
    expect(idle!.rowsChanged, JSON.stringify(idle)).toBe(0);
    expect(idle!.walBytes).toBe(0);
    expectSqliteWriteBudget({ scenario: "headless-owner-lifecycle-idle-hour", writes,
      note: "Built Node root: boot an existing empty profile, one idle hour on fake timers, then shutdown. Idle timer statements change zero rows and grow the WAL by zero bytes." });
  } finally {
    await runtime.shutdownHeadlessHost("idle-budget-cleanup");
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
