// A newer release published while an older update sits downloaded.
//
// A downloaded update used to end every later check, so an operator who left
// the app open across two releases restarted into the older build only to be
// offered the newer one straight away. These pin that the newer release
// replaces it, and what each platform can still install while that happens
// (see `supersedingDownload` in auto-updater.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  function emitter() {
    const handlers = new Map<string, Set<Handler>>();
    const add = (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    };
    return {
      handlers,
      on: (event: string, handler: Handler) => add(event, handler),
      once: (event: string, handler: Handler) => {
        const wrapped: Handler = (...args) => {
          handlers.get(event)?.delete(wrapped);
          handler(...args);
        };
        (wrapped as { original?: Handler }).original = handler;
        add(event, wrapped);
      },
      removeListener: (event: string, handler: Handler) => {
        for (const h of handlers.get(event) ?? []) {
          if (h === handler || (h as { original?: Handler }).original === handler) {
            handlers.get(event)?.delete(h);
          }
        }
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
      },
      count: (event: string) => handlers.get(event)?.size ?? 0,
    };
  }
  const updaterEvents = emitter();
  const autoUpdater = {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    currentVersion: { version: "1.0.0" },
    logger: undefined as unknown,
    on: (event: string, handler: Handler) => updaterEvents.on(event, handler),
    once: vi.fn(),
    removeListener: vi.fn(),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
  };
  return {
    updaterEvents,
    native: emitter(),
    send: vi.fn(),
    autoUpdater,
    deferAutomaticChecks: false,
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => mocks.autoUpdater.currentVersion.version,
    isPackaged: false,
    quit: vi.fn(),
    relaunch: vi.fn(),
  },
  autoUpdater: mocks.native,
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: mocks.autoUpdater,
    DebUpdater: class {},
    RpmUpdater: class {},
    PacmanUpdater: class {},
    AppImageUpdater: class {},
  },
}));
vi.mock("../linux-package-updater", () => ({
  createLinuxPackageUpdater: (updater: unknown) => updater,
  authorizeLinuxPackageUpdate: () => true,
}));
vi.mock("../github-release-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-release-cache")>();
  return {
    ...actual,
    reserveAppReleaseCheck: (manual: boolean) => {
      if (mocks.deferAutomaticChecks && !manual) {
        throw new actual.ReleaseCheckDeferredError(Date.now() + 60_000);
      }
    },
    fetchGitHubReleaseMetadata: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  };
});
vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: () => ({
    read: () => ({ channel: "latest", train: "stable", selectionSource: "user" }),
    subscribe: () => () => undefined,
  }),
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../update-install-state", () => ({
  markUpdateInstallInProgress: vi.fn(),
  markUpdateInstallUpdaterQuitReady: vi.fn(),
  prepareForUpdateInstall: async () => undefined,
}));

const fetchMock = vi.fn();
const originalPlatform = process.platform;
const originalNodeEnv = process.env.NODE_ENV;
const originalE2e = process.env.PWRAGENT_E2E;
const originalFetch = globalThis.fetch;

function feed(version: string): void {
  fetchMock.mockResolvedValue({
    headers: new Headers(),
    ok: true,
    status: 200,
    json: async () => [{
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: [
        { name: "latest-mac.yml", state: "uploaded" },
        { name: `PwrAgent-${version}-universal-mac.zip`, state: "uploaded" },
      ],
    }],
  });
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The updater attaches its own handlers; this one only keeps a rejection
  // the test causes from being reported before they run.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** electron-updater accepting `version` and starting its download. */
function offerDownload(version: string) {
  const download = deferred();
  const token = { cancel: vi.fn() };
  mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
    mocks.updaterEvents.emit("checking-for-update");
    mocks.updaterEvents.emit("update-available", { version });
    return {
      updateInfo: { version },
      cancellationToken: token,
      downloadPromise: download.promise,
    };
  });
  return { download, token };
}

