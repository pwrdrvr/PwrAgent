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
import { mkdtempSync, rmSync } from "node:fs";
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

type Request = { at: number; manual: boolean; resetAt?: number };

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

vi.mock("@pwragent/shared", async (importOriginal) => await importOriginal());
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0", quit: () => {}, relaunch: () => {} },
  autoUpdater: { on: () => {}, removeListener: () => {}, checkForUpdates: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: nativeUpdater } }));
vi.mock("../linux-package-updater", () => ({
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
vi.mock("../update-install-state", () => ({
  markUpdateInstallInProgress: () => {},
  markUpdateInstallUpdaterQuitReady: () => {},
  prepareForUpdateInstall: async () => {},
}));

type Updater = typeof import("../auto-updater");
type World = { updater: Updater; firstLaunchAt: number };
type Model = Record<string, never>;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
}

async function launch(world: World): Promise<void> {
  // The old process exits. clearAllTimers rewinds the fake clock to where
  // it was installed, so put the time back: a restart does not move the clock.
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  vi.resetModules();
  world.updater = await import("../auto-updater");
  world.updater.initAutoUpdater();
  await settle();
}

function checkBudget(world: World): void {
  const log = fake.requests;
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
    await world.updater.readAppUpdateReleaseVersions().catch(() => undefined);
    await settle();
    checkBudget(world);
  }
  toString = () => "openSettings";
}

class ManualCheck implements fc.AsyncCommand<Model, World> {
  check = () => true;
  async run(_model: Model, world: World): Promise<void> {
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PWRAGENT_E2E", "");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchStub });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function runSession(commands: Iterable<fc.AsyncCommand<Model, World>>): Promise<void> {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "updater-budget-"));
    vi.stubEnv("PWRAGENT_HOME", root);
    fake.reset();
    const world = { firstLaunchAt: Date.now() } as World;
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
    await runSession(commands);
  });

  it("never spends a release-list request the budget does not allow", async () => {
    await fc.assert(fc.asyncProperty(
      fc.commands(commandArbs, { maxCommands: 20 }),
      runSession,
    ), { numRuns: 100 });
  });
});
