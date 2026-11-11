import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import type { startHeadlessHost } from "../headless";
import type { SqliteWriteDelta, measureSqliteWrites } from "../state/sqlite-write-metrics";
import type { StateDb } from "../state/state-db";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

it("the built Node owner's boot, one idle hour and shutdown stay within the lifecycle write budget", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-idle-budget-")));
  const directory = path.join(root, "bundle");
  for (const name of ["workspace", "fixture", "profiles/t/state"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  await buildOwnerFixture(directory, "headless", `
    export { measureSqliteWrites, resetSqliteWriteMetrics } from "../state/sqlite-write-metrics";
    export { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
    export { StateDb } from "../state/state-db";
  `);
  type Runtime = {
    StateDb: typeof StateDb;
    issueProviderDiscoveryPermit: typeof import("../settings/provider-discovery-permit").issueProviderDiscoveryPermit;
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
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 12) });
  let idle: SqliteWriteDelta | undefined;
  try {
    const { writes } = await runtime.measureSqliteWrites(async () => {
      const services = await runtime.startHeadlessHost(undefined, { manageSignals: false });
      const permit = runtime.issueProviderDiscoveryPermit("startup");
      await services.settings.refreshStartupDiscovery(permit);
      await services.registry.refreshProvidersAtStartup(permit);
      await services.service.startOwnerNavigation();
      await services.registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false });
      ({ writes: idle } = await runtime.measureSqliteWrites(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        if (services.registry.getThreadArchiveSweepStatus().running) {
          await services.registry.sweepInactiveThreads({ manual: false });
        }
      }));
      await runtime.shutdownHeadlessHost("idle-budget");
    });
    // The first scheduled archive sweep claims and completes its one-time
    // repair. Its two metadata writes belong to this first idle hour.
    expect(idle!.tables.filter(table => table.rowsChanged > 0)).toMatchObject([{ table: "meta", rowsChanged: 2 }]);
    expectSqliteWriteBudget({ scenario: "headless-owner-lifecycle-idle-hour", writes,
      note: "Built Node root: boot an existing empty profile, one idle hour on fake timers, then shutdown. Wait for provider/navigation startup and join the archive sweep before measuring its complete timer cost." });
  } finally {
    await runtime.shutdownHeadlessHost("idle-budget-cleanup");
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
