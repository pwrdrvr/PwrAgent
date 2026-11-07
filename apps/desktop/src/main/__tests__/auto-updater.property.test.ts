// Ported from pwrdrvr/PwrGit#554 (ef3d79acc). Release slots follow the
// runbook's tag scheme; the independent oracle never calls compareSemver.
// PwrAgent returns at `available`, so its model settles downloads through
// updater events and exercises its cancellation token as well as failures.
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AppUpdateStatus } from "../../shared/app-metadata";

type Handler = (...args: unknown[]) => void;
type Pending = {
  version: string;
  promise: Promise<string[]>;
  resolve: (files: string[]) => void;
  reject: (error: Error) => void;
};

const fake = vi.hoisted(() => {
  const macrotask = globalThis.setImmediate;
  const handlers = new Map<string, Set<Handler>>();
  const nativeHandlers = new Map<string, Handler>();
  const native = {
    checkForUpdates: vi.fn(),
    once: (event: string, handler: Handler) => nativeHandlers.set(event, handler),
    removeListener: (event: string, handler: Handler) => {
      if (nativeHandlers.get(event) === handler) nativeHandlers.delete(event);
    },
    emit: (event: string) => {
      const handler = nativeHandlers.get(event);
      nativeHandlers.delete(event);
      handler?.();
    },
  };
  const state = {
    feed: new Set<string>(),
    train: "stable" as "stable" | "beta",
    changed: () => {},
    disk: new Set<string>(),
    file: undefined as string | undefined,
    pending: undefined as Pending | undefined,
    feedTag: "",
    shown: undefined as AppUpdateStatus | undefined,
    quitHandlerAdded: false,
    ran: [] as Array<{ file: string | undefined; onDisk: boolean }>,
  };
  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };
  const landed = (version: string): void => {
    state.disk.add(version);
    state.file = version;
    emit("update-downloaded", { version });
    // MacUpdater.doDownloadUpdate dispatches the zip's event first, then
    // requests Squirrel staging only if auto-install is still enabled.
    if (process.platform === "darwin" && autoUpdater.autoInstallOnAppQuit) {
      native.checkForUpdates();
    }
    if (autoUpdater.autoInstallOnAppQuit) state.quitHandlerAdded = true;
  };
  const stop = (canceled: boolean): void => {
    const pending = state.pending!;
    state.pending = undefined;
    state.disk.clear();
    state.file = undefined;
    const error = new Error("network failed");
    // A cancel rejects with the same error shape, but emits no error event.
    emit(
      canceled ? "update-cancelled" : "error",
      canceled ? { version: pending.version } : error,
    );
    pending.reject(error);
  };
  const autoUpdater = {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    currentVersion: { version: "1.0.0" },
    logger: undefined as unknown,
    setFeedURL: ({ url }: { url: string }) => {
      state.feedTag = decodeURIComponent(/\/download\/([^/]+)\/$/.exec(url)![1]);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
    },
    checkForUpdates: async () => {
      const version = state.feedTag.slice(1);
      emit("checking-for-update");
      emit("update-available", { version });
      // AppUpdater.downloadUpdate reuses a running downloadPromise. A check
      // can return at available while that download is still running here.
      if (state.pending) {
        return { updateInfo: { version }, downloadPromise: state.pending.promise };
      }
      let downloadPromise: Promise<string[]>;
      if (state.disk.has(version)) {
        // Cached validation hashes the file before emitting update-downloaded.
        downloadPromise = new Promise<void>((resolve) => macrotask(resolve)).then(() => {
          landed(version);
          return [];
        });
      } else {
        // electron-updater has ONE pending cache across tracks. Starting a
        // different download deletes the old installer but leaves file stale.
        state.disk.clear();
        let resolve!: Pending["resolve"];
        let reject!: Pending["reject"];
        downloadPromise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        state.pending = { version, promise: downloadPromise, resolve, reject };
      }
      return {
        updateInfo: { version },
        downloadPromise,
        cancellationToken: {
          cancel: () => { if (state.pending) stop(true); },
        },
      };
    },
    quitAndInstall: () => {
      state.ran.push({
        file: state.file,
        onDisk: state.file !== undefined && state.disk.has(state.file),
      });
    },
  };
  return {
    state,
    autoUpdater,
    native,
    nativeHandlers,
    macrotask,
    stop,
    succeed: () => {
      const pending = state.pending!;
      state.pending = undefined;
      landed(pending.version);
      pending.resolve([]);
    },
    reset: () => {
      handlers.clear();
      nativeHandlers.clear();
      native.checkForUpdates.mockReset();
      state.disk.clear();
      state.file = undefined;
      state.pending = undefined;
      state.shown = undefined;
      state.quitHandlerAdded = false;
      state.ran = [];
      state.changed = () => {};
      autoUpdater.autoInstallOnAppQuit = false;
    },
  };
});

