// Model-based test of the GitHub release-list request budget, PwrAgent's port
// of PwrGit's invariant I5 (pwrdrvr/PwrGit#554). fast-check generates
// sessions of launches, restarts, clock advances, Settings opens, manual
// checks and rate-limited responses, and runs each on the real
// `auto-updater.ts` and the real on-disk `github-release-cache.ts`, under a
// fresh PWRAGENT_HOME per run with fake timers and a stubbed `fetch`.
//
// Unauthenticated GitHub API calls share 60 requests an hour per IP, and every
// PwrAgent, PwrGit and PwrSnap instance on a machine spends from that one
// allowance. The rules, checked on the log of release-list requests after
// every command and across restarts:
//
//   I5a  No automatic request in the first 10 minutes after first launch.
//   I5b  No automatic request within 15 minutes of a successful one.
//   I5c  No request at all, manual or automatic, before a rate limit resets.
//   I5d  At most 6 automatic requests in any hour.
//
// A request counts as manual only while an operator's Check for Updates is in
// flight. The 15-minute floor is the in-memory cache TTL #1768 promised; the
// durable cache since #2414 is stricter (hourly), and stays within it.
//
// Against PwrAgent's own pre-fix code (see the PR that added this file):
// before #1768 (no cache, no back-off) I5b and I5c fail without any restart;
// before #2414 (budget held in memory) a restart breaks I5a and I5b.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const MINUTE = 60_000;
const FIRST_CHECK_DELAY_MS = 10 * MINUTE;
const CACHE_TTL_MS = 15 * MINUTE;
const HOURLY_BUDGET = 6;
const RELEASES_URL = "https://api.github.com/repos/pwrdrvr/PwrAgent/releases";

// Captured before fake timers install, so settling never moves the clock.
const realSetImmediate = globalThis.setImmediate;
const cacheOperations = new Set<Promise<unknown>>();
type Gate = { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };
let responseGate: Gate | undefined;

function observe<T>(operations: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  operations.add(promise);
  void promise.then(() => operations.delete(promise), () => operations.delete(promise));
  return promise;
}

// Observe the real cache through its complete operation promise, including
// response-body consumption and the durable commit. It has no process-local
// budget state to reset: restarts must recover that state from disk.
vi.mock("../github-release-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-release-cache")>();
  return {
    ...actual,
    fetchGitHubReleaseMetadata: (...args: Parameters<typeof actual.fetchGitHubReleaseMetadata>) =>
      observe(cacheOperations, actual.fetchGitHubReleaseMetadata(...args)),
  };
});

type Request = { at: number; manual: boolean; resetAt?: number };
type DiskBudget = {
  createdAt: number;
  automaticAttempts: number[];
  rateLimitUntil?: number;
  entries: Record<string, { lastAttempt?: number; lastSuccess?: number; pendingUntil?: number; body?: string }>;
};

function readDiskBudget(directory: string): DiskBudget {
  return JSON.parse(readFileSync(path.join(directory, "cache", "github-releases", "state.json"), "utf8"));
}

const fake = {
  requests: [] as Request[],
  manualDepth: 0,
  rateLimitNextMinutes: undefined as number | undefined,
  reset(): void {
    this.requests = [];
    this.manualDepth = 0;
    this.rateLimitNextMinutes = undefined;
  },
};

const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(RELEASES_URL)) throw new Error(`unexpected request to ${url}`);
  const at = Date.now();
  const manual = fake.manualDepth > 0;
  const gate = responseGate;
  responseGate = undefined;
  if (gate) {
    gate.entered.resolve();
    await gate.release.promise;
  }
  if (fake.rateLimitNextMinutes !== undefined) {
    const resetAt = Math.ceil((at + fake.rateLimitNextMinutes * MINUTE) / 1_000) * 1_000;
    fake.rateLimitNextMinutes = undefined;
    fake.requests.push({ at, manual, resetAt });
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt / 1_000) },
    });
  }
  fake.requests.push({ at, manual });
  return new Response(JSON.stringify([{
    tag_name: "v1.0.0",
    prerelease: false,
    draft: false,
    assets: [
      { name: "latest-mac.yml", state: "uploaded" },
      { name: "PwrAgent-1.0.0-universal-mac.zip", state: "uploaded" },
    ],
  }]), { status: 200, headers: { "content-type": "application/json", etag: 'W/"releases"' } });
};

