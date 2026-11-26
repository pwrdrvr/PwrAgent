import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { startHeadlessHost } from "../headless";
import type { SqliteWriteDelta, measureSqliteWrites } from "../state/sqlite-write-metrics";
import type { StateDb } from "../state/state-db";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";
import { LOADED_ON_FIRST_USE, packageOfFile } from "./helpers/headless-first-use-packages";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { FAKE_APPLICATION_ID, installFakeApplicationBundle } from "./helpers/fake-application-bundle";

type Runtime = {
  StateDb: typeof StateDb;
  issueProviderDiscoveryPermit: typeof import("../settings/provider-discovery-permit").issueProviderDiscoveryPermit;
  startHeadlessHost: typeof startHeadlessHost;
  shutdownHeadlessHost(source: string): Promise<void>;
  measureSqliteWrites: typeof measureSqliteWrites;
  discoverDesktopApplications: typeof import("../settings/application-discovery").discoverDesktopApplications;
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
  // Startup discovery also looks in ~/Applications. A fake home holding an
  // editor bundle with a decodable icon means every host, Linux CI included,
  // boots with an application whose icon a regression would decode.
  const home = path.join(root, "home");
  installFakeApplicationBundle(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
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

type PathSpelling = "canonical" | "symlink";
let activeFixture: Promise<void> | undefined;

function runFixture(
  spelling: PathSpelling,
  signal: AbortSignal,
  onFinished: (join: () => Promise<void>) => void,
  run: (root: string) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  // A cleanup hook also has a deadline. If it ever expires, the next case
  // must still leave the worker globals with the outstanding owner.
  if (activeFixture) throw new Error("The previous idle-budget fixture is still shutting down.");
  const work = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    const canonicalRoot = createFixtureRoot();
    const root = spelling === "symlink" ? `${canonicalRoot}-alias` : canonicalRoot;
    try {
      if (root !== canonicalRoot) fs.symlinkSync(canonicalRoot, root, "dir");
      try {
        enterFixture(root);
        await run(root);
      } finally {
        leaveFixture();
        if (root !== canonicalRoot) fs.unlinkSync(root);
      }
    } finally {
      fs.rmSync(canonicalRoot, { recursive: true, force: true });
    }
  }).finally(() => { activeFixture = undefined; });
  activeFixture = work;
  // Vitest times out the await of the test callback. Join the underlying
  // work and its teardown before the next case gets the clock and env.
  onFinished(async () => {
    try {
      await work;
    } catch (error) {
      // The callback already reports its own error. On timeout, still report
      // any distinct failure that happened while draining the fixture.
      if (signal.aborted && error !== signal.reason) throw error;
    }
  });
  return work;
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
    export { discoverDesktopApplications } from "../settings/application-discovery";
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

async function assertLifecycleBudget(root: string, signal: AbortSignal): Promise<void> {
  const directory = path.join(root, "bundle");
  let runtime: Runtime | undefined;
  let boot: SqliteWriteDelta | undefined;
  let idle: SqliteWriteDelta | undefined;
  let shutdown: SqliteWriteDelta | undefined;
  let loadedAfterBoot: string[] = [];
  try {
    fs.cpSync(builtBundle, directory, bundleCopy);
    const owner = runtime = createRequire(import.meta.url)(path.join(directory, "dist/index.js")) as Runtime;
    // Schema creation is fixture setup; every owner lifecycle write is measured.
    const db = owner.StateDb.open(path.join(root, "profiles/t/state/state.db"));
    db.close();
    owner.resetSqliteWriteMetrics();
    const { writes } = await owner.measureSqliteWrites(async () => {
      const started = await owner.measureSqliteWrites(async () => {
        const services = await owner.startHeadlessHost(undefined, { manageSignals: false });
        signal.throwIfAborted();
        const permit = owner.issueProviderDiscoveryPermit("startup");
        await services.settings.refreshStartupDiscovery(permit);
        signal.throwIfAborted();
        await services.registry.refreshProvidersAtStartup(permit);
        signal.throwIfAborted();
        await services.service.startOwnerNavigation();
        signal.throwIfAborted();
        await services.registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false });
        signal.throwIfAborted();
        // Every package this worker has loaded once the owner has booted.
        // Deferring a package only helps if boot does not then load it
        // anyway. The whole cache is read, not what boot added, so a package
        // an earlier case or file already loaded cannot hide from the check.
        loadedAfterBoot = [...new Set(Object.keys(createRequire(import.meta.url).cache)
          .map(packageOfFile).filter(name => name !== undefined))].sort();
        return services;
      });
      boot = started.writes;
      const services = started.result;
      ({ writes: idle } = await owner.measureSqliteWrites(async () => {
        // A single async tick for the full hour cannot observe cancellation.
        for (let minute = 0; minute < 60; minute++) {
          signal.throwIfAborted();
          await vi.advanceTimersByTimeAsync(60 * 1000);
        }
        signal.throwIfAborted();
        if (services.registry.getThreadArchiveSweepStatus().running) {
          await services.registry.sweepInactiveThreads({ manual: false });
        }
      }));
      signal.throwIfAborted();
      ({ writes: shutdown } = await owner.measureSqliteWrites(() => owner.shutdownHeadlessHost("idle-budget")));
    });
    signal.throwIfAborted();
    // No first-use package loads during boot. Startup discovery finds the
    // fake home's editor bundle without decoding its icon, so canvas stays
    // unloaded on every host.
    expect(loadedAfterBoot.filter(name => LOADED_ON_FIRST_USE.includes(name))).toEqual([]);
    // The owner's own discovery sees that bundle, so the check above has an
    // icon to decline. Discovery decodes nothing, so this loads no codec.
    const applications = await owner.discoverDesktopApplications();
    signal.throwIfAborted();
    expect(applications.editors.map(candidate => candidate.id)).toContain(FAKE_APPLICATION_ID);
    // The first scheduled archive sweep claims and completes its one-time
    // repair. Its two metadata writes belong to this first idle hour.
    expect(idle!.tables.filter(table => table.rowsChanged > 0)).toMatchObject([{ table: "meta", rowsChanged: 2 }]);
    try {
      expectSqliteWriteBudget({ scenario: "headless-owner-lifecycle-idle-hour", writes,
        note: "Built Node root: boot an existing empty profile, one idle hour on fake timers, then shutdown. The To-do runtime initializes the review tracking boundary once per profile. Checkout ownership adds one Federation instance ID commit on the first boot. Wait for provider/navigation startup and join the archive sweep." });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ lifecycle: writes.tables, boot: boot!.tables, idle: idle!.tables, shutdown: shutdown!.tables }, null, 2)}`, { cause: error });
    }
  } finally {
    await runtime?.shutdownHeadlessHost("idle-budget-cleanup");
  }
}

const spellings: PathSpelling[] = process.platform === "win32" ? ["canonical"] : ["canonical", "symlink"];
it.for(spellings)("the built Node owner's boot, one idle hour and shutdown stay within the lifecycle write budget (%s path)", (spelling, { signal, onTestFinished }) => {
  return runFixture(spelling, signal, onTestFinished, root => assertLifecycleBudget(root, signal));
});

it("keeps the clock and environment owned while a timed-out case drains", async ({ signal, onTestFinished }) => {
  const controller = new AbortController();
  const timeout = new Error("controlled test deadline");
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const outerHome = process.env.PWRAGENT_HOME;
  let join!: () => Promise<void>;
  const outcome = runFixture("canonical", controller.signal, finish => { join = finish; }, async root => {
    entered.resolve(root);
    await release.promise;
    controller.signal.throwIfAborted();
  }).catch((error: unknown) => error);
  onTestFinished(async () => {
    release.resolve();
    await join();
  });

  const root = await entered.promise;
  controller.abort(timeout);
  let joined = false;
  const drained = join().then(() => { joined = true; });
  try {
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(() => runFixture("canonical", signal, onTestFinished, async () => {})).toThrow("previous idle-budget fixture");
    expect(process.env.PWRAGENT_HOME).toBe(root);
    expect(vi.isFakeTimers()).toBe(true);
  } finally {
    release.resolve();
    await drained;
  }

  expect(await outcome).toBe(timeout);
  await runFixture("canonical", signal, onTestFinished, async successorRoot => {
    expect(process.env.PWRAGENT_HOME).toBe(successorRoot);
    expect(vi.isFakeTimers()).toBe(true);
  });
  expect(process.env.PWRAGENT_HOME).toBe(outerHome);
  expect(vi.isFakeTimers()).toBe(false);
});
