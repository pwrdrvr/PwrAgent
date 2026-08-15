import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveStartupCodexHome = vi.hoisted(() => vi.fn());

vi.mock("node:os", () => ({
  arch: () => "arm64",
  hostname: () => "viewer-mac.local",
  platform: () => "darwin",
  release: () => "25.0.0",
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: vi.fn(() => "/app"),
    getName: vi.fn(() => "PwrAgent"),
    getVersion: vi.fn(() => "1.2.3"),
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
  resolveActiveProfileName: vi.fn(() => "sstk"),
}));

vi.mock("../log", () => ({
  getMainLogFilePath: vi.fn(
    () => "/Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
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
vi.mock("../changelog-window", () => ({ showChangelogWindow: vi.fn() }));
vi.mock("../license-document-window", () => ({
  showThirdPartyNoticesWindow: vi.fn(),
}));
vi.mock("../window-channels", () => ({ subscribersForChannel: vi.fn(() => []) }));

describe("app metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveStartupCodexHome.mockReturnValue(
      "/Users/operator/.codex/profiles/work",
    );
  });

  it("reports the Codex home pinned for the running process", async () => {
    const { resolveAppMetadata } = await import("../ipc/app-metadata");

    const metadata = resolveAppMetadata(4101);

    expect(resolveStartupCodexHome).toHaveBeenCalledOnce();
    expect(metadata).toMatchObject({
      activeProfileName: "sstk",
      architecture: "arm64",
      codexProfilePath: "/Users/operator/.codex/profiles/work",
      hostname: "viewer-mac.local",
      logFilePath:
        "/Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
      osVersion: "25.0.0",
      platform: "darwin",
      rendererProcessId: 4101,
    });
  });
});
