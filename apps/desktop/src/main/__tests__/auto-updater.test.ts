import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateEventHandler = (info?: { version?: string }) => void;

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const updateEventHandlers = new Map<string, UpdateEventHandler>();
const windowSendMock = vi.fn();
const checkForUpdatesMock = vi.fn();
const setFeedURLMock = vi.fn();
const resolveUpdateChannelMock = vi.fn();
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();
const fetchMock = vi.fn();

const autoUpdaterMock = {
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
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler);
      },
    ),
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
  })),
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    info: logInfoMock,
    warn: logWarnMock,
  })),
}));

const markUpdateInstallInProgressMock = vi.fn();
vi.mock("../update-install-state", () => ({
  markUpdateInstallInProgress: () => markUpdateInstallInProgressMock(),
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

function mockGitHubReleases(releases = [githubRelease("v1.0.0-beta.8")]): void {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => releases,
  });
}

describe("auto updater", () => {
  const originalNodeEnv = process.env.NODE_ENV;
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
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = false;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.currentVersion = { version: "1.0.0-beta.7" };
    autoUpdaterMock.logger = undefined;
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockReset();
    markUpdateInstallInProgressMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
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
    expect(checkForUpdatesMock).not.toHaveBeenCalled();

    resolveUpdateChannelMock.mockReturnValue("prerelease");
    checkForUpdatesMock.mockClear();
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded",
      version: "1.0.0-beta.8",
    });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
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
    expect(callOrder).toEqual(["mark", "quitAndInstall"]);
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
