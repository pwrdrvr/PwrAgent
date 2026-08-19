import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateEventHandler = (info?: { version?: string }) => void;

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const updateEventHandlers = new Map<string, UpdateEventHandler>();
const windowSendMock = vi.fn();
const checkForUpdatesMock = vi.fn();
const setFeedURLMock = vi.fn();
const resolveUpdateChannelMock = vi.fn();
const resolveUpdateTrainMock = vi.fn();
const configWrittenListeners = new Set<() => void>();
const onConfigWrittenMock = vi.fn((listener: () => void) => {
  configWrittenListeners.add(listener);
  return () => {
    configWrittenListeners.delete(listener);
  };
});
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();
const fetchMock = vi.fn();

const autoUpdaterMock = {
  allowDowngrade: false,
  allowPrerelease: false,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  checkForUpdates: checkForUpdatesMock,
  currentVersion: { version: "1.0.0-beta.7" },
  logger: undefined as Console | undefined,
  on: vi.fn((event: string, handler: UpdateEventHandler) => {
    updateEventHandlers.set(event, handler);
  }),
  quitAndInstall: vi.fn(),
  setFeedURL: setFeedURLMock,
};

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: {
          send: windowSendMock,
        },
      },
    ]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
  },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: autoUpdaterMock,
  },
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: vi.fn(() => ({
    resolveUpdateChannel: resolveUpdateChannelMock,
    resolveUpdateTrain: resolveUpdateTrainMock,
    onConfigWritten: onConfigWrittenMock,
  })),
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    info: logInfoMock,
    warn: logWarnMock,
  })),
}));

const markUpdateInstallInProgressMock = vi.fn();
const markUpdateInstallUpdaterQuitReadyMock = vi.fn();
const prepareForUpdateInstallMock = vi.fn<() => Promise<void>>(
  async () => undefined,
);
vi.mock("../update-install-state", () => ({
  markUpdateInstallInProgress: () => markUpdateInstallInProgressMock(),
  markUpdateInstallUpdaterQuitReady: () =>
    markUpdateInstallUpdaterQuitReadyMock(),
  prepareForUpdateInstall: () => prepareForUpdateInstallMock(),
}));

async function importAutoUpdater() {
  return await import("../auto-updater");
}

function macUpdateAssets(version: string) {
  return [
    { name: "latest-mac.yml", state: "uploaded" },
    { name: `PwrAgent-${version}-universal-mac.zip`, state: "uploaded" },
  ];
}

function githubRelease(
  tagName: string,
  options: {
    assets?: Array<{ name?: string; state?: string }>;
    draft?: boolean;
    prerelease?: boolean;
  } = {},
) {
  const version = tagName.replace(/^v/i, "");
  return {
    tag_name: tagName,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: options.assets ?? macUpdateAssets(version),
  };
}

function githubResponse(
  body: unknown,
  options: { headers?: Record<string, string>; status?: number } = {},
) {
  const status = options.status ?? 200;
  const headers = new Headers(options.headers ?? {});
  return {
    headers,
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  };
}

function mockGitHubReleases(releases = [githubRelease("v1.0.0-beta.8")]): void {
  fetchMock.mockResolvedValue(
    githubResponse(releases, { headers: { etag: 'W/"releases"' } }),
  );
}

function rateLimitedResponse(resetAtMs: number) {
  return githubResponse(
    { message: "API rate limit exceeded" },
    {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(resetAtMs / 1_000)),
      },
      status: 403,
    },
  );
}