// The shared module is real, loaded once across resetModules for each run.
vi.mock("@pwragent/shared", async (importOriginal) => await importOriginal());
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0" },
  autoUpdater: fake.native,
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, status: AppUpdateStatus) => {
          if (channel === "app:update-status-event") fake.state.shown = status;
        },
      },
    }],
  },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: fake.autoUpdater } }));
vi.mock("../linux-package-updater", () => ({
  createLinuxPackageUpdater: (updater: unknown) => updater,
  authorizeLinuxPackageUpdate: () => true,
}));
// Request-budget persistence has its own tests. This model owns only the
// network feed and updater cache, so no live settings, SQLite or HTTP is used.
vi.mock("../github-release-cache", () => ({
  reserveAppReleaseCheck: () => {},
  ReleaseCheckDeferredError: class extends Error {},
  fetchGitHubReleaseMetadata: async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => [...fake.state.feed].map((tag) => ({
      tag_name: tag,
      prerelease: tag.includes("-"),
      draft: false,
      // PwrAgent's non-Linux selector requires the Mac manifest and zip,
      // including in Windows checks (unlike PwrGit's Windows asset filter).
      assets: [
        { name: "latest-mac.yml", state: "uploaded" },
        { name: "PwrAgent-universal-mac.zip", state: "uploaded" },
      ],
    })),
  }),
}));
vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: () => ({
    read: () => ({ channel: "latest", train: fake.state.train, selectionSource: "user" }),
    subscribe: (_keys: string[], changed: () => void) => {
      fake.state.changed = changed;
      return () => {};
    },
  }),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ info: () => {}, warn: () => {} }) }));
vi.mock("../update-install-state", () => ({
  markUpdateInstallInProgress: () => {},
  markUpdateInstallUpdaterQuitReady: () => {},
  prepareForUpdateInstall: async () => {},
}));

type GitHubRelease = Parameters<typeof import("../auto-updater").selectChannelReleases>[0][number];
const { selectChannelReleases, compareSemver } = await import("../auto-updater");

const originalPlatform = process.platform;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
});

type Kind = "final" | "prerelease" | "beta" | "alpha";
type Tag = { core: [number, number, number]; kind: Kind; n: number };

function tagName(tag: Tag): string {
  const core = tag.core.join(".");
  return tag.kind === "final" ? `v${core}` : `v${core}-${tag.kind}.${tag.n}`;
}

