import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const runtimeMock = vi.hoisted(() => ({
  applyConfig: vi.fn(async () => undefined),
  getPlatformStatuses: vi.fn(() => []),
  isEnabled: vi.fn(() => true),
  onBindingsChanged: vi.fn(() => vi.fn()),
  onPlatformStatus: vi.fn(() => vi.fn()),
  stop: vi.fn(async () => undefined),
}));
const settingsServiceMock = vi.hoisted(() => ({
  readSettings: vi.fn(),
}));
const messagingConfigMocks = vi.hoisted(() => ({
  loadDesktopMessagingConfigFromSettings: vi.fn(async () => ({
    enabled: true,
    inputDebounceMs: 500,
  })),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../messaging/messaging-runtime", () => ({
  getDesktopMessagingRuntime: vi.fn(() => runtimeMock),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: vi.fn(() => settingsServiceMock),
}));

vi.mock("../messaging/messaging-config", () => ({
  loadDesktopMessagingConfigFromSettings:
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings,
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(() => []),
}));

vi.mock("../messaging-activity-window", () => ({
  showMessagingActivityWindow: vi.fn(),
}));

describe("messaging status ipc", () => {
  beforeEach(() => {
    handlers.clear();
    runtimeMock.applyConfig.mockClear();
    runtimeMock.getPlatformStatuses.mockClear();
    runtimeMock.isEnabled.mockClear();
    runtimeMock.isEnabled.mockReturnValue(true);
    runtimeMock.onBindingsChanged.mockClear();
    runtimeMock.onPlatformStatus.mockClear();
    runtimeMock.stop.mockClear();
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings.mockClear();
  });

  it("loads startup eligibility diagnostics when enabling messaging at runtime", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_SET_ENABLED_CHANNEL } = await import("../../shared/ipc");

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_SET_ENABLED_CHANNEL)?.({}, { enabled: true }),
    ).resolves.toMatchObject({ enabled: true });

    expect(
      messagingConfigMocks.loadDesktopMessagingConfigFromSettings,
    ).toHaveBeenCalledWith(settingsServiceMock, process.env, {
      logStartupEligibility: true,
      messagingEnabledOverride: true,
    });
    expect(runtimeMock.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
      { allowStart: true },
    );
  });
});