function requestHeader(callIndex: number, name: string): string | undefined {
  const init = fetchMock.mock.calls[callIndex]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.[name];
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("auto updater", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalE2e = process.env.PWRAGENT_E2E;
  const originalPlatform = process.platform;
  const originalFetch = globalThis.fetch;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    setPlatform("darwin");
    process.env.NODE_ENV = "production";
    ipcHandlers.clear();
    updateEventHandlers.clear();
    windowSendMock.mockReset();
    checkForUpdatesMock.mockReset();
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.0.0-beta.8" },
    });
    setFeedURLMock.mockReset();
    fetchMock.mockReset();
    mockGitHubReleases();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });
    resolveUpdateChannelMock.mockReset();
    resolveUpdateChannelMock.mockReturnValue("latest");
    resolveUpdateTrainMock.mockReset();
    resolveUpdateTrainMock.mockReturnValue("stable");
    configWrittenListeners.clear();
    onConfigWrittenMock.mockClear();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = false;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.7" };
    autoUpdaterMock.logger = undefined;
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockReset();
    markUpdateInstallInProgressMock.mockReset();
    markUpdateInstallUpdaterQuitReadyMock.mockReset();
    prepareForUpdateInstallMock.mockReset();
    prepareForUpdateInstallMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalE2e === undefined) {
      delete process.env.PWRAGENT_E2E;
    } else {
      process.env.PWRAGENT_E2E = originalE2e;
    }
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("checks on startup and then hourly", async () => {
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();

    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_CHECK_INTERVAL_MS);

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a downloaded update visible during follow-up no-update checks", async () => {
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    windowSendMock.mockClear();

    updateEventHandlers.get("checking-for-update")?.();
    updateEventHandlers.get("update-not-available")?.({
      version: "1.0.0-beta.7",
    });

    expect(windowSendMock).not.toHaveBeenCalled();
  });

  it("does not check again when an update is already downloaded for the selected channel", async () => {
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    checkForUpdatesMock.mockClear();

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "downloaded",
      version: "1.0.0-beta.8",
    });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("checks again when the selected channel changes after an update is downloaded", async () => {
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    checkForUpdatesMock.mockClear();

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "available",
      version: "1.0.0-beta.8",
    });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("binds a downloaded update to the channel that found it", async () => {
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    mockGitHubReleases([
      githubRelease("v1.0.0-beta.8", { prerelease: true }),
      githubRelease("v1.0.0-beta.7"),
    ]);
    checkForUpdatesMock
      .mockResolvedValueOnce({ updateInfo: { version: "1.0.0-beta.8" } })
      .mockResolvedValue({ updateInfo: { version: "1.0.0-beta.7" } });
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });

    resolveUpdateChannelMock.mockReturnValue("latest");
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.0-beta.7",
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });

    checkForUpdatesMock.mockClear();
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.0-beta.7",
    });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "no-update",
      version: "1.0.0-beta.7",
    });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();

    resolveUpdateChannelMock.mockReturnValue("prerelease");
    checkForUpdatesMock.mockClear();
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded",
      version: "1.0.0-beta.8",
    });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("does not offer a downloaded update after switching trains", async () => {
    resolveUpdateTrainMock.mockReturnValue("beta");
    resolveUpdateChannelMock.mockReturnValue("latest");
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.0.0"),
    ]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.1.0-beta.2" },
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0" };
    const updater = await importAutoUpdater();
    const requestQuit = vi.fn(async (performQuit: () => void) => {
      performQuit();
      return true;
    });

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    await vi.waitFor(() => {
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
    });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.1.0-beta.2" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0-beta.2",
    });
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);

    resolveUpdateTrainMock.mockReturnValue("stable");
    for (const listener of configWrittenListeners) {
      listener();
    }

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "no-update",
      version: "1.0.0",
    });
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    const install = ipcHandlers.get("app:install-update");
    await expect(install?.()).resolves.toEqual({
      status: "error",
      message: "The downloaded update is not for the selected channel.",
    });
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    resolveUpdateTrainMock.mockReturnValue("beta");
    for (const listener of configWrittenListeners) {
      listener();
    }

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0-beta.2",
    });
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true);
  });

  it("offers a switch back when the selected release is older than the running build", async () => {
    // The stranding case: a prerelease auto-update landed a 1.1 alpha on a
    // machine whose selection resolves to the 1.0 stable train.
    resolveUpdateTrainMock.mockReturnValue("stable");
    resolveUpdateChannelMock.mockReturnValue("latest");
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.2"),
    ]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.0.2" },
    });
    autoUpdaterMock.currentVersion = { version: "1.1.0-alpha.2" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.2",
      direction: "downgrade",
    });
    expect(autoUpdaterMock.allowDowngrade).toBe(true);
    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrAgent/releases/download/v1.0.2/",
    });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("leaves allowDowngrade off when the selected release is newer", async () => {
    mockGitHubReleases([githubRelease("v1.0.0-beta.8")]);
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.7" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0-beta.8",
    });
    expect(autoUpdaterMock.allowDowngrade).toBe(false);
  });

  it("resets allowDowngrade once a later check resolves to a newer release", async () => {
    // The flag is global state on the shared autoUpdater singleton, so the
    // case that matters is clearing it after a switch-back check set it.
    resolveUpdateChannelMock.mockReturnValue("latest");
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.2"),
    ]);
    checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: "1.0.2" } });
    autoUpdaterMock.currentVersion = { version: "1.1.0-alpha.2" };
    const updater = await importAutoUpdater();

    await updater.checkForAppUpdatesNow("manual");
    expect(autoUpdaterMock.allowDowngrade).toBe(true);

    // The operator switches to Beta, where the alpha is a real update.
    resolveUpdateTrainMock.mockReturnValue("beta");
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    autoUpdaterMock.currentVersion = { version: "1.0.2" };
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.1.0-alpha.2" },
    });

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.1.0-alpha.2",
    });
    expect(autoUpdaterMock.allowDowngrade).toBe(false);
  });

  it("does not treat an unreadable release tag as a switch back", async () => {
    // compareSemver sorts a tag it cannot parse below every real version, so
    // an unreadable tag must not reach the downgrade path and pin the feed.
    mockGitHubReleases([githubRelease("nightly")]);
    autoUpdaterMock.currentVersion = { version: "1.0.2" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.2",
    });
    expect(autoUpdaterMock.allowDowngrade).toBe(false);
    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("reports no update when the selected release matches the running build", async () => {
    mockGitHubReleases([githubRelease("v1.0.0-beta.7")]);
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.7" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.0-beta.7",
    });
    expect(autoUpdaterMock.allowDowngrade).toBe(false);
    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("does not offer a switch back on background checks", async () => {
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.2"),
    ]);
    autoUpdaterMock.currentVersion = { version: "1.1.0-alpha.2" };
    const updater = await importAutoUpdater();

    for (const trigger of ["startup", "periodic"] as const) {
      await expect(updater.checkForAppUpdatesNow(trigger)).resolves.toEqual({
        status: "no-update",
        version: "1.1.0-alpha.2",
      });
    }
    expect(autoUpdaterMock.allowDowngrade).toBe(false);
    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("never auto-installs a downloaded switch back on quit", async () => {
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.2"),
    ]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.0.2" },
    });
    autoUpdaterMock.currentVersion = { version: "1.1.0-alpha.2" };
    const updater = await importAutoUpdater();
    const requestQuit = vi.fn(async (performQuit: () => void) => {
      performQuit();
      return true;
    });

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    // Let the startup check settle first; it declines the switch back, so the
    // manual check below cannot join it as an in-flight result.
    await vi.waitFor(() =>
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "no-update",
        version: "1.1.0-alpha.2",
      }),
    );
    await updater.checkForAppUpdatesNow("manual");
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.2" });

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.0.2",
      direction: "downgrade",
    });
    // The switch back only happens when the operator asks for it.
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    await expect(ipcHandlers.get("app:install-update")?.()).resolves.toEqual({
      status: "restarting",
    });
    await vi.waitFor(() =>
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce(),
    );
  });

  it("skips electron-updater on Linux package builds", async () => {
    setPlatform("linux");
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    const manualResult = await updater.checkForAppUpdatesNow();

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(manualResult).toEqual({
      status: "skipped",
      reason: "Linux builds are updated by installing a newer package.",
    });
    expect(windowSendMock).toHaveBeenLastCalledWith(
      "app:update-status-event",
      manualResult,
    );
  });

  it("uses the selected update channel for manual checks", async () => {
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    const updater = await importAutoUpdater();

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "available",
      version: "1.0.0-beta.8",
    });
    expect(resolveUpdateChannelMock).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.allowPrerelease).toBe(true);
  });

  it("pins electron-updater to the selected GitHub Release download feed", async () => {
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    mockGitHubReleases([githubRelease("v1.0.0-beta.36")]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.0.0-beta.36" },
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.35" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0-beta.36",
    });

    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrAgent/releases/download/v1.0.0-beta.36/",
    });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("pins the beta train to the smoke-checked main-train tag", async () => {
    resolveUpdateTrainMock.mockReturnValue("beta");
    resolveUpdateChannelMock.mockReturnValue("latest");
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.1.0-alpha.7", { prerelease: true }),
      githubRelease("v1.0.0"),
    ]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.1.0-beta.2" },
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.1.0-beta.2",
    });
    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrAgent/releases/download/v1.1.0-beta.2/",
    });
    expect(autoUpdaterMock.allowPrerelease).toBe(true);
  });

  it("does not ask electron-updater to check a tag-only newer release", async () => {
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    mockGitHubReleases([githubRelease("v1.0.0-beta.36")]);
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.36" };
    const updater = await importAutoUpdater();

    const manualResult = await updater.checkForAppUpdatesNow("manual");

    expect(manualResult).toEqual({
      status: "no-update",
      version: "1.0.0-beta.36",
    });
    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it("ignores assetless GitHub Releases when selecting an update feed", async () => {
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    mockGitHubReleases([
      githubRelease("v1.0.0-beta.37", { assets: [] }),
      githubRelease("v1.0.0-beta.36"),
    ]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.0.0-beta.36" },
    });
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.35" };
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0-beta.36",
    });

    expect(setFeedURLMock).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrAgent/releases/download/v1.0.0-beta.36/",
    });
  });

  it("routes downloaded update installs through requestQuit", async () => {
    const updater = await importAutoUpdater();
    const requestQuit = vi.fn(async (performQuit: () => void) => {
      performQuit();
      return true;
    });

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    const install = ipcHandlers.get("app:install-update");

    await expect(install?.()).resolves.toEqual({ status: "restarting" });
    expect(requestQuit).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("latches update-install-in-progress before handing off to quitAndInstall", async () => {
    const updater = await importAutoUpdater();
    const callOrder: string[] = [];
    markUpdateInstallInProgressMock.mockImplementation(() => {
      callOrder.push("mark");
    });
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      callOrder.push("quitAndInstall");
    });
    markUpdateInstallUpdaterQuitReadyMock.mockImplementation(() => {
      callOrder.push("ready");
    });
    const requestQuit = vi.fn(async (performQuit: () => void) => {
      performQuit();
      return true;
    });

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    const install = ipcHandlers.get("app:install-update");

    await expect(install?.()).resolves.toEqual({ status: "restarting" });
    // The latch must be set before quitAndInstall so window-all-closed sees it.
    await vi.waitFor(() =>
      expect(callOrder).toEqual(["mark", "ready", "quitAndInstall"]),
    );
  });

  it("awaits shutdown preparation before handing quit ownership to the updater", async () => {
    const preparation = createDeferred<void>();
    prepareForUpdateInstallMock.mockReturnValueOnce(preparation.promise);
    const updater = await importAutoUpdater();
    const requestQuit = vi.fn(async (performQuit: () => void) => {
      performQuit();
      return true;
    });

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    const install = ipcHandlers.get("app:install-update");

    await expect(install?.()).resolves.toEqual({ status: "restarting" });
    expect(markUpdateInstallInProgressMock).toHaveBeenCalledOnce();
    expect(markUpdateInstallUpdaterQuitReadyMock).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    preparation.resolve();
    await vi.waitFor(() =>
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce(),
    );
    expect(markUpdateInstallInProgressMock).toHaveBeenCalledOnce();
    expect(markUpdateInstallUpdaterQuitReadyMock).toHaveBeenCalledOnce();
  });

  it("does not latch update-install-in-progress when quit is cancelled", async () => {
    const updater = await importAutoUpdater();
    const requestQuit = vi.fn(async () => false);

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    const install = ipcHandlers.get("app:install-update");

    await install?.();
    expect(markUpdateInstallInProgressMock).not.toHaveBeenCalled();
  });

  it("serves renderer release reads from the main-process cache", async () => {
    const updater = await importAutoUpdater();

    const first = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.stable.latest.version).toBe("v1.0.0-beta.8");
  });

  it("shares one request between concurrent release readers", async () => {
    const updater = await importAutoUpdater();

    const [versions, release] = await Promise.all([
      updater.readAppUpdateReleaseVersions(),
      updater.checkForAppUpdatesNow("periodic"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(versions.stable.latest.version).toBe("v1.0.0-beta.8");
    expect(release.status).not.toBe("error");
  });

  it("refetches once the cache entry expires", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1);
    await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("revalidates conditionally and keeps the cached list on 304", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    fetchMock.mockResolvedValueOnce(githubResponse(undefined, { status: 304 }));

    const result = await updater.checkForAppUpdatesNow("manual");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestHeader(1, "If-None-Match")).toBe('W/"releases"');
    expect(result.status).not.toBe("error");
  });

  it("reports the rate-limit reset time instead of a bare 403", async () => {
    const updater = await importAutoUpdater();
    const resetAt = Date.now() + 30 * 60 * 1_000;
    fetchMock.mockResolvedValue(rateLimitedResponse(resetAt));

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(versions.stable.latest.unavailableReason).toMatch(
      /GitHub rate limit reached\. Update checks resume at /,
    );
    expect(versions.stable.latest.unavailableReason).not.toMatch(/403/);
  });

  it("stops requesting while rate limited and serves the last good list", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    const resetAt = Date.now() + 30 * 60 * 1_000;
    fetchMock.mockResolvedValue(rateLimitedResponse(resetAt));
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1);

    // One request discovers the limit; that read already degrades to the
    // cached list, and later reads must not spend another request.
    const discovering = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(discovering.stable.latest.version).toBe("v1.0.0-beta.8");
    expect(discovering.stable.latest.unavailableReason).toBeUndefined();

    const stale = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale.stable.latest.version).toBe("v1.0.0-beta.8");
    expect(stale.stable.latest.unavailableReason).toBeUndefined();
  });

  it("makes no update requests during an E2E run", async () => {
    process.env.PWRAGENT_E2E = "1";
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    const result = await updater.checkForAppUpdatesNow("startup");
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_CHECK_INTERVAL_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
  });

  it("serves the E2E release read without reaching GitHub", async () => {
    process.env.PWRAGENT_E2E = "1";
    const updater = await importAutoUpdater();

    updater.registerAppUpdateIpcHandlers();
    const versions = (await ipcHandlers.get("app:read-update-releases")?.()) as
      | { stable: { latest: { unavailableReason?: string } } }
      | undefined;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(versions?.stable.latest.unavailableReason).toBe(
      "Update checks are disabled.",
    );
  });

  it("still backs off when the rate-limit reset header is already past", async () => {
    const updater = await importAutoUpdater();
    // A local clock running ahead of GitHub reports the reset in the past.
    fetchMock.mockResolvedValue(rateLimitedResponse(Date.now() - 60_000));

    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.stable.latest.unavailableReason).toMatch(
      /GitHub rate limit reached/,
    );
  });

  it("treats a backwards clock jump as a stale cache", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1_000);
    await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resumes requesting after the rate-limit window passes", async () => {
    const updater = await importAutoUpdater();
    const resetAt = Date.now() + 30 * 60 * 1_000;
    fetchMock.mockResolvedValue(rateLimitedResponse(resetAt));

    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);
    mockGitHubReleases();
    const recovered = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovered.stable.latest.version).toBe("v1.0.0-beta.8");
  });

  it("does not install a downloaded update when quit confirmation is cancelled", async () => {
    const updater = await importAutoUpdater();
    const requestQuit = vi.fn(async () => false);

    updater.initAutoUpdater();
    updater.registerAppUpdateIpcHandlers({ requestQuit });
    updateEventHandlers.get("update-downloaded")?.({ version: "1.0.0-beta.8" });
    const install = ipcHandlers.get("app:install-update");

    await expect(install?.()).resolves.toEqual({
      status: "error",
      message: "Update restart cancelled.",
    });
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("compareSemver", () => {
  it("orders by major/minor/patch", async () => {
    const { compareSemver } = await import("../auto-updater");
    expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("v1.2.0", "v1.10.0")).toBeLessThan(0);
    expect(compareSemver("v1.2.3", "v1.2.3")).toBe(0);
  });

  it("treats stable as higher precedence than prerelease at the same core", async () => {
    const { compareSemver } = await import("../auto-updater");
    expect(compareSemver("v1.0.0", "v1.0.0-beta.8")).toBeGreaterThan(0);
    expect(compareSemver("v1.0.0-beta.8", "v1.0.0")).toBeLessThan(0);
  });

  it("orders numeric prerelease identifiers numerically, not lexically", async () => {
    const { compareSemver } = await import("../auto-updater");
    expect(compareSemver("v1.0.0-beta.9", "v1.0.0-beta.10")).toBeLessThan(0);
    expect(compareSemver("v1.0.0-beta.2", "v1.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("sorts unparseable tags below valid versions", async () => {
    const { compareSemver } = await import("../auto-updater");
    expect(compareSemver("not-a-version", "v1.0.0-beta.1")).toBeLessThan(0);
    expect(compareSemver("v0.0.1", "garbage")).toBeGreaterThan(0);
  });
});

describe("selectChannelReleases", () => {
  it("picks the highest-precedence stable for latest and never lets prerelease go backwards", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    // GitHub returns releases newest-first by publish date. Here a newer
    // stable (beta.8) was promoted after older beta-tagged prereleases were
    // published — exactly the production scenario behind this bug.
    const releases = [
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.2", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.1", prerelease: true, draft: false },
    ];
    const { latest, prerelease } = selectChannelReleases(releases);
    expect(latest?.tag_name).toBe("v1.0.0-beta.8");
    // The prerelease slot must mirror the latest stable because no published
    // prerelease has higher precedence than v1.0.0-beta.8.
    expect(prerelease?.tag_name).toBe("v1.0.0-beta.8");
  });

  it("prefers a higher prerelease over latest stable when one exists", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.0.0-beta.9", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.1", prerelease: true, draft: false },
    ];
    const { latest, prerelease } = selectChannelReleases(releases);
    expect(latest?.tag_name).toBe("v1.0.0-beta.8");
    expect(prerelease?.tag_name).toBe("v1.0.0-beta.9");
  });

  it("classifies main-train alpha and beta without stealing stable latest", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0-beta.2", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.1-prerelease.1", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.41", prerelease: true, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.1-prerelease.1");
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0-beta.2");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-beta.2");
    expect(selected.latest?.tag_name).toBe("v1.0.0");
    expect(selected.prerelease?.tag_name).toBe("v1.0.1-prerelease.1");
  });

  it("keeps legacy 1.0 beta prereleases on the stable prerelease track", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.0.0-beta.41", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0-beta.8");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.0-beta.41");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
  });

  it("promotes a same-core alpha to beta latest once the beta tag exists", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0-beta.1", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0-beta.1");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-beta.1");
  });

  it("does not put shipped 1.0.0-beta tags on the Beta train after 1.0.1", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.0.1", prerelease: false, draft: false },
      { tag_name: "v1.0.1-prerelease.5", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.50", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.48", prerelease: true, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.1");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.1");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
  });

  it("does not advertise leftover same-core betas after that train becomes Latest", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-beta.3", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.1", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
  });

  it("keeps a newer main-train alpha on Beta after Stable is promoted", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-beta.3", prerelease: true, draft: false },
      { tag_name: "v1.2.0-alpha.1", prerelease: true, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.2.0-alpha.1");
  });

  it("shows an alpha as beta prerelease before a beta exists", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-alpha.7");
  });

  it("does not let a mistagged main-train alpha take stable latest", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    // The GitHub Pre-release flag is set by hand at tag time. If a `main` tag
    // ships without it, it must still not become the feed every Stable
    // operator is pushed onto.
    const releases = [
      { tag_name: "v1.1.0-alpha.1", prerelease: false, draft: false },
      { tag_name: "v1.0.2", prerelease: false, draft: false },
      { tag_name: "v1.0.2-prerelease.2", prerelease: true, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.2");
    // The same flag is what keeps it out of the Stable prerelease slot, so a
    // mistag must not leak it there either.
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.2");
  });

  it("does not let a mistagged main-train beta take stable latest", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0-beta.3", prerelease: false, draft: false },
      { tag_name: "v1.0.2", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.2");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.2");
  });

  it("still promotes a real suffix-free stable over the current one", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.0.2", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
  });

  it("falls back to a suffixed stable when no suffix-free tag exists", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    // The pre-v1.0.0 world: every stable was a `-beta.N` tag published as
    // GitHub Latest. Those trains must keep resolving.
    const releases = [
      { tag_name: "v1.0.0-beta.50", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.48", prerelease: true, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0-beta.50");
  });

  it("ignores drafts in both channels", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v2.0.0", prerelease: false, draft: true },
      { tag_name: "v1.5.0", prerelease: false, draft: false },
      { tag_name: "v1.6.0-rc.1", prerelease: true, draft: true },
      { tag_name: "v1.5.1-rc.1", prerelease: true, draft: false },
    ];
    const { latest, prerelease } = selectChannelReleases(releases);
    expect(latest?.tag_name).toBe("v1.5.0");
    // v1.5.1-rc.1 > v1.5.0 by core, and stable rule doesn't override that.
    expect(prerelease?.tag_name).toBe("v1.5.1-rc.1");
  });
});

describe("selectAppUpdateReleases", () => {
  it("requires macOS updater metadata and zip assets", async () => {
    const { selectAppUpdateReleases } = await import("../auto-updater");
    const releases = [
      githubRelease("v1.0.0-beta.37", { assets: [] }),
      githubRelease("v1.0.0-beta.36", {
        assets: [{ name: "latest-mac.yml", state: "uploaded" }],
      }),
      githubRelease("v1.0.0-beta.35"),
    ];

    const { latest, prerelease } = selectAppUpdateReleases(releases);

    expect(latest?.tag_name).toBe("v1.0.0-beta.35");
    expect(prerelease?.tag_name).toBe("v1.0.0-beta.35");
  });
});