function parseTag(name: string | undefined): Tag {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(prerelease|beta|alpha)\.(\d+))?$/.exec(name ?? "");
  if (!match) throw new Error(`not a generated tag: ${name}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    kind: (match[4] as Kind | undefined) ?? "final",
    n: Number(match[5] ?? 0),
  };
}

function compareCore(a: Tag, b: Tag): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  }
  return 0;
}

/** Semver precedence, written out for this scheme only, so the oracle does
 *  not share code with the module it judges. A final outranks its own
 *  prereleases; `alpha` < `beta` < `prerelease` is also their ASCII order. */
function compareTags(a: string | undefined, b: string | undefined): number {
  const x = parseTag(a);
  const y = parseTag(b);
  const core = compareCore(x, y);
  if (core !== 0) return core;
  if (x.kind === y.kind) return x.n - y.n;
  if (x.kind === "final") return 1;
  if (y.kind === "final") return -1;
  return x.kind < y.kind ? -1 : 1;
}

const tagArb: fc.Arbitrary<Tag> = fc.record({
  // Small ranges, so cores collide and an alpha and a beta share one.
  core: fc.tuple(fc.nat(2), fc.nat(2), fc.nat(2)),
  kind: fc.constantFrom<Kind>("final", "prerelease", "beta", "alpha"),
  n: fc.integer({ min: 1, max: 3 }),
});

const releaseArb: fc.Arbitrary<GitHubRelease> = fc
  .record({
    tag: tagArb,
    stagedAsPrerelease: fc.boolean(),
    draft: fc.nat(4).map((n) => n === 0),
  })
  .map(({ tag, stagedAsPrerelease, draft }) => ({
    tag_name: tagName(tag),
    prerelease: tag.kind !== "final" || stagedAsPrerelease,
    draft,
  }));

const feedArb = fc.uniqueArray(releaseArb, {
  maxLength: 8,
  selector: (release) => release.tag_name,
});

/** A feed with at least one GitHub Latest: a published, unstaged final. */
const feedWithLatestArb = fc
  .tuple(fc.tuple(fc.nat(2), fc.nat(2), fc.nat(2)), feedArb)
  .map(([core, feed]): GitHubRelease[] => {
    const latest = { tag_name: `v${core.join(".")}`, prerelease: false, draft: false };
    return [latest, ...feed.filter((r) => r.tag_name !== latest.tag_name)];
  });

const published = (feed: GitHubRelease[]) => feed.filter((r) => r.draft !== true);

/** The highest release GitHub marks Latest: published, not a Pre-release. */
function oracleStableLatest(feed: GitHubRelease[]): string | undefined {
  return published(feed)
    .filter((r) => r.prerelease !== true)
    .map((r) => r.tag_name)
    .sort(compareTags)
    .at(-1);
}

const tagOf = (release: GitHubRelease | undefined) => release?.tag_name;

/** `lower` ≤ `upper`, where a missing `lower` bounds nothing and a missing
 *  `upper` is below any release. */
function atMost(lower: GitHubRelease | undefined, upper: GitHubRelease | undefined): boolean {
  if (lower === undefined) return true;
  return upper !== undefined && compareTags(lower.tag_name, upper.tag_name) <= 0;
}

describe("selectChannelReleases", () => {
  it("P0: every slot is a published release, and Stable Latest is the highest GitHub Latest", () => {
    fc.assert(
      fc.property(feedArb, (feed) => {
        const slots = selectChannelReleases(feed);
        const publishedTags = new Set(published(feed).map((r) => r.tag_name));
        for (const slot of Object.values(slots)) {
          if (slot) expect(publishedTags).toContain(slot.tag_name);
        }
        expect(tagOf(slots.stableLatest)).toBe(oracleStableLatest(feed));
      })
    );
  });

  it("P1: with a Stable Latest, every slot is set and none is below the oracle's latest", () => {
    fc.assert(
      fc.property(feedWithLatestArb, (feed) => {
        const { stableLatest, stablePrerelease, betaLatest, betaPrerelease } =
          selectChannelReleases(feed);
        expect(stableLatest).toBeDefined();
        for (const slot of [stableLatest, stablePrerelease, betaLatest, betaPrerelease]) {
          expect(slot).toBeDefined();
          expect(compareTags(tagOf(slot), oracleStableLatest(feed))).toBeGreaterThanOrEqual(0);
        }
      })
    );
  });

  it("P2: Prerelease never trails Latest, and Beta never trails Stable", () => {
    fc.assert(
      fc.property(feedArb, (feed) => {
        // Outside the runbook's scheme: a `-beta.N` line with no same-core
        // alpha and no Stable Latest is the pre-1.0 world, whose betas were
        // Stable prereleases. Stable · Prerelease offers it and Beta ·
        // Prerelease does not, on purpose (PwrGit#417's "outside the runbook's tag
        // scheme"). Every other feed must keep the lattice.
        fc.pre(!hasLegacyBetaLineWithoutLatest(feed));
        const s = selectChannelReleases(feed);
        expect(atMost(s.stableLatest, s.stablePrerelease)).toBe(true);
        expect(atMost(s.stablePrerelease, s.betaPrerelease)).toBe(true);
        expect(atMost(s.stableLatest, s.betaLatest)).toBe(true);
        expect(atMost(s.betaLatest, s.betaPrerelease)).toBe(true);
      })
    );
  });

  it("P3: the order releases were published in does not change any slot", () => {
    const feedAndShuffleArb = feedArb.chain((feed) =>
      fc.tuple(
        fc.constant(feed),
        fc.shuffledSubarray(feed, { minLength: feed.length, maxLength: feed.length }),
      ),
    );
    fc.assert(
      fc.property(feedAndShuffleArb, ([feed, shuffled]) => {
        const a = selectChannelReleases(feed);
        const b = selectChannelReleases(shuffled);
        for (const key of Object.keys(a) as Array<keyof typeof a>) {
          expect(tagOf(b[key])).toBe(tagOf(a[key]));
        }
      })
    );
  });
});

function hasLegacyBetaLineWithoutLatest(feed: GitHubRelease[]): boolean {
  if (oracleStableLatest(feed) !== undefined) return false;
  const tags = published(feed).map((r) => parseTag(r.tag_name));
  return tags.some(
    (beta) =>
      beta.kind === "beta"
      && !tags.some((alpha) => alpha.kind === "alpha" && compareCore(alpha, beta) === 0),
  );
}

/** Independent SemVer 2 precedence oracle. semver is not a declared project
 * dependency, so use bigint identifiers and a lexicographic tuple comparison
 * instead of importing an undeclared transitive package. Build metadata has
 * no precedence. Nonversions are a bottom element, as the updater promises.
 * The generator uses valid SemVer (optionally prefixed with the repo's `v`)
 * plus definitely unparseable tags. It does not judge extra parser leniency.
 */
function referenceSemver(a: string | undefined, b: string | undefined): number {
  const parse = (tag: string | undefined) => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag ?? "");
    return match === null ? undefined : {
      core: match.slice(1, 4).map((part) => BigInt(part)),
      pre: match[4]?.split("."),
    };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return Number(x !== undefined) - Number(y !== undefined);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  }
  if (!x.pre || !y.pre) return Number(y.pre !== undefined) - Number(x.pre !== undefined);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const xi = x.pre[i];
    const yi = y.pre[i];
    if (xi === yi) continue;
    const xn = /^\d+$/.test(xi);
    const yn = /^\d+$/.test(yi);
    if (xn && yn) return BigInt(xi) > BigInt(yi) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return xi > yi ? 1 : -1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

const coreArb = fc.tuple(fc.nat(10_000), fc.nat(10_000), fc.nat(10_000));
const textIdArb = fc.tuple(
  fc.constantFrom("a", "b", "Z", "-"),
  fc.string({ unit: fc.constantFrom("a", "b", "Z", "0", "9", "-"), maxLength: 8 }),
).map(([first, rest]) => first + rest);
const idArb = fc.oneof(fc.nat(1_000_000).map(String), textIdArb);
const versionPartsArb = fc.record({
  pre: fc.array(idArb, { maxLength: 5 }),
  build: fc.array(idArb, { maxLength: 3 }),
  prefix: fc.constantFrom("", "v"),
});
const versionOnCore = (core: number[]) => versionPartsArb.map(({ pre, build, prefix }) =>
  `${prefix}${core.join(".")}${pre.length ? `-${pre.join(".")}` : ""}${build.length ? `+${build.join(".")}` : ""}`,
);
const versionArb = coreArb.chain(versionOnCore);
const unparseableArb = fc.oneof(
  fc.constantFrom(undefined, "", "latest", "v1", "1.2", "1.2.3-", "1.2.3+", "1.2.3/"),
  fc.string({ maxLength: 16 }).map((s) => `release-${s}`),
);
const versionOrInvalidArb = fc.oneof(versionArb, unparseableArb);

describe("compareSemver", () => {
  it("agrees with independent SemVer precedence, with unparseable tags below versions", () => {
    const pairArb = fc.oneof(
      fc.tuple(versionOrInvalidArb, versionOrInvalidArb),
      // Most uniformly random cores differ immediately. Share cores in half
      // the cases so numeric/text identifiers and prerelease lengths matter.
      coreArb.chain((core) => fc.tuple(versionOnCore(core), versionOnCore(core))),
    );
    fc.assert(fc.property(pairArb, ([a, b]) => {
      const expected = referenceSemver(a, b);
      expect(Math.sign(compareSemver(a, b)) || 0).toBe(expected);
      expect(Math.sign(compareSemver(b, a)) || 0).toBe(-expected || 0);
    }));
  });
});

type Train = "stable" | "beta";
type Updater = typeof import("../auto-updater");
const BASELINE = "v1.0.0";
const TAG_POOL = [
  "v1.0.1",
  "v1.0.2",
  "v1.1.0",
  "v1.1.0-beta.1",
  "v1.1.0-beta.2",
  "v1.2.0-beta.1",
  "v1.1.0-alpha.1",
  "v1.0.3-prerelease.1",
] as const;

/** The Latest tracks ignore alphas and RCs. A beta needs a core above the
 * newest final; otherwise both tracks follow that final's promotion. */
function newestEligible(feed: ReadonlySet<string>, train: Train): string {
  const tags = [...feed];
  const stable = tags.filter((tag) => !tag.includes("-")).sort(compareTags).at(-1)!;
  const core = (tag: string) => tag.split("-")[0];
  const eligible = train === "stable" ? [stable] : [stable, ...tags.filter((tag) =>
    /-beta\.\d+$/.test(tag) && compareTags(core(tag), core(stable)) > 0,
  )];
  return eligible.sort(compareTags).at(-1)!.slice(1);
}

type Model = { feed: Set<string>; train: Train; downloading: boolean };
type World = { updater: Updater };
type Action = "publish" | "selectTrain" | "check" | "succeed" | "fail" | "cancel" | "restart";

/** The real macrotask drains microtasks without relying on a guessed number
 * of Promise.resolve calls. Cached validation and queued selection checks
 * can each need a turn. Fake timers control only the updater's own timers;
 * no real sleeps or live network requests are used. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await new Promise<void>((resolve) => fake.macrotask(resolve));
  }
}

function checkInvariants(world: World): void {
  const { state, autoUpdater } = fake;
  const assertOnDisk = (status: AppUpdateStatus | undefined) => {
    if (status?.status === "downloaded") {
      expect(state.disk, `Restart to v${status.version} must exist on disk`).toContain(status.version);
    }
  };
  // Check the renderer's last broadcast before a status read can reconcile it.
  assertOnDisk(state.shown);
  assertOnDisk(world.updater.readAppUpdateStatus());
  if (autoUpdater.autoInstallOnAppQuit && state.quitHandlerAdded && state.file) {
    expect(state.disk, `install-on-quit would run v${state.file}`).toContain(state.file);
  }
}

async function afterCommand(model: Model, world: World): Promise<void> {
  await settle();
  // electron-updater owns download lifetime. The fake cache is the disk
  // oracle, independent of main's held-update bookkeeping (as in PwrGit).
  model.downloading = fake.state.pending !== undefined;
  checkInvariants(world);
}

class SessionCommand implements fc.AsyncCommand<Model, World> {
  constructor(readonly action: Action, readonly value = "") {}
  check(model: Readonly<Model>): boolean {
    switch (this.action) {
      case "publish": return !model.feed.has(this.value);
      case "selectTrain": return model.train !== this.value;
      // Settings disables Check while its download is in progress. Track
      // changes are still generated then, exercising the queued handoff.
      case "check": return !model.downloading;
      case "succeed":
      case "fail":
      case "cancel": return model.downloading;
      case "restart": return true;
    }
  }
  async run(model: Model, world: World): Promise<void> {
    const { state } = fake;
    switch (this.action) {
      case "publish":
        model.feed.add(this.value);
        state.feed.add(this.value);
        break;
      case "selectTrain":
        model.train = this.value as Train;
        state.train = model.train;
        state.changed();
        break;
      case "check": {
        const target = newestEligible(model.feed, model.train);
        const result = await world.updater.checkForAppUpdatesNow("manual");
        if (target === "1.0.0") {
          expect(result).toEqual({ status: "no-update", version: target });
        } else {
          // PwrAgent answers before downloadPromise settles, unlike PwrGit.
          expect(["available", "downloaded"]).toContain(result.status);
          expect("version" in result ? result.version : undefined).toBe(target);
        }
        break;
      }
      case "succeed": fake.succeed(); break;
      case "fail": fake.stop(false); break;
      case "cancel":
        expect(world.updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
        break;
      case "restart": {
        const shown = state.shown;
        const named = shown?.status === "downloaded" ? shown.version : undefined;
        const before = state.ran.length;
        await world.updater.installDownloadedAppUpdate();
        await settle();
        expect(state.ran.slice(before), "Restart installs only what its offer names").toEqual(
          named === undefined ? [] : [{ file: named, onDisk: true }],
        );
        break;
      }
    }
    await afterCommand(model, world);
  }
  toString(): string {
    return this.value ? `${this.action}(${this.value})` : this.action;
  }
}

const selectTrainArb = fc.constantFrom<Train>("stable", "beta")
  .map((train) => new SessionCommand("selectTrain", train));
const checkArb = fc.constant(new SessionCommand("check"));
const commandArbs = [
  fc.constantFrom(...TAG_POOL).map((tag) => new SessionCommand("publish", tag)),
  // PwrGit's weighting: most races live at a check or a selection change
  // between starting and settling a download.
  selectTrainArb,
  selectTrainArb,
  checkArb,
  checkArb,
  ...(["succeed", "fail", "cancel", "restart"] as const)
    .map((action) => fc.constant(new SessionCommand(action))),
];

async function runSession(
  start: { published: string[]; train: Train },
  commands: Iterable<fc.AsyncCommand<Model, World>>,
): Promise<void> {
  vi.clearAllTimers();
  fake.reset();
  const feed = new Set([BASELINE, ...start.published]);
  fake.state.feed = new Set(feed);
  fake.state.train = start.train;
  vi.resetModules();
  const world = { updater: await import("../auto-updater") };
  world.updater.initAutoUpdater();
  const model: Model = { feed, train: start.train, downloading: false };
  try {
    await afterCommand(model, world);
    await fc.asyncModelRun(() => ({ model, real: world }), commands);
  } finally {
    // Drain selection waiters before the next run resets the module.
    // A cancel may unblock another queued track's download.
    while (fake.state.pending) {
      world.updater.cancelAppUpdateDownload();
      await settle();
    }
  }
}

function useWindowsUpdater(): void {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
}

describe("auto-updater held-update model (Windows pending cache)", () => {
  it("does not restore a deleted Stable installer when switching back during a Beta download", async () => {
    useWindowsUpdater();
    // Shrunk from the model: Stable finishes after selecting Beta, whose
    // queued check deletes the Stable installer before selecting Stable again.
    await runSession({ published: ["v1.1.0", "v1.2.0-beta.1"], train: "stable" }, [
      new SessionCommand("selectTrain", "beta"),
      new SessionCommand("succeed"),
      new SessionCommand("selectTrain", "stable"),
    ]);
  });

  it("Restart offers and install-on-quit always name an installer still on disk", async () => {
    useWindowsUpdater();
    await fc.assert(fc.asyncProperty(
      fc.record({ published: fc.subarray([...TAG_POOL]), train: fc.constantFrom<Train>("stable", "beta") }),
      fc.commands(commandArbs, { size: "medium", maxCommands: 30 }),
      runSession,
    // PwrGit's 400 medium sessions catch races much more reliably than the
    // default short commands. With in-memory cache/settings and one module
    // reload per run this stays under the 5 s local test timeout.
    ), { numRuns: 400 });
  });
});

/** An unselected installer must stay disarmed, but its replacement still
 * needs a native staging request before its Restart offer can be shown. The
 * fake's post-dispatch gate above is the oracle from MacUpdater's source. */
async function runMacStagingSession(patch: number, beta: number, startTrain: Train): Promise<void> {
  vi.clearAllTimers();
  fake.reset();
  const stableVersion = `1.0.${patch}`;
  const betaVersion = `2.0.0-beta.${beta}`;
  fake.state.feed = new Set([BASELINE, `v${stableVersion}`, `v${betaVersion}`]);
  fake.state.train = startTrain;
  vi.resetModules();
  const updater = await import("../auto-updater");
  updater.initAutoUpdater();
  await settle();
  fake.succeed();
  await settle();
  expect(fake.native.checkForUpdates).toHaveBeenCalledTimes(1);
  // The first build has staged. The replacement's completion is delivered
  // separately, only after main or MacUpdater actually requests staging.
  fake.native.emit("update-downloaded");
  fake.native.checkForUpdates.mockReset();
  fake.native.checkForUpdates.mockImplementation(() => {
    expect(fake.nativeHandlers.has("update-downloaded"), "observe staging before starting it").toBe(true);
    expect(fake.nativeHandlers.has("error")).toBe(true);
  });

  fake.state.train = startTrain === "stable" ? "beta" : "stable";
  const target = fake.state.train === "beta" ? betaVersion : stableVersion;
  fake.state.changed();
  await settle();
  expect(fake.autoUpdater.autoInstallOnAppQuit, "the unselected installer stays disarmed").toBe(false);
  fake.succeed();
  await settle();
  expect(fake.native.checkForUpdates, "the replacement must be staged explicitly").toHaveBeenCalledTimes(1);
  expect(fake.autoUpdater.autoInstallOnAppQuit).toBe(false);
  expect(updater.readAppUpdateStatus()).not.toEqual({ status: "downloaded", version: target });
  fake.native.emit("update-downloaded");
  expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: target });
  expect(fake.autoUpdater.autoInstallOnAppQuit).toBe(true);
  expect(fake.nativeHandlers.size).toBe(0);
}

describe("macOS cross-track staging", () => {
  function useMacUpdater(): void {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  }

  it("stages Beta explicitly while the held Stable installer is disarmed", async () => {
    useMacUpdater();
    await runMacStagingSession(1, 1, "stable");
  });

  it("every cross-track replacement requests staging before offering Restart", async () => {
    useMacUpdater();
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 1, max: 100 }),
      fc.constantFrom<Train>("stable", "beta"),
      runMacStagingSession,
    ), { numRuns: 25 });
  });
});