const nativeUpdater = {
  allowDowngrade: false,
  allowPrerelease: false,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  channel: undefined as string | undefined,
  currentVersion: { version: "1.0.0" },
  logger: undefined as unknown,
  // The installed build is the newest release, so no check downloads.
  checkForUpdates: async () => ({ updateInfo: { version: "1.0.0" } }),
  setFeedURL: () => {},
  on: () => nativeUpdater,
  once: () => nativeUpdater,
  removeListener: () => nativeUpdater,
  quitAndInstall: () => {},
};

vi.mock("@pwragent/shared/contracts/settings", async (importOriginal) => await importOriginal());
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0", quit: () => {}, relaunch: () => {} },
  autoUpdater: { on: () => {}, removeListener: () => {}, checkForUpdates: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: nativeUpdater } }));
vi.mock("../shell/linux-package-updater", () => ({
  createLinuxPackageUpdater: (updater: unknown) => updater,
  authorizeLinuxPackageUpdate: () => true,
}));
vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: () => ({
    read: () => ({ channel: "latest", train: "stable", selectionSource: "user" }),
    subscribe: () => () => {},
  }),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ info: () => {}, warn: () => {} }) }));
vi.mock("../shell/update-install-state", () => ({
  markUpdateInstallInProgress: () => {},
  markUpdateInstallUpdaterQuitReady: () => {},
  prepareForUpdateInstall: async () => {},
}));

type Updater = typeof import("../shell/auto-updater");
type World = { updater: Updater; firstLaunchAt: number; directory: string; owner: BudgetTestOwner };
type Model = Record<string, never>;
const loader = { load: () => import("../shell/auto-updater") };

class BudgetTestOwner {
  stopped = false;
  private readonly tasks = new Set<Promise<unknown>>();

  checkpoint(): void {
    if (this.stopped) throw new fc.PreconditionFailure(true);
  }

  run(work: (owner: BudgetTestOwner) => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(() => {
      this.checkpoint();
      return work(this);
    });
    return observe(this.tasks, task);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.tasks]);
    await settle();
  }
}

async function settle(): Promise<void> {
  do {
    await Promise.allSettled([...cacheOperations]);
    // Once the cache's real I/O settles, updater continuations and the
    // already-current native updater fake use only microtasks. Drain those
    // before examining whether they started another cache operation.
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  } while (cacheOperations.size > 0);
}

async function launch(world: World): Promise<void> {
  world.owner.checkpoint();
  // The old process exits. clearAllTimers rewinds the fake clock to where
  // it was installed, so put the time back: a restart does not move the clock.
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  vi.resetModules();
  world.updater = await loader.load();
  world.owner.checkpoint();
  world.updater.initAutoUpdater();
  // Join the check initAutoUpdater just started, in the same synchronous
  // turn. Joining does not spend another request or mark startup as manual.
  await world.updater.checkForAppUpdatesNow("startup");
  await settle();
}

function checkBudget(world: World): void {
  world.owner.checkpoint();
  const log = fake.requests;
  const durable = readDiskBudget(world.directory);
  expect(durable.createdAt, "a restart must keep the original first-launch delay").toBe(world.firstLaunchAt);
  const lastRequest = log.at(-1);
  expect(durable.automaticAttempts, "the disk reservation log must agree with actual automatic traffic").toEqual(
    log.filter((request) => !request.manual && request.at > (lastRequest?.at ?? world.firstLaunchAt) - 60 * MINUTE)
      .map((request) => request.at),
  );
  expect(durable.rateLimitUntil, "back-off must survive the next launch").toBe(
    log.filter((request) => request.resetAt !== undefined).map((request) => request.resetAt!).sort((a, b) => a - b).at(-1),
  );
  const entries = Object.values(durable.entries);
  expect(entries).toHaveLength(lastRequest ? 1 : 0);
  if (lastRequest) {
    const entry = entries[0];
    const success = log.filter((request) => request.resetAt === undefined).at(-1);
    expect(entry.pendingUntil, "commands may observe the budget only after the cache commit").toBeUndefined();
    expect(entry.lastAttempt).toBe(lastRequest.at);
    expect(entry.lastSuccess).toBe(success?.at);
    expect(entry.body === undefined ? undefined : JSON.parse(entry.body)[0].tag_name).toBe(success ? "v1.0.0" : undefined);
  }
  log.forEach((request, index) => {
    const earlier = log.slice(0, index);
    const limited = earlier.find((prior) => prior.resetAt !== undefined && request.at < prior.resetAt);
    expect(limited, `I5c: request at +${elapsed(world, request)} before the rate limit reset`).toBeUndefined();
    if (request.manual) return;
    expect(request.at - world.firstLaunchAt, "I5a: automatic request inside the first-launch delay")
      .toBeGreaterThanOrEqual(FIRST_CHECK_DELAY_MS);
    const success = earlier.filter((prior) => prior.resetAt === undefined).at(-1);
    if (success) {
      expect(request.at - success.at, `I5b: automatic request at +${elapsed(world, request)} inside the cache TTL`)
        .toBeGreaterThanOrEqual(CACHE_TTL_MS);
    }
    const lastHour = earlier.filter((prior) => !prior.manual && prior.at > request.at - 60 * MINUTE);
    expect(lastHour.length + 1, "I5d: hourly automatic budget").toBeLessThanOrEqual(HOURLY_BUDGET);
  });
}

