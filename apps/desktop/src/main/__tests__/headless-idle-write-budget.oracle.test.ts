import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { startHeadlessHost } from "../headless";
import type { SqliteWriteDelta, measureSqliteWrites } from "../state/sqlite-write-metrics";
import type { StateDb } from "../state/state-db";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

type Runtime = {
  StateDb: typeof StateDb;
  issueProviderDiscoveryPermit: typeof import("../settings/provider-discovery-permit").issueProviderDiscoveryPermit;
  startHeadlessHost: typeof startHeadlessHost;
  shutdownHeadlessHost(source: string): Promise<void>;
  measureSqliteWrites: typeof measureSqliteWrites;
  resetSqliteWriteMetrics(): void;
};

function createFixtureRoot(): string {
  // Every root sits at the same depth, so the bundle's relative runtime.json
  // resolves the same from a copy as from the directory it was built in.
  return fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pa-idle-budget-")));
}

/** The fixture environment and clock, installed before any bundle evaluates so
 * module-level consumers cannot capture the outer host. */
function enterFixture(root: string): void {
  for (const name of ["workspace", "fixture", "codex", "profiles/t/state"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  vi.stubEnv("PWRAGENT_HOME", root);
  vi.stubEnv("PWRAGENT_PROFILE", "t");
  vi.stubEnv("PWRAGENT_INSTANCE_ROOT", path.join(root, "workspace"));
  vi.stubEnv("PWRAGENT_CODEX_COMMAND", process.execPath);
  vi.stubEnv("PWRAGENT_CODEX_HOME", path.join(root, "codex"));
  vi.stubEnv("CODEX_HOME", path.join(root, "codex"));
  vi.stubEnv("PWRAGENT_TEST_DATA", path.join(root, "fixture"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 12) });
}

function leaveFixture(): void {
  vi.useRealTimers();
  vi.unstubAllEnvs();
}

// One build serves every case; each case runs its own copy, so each still
// evaluates a fresh owner module graph. Building per case cost ~150 ms each.
let buildRoot: string | undefined;
let builtBundle: string;
// Node reads no source map without --enable-source-maps; skipping them saves
// copying 22 MB of the bundle's 34 MB into every case.
const bundleCopy = { recursive: true, filter: (source: string) => !source.endsWith(".map") };

beforeAll(async () => {
  buildRoot = createFixtureRoot();
  builtBundle = path.join(buildRoot, "bundle");
  await buildOwnerFixture(builtBundle, "headless", `
    export { measureSqliteWrites, resetSqliteWriteMetrics } from "../state/sqlite-write-metrics";
    export { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
    export { StateDb } from "../state/state-db";
  `);
  // The bundle loads ~680 third-party files from node_modules by absolute
  // path, and Node caches them for the whole worker. Whichever case ran first
  // paid that load inside its own timeout, the symlink case never did. One
  // throwaway evaluation here loads them once for both cases. It never boots
  // a host, and each case requires its own copy at another path.
  try {
    enterFixture(buildRoot);
    createRequire(import.meta.url)(path.join(builtBundle, "dist/index.js"));
  } finally {
    leaveFixture();
  }
});

afterAll(() => {
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

it.each(process.platform === "win32" ? ["canonical"] : ["canonical", "symlink"])("the built Node owner's boot, one idle hour and shutdown stay within the lifecycle write budget (%s path)", async spelling => {
  const canonicalRoot = createFixtureRoot();
  const root = spelling === "symlink" ? `${canonicalRoot}-alias` : canonicalRoot;
  if (root !== canonicalRoot) fs.symlinkSync(canonicalRoot, root, "dir");
  const directory = path.join(root, "bundle");
  let runtime: Runtime | undefined;
  let boot: SqliteWriteDelta | undefined;
  let idle: SqliteWriteDelta | undefined;
  let shutdown: SqliteWriteDelta | undefined;
  try {
    fs.cpSync(builtBundle, directory, bundleCopy);
    enterFixture(root);
    const owner = runtime = createRequire(import.meta.url)(path.join(directory, "dist/index.js")) as Runtime;
    // Schema creation is fixture setup; every owner lifecycle write is measured.
    const db = owner.StateDb.open(path.join(root, "profiles/t/state/state.db"));
    db.close();
    owner.resetSqliteWriteMetrics();
    const { writes } = await owner.measureSqliteWrites(async () => {
      const started = await owner.measureSqliteWrites(async () => {
        const services = await owner.startHeadlessHost(undefined, { manageSignals: false });
        const permit = owner.issueProviderDiscoveryPermit("startup");
        await services.settings.refreshStartupDiscovery(permit);
        await services.registry.refreshProvidersAtStartup(permit);
        await services.service.startOwnerNavigation();
        await services.registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false });
        return services;
      });
      boot = started.writes;
      const services = started.result;
      ({ writes: idle } = await owner.measureSqliteWrites(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        if (services.registry.getThreadArchiveSweepStatus().running) {
          await services.registry.sweepInactiveThreads({ manual: false });
        }
      }));
      ({ writes: shutdown } = await owner.measureSqliteWrites(() => owner.shutdownHeadlessHost("idle-budget")));
    });
    // The first scheduled archive sweep claims and completes its one-time
    // repair. Its two metadata writes belong to this first idle hour.
    expect(idle!.tables.filter(table => table.rowsChanged > 0)).toMatchObject([{ table: "meta", rowsChanged: 2 }]);
    try {
      expectSqliteWriteBudget({ scenario: "headless-owner-lifecycle-idle-hour", writes,
        note: "Built Node root: boot an existing empty profile, one idle hour on fake timers, then shutdown. Wait for provider/navigation startup and join the archive sweep before measuring its complete timer cost." });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ lifecycle: writes.tables, boot: boot!.tables, idle: idle!.tables, shutdown: shutdown!.tables }, null, 2)}`, { cause: error });
    }
  } finally {
    try {
      await runtime?.shutdownHeadlessHost("idle-budget-cleanup");
    } finally {
      leaveFixture();
      if (root !== canonicalRoot) fs.unlinkSync(root);
      fs.rmSync(canonicalRoot, { recursive: true, force: true });
    }
  }
});
