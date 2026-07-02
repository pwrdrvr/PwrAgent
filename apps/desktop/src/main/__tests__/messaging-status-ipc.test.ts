import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const runtimeMock = vi.hoisted(() => ({
  applyConfig: vi.fn(async (_config: unknown, _options?: unknown) => undefined),
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
  resolveSlackBotTokenSync: vi.fn(),
  writeConfigPatch: vi.fn(async () => ({ configPath: "/tmp/pwragent-config.toml" })),
}));
const pairingStoreMock = vi.hoisted(() => ({
  markStatus: vi.fn(),
  recordApproval: vi.fn(),
}));
const activityLogMock = vi.hoisted(() => ({
  getPlatformActivitySummary: vi.fn(() => ({ summaries: [] as unknown[] })),
  record: vi.fn(),
}));
const messagingConfigMocks = vi.hoisted(() => ({
  loadDesktopMessagingConfigFromSettings: vi.fn(async () => ({
    enabled: true,
    inputDebounceMs: 500,
  })),
}));
const leaseCoordinatorMock = vi.hoisted(() => ({
  applyLatestConfig: vi.fn(
    async (
      runtime: typeof runtimeMock,
      loadConfig: (options: unknown) => Promise<unknown>,
      options: unknown,
    ) => {
      const config = await loadConfig(options);
      await runtime.applyConfig(config, { allowStart: true });
      return { enabled: true };
    },
  ),
  disableForSession: vi.fn(async (runtime: typeof runtimeMock) => {
    await runtime.stop();
    return { enabled: false, disabledReasonKind: "runtime_stopped" };
  }),
  shutdown: vi.fn(async (runtime: typeof runtimeMock) => {
    await runtime.stop();
  }),
}));
const slackProviderMock = vi.hoisted(() => ({
  resolveContact: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
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

vi.mock("../runtime-messaging-lease", () => ({
  getRuntimeMessagingLeaseCoordinator: vi.fn(() => leaseCoordinatorMock),
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

vi.mock("@pwragent/messaging-provider-slack", () => slackProviderMock);

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
    settingsServiceMock.resolveSlackBotTokenSync.mockReset();
    settingsServiceMock.writeConfigPatch.mockClear();
    settingsServiceMock.writeConfigPatch.mockResolvedValue({
      configPath: "/tmp/pwragent-config.toml",
    });
    pairingStoreMock.markStatus.mockReset();
    pairingStoreMock.recordApproval.mockReset();
    activityLogMock.getPlatformActivitySummary.mockClear();
    activityLogMock.getPlatformActivitySummary.mockReturnValue({ summaries: [] });
    activityLogMock.record.mockClear();
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings.mockClear();
    leaseCoordinatorMock.applyLatestConfig.mockClear();
    leaseCoordinatorMock.disableForSession.mockClear();
    leaseCoordinatorMock.shutdown.mockClear();
    slackProviderMock.resolveContact.mockReset();
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
    expect(leaseCoordinatorMock.applyLatestConfig).toHaveBeenCalledWith(
      runtimeMock,
      expect.any(Function),
      {
        logStartupEligibility: true,
        messagingEnabledOverride: true,
      },
    );
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
    expect(leaseCoordinatorMock.applyLatestConfig).toHaveBeenCalledWith(
      runtimeMock,
      expect.any(Function),
      { logStartupEligibility: true },
    );
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

  it("approves Slack observed pairing into the requested allowlist", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const entry = {
      id: "pairing-slack-channel",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U012ABCDEF0", displayName: "Harold" },
      observedChat: {
        id: "C012ABCDEF0",
        kind: "channel",
        title: "hi",
        bucketId: "T025C2NKT",
      },
    };
    const consumed = { ...entry, status: "consumed" };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    pairingStoreMock.markStatus.mockReturnValue(consumed);

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
        {},
        { entryId: entry.id, target: "conversation" },
      ),
    ).resolves.toMatchObject({ added: true, entry: consumed });

    expect(slackProviderMock.resolveContact).not.toHaveBeenCalled();
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedChannels: [
            { id: "C012ABCDEF0", displayName: "hi" },
          ],
        },
      },
    });

    settingsServiceMock.writeConfigPatch.mockClear();
    pairingStoreMock.markStatus.mockReturnValue(consumed);

    await expect(
      handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
        {},
        { entryId: entry.id, target: "actor" },
      ),
    ).resolves.toMatchObject({ added: true, entry: consumed });

    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedUserIds: [
            { id: "U012ABCDEF0", displayName: "Harold" },
          ],
        },
      },
    });
  });

  it("keeps a Slack request observed and records the target when consume is false", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const entry = {
      id: "pairing-slack-stay",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U012ABCDEF0", displayName: "Harold" },
      observedChat: {
        id: "C012ABCDEF0",
        kind: "channel",
        title: "team-alerts",
        bucketId: "T025C2NKT",
      },
    };
    const observedWithTarget = { ...entry, approvedTargets: ["team"] };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    pairingStoreMock.recordApproval.mockReturnValue(observedWithTarget);

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
        {},
        { entryId: entry.id, target: "team", consume: false },
      ),
    ).resolves.toMatchObject({ added: true, entry: observedWithTarget });

    // Team approval writes the workspace allowlist using the observed team ID.
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedWorkspaces: [
            { id: "T025C2NKT", displayName: "" },
          ],
        },
      },
    });
    // Stays observed: recorded, never consumed, no outcome delivered.
    expect(pairingStoreMock.recordApproval).toHaveBeenCalledWith({
      entryId: entry.id,
      target: "team",
    });
    expect(pairingStoreMock.markStatus).not.toHaveBeenCalled();
    // Stays observed, but the user gets a note confirming what was granted.
    expect(runtimeMock.deliverPairingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id }),
      "approved",
      expect.objectContaining({ text: expect.stringContaining("workspace") }),
    );
  });

  it("confirms a user-only approval and notes the channel is still gated", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const entry = {
      id: "pairing-slack-actor-note",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U079K80HTGS", displayName: "Harold" },
      observedChat: {
        id: "C012ABCDEF0",
        kind: "channel",
        title: "signals-chat",
        bucketId: "T025C2NKT",
      },
    };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    pairingStoreMock.recordApproval.mockReturnValue(entry);

    registerMessagingStatusIpcHandlers();

    await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
      {},
      { entryId: entry.id, target: "actor", consume: false },
    );

    expect(runtimeMock.deliverPairingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id }),
      "approved",
      expect.objectContaining({
        text: expect.stringContaining("channel isn't authorized yet"),
      }),
    );
  });

  it("maps a Slack thread pairing to the channel name and team ID, not the thread text", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    // Pairing sent as a thread reply in #signals-chat: title is the thread's
    // root message ("hi"), parentTitle is the channel name, bucketId the team.
    const entry = {
      id: "pairing-slack-thread",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U079K80HTGS", displayName: "Harold" },
      observedChat: {
        id: "G01N9LZU287",
        kind: "thread",
        title: "hi",
        parentId: "1712023032.000100",
        parentTitle: "signals-chat",
        bucketId: "T025C2NKT",
      },
    };
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    pairingStoreMock.recordApproval.mockReturnValue(entry);

    const approve = async (target: string) => {
      settingsServiceMock.writeConfigPatch.mockClear();
      runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
      registerMessagingStatusIpcHandlers();
      await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
        {},
        { entryId: entry.id, target, consume: false },
      );
    };

    // Channel approval uses the channel name (parentTitle), never "hi".
    await approve("conversation");
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedChannels: [{ id: "G01N9LZU287", displayName: "signals-chat" }],
        },
      },
    });

    // Team approval uses the workspace ID with a blank name (never the
    // channel name), so a Lookup can fill it in.
    await approve("team");
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedWorkspaces: [{ id: "T025C2NKT", displayName: "" }],
        },
      },
    });
  });

  it("maps a Slack channel-level pairing (no thread) to the channel name", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    // Pairing sent directly in #signals-chat (not a thread): the channel name
    // is the chat title, there is no parentTitle, bucketId is the team.
    const entry = {
      id: "pairing-slack-channel-level",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U079K80HTGS", displayName: "Harold" },
      observedChat: {
        id: "G01N9LZU287",
        kind: "channel",
        title: "signals-chat",
        bucketId: "T025C2NKT",
      },
    };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    pairingStoreMock.recordApproval.mockReturnValue(entry);

    registerMessagingStatusIpcHandlers();

    await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
      {},
      { entryId: entry.id, target: "conversation", consume: false },
    );

    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedChannels: [{ id: "G01N9LZU287", displayName: "signals-chat" }],
        },
      },
    });
  });

  it("resolves the Slack workspace name for a team approval when available", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const entry = {
      id: "pairing-slack-teamname",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U079K80HTGS", displayName: "Harold" },
      observedChat: {
        id: "G01N9LZU287",
        kind: "thread",
        title: "hi",
        parentTitle: "signals-chat",
        bucketId: "T025C2NKT",
      },
    };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    settingsServiceMock.resolveSlackBotTokenSync.mockReturnValue("xoxb-token");
    slackProviderMock.resolveContact.mockResolvedValue({
      status: "ok",
      id: "T025C2NKT",
      displayName: "PwrDrvr",
    });
    pairingStoreMock.recordApproval.mockReturnValue(entry);

    registerMessagingStatusIpcHandlers();

    await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
      {},
      { entryId: entry.id, target: "team", consume: false },
    );

    expect(slackProviderMock.resolveContact).toHaveBeenCalledWith(
      { botToken: "xoxb-token" },
      { id: "T025C2NKT", kind: "workspace" },
    );
    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedWorkspaces: [{ id: "T025C2NKT", displayName: "PwrDrvr" }],
        },
      },
    });
  });

  it("falls back to a blank Slack workspace name when the lookup fails", async () => {
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_APPROVE_PAIRING_CHANNEL } = await import("../../shared/ipc");
    const entry = {
      id: "pairing-slack-teamname-fail",
      platform: "slack",
      instanceId: "default",
      scope: "observed",
      status: "observed",
      generatedAt: 1_000,
      expiresAt: 2_000,
      observedActor: { id: "U079K80HTGS", displayName: "Harold" },
      observedChat: {
        id: "G01N9LZU287",
        kind: "channel",
        title: "signals-chat",
        bucketId: "T025C2NKT",
      },
    };
    runtimeMock.listPairingRequests.mockReturnValue({ entries: [entry] });
    settingsServiceMock.readSettings.mockResolvedValue(slackSettingsSnapshot());
    settingsServiceMock.resolveSlackBotTokenSync.mockReturnValue("xoxb-token");
    slackProviderMock.resolveContact.mockRejectedValue(new Error("network down"));
    pairingStoreMock.recordApproval.mockReturnValue(entry);

    registerMessagingStatusIpcHandlers();

    await handlers.get(MESSAGING_APPROVE_PAIRING_CHANNEL)?.(
      {},
      { entryId: entry.id, target: "team", consume: false },
    );

    expect(settingsServiceMock.writeConfigPatch).toHaveBeenCalledWith({
      messaging: {
        slack: {
          authorizedWorkspaces: [{ id: "T025C2NKT", displayName: "" }],
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

  it("shuts the messaging runtime down on graduation request", async () => {
    // The wizard's graduation path calls this IPC right before it
    // spawns the operator's chosen profile in a child Electron — the
    // child's own adapters can't start cleanly if the bootstrap is
    // still polling. Asserting the IPC routes through to the lease
    // coordinator's `shutdown` (which both stops the runtime AND
    // releases its lease, mirroring the SIGTERM cleanup).
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_SHUTDOWN_RUNTIME_CHANNEL } = await import("../../shared/ipc");

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_SHUTDOWN_RUNTIME_CHANNEL)?.(),
    ).resolves.toBeUndefined();

    expect(leaseCoordinatorMock.shutdown).toHaveBeenCalledWith(runtimeMock);
    expect(runtimeMock.stop).toHaveBeenCalled();
  });

  it("returns persisted per-provider request and response activity summaries", async () => {
    const summary = {
      summaries: [
        {
          platform: "telegram",
          lastRequestAt: 1_000,
          lastResponseAt: 2_000,
        },
      ],
    };
    activityLogMock.getPlatformActivitySummary.mockReturnValue(summary);
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL } = await import(
      "../../shared/ipc"
    );

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_GET_ACTIVITY_SUMMARY_CHANNEL)?.(),
    ).resolves.toEqual(summary);
    expect(activityLogMock.getPlatformActivitySummary).toHaveBeenCalled();
  });

  it("swallows shutdown errors so a failing teardown can't block the spawn", async () => {
    // The wizard cannot recover if `shutdownMessagingRuntime`
    // throws — it still needs to spawn the new profile. The IPC
    // must catch internally and return success; the failure is
    // logged but the spawn proceeds. Otherwise a stuck adapter
    // teardown would strand the operator with no main window.
    leaseCoordinatorMock.shutdown.mockRejectedValueOnce(new Error("boom"));
    const { registerMessagingStatusIpcHandlers } = await import(
      "../ipc/messaging-status"
    );
    const { MESSAGING_SHUTDOWN_RUNTIME_CHANNEL } = await import("../../shared/ipc");

    registerMessagingStatusIpcHandlers();

    await expect(
      handlers.get(MESSAGING_SHUTDOWN_RUNTIME_CHANNEL)?.(),
    ).resolves.toBeUndefined();
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

function slackSettingsSnapshot() {
  return {
    messaging: {
      slack: {
        authorizedUserIds: { value: [], source: "default" },
        authorizedWorkspaces: { value: [], source: "default" },
        authorizedChannels: { value: [], source: "default" },
      },
    },
  };
}