const elapsed = (world: World, request: Request) => `${Math.round((request.at - world.firstLaunchAt) / MINUTE)}m`;

class Advance implements fc.AsyncCommand<Model, World> {
  constructor(readonly minutes: number) {}
  check = () => true;
  async run(_model: Model, world: World): Promise<void> {
    world.owner.checkpoint();
    await vi.advanceTimersByTimeAsync(this.minutes * MINUTE);
    await settle();
    checkBudget(world);
  }
  toString = () => `advance(${this.minutes}m)`;
}

class Restart implements fc.AsyncCommand<Model, World> {
  check = () => true;
  async run(_model: Model, world: World): Promise<void> {
    await launch(world);
    checkBudget(world);
  }
  toString = () => "restart";
}

class OpenSettings implements fc.AsyncCommand<Model, World> {
  check = () => true;
  async run(_model: Model, world: World): Promise<void> {
    world.owner.checkpoint();
    await world.updater.readAppUpdateReleaseVersions().catch(() => undefined);
    await settle();
    checkBudget(world);
  }
  toString = () => "openSettings";
}

class ManualCheck implements fc.AsyncCommand<Model, World> {
  check = () => true;
  async run(_model: Model, world: World): Promise<void> {
    world.owner.checkpoint();
    fake.manualDepth++;
    try {
      await world.updater.checkForAppUpdatesNow("manual").catch(() => undefined);
    } finally {
      fake.manualDepth--;
    }
    await settle();
    checkBudget(world);
  }
  toString = () => "manualCheck";
}

class RateLimitNext implements fc.AsyncCommand<Model, World> {
  constructor(readonly minutes: number) {}
  check = () => true;
  async run(_model: Model, world: World): Promise<void> {
    world.owner.checkpoint();
    fake.rateLimitNextMinutes = this.minutes;
    checkBudget(world);
  }
  toString = () => `rateLimitNext(${this.minutes}m)`;
}

const commandArbs = [
  fc.constantFrom(1, 5, 9, 11, 16, 30, 61, 120).map((minutes) => new Advance(minutes)),
  fc.constantFrom(1, 5, 9, 11, 16, 30, 61, 120).map((minutes) => new Advance(minutes)),
  fc.constant(new Restart()),
  fc.constant(new OpenSettings()),
  fc.constant(new OpenSettings()),
  fc.constant(new ManualCheck()),
  fc.integer({ min: 1, max: 90 }).map((minutes) => new RateLimitNext(minutes)),
];

