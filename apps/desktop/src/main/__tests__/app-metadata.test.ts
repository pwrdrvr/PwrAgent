import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveStartupCodexHome = vi.hoisted(() => vi.fn());
const readAppBuildIdentity = vi.hoisted(() => vi.fn());
const appBuildMode = vi.hoisted(() => ({ isPackaged: true }));
const resolveDefaultCodexHome = vi.hoisted(() =>
  vi.fn(() => "/Users/operator/.codex"),
);

vi.mock("@pwrdrvr/codex-discovery", () => ({ resolveDefaultCodexHome }));

vi.mock("electron", () => ({
  app: {
    getAppPath: vi.fn(() => "/repo/apps/desktop"),
    getName: vi.fn(() => "PwrAgent"),
    getVersion: vi.fn(() => "1.2.3"),
    get isPackaged() { return appBuildMode.isPackaged; },
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({ resolveStartupCodexHome }),
}));

vi.mock("../profile", () => ({
  resolveActiveProfileName: vi.fn(() => "work"),
}));

vi.mock("../log", () => ({
  getMainLogFilePath: vi.fn(
    () => "/Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
  ),
  isMainLogDebugCollectionEnabled: vi.fn(() => false),
  setMainLogDebugCollectionEnabled: vi.fn(),
}));

vi.mock("../app-logs", () => ({
  readAppLogSnapshot: vi.fn(),
  subscribeAppLogEntries: vi.fn(() => () => undefined),
}));

vi.mock("../app-log-window", () => ({ showAppLogWindow: vi.fn() }));
vi.mock("../app-version", () => ({
  resolveApplicationVersion: vi.fn((version: string) => version),
}));
vi.mock("../app-build-identity", () => ({ readAppBuildIdentity }));
vi.mock("../changelog-window", () => ({ showChangelogWindow: vi.fn() }));
vi.mock("../license-document-window", () => ({
  showThirdPartyNoticesWindow: vi.fn(),
}));
vi.mock("../window-channels", () => ({ subscribersForChannel: vi.fn(() => []) }));

describe("app metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    appBuildMode.isPackaged = true;
    readAppBuildIdentity.mockReset().mockResolvedValue({ kind: "packaged" });
    resolveStartupCodexHome.mockReturnValue(
      "/Users/operator/.codex/profiles/work",
    );
  });

  it("captures development identity at startup and retains it across later metadata reads", async () => {
    appBuildMode.isPackaged = false;
    const startupIdentity = {
      kind: "development", appPath: "/repo/apps/desktop", checkoutPath: "/repo",
      branch: "startup-branch", commitSha: "1234567890abcdef1234567890abcdef12345678",
    };
    readAppBuildIdentity.mockResolvedValueOnce(startupIdentity)
      .mockResolvedValueOnce({ ...startupIdentity, branch: "later-branch" });
    const { registerAppMetadataIpcHandlers, resolveAppMetadata } = await import("../ipc/app-metadata");
    const { resolveAppBuildMetadata } = await import("../app-build-metadata");
    registerAppMetadataIpcHandlers();
    expect(readAppBuildIdentity).toHaveBeenCalledOnce();
    expect(readAppBuildIdentity).toHaveBeenCalledWith(false, "/repo/apps/desktop");
    expect((await resolveAppMetadata(4101)).buildIdentity).toEqual(startupIdentity);
    expect((await resolveAppMetadata(4102)).buildIdentity).toEqual(startupIdentity);
    expect(await resolveAppBuildMetadata()).toEqual({
      applicationVersion: "1.2.3",
      buildIdentity: startupIdentity,
    });
    expect(readAppBuildIdentity).toHaveBeenCalledOnce();
  });

  it("reports the Codex home pinned for the running process", async () => {
    const { resolveAppMetadata } = await import("../ipc/app-metadata");

    const metadata = await resolveAppMetadata(4101);

    expect(resolveDefaultCodexHome).not.toHaveBeenCalled();
    expect(resolveStartupCodexHome).toHaveBeenCalledOnce();
    expect(metadata).toMatchObject({
      activeProfileName: "work",
      codexProfilePath: "/Users/operator/.codex/profiles/work",
      logFilePath:
        "/Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
      rendererProcessId: 4101,
    });
  });

  it("reports the system-default Codex home when no named profile is pinned", async () => {
    resolveStartupCodexHome.mockReturnValue(undefined);
    const { resolveAppMetadata } = await import("../ipc/app-metadata");

    const metadata = await resolveAppMetadata(4101);

    expect(resolveDefaultCodexHome).toHaveBeenCalledOnce();
    expect(metadata.codexProfilePath).toBe("/Users/operator/.codex");
  });
});
