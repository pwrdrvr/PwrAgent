import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateEventHandler = (info?: {
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}) => void;

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const updateEventHandlers = new Map<string, UpdateEventHandler>();
const windowSendMock = vi.fn();
const checkForUpdatesMock = vi.fn();
const setFeedURLMock = vi.fn();
const resolveUpdateChannelMock = vi.fn();
const resolveUpdateTrainMock = vi.fn();
const updateDomainListeners = new Set<() => void>();
const subscribeConfigStoreMock = vi.fn(
  (_domains: readonly string[], listener: () => void) => {
    updateDomainListeners.add(listener);
    return () => {
      updateDomainListeners.delete(listener);
    };
  },
);
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

// The version of the binary doing the reading. It is what an unpinned
// selection resolves from, so a test that exercises inference has to be able
// to move it.
const appVersionMock = vi.fn(() => "1.0.0-beta.7");

vi.mock("electron", () => ({
  app: { getVersion: () => appVersionMock(), isPackaged: false },
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

const updateSelectionSourceMock = vi.fn<() => string | undefined>(
  () => "user",
);

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: vi.fn(() => ({
    read: vi.fn(() => ({
      channel: resolveUpdateChannelMock(),
      train: resolveUpdateTrainMock(),
      // These tests state the slot the operator is on, so they default to a
      // pin. Without it the stored pair goes back through the version
      // inference and a test that says "on Beta Prerelease" would silently
      // be testing whatever `app.getVersion()` infers instead.
      selectionSource: updateSelectionSourceMock(),
    })),
    subscribe: subscribeConfigStoreMock,
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
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/** Every `app:update-status-event` payload broadcast so far, in order. */
function broadcastStatuses(): Array<{ status: string; percent?: number }> {
  return windowSendMock.mock.calls
    .filter(([channel]) => channel === "app:update-status-event")
    .map(([, payload]) => payload as { status: string; percent?: number });
}

/** Every `app:update-check-result-event` payload broadcast so far. */
function broadcastCheckResults(): Array<{ status: string }> {
  return windowSendMock.mock.calls
    .filter(([channel]) => channel === "app:update-check-result-event")
    .map(([, payload]) => payload as { status: string });
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
    updateSelectionSourceMock.mockReset();
    updateSelectionSourceMock.mockReturnValue("user");
    appVersionMock.mockReset();
    appVersionMock.mockReturnValue("1.0.0-beta.7");
    updateDomainListeners.clear();
    subscribeConfigStoreMock.mockClear();
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
    for (const listener of updateDomainListeners) {
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
    for (const listener of updateDomainListeners) {
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

  it("follows the running build's feed when the stored selection is a guess", async () => {
    // The feed and the Settings snapshot must resolve through the SAME rule.
    // They used to each carry a copy, and the copy here still read a legacy
    // half pair as a deliberate Stable pin: Settings showed Beta Prerelease
    // on a 1.1.0-alpha install while this path polled Stable Latest forever.
    // The exact config an older build left behind: `channel` alone, because
    // `channel` shipped before `train` did.
    resolveUpdateChannelMock.mockReturnValue("latest");
    resolveUpdateTrainMock.mockReturnValue(undefined);
    updateSelectionSourceMock.mockReturnValue(undefined);
    appVersionMock.mockReturnValue("1.1.0-alpha.7");
    autoUpdaterMock.currentVersion = { version: "1.1.0-alpha.7" };
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.9", { prerelease: true }),
      githubRelease("v1.0.3"),
    ]);
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.1.0-alpha.9" },
    });
    const updater = await importAutoUpdater();

    await updater.checkForAppUpdatesNow("manual");

    // Read as a pin, the half pair would resolve to Stable Latest and this
    // alpha install would be offered v1.0.3 forever. Re-inferred from the
    // running binary it follows the alpha feed it came from.
    expect(logInfoMock).toHaveBeenCalledWith(
      "configured auto-update channel",
      expect.objectContaining({
        updateChannel: "prerelease",
        updateTrain: "beta",
      }),
    );
    expect(autoUpdaterMock.allowPrerelease).toBe(true);
  });

  it("honors a pinned selection over the running build's own feed", async () => {
    // The mirror of the case above: an alpha binary whose operator picked
    // Stable stays on Stable, because the pin is on disk to say so.
    resolveUpdateChannelMock.mockReturnValue("latest");
    resolveUpdateTrainMock.mockReturnValue("stable");
    updateSelectionSourceMock.mockReturnValue("user");
    appVersionMock.mockReturnValue("1.1.0-alpha.7");
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.9", { prerelease: true }),
      githubRelease("v1.0.3"),
    ]);
    const updater = await importAutoUpdater();

    await updater.checkForAppUpdatesNow("manual");

    expect(logInfoMock).toHaveBeenCalledWith(
      "configured auto-update channel",
      expect.objectContaining({
        updateChannel: "latest",
        updateTrain: "stable",
      }),
    );
  });

  it("names the missing manifest instead of dumping the raw HttpError", async () => {
    // electron-updater reports a 404 on the channel file as one multi-KB
    // string — request URL, every response header, a stack of packaged file
    // paths — and Settings rendered it verbatim. It is also not a transport
    // failure: the GitHub release exists and the release matrix shows its
    // version, but this platform has nothing installable in that slot.
    resolveUpdateTrainMock.mockReturnValue("beta");
    resolveUpdateChannelMock.mockReturnValue("prerelease");
    mockGitHubReleases([githubRelease("v1.1.0-alpha.2", { prerelease: true })]);
    autoUpdaterMock.currentVersion = { version: "1.1.0-alpha.1" };
    checkForUpdatesMock.mockRejectedValue(
      new Error(
        'Cannot find channel "latest.yml" update info: HttpError: 404 "method: GET url:'
        + " https://github.com/pwrdrvr/PwrAgent/releases/download/v1.1.0-alpha.2/latest.yml"
        + '\n\nPlease double check that your authentication token is correct."'
        + ' Headers: { "cache-control": "no-cache", "content-encoding": "gzip" }'
        + " at createHttpError (C:\\Users\\x\\httpExecutor.js:53:12)",
      ),
    );
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "error",
      message:
        "The Beta Prerelease release (v1.1.0-alpha.2) publishes no latest.yml"
        + " for this platform, so there is nothing to install from it yet.",
    });
    // The whole error still reaches the log — diagnosing a feed failure from
    // the reported sentence alone would be worse than having no summary.
    expect(logWarnMock).toHaveBeenCalledWith(
      "checkForUpdates failed",
      expect.objectContaining({
        message: expect.stringContaining("Headers: {"),
        updateChannel: "prerelease",
        updateTrain: "beta",
      }),
    );
  });

  it("truncates any other update failure to one line", async () => {
    mockGitHubReleases([githubRelease("v1.0.0-beta.8")]);
    checkForUpdatesMock.mockRejectedValue(
      new Error(
        `HttpError: 500 ${"very long body ".repeat(40)}`
        + '\nHeaders: { "server": "github.com" }',
      ),
    );
    const updater = await importAutoUpdater();

    const result = await updater.checkForAppUpdatesNow("manual");
    expect(result.status).toBe("error");
    const message = result.status === "error" ? result.message : "";
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message.startsWith("HttpError: 500 very long body")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    expect(message).not.toContain("Headers");
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

  describe("reporting a check the operator asked for", () => {
    it("narrates a menu check on its own channel", async () => {
      const updater = await importAutoUpdater();

      const result = await updater.checkForAppUpdatesNow("menu");

      // `checking` arms the live card; the outcome takes it back down. Both
      // ride a channel the hourly poll never touches.
      expect(broadcastCheckResults()).toEqual([
        { status: "checking" },
        result,
      ]);
    });

    it("says nothing on the result channel for any other trigger", async () => {
      // Settings answers its own `manual` check inline, the app-management
      // tool answers the agent that called it, and a background poll has
      // nobody waiting. A card raised for any of them is a card raised at
      // someone who did not ask.
      const updater = await importAutoUpdater();

      for (const trigger of ["manual", "startup", "periodic"] as const) {
        await updater.checkForAppUpdatesNow(trigger);
      }

      expect(broadcastCheckResults()).toEqual([]);
      // Silent on the reporting channel, not skipped: each one still ran.
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(3);
    });

    it("still answers the channel when the check throws past its own catch", async () => {
      // The card is armed by `checking` and only an outcome disarms it, so a
      // throw that escapes `runAppUpdateCheck` must not leave the operator on
      // a sweep that cannot end. It also must not reach the menu's `void`
      // call site as an unhandled rejection.
      setPlatform("linux");
      const updater = await importAutoUpdater();
      const { BrowserWindow } = await import("electron");
      const getAllWindows = vi.mocked(BrowserWindow.getAllWindows);
      const windows = getAllWindows();
      const broken = new Error("broadcast exploded");
      let calls = 0;
      getAllWindows.mockImplementation(() => {
        calls += 1;
        // Call 1 is the `checking` tick, which is fine. Call 2 is the status
        // broadcast inside the check — the one outside its own try.
        if (calls === 2) throw broken;
        return windows;
      });

      await expect(updater.checkForAppUpdatesNow("menu")).resolves.toEqual({
        status: "error",
        message: broken.message,
      });
      // Armed, then disarmed — not left mid-flight.
      expect(broadcastCheckResults()).toEqual([
        { status: "checking" },
        { status: "error", message: broken.message },
      ]);
    });
  });

  describe("canceling a download", () => {
    function availableWithDownload(download: Promise<unknown>, cancel = vi.fn()) {
      checkForUpdatesMock.mockResolvedValue({
        cancellationToken: { cancel },
        downloadPromise: download,
        isUpdateAvailable: true,
        updateInfo: { version: "1.0.0-beta.8" },
      });
      return cancel;
    }

    it("stops a download the operator asked to stop, without calling it a failure", async () => {
      const download = createDeferred<string[]>();
      const cancel = availableWithDownload(download.promise, vi.fn(() => {
        download.reject(new Error("cancelled"));
      }));
      const updater = await importAutoUpdater();
      await updater.checkForAppUpdatesNow("menu");

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });

      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(updater.readAppUpdateStatus()).toEqual({
          status: "canceled",
          version: "1.0.0-beta.8",
        });
      });
    });

    it("aborts a download that had not handed over its token yet", async () => {
      // `update-available` — the status that puts Cancel on screen — is
      // emitted from inside `checkForUpdates`, which does not resolve (and so
      // does not yield its cancellationToken) until the download is already
      // under way. A click in that window must be applied to the token when
      // it arrives, not discarded.
      const download = createDeferred<string[]>();
      const cancel = vi.fn(() => {
        download.reject(new Error("cancelled"));
      });
      let reachedUpdater!: () => void;
      const insideCheck = new Promise<void>((resolve) => {
        reachedUpdater = resolve;
      });
      const released = createDeferred<void>();
      checkForUpdatesMock.mockImplementation(async () => {
        reachedUpdater();
        await released.promise;
        return {
          cancellationToken: { cancel },
          downloadPromise: download.promise,
          isUpdateAvailable: true,
          updateInfo: { version: "1.0.0-beta.8" },
        };
      });
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      await insideCheck;

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      expect(cancel).not.toHaveBeenCalled();

      released.resolve(undefined);
      await pending;

      await vi.waitFor(() => {
        expect(cancel).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(updater.readAppUpdateStatus()).toEqual({
          status: "canceled",
          version: "1.0.0-beta.8",
        });
      });
    });

    it("still reports a download that broke on its own as an error", async () => {
      // The rejection is byte-identical to a cancel's; only our own flag
      // tells them apart, so a genuine failure must not be swallowed as
      // "canceled".
      const download = createDeferred<string[]>();
      availableWithDownload(download.promise);
      const updater = await importAutoUpdater();
      updater.initAutoUpdater();
      await vi.waitFor(() => {
        expect(updateEventHandlers.has("error")).toBe(true);
      });
      await updater.checkForAppUpdatesNow("menu");

      download.reject(new Error("socket hang up"));
      // electron-updater dispatches its own `error` event for this one, and
      // deliberately does not for a cancellation.
      updateEventHandlers.get("error")?.(
        new Error("socket hang up") as never,
      );

      await vi.waitFor(() => {
        expect(updater.readAppUpdateStatus()).toEqual({
          status: "error",
          message: "socket hang up",
        });
      });
      expect(
        broadcastStatuses().some((entry) => entry.status === "canceled"),
      ).toBe(false);
    });

    it("answers a cancel with nothing to stop without inventing one", async () => {
      const updater = await importAutoUpdater();

      // Nothing has run yet.
      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });

      const download = createDeferred<string[]>();
      availableWithDownload(download.promise);
      await updater.checkForAppUpdatesNow("menu");
      download.resolve([]);
      await vi.waitFor(() => {
        expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });
      });
      // A click that lost the race must not rewrite the offer the operator
      // now has.
      expect(
        broadcastStatuses().some((entry) => entry.status === "canceled"),
      ).toBe(false);
    });

    it("ignores a second press while the first is still settling", async () => {
      const download = createDeferred<string[]>();
      const cancel = availableWithDownload(download.promise);
      const updater = await importAutoUpdater();
      await updater.checkForAppUpdatesNow("menu");

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });

      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("settles on canceled when electron-updater reports its own abort", async () => {
      const updater = await importAutoUpdater();
      updater.initAutoUpdater();
      await vi.waitFor(() => {
        expect(updateEventHandlers.has("update-cancelled")).toBe(true);
      });

      updateEventHandlers.get("update-cancelled")?.({
        version: "1.0.0-beta.8",
      });

      // Not `available`, which promises a download is under way, and not
      // `error`, which claims something broke.
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "canceled",
        version: "1.0.0-beta.8",
      });
    });

    it("keeps a held download when a cancel arrives for something else", async () => {
      const updater = await importAutoUpdater();
      updater.initAutoUpdater();
      await vi.waitFor(() => {
        expect(updateEventHandlers.has("update-downloaded")).toBe(true);
      });
      updateEventHandlers.get("update-downloaded")?.({ version: "1.1.0" });
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "downloaded",
        version: "1.1.0",
      });

      updateEventHandlers.get("update-cancelled")?.({
        version: "1.0.0-beta.8",
      });

      // The Restart the operator has already been offered is still good.
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "downloaded",
        version: "1.1.0",
      });
    });

    it("carries the download's byte counts to the card, not just a percent", async () => {
      const updater = await importAutoUpdater();
      updater.initAutoUpdater();
      await vi.waitFor(() => {
        expect(updateEventHandlers.has("download-progress")).toBe(true);
      });

      updateEventHandlers.get("update-available")?.({ version: "1.0.0-beta.8" });
      updateEventHandlers.get("download-progress")?.({
        percent: 42.4,
        transferred: 50_000_000,
        total: 118_000_000,
        bytesPerSecond: 3_300_000,
      });

      expect(updater.readAppUpdateStatus()).toEqual({
        status: "downloading",
        version: "1.0.0-beta.8",
        percent: 42,
        transferred: 50_000_000,
        total: 118_000_000,
        bytesPerSecond: 3_300_000,
      });
    });
  });

  describe("the dev/QA fake update", () => {
    beforeEach(() => {
      delete process.env.NODE_ENV;
      process.env.PWRAGENT_DEV_FAKE_UPDATE = "1";
      process.env.PWRAGENT_DEV_FAKE_UPDATE_STEP_MS = "100";
    });

    afterEach(() => {
      delete process.env.PWRAGENT_DEV_FAKE_UPDATE;
      delete process.env.PWRAGENT_DEV_FAKE_UPDATE_STEP_MS;
    });

    async function runFakeCheck(
      updater: Awaited<ReturnType<typeof importAutoUpdater>>,
      trigger: "manual" | "menu" | "startup" | "periodic",
    ) {
      const pending = updater.checkForAppUpdatesNow(trigger);
      // Generous: the fake walks one delay per percent tick, and a short
      // advance would resolve nothing and time the test out rather than fail.
      await vi.advanceTimersByTimeAsync(10_000);
      return await pending;
    }

    it("stays off unless the operator opted in", async () => {
      delete process.env.PWRAGENT_DEV_FAKE_UPDATE;
      const updater = await importAutoUpdater();

      // The whole point of the opt-in: Settings -> Updates is a real
      // diagnostic surface in dev, and the app-management agent tool runs
      // `manual` checks it would otherwise report to the user as fact.
      await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
        status: "skipped",
        reason: "auto-update disabled in development",
      });
    });

    it("walks the whole machine without reaching GitHub", async () => {
      const updater = await importAutoUpdater();

      await expect(runFakeCheck(updater, "menu")).resolves.toEqual({
        status: "downloaded",
        version: "420.0.0",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(checkForUpdatesMock).not.toHaveBeenCalled();
      const statuses = broadcastStatuses();
      expect([...new Set(statuses.map((entry) => entry.status))]).toEqual([
        "checking",
        "available",
        "downloading",
        "downloaded",
      ]);
      // And the download half is a RAMP, not a single frozen sample: a meter
      // cannot be judged in dev against one 60% tick.
      const percents = statuses
        .filter((entry) => entry.status === "downloading")
        .map((entry) => entry.percent);
      expect(percents.length).toBeGreaterThan(3);
      expect(percents.at(0)).toBe(0);
      expect(percents.at(-1)).toBe(100);
      expect([...percents].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(percents);
    });

    it("stays silent on startup and periodic checks", async () => {
      const updater = await importAutoUpdater();

      await expect(runFakeCheck(updater, "startup")).resolves.toEqual({
        status: "skipped",
        reason: "auto-update disabled in development",
      });
    });

    it("runs on Linux too, where a packaged build would answer skipped", async () => {
      // The Linux branch sits behind `productionUpdatesEnabled()`, so an
      // unpackaged opt-in reaches the fake on every platform — which is what
      // lets one e2e spec cover this flow on the Linux lane.
      setPlatform("linux");
      const updater = await importAutoUpdater();

      await expect(runFakeCheck(updater, "menu")).resolves.toEqual({
        status: "downloaded",
        version: "420.0.0",
      });
    });

    it("stops the fake download when the operator cancels it", async () => {
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      // Far enough in to be downloading, not far enough to have finished.
      await vi.advanceTimersByTimeAsync(300);
      expect(updater.readAppUpdateStatus().status).toBe("downloading");

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toEqual({ status: "canceled", version: "420.0.0" });
      // Nothing is held, so no Restart is offered for an update that never
      // finished arriving.
      expect(
        broadcastStatuses().some((entry) => entry.status === "downloaded"),
      ).toBe(false);
    });

    it("takes a cancel pressed before the bytes start moving", async () => {
      // The card offers Cancel from `available` onward. Main must already be
      // able to take one there, or the button sits on screen doing nothing
      // and the update installs anyway.
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      await vi.advanceTimersByTimeAsync(150);
      expect(updater.readAppUpdateStatus().status).toBe("available");

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toEqual({ status: "canceled", version: "420.0.0" });
      expect(
        broadcastStatuses().some((entry) => entry.status === "downloaded"),
      ).toBe(false);
    });

    it("takes a cancel pressed on the last step of the download", async () => {
      const updater = await importAutoUpdater();
      const pending = updater.checkForAppUpdatesNow("menu");
      // Two phase steps plus every percent tick but the final delay.
      await vi.advanceTimersByTimeAsync(100 * 8 + 50);
      const percents = broadcastStatuses()
        .filter((entry) => entry.status === "downloading")
        .map((entry) => entry.percent);
      expect(percents.at(-1)).toBe(100);

      expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
      await vi.advanceTimersByTimeAsync(10_000);

      // A cancel read only at the top of the loop would have been dropped
      // here, and the preview would offer a Restart the operator just
      // declined.
      expect(await pending).toEqual({ status: "canceled", version: "420.0.0" });
      expect(updater.readAppUpdateStatus().status).toBe("canceled");
    });

    it("declines to install the fake rather than quitting the app", async () => {
      const updater = await importAutoUpdater();
      await runFakeCheck(updater, "menu");

      const install = await updater.installDownloadedAppUpdate();

      expect(install).toEqual({
        status: "error",
        message:
          "This is the dev preview update. Nothing was downloaded to install.",
      });
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    });
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

  describe("stable promotion", () => {
    for (const installed of ["1.1.0-alpha.7", "1.1.0-beta.5"]) {
      for (const train of ["stable", "beta"]) {
        for (const channel of ["latest", "prerelease"]) {
          it.each(["manual", "menu", "startup", "periodic"] as const)(
            `offers the final to ${installed} on ${train}/${channel} during %s`,
            async (trigger) => {
              appVersionMock.mockReturnValue(installed);
              autoUpdaterMock.currentVersion = { version: installed };
              resolveUpdateTrainMock.mockReturnValue(train);
              resolveUpdateChannelMock.mockReturnValue(channel);
              mockGitHubReleases([
                githubRelease("v1.1.0-beta.5", { prerelease: true }),
                githubRelease("v1.1.0"),
                githubRelease("v1.1.0-alpha.7", { prerelease: true }),
              ]);
              checkForUpdatesMock.mockResolvedValue({ updateInfo: { version: "1.1.0" } });
              const updater = await importAutoUpdater();

              await expect(updater.checkForAppUpdatesNow(trigger)).resolves.toEqual({
                status: "available",
                version: "1.1.0",
              });
              expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
              expect(setFeedURLMock).toHaveBeenCalledWith({
                provider: "generic",
                url: "https://github.com/pwrdrvr/PwrAgent/releases/download/v1.1.0/",
              });
              const versions = await updater.readAppUpdateReleaseVersions();
              expect(versions.beta.latest.version).toBe("v1.1.0");
              expect(versions.beta.prerelease.version).toBe("v1.1.0");
              expect(resolveUpdateTrainMock()).toBe(train);
              expect(resolveUpdateChannelMock()).toBe(channel);
            },
          );
        }
      }
    }
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
    expect(selected.betaLatest).toBe(selected.stableLatest);
    expect(selected.betaPrerelease).toBe(selected.stableLatest);
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
    expect(selected.betaLatest).toBe(selected.stableLatest);
    expect(selected.betaPrerelease).toBe(selected.stableLatest);
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
    expect(selected.betaLatest).toBe(selected.stableLatest);
    expect(selected.betaPrerelease).toBe(selected.stableLatest);
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
    expect(selected.betaLatest).toBe(selected.stableLatest);
    expect(selected.betaPrerelease?.tag_name).toBe("v1.2.0-alpha.1");
  });

  it("shows an alpha as beta prerelease before a beta exists", async () => {
    const { selectChannelReleases } = await import("../auto-updater");
    const releases = [
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
    ];
    const selected = selectChannelReleases(releases);
    expect(selected.betaLatest).toBe(selected.stableLatest);
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
  it("prefers newer eligible alpha and beta releases over the stable fallback", async () => {
    const { selectAppUpdateReleases } = await import("../auto-updater");
    const selected = selectAppUpdateReleases([
      githubRelease("v1.2.0-beta.1", { prerelease: true }),
      githubRelease("v1.3.0-alpha.1", { prerelease: true }),
      githubRelease("v1.1.0"),
    ]);
    expect(selected.betaLatest?.tag_name).toBe("v1.2.0-beta.1");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.3.0-alpha.1");
  });

  it.each([
    [],
    [{ name: "latest-mac.yml", state: "uploaded" }],
    [{ name: "PwrAgent.zip", state: "uploaded" }],
    [{ name: "latest-mac.yml", state: "deleted" }, { name: "PwrAgent.zip" }],
    [{ name: "latest.yml" }, { name: "PwrAgent.exe" }],
  ].map((assets) => ({ assets })))("requires eligible macOS assets for the stable fallback (%j)", async ({ assets }) => {
    const { selectAppUpdateReleases } = await import("../auto-updater");
    const selected = selectAppUpdateReleases([
      githubRelease("v1.1.0", { assets }),
      githubRelease("v1.0.0"),
      githubRelease("v1.2.0-alpha.1", { prerelease: true, assets: [] }),
      githubRelease("v1.2.0-beta.1", { prerelease: true, assets: [] }),
    ]);
    expect(selected.betaLatest?.tag_name).toBe("v1.0.0");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.0.0");
    const unavailable = selectAppUpdateReleases([githubRelease("v1.1.0", { assets })]);
    expect(unavailable.betaLatest).toBeUndefined();
    expect(unavailable.betaPrerelease).toBeUndefined();
  });

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