describe("auto-updater release-list request budget", () => {
  const originalFetch = globalThis.fetch;
  const originalPlatform = process.platform;
  let root: string | undefined;
  let owner: BudgetTestOwner;

  beforeEach(() => {
    owner = new BudgetTestOwner();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PWRAGENT_E2E", "");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  });

  async function cleanup(): Promise<void> {
    // Vitest's outer timeout does not cancel fc.assert or a pending import.
    // Keep the fake clock, fetch and PWRAGENT_HOME installed until every
    // owned launch/model and real cache commit has settled.
    await owner.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
  afterEach(cleanup);

  async function runSession(scope: BudgetTestOwner, commands: Iterable<fc.AsyncCommand<Model, World>>): Promise<void> {
    scope.checkpoint();
    await settle();
    scope.checkpoint();
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "updater-budget-"));
    vi.stubEnv("PWRAGENT_HOME", root);
    fake.reset();
    const world = { firstLaunchAt: Date.now(), directory: root, owner: scope } as World;
    await launch(world);
    checkBudget(world);
    await fc.asyncModelRun(() => ({ model: {}, real: world }), commands);
  }

  // The shrunk counterexamples from the pre-fix runs, each led by an
  // eleven-minute wait so the deferred first check reaches GitHub first.
  it.each([
    // Before #1768 every Settings open spent a request.
    ["#1768 cache", [new Advance(11), new OpenSettings()]],
    // Before #1768 nothing backed off after a rate-limited response.
    ["#1768 back-off", [new Advance(11), new RateLimitNext(1), new ManualCheck(), new OpenSettings(), new OpenSettings()]],
    // Before #2414 the budget lived in memory, so a restart spent another.
    ["#2414 restart", [new Advance(11), new Restart()]],
  ])("keeps the shrunk %s sequence", async (_name, commands) => {
    await owner.run((scope) => runSession(scope, commands));
  });

  it("waits for the timer's real cache commit before the next model command", async ({ signal }) => {
    const gate: Gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const releaseOnTimeout = () => gate.release.resolve();
    signal.addEventListener("abort", releaseOnTimeout, { once: true });
    await owner.run((scope) => runSession(scope, []));
    responseGate = gate;
    const advancing = owner.run(async () => { await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS); });
    await gate.entered.promise;
    await advancing;
    let advanced = false;
    const waiting = Promise.withResolvers<void>();
    const ready = owner.run(async () => { waiting.resolve(); await settle(); advanced = true; });
    await waiting.promise;
    const directory = root!;
    const at = Date.now();
    try {
      const reserved = readDiskBudget(directory);
      expect(at).toBe(reserved.createdAt + FIRST_CHECK_DELAY_MS);
      expect(reserved.automaticAttempts).toEqual([at]);
      expect(Object.values(reserved.entries)).toEqual([expect.objectContaining({
        lastAttempt: at,
        pendingUntil: at + 30_000,
      })]);
      // Replay the former helper's three turns with the HTTP gate still
      // closed. These turns may flush callbacks, but cannot commit the body.
      for (let turn = 0; turn < 3; turn++) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(advanced, "a timer firing is not evidence that its request and disk commit finished").toBe(false);
      expect(Object.values(readDiskBudget(directory).entries)[0].lastSuccess).toBeUndefined();
    } finally {
      signal.removeEventListener("abort", releaseOnTimeout);
      gate.release.resolve();
      await ready;
      await settle();
    }
    const committed = Object.values(readDiskBudget(directory).entries)[0];
    expect(committed.pendingUntil).toBeUndefined();
    expect(committed.lastSuccess).toBe(at);
    expect(JSON.parse(committed.body!)[0].tag_name).toBe("v1.0.0");
  });

  it("joins a pending restart and the whole property before removing its durable budget", async ({ signal }) => {
    const gate: Gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const releaseOnTimeout = () => gate.release.resolve();
    signal.addEventListener("abort", releaseOnTimeout, { once: true });
    const load = loader.load;
    let launches = 0;
    let sessions = 0;
    const spy = vi.spyOn(loader, "load").mockImplementation(async () => {
      const updater = await load();
      if (++launches === 2) {
        gate.entered.resolve();
        await gate.release.promise;
      }
      return updater;
    });
    const running = owner.run((scope) => fc.assert(fc.asyncProperty(fc.constant(null), async () => {
      scope.checkpoint();
      sessions++;
      await runSession(scope, [new Advance(11), new Restart()]);
    }), { numRuns: 2, markInterruptAsFailure: true }));
    const outcome = running.then(() => "passed", () => "interrupted");
    await gate.entered.promise;
    const directory = root!;
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      const persisted = readDiskBudget(directory);
      expect(Object.values(persisted.entries)[0].lastSuccess).toBe(persisted.createdAt + FIRST_CHECK_DELAY_MS);
      closing = cleanup().then(() => { closed = true; });
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      expect(closed, "teardown must join the pending launch before restoring globals or deleting its root").toBe(false);
      expect(process.platform).toBe("win32");
      expect(process.env.PWRAGENT_HOME).toBe(directory);
      expect(readDiskBudget(directory)).toEqual(persisted);
    } finally {
      signal.removeEventListener("abort", releaseOnTimeout);
      // Also keep the oracle safe when run against the old teardown.
      owner.stopped = true;
      gate.release.resolve();
      await (closing ?? owner.close());
      await outcome;
      spy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(await outcome).toBe("interrupted");
    expect(sessions, "no further generated session or shrinking may reset the fixture after stop").toBe(1);
    expect(launches).toBe(2);
    expect(cacheOperations.size).toBe(0);
    expect(existsSync(directory)).toBe(false);
  });

  it("never spends a release-list request the budget does not allow", async () => {
    await owner.run((scope) => fc.assert(fc.asyncProperty(
      fc.commands(commandArbs, { maxCommands: 20 }),
      (commands) => runSession(scope, commands),
    ), { numRuns: 100, markInterruptAsFailure: true }));
  });
});
