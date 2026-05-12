import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const runtimeMock = vi.hoisted(() => ({
  applyConfig: vi.fn(async () => undefined),
  deliverPairingOutcome: vi.fn(async () => undefined),
  getPlatformStatuses: vi.fn(() => []),
  isEnabled: vi.fn(() => true),
  listPairingRequests: vi.fn((): { entries: unknown[] } => ({ entries: [] })),
  onBindingsChanged: vi.fn(() => vi.fn()),
  onPairingChanged: vi.fn(() => vi.fn()),
  onPlatformStatus: vi.fn(() => vi.fn()),
  stop: vi.fn(async () => undefined),
}));
const settingsServiceMock = vi.hoisted(() => ({
  readSettings: vi.fn(),
  writeConfigPatch: vi.fn(async () => ({ configPath: "/tmp/pwragent-config.toml" })),
}));
const pairingStoreMock = vi.hoisted(() => ({
  markStatus: vi.fn(),
}));
const activityLogMock = vi.hoisted(() => ({
  record: vi.fn(),
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

vi.mock("../messaging/desktop-messaging-pairing-store", () => ({
  getDesktopMessagingPairingStore: vi.fn(() => pairingStoreMock),
}));

vi.mock("../messaging/desktop-messaging-activity-log", () => ({
  getDesktopMessagingActivityLog: vi.fn(() => activityLogMock),
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
    runtimeMock.deliverPairingOutcome.mockClear();
    runtimeMock.getPlatformStatuses.mockClear();
    runtimeMock.isEnabled.mockClear();
    runtimeMock.isEnabled.mockReturnValue(true);
    runtimeMock.listPairingRequests.mockClear();
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [] });
    runtimeMock.onBindingsChanged.mockClear();
    runtimeMock.onPairingChanged.mockClear();
    runtimeMock.onPlatformStatus.mockClear();
    runtimeMock.stop.mockClear();
    settingsServiceMock.readSettings.mockReset();
    settingsServiceMock.writeConfigPatch.mockClear();
    settingsServiceMock.writeConfigPatch.mockResolvedValue({
      configPath: "/tmp/pwragent-config.toml",
    });
    pairingStoreMock.markStatus.mockReset();
    activityLogMock.record.mockClear();
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

  it("approves LINE user pairing into authorized users", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const entry = {
      id: "pairing-line-user",
      platform: "line",
      instanceId: "default",
      scope: "user_dm",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U0123456789abcdef0123456789abcdef", displayName: "Harold" },
      observedChat: { id: "U0123456789abcdef0123456789abcdef", kind: "dm" },
    };
    const consumed = { ...entry, status: "consumed" };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(lineSettingsSnapshot());
    pairingStoreMock.markStatus.mockReturnValue(consumed);

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.({}, { entryId: entry.id }),
    ).resolves.toMatchObject({ added: true, entry: consumed });

    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        line: {
          authorizedUserIds: [
            { id: "U0123456789abcdef0123456789abcdef", displayName: "Harold" },
          ],
        },
      },
    });
    expect(runtimeMock.deliverPairingOutcome).toHaveBeenCalledWith(consumed, "approved");
  });

  it("approves LINE group and room pairing into separate bucket lists", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const approve = async (entry: Record<string, unknown>) => {
      runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
      pairingStoreMock.markStatus.mockReturnValue({ ...entry, status: "consumed" });
      registerMessagingStatusIpcHandlers();
      await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.({}, { entryId: entry.id });
    };

    settingsServiceMock.readSettings.mockResolvedValue(lineSettingsSnapshot());

    await approve({
      id: "pairing-line-group",
      platform: "line",
      instanceId: "default",
      scope: "bucket",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U0123456789abcdef0123456789abcdef" },
      observedChat: {
        id: "C0123456789abcdef0123456789abcdef",
        kind: "channel",
        title: "LINE group",
      },
    });
    await approve({
      id: "pairing-line-room",
      platform: "line",
      instanceId: "default",
      scope: "bucket",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U0123456789abcdef0123456789abcdef" },
      observedChat: {
        id: "R0123456789abcdef0123456789abcdef",
        kind: "channel",
        title: "LINE room",
      },
    });

    expect(settingsServiceMock.writeConfigPatch).toHaveBeenNthCalledWith(1, {
      messaging: {
        line: {
          authorizedGroups: [
            { id: "C0123456789abcdef0123456789abcdef", displayName: "LINE group" },
          ],
        },
      },
    });
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenNthCalledWith(2, {
      messaging: {
        line: {
          authorizedRooms: [
            { id: "R0123456789abcdef0123456789abcdef", displayName: "LINE room" },
          ],
        },
      },
    });
  });

  it("approves Feishu user and group pairing into the Feishu allowlists", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const approve = async (entry: Record<string, unknown>) => {
      runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
      pairingStoreMock.markStatus.mockReturnValue({ ...entry, status: "consumed" });
      registerMessagingStatusIpcHandlers();
      await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.({}, { entryId: entry.id });
    };

    settingsServiceMock.readSettings.mockResolvedValue(feishuSettingsSnapshot());

    await approve({
      id: "pairing-feishu-user",
      platform: "feishu",
      instanceId: "default",
      scope: "user_in_group",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: {
        id: "ou_fa23371f44e1e45ef8eb1848c3797042",
        displayName: "Harold",
      },
      observedChat: {
        id: "oc_071623e2edfe83f4783761cf7fab1601",
        kind: "channel",
        title: "Development",
        parentId: "19671ef596db072d",
      },
    });
    await approve({
      id: "pairing-feishu-group",
      platform: "feishu",
      instanceId: "default",
      scope: "bucket",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "ou_fa23371f44e1e45ef8eb1848c3797042" },
      observedChat: {
        id: "oc_071623e2edfe83f4783761cf7fab1601",
        kind: "channel",
        title: "Development",
        parentId: "19671ef596db072d",
      },
    });

    expect(settingsServiceMock.writeConfigPatch).toHaveBeenNthCalledWith(1, {
      messaging: {
        feishu: {
          authorizedChats: [
            { id: "oc_071623e2edfe83f4783761cf7fab1601", displayName: "Development" },
          ],
          authorizedUserIds: [
            { id: "ou_fa23371f44e1e45ef8eb1848c3797042", displayName: "Harold" },
          ],
        },
      },
    });
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenNthCalledWith(2, {
      messaging: {
        feishu: {
          authorizedChats: [
            { id: "oc_071623e2edfe83f4783761cf7fab1601", displayName: "Development" },
          ],
        },
      },
    });
  });
});

function lineSettingsSnapshot() {
  return {
    messaging: {
      line: {
        authorizedUserIds: { value: [], source: "default" },
        authorizedGroups: { value: [], source: "default" },
        authorizedRooms: { value: [], source: "default" },
      },
    },
  };
}

function feishuSettingsSnapshot() {
  return {
    messaging: {
      feishu: {
        authorizedUserIds: { value: [], source: "default" },
        authorizedChats: { value: [], source: "default" },
        authorizedTenants: { value: [], source: "default" },
      },
    },
  };
}