/** Boot with v1.0.1 already downloaded over a running v1.0.0. */
async function bootWithDownloaded() {
  feed("1.0.1");
  const first = offerDownload("1.0.1");
  const updater = await import("../auto-updater");
  updater.initAutoUpdater();
  await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1));
  mocks.updaterEvents.emit("update-downloaded", { version: "1.0.1" });
  first.download.resolve([]);
  await vi.waitFor(() => expect(updater.readAppUpdateStatus()).toEqual({
    status: "downloaded",
    version: "1.0.1",
  }));
  return updater;
}

/** Download v1.0.2 over the held v1.0.1 through a check from Settings. */
async function supersede(updater: Awaited<ReturnType<typeof bootWithDownloaded>>) {
  feed("1.0.2");
  const second = offerDownload("1.0.2");
  await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
    status: "available",
    version: "1.0.2",
  });
  return second;
}

function checkResults(): unknown[] {
  return mocks.send.mock.calls
    .filter(([channel]) => channel === "app:update-check-result-event")
    .map(([, payload]) => payload);
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  setPlatform("darwin");
  process.env.NODE_ENV = "production";
  delete process.env.PWRAGENT_E2E;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  fetchMock.mockReset();
  mocks.updaterEvents.handlers.clear();
  mocks.native.handlers.clear();
  mocks.send.mockReset();
  mocks.deferAutomaticChecks = false;
  mocks.autoUpdater.checkForUpdates.mockReset();
  mocks.autoUpdater.quitAndInstall.mockReset();
  mocks.autoUpdater.autoInstallOnAppQuit = false;
  mocks.autoUpdater.currentVersion = { version: "1.0.0" };
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
  process.env.NODE_ENV = originalNodeEnv;
  if (originalE2e === undefined) delete process.env.PWRAGENT_E2E;
  else process.env.PWRAGENT_E2E = originalE2e;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("a newer release replaces a downloaded update", () => {
  it("keeps the downloaded update when the feed has nothing newer", async () => {
    const updater = await bootWithDownloaded();
    fetchMock.mockClear();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded",
      version: "1.0.1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
  });

  it("a deferred automatic check says skipped, and the next click still reads the feed", async () => {
    const updater = await bootWithDownloaded();
    fetchMock.mockClear();

    // Not the held result: that would claim a look at the feed that did not
    // happen, and a caller retrying on `skipped` would never make its own.
    mocks.deferAutomaticChecks = true;
    await expect(updater.checkForAppUpdatesNow("periodic")).resolves.toMatchObject({
      status: "skipped",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });

    await supersede(updater);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("answers a failed look with the downloaded update", async () => {
    const updater = await bootWithDownloaded();

    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded",
      version: "1.0.1",
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
  });

  it("keeps a downloaded update whose version does not parse rather than downloading again", async () => {
    feed("1.0.1");
    const first = offerDownload("1.0.1");
    const updater = await import("../auto-updater");
    updater.initAutoUpdater();
    await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1));
    mocks.updaterEvents.emit("update-downloaded", { version: "nightly" });
    first.download.resolve([]);

    // `compareSemver` ranks "nightly" below every release, so without a
    // guard each of these would start the same download over again.
    feed("1.0.2");
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded",
      version: "nightly",
    });
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS);
    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("macOS offers the newer build only once Squirrel.Mac has staged it", async () => {
    const updater = await bootWithDownloaded();
    const second = await supersede(updater);

    mocks.updaterEvents.emit("download-progress", { percent: 40, transferred: 40, total: 100 });
    // A Settings mount reads (and reconciles) the status mid-download. It
    // must not put the older offer back over the newer download's progress.
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    // Squirrel still has v1.0.1 staged, so install-on-quit stays armed: it is
    // also what makes MacUpdater ask Squirrel to stage v1.0.2.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);

    // electron-updater has the zip; Squirrel has not staged it yet, so a
    // Restart here would still install v1.0.1.
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.2",
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    mocks.native.emit("update-downloaded");
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
    expect(mocks.native.count("error")).toBe(0);

    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({ status: "restarting" });
    await vi.waitFor(() => expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it("macOS puts the older Restart offer back when the newer download is canceled", async () => {
    const updater = await bootWithDownloaded();
    const second = await supersede(updater);

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    expect(second.token.cancel).toHaveBeenCalledTimes(1);
    mocks.updaterEvents.emit("update-cancelled", { version: "1.0.2" });
    second.download.reject(new Error("cancelled"));

    await vi.waitFor(() => expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.0.1",
    }));
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("macOS puts the older Restart offer back when the newer download fails", async () => {
    const updater = await bootWithDownloaded();
    const second = await supersede(updater);

    mocks.updaterEvents.emit("error", new Error("network failed"));
    second.download.reject(new Error("network failed"));

    await vi.waitFor(() => expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.0.1",
    }));
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("macOS falls back to the older staged build when Squirrel.Mac fails to stage the newer one", async () => {
    const updater = await bootWithDownloaded();
    const second = await supersede(updater);
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    await vi.advanceTimersByTimeAsync(0);

    // MacUpdater re-emits Squirrel's error as its own before ours hears it.
    const err = new Error("signature check failed");
    mocks.updaterEvents.emit("error", err);
    mocks.native.emit("error", err);

    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
    expect(mocks.native.count("error")).toBe(0);
  });

  it("macOS stops waiting for Squirrel.Mac after the stage timeout", async () => {
    const updater = await bootWithDownloaded();
    const second = await supersede(updater);
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1);
    expect(updater.readAppUpdateStatus().status).not.toBe("downloaded");
    await vi.advanceTimersByTimeAsync(1);

    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
    // A late stage after the fallback must not move the offer.
    mocks.native.emit("update-downloaded");
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
  });

  it("the menu check reports the newer build, not the one it replaces", async () => {
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");

    await expect(updater.checkForAppUpdatesNow("menu")).resolves.toEqual({
      status: "available",
      version: "1.0.2",
    });
    expect(checkResults()).toEqual([
      { status: "checking" },
      { status: "available", version: "1.0.2" },
    ]);

    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    mocks.native.emit("update-downloaded");
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
  });

  it("Settings discovery downloads only a release newer than the downloaded one", async () => {
    const updater = await bootWithDownloaded();

    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS);
    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    feed("1.0.2");
    offerDownload("1.0.2");
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS);
    await updater.readAppUpdateReleaseVersions();
    await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2));
    expect(checkResults()).toEqual([]);
  });

  it("Windows withdraws the older offer once its installer is replaced, and holds install-on-quit", async () => {
    setPlatform("win32");
    const updater = await bootWithDownloaded();
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    const second = await supersede(updater);

    // electron-updater has emptied the pending cache dir, older installer
    // included, while its own `downloadedUpdateHelper.file` still names it.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    await expect(updater.installDownloadedAppUpdate()).resolves.toMatchObject({ status: "error" });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("Windows does not resurrect the deleted older installer when the newer download fails", async () => {
    setPlatform("win32");
    const updater = await bootWithDownloaded();
    const second = await supersede(updater);

    mocks.updaterEvents.emit("error", new Error("network failed"));
    second.download.reject(new Error("network failed"));

    await vi.waitFor(() => expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true));
    expect(updater.readAppUpdateStatus()).toEqual({ status: "error", message: "network failed" });
    await expect(updater.installDownloadedAppUpdate()).resolves.toMatchObject({ status: "error" });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("a downloaded switch back is not quietly replaced", async () => {
    mocks.autoUpdater.currentVersion = { version: "1.1.0" };
    feed("1.0.1");
    const first = offerDownload("1.0.1");
    const updater = await import("../auto-updater");
    updater.initAutoUpdater();
    // The startup check holds a switch back for a check the operator asks for.
    await vi.waitFor(() => expect(updater.readAppUpdateStatus().status).toBe("no-update"));
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.1",
      direction: "downgrade",
    });
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.1" });
    first.download.resolve([]);

    feed("1.0.2");
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded",
      version: "1.0.1",
      direction: "downgrade",
    });
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS);
    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
