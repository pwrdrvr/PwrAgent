import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type UpdateEventHandler = (info?: { version?: string }) => void;

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const updateEventHandlers = new Map<string, UpdateEventHandler>();
const windowSendMock = vi.fn();
const checkForUpdatesMock = vi.fn();
const resolveUpdateChannelMock = vi.fn();
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();

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
  })),
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    info: logInfoMock,
    warn: logWarnMock,
  })),
}));

async function importAutoUpdater() {
  return await import("../auto-updater");
}

describe("auto updater", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.NODE_ENV = "production";
    ipcHandlers.clear();
    updateEventHandlers.clear();
    windowSendMock.mockReset();
    checkForUpdatesMock.mockReset();
    checkForUpdatesMock.mockResolvedValue({
      updateInfo: { version: "1.0.0-beta.8" },
    });
    resolveUpdateChannelMock.mockReset();
    resolveUpdateChannelMock.mockReturnValue("latest");
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = false;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.logger = undefined;
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("checks on startup and then hourly", async () => {
    const updater = await importAutoUpdater();

    updater.initAutoUpdater();
    await Promise.resolve();

    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);

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
});
