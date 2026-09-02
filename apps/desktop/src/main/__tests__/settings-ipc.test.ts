import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const tempRoots: string[] = [];
const disposeDesktopBackendRegistryMock = vi.fn(async () => undefined);
const listThreadsMock = vi.fn(async () => [] as unknown[]);
const listBackendsMock = vi.fn(async () => ({ backends: [], fetchedAt: 1 }));
const invalidateAcpBackendDiscoveryMock = vi.fn();
const getDesktopBackendRegistryMock = vi.fn(() => ({
  invalidateAcpBackendDiscovery: invalidateAcpBackendDiscoveryMock,
  listBackends: listBackendsMock,
  listThreads: listThreadsMock,
}));
const desktopConfigStoreMock = vi.hoisted(() => ({
  configRevision: vi.fn(() => "config-revision"),
  fileStatus: vi.fn(() => ({ kind: "valid", contentHash: "hash", observedAt: 20 })),
  recordProviderDiscovery: vi.fn(),
  read: vi.fn((domain: string) =>
    domain === "general"
      ? {
          appearance: {
            theme: "system",
            density: "mission-control",
            sidebarTextSize: "md",
            transcriptTextSize: "md",
          },
        }
      : {
          completed: true,
          completedSource: "migrated",
        },
  ),
  version: vi.fn(() => 1),
}));
const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
const localAcpDiscoveryMock = vi.hoisted(() => ({
  discoverLocalAcpAgentRecords: vi.fn(async () => [] as unknown[]),
}));
const acpRuntimeDiscoveryMock = vi.hoisted(() => ({
  discoverAcpRuntimeCapabilities: vi.fn(async () => ({} as unknown)),
}));
const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));
const providerMocks = vi.hoisted(() => ({
  resolveTelegramContact: vi.fn(),
  resolveDiscordContact: vi.fn(),
  inspectDiscordThreadPermissions: vi.fn(),
  listDiscordThreadPermissionChannels: vi.fn(),
  discoverDiscordApplicationId: vi.fn(
    async () => "1480556454498009351",
  ),
  buildDiscordThreadPermissionRequestUrl: vi.fn(
    () => "https://discord.com/oauth2/authorize?client_id=1480556454498009351",
  ),
  resolveMattermostContact: vi.fn(),
  resolveSlackContact: vi.fn(),
  buildSlackCreateAppUrl: vi.fn(() => ({
    url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
    fullUrl: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
    oversized: false,
    manifestJson: "{}",
  })),
}));
const runtimeMock = vi.hoisted(() => ({
  applyConfig: vi.fn(async (_config: unknown, _options?: unknown) => undefined),
  getPlatformCredentialMetadata: vi.fn(),
  isEnabled: vi.fn(() => false),
  requestCredentialValidation: vi.fn(),
}));
const messagingConfigMocks = vi.hoisted(() => ({
  loadDesktopMessagingConfigFromSettings: vi.fn(),
}));
const leaseCoordinatorMock = vi.hoisted(() => ({
  applyLatestConfig: vi.fn(
    async (
      runtime: typeof runtimeMock,
      loadConfig: (options: unknown) => Promise<unknown>,
      options: { allowStart?: boolean },
    ) => {
      const config = await loadConfig({
        logStartupEligibility: true,
      });
      await runtime.applyConfig(config, {
        allowStart: options.allowStart ?? true,
      });
      return { enabled: runtime.isEnabled() };
    },
  ),
  snapshot: vi.fn(() => ({
    instanceId: "test-instance",
    effectiveMessagingEnabled: false,
    leaseHeld: false,
    disabledReason: undefined as string | undefined,
    disabledReasonKind: undefined as "lease_held" | undefined,
    leaseHolder: undefined as { instanceId: string } | undefined,
  })),
}));

type MockSpawnStream = EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
};

type MockSpawnChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  stderr: MockSpawnStream;
  stdout: MockSpawnStream;
};

function createMockSpawnChild(
  schedule: (child: MockSpawnChild) => void,
): MockSpawnChild {
  const child = new EventEmitter() as MockSpawnChild;
  child.pid = 321;
  child.kill = vi.fn();
  child.stdout = new EventEmitter() as MockSpawnStream;
  child.stderr = new EventEmitter() as MockSpawnStream;
  child.stdout.setEncoding = vi.fn();
  child.stdout.destroy = vi.fn();
  child.stderr.setEncoding = vi.fn();
  child.stderr.destroy = vi.fn();
  schedule(child);
  return child;
}

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
  safeStorage: {
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false),
  },
  shell: {
    openExternal: electronMocks.openExternal,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: childProcessMocks.execFile,
  spawn: childProcessMocks.spawn,
}));
// @pwrdrvr/codex-discovery's bundled dist imports the un-prefixed
// "child_process" specifier; mock it too so the kit's CodexLoginManager spawn
// (Codex login now runs through the package) hits the same fake.
vi.mock("child_process", () => ({
  execFile: childProcessMocks.execFile,
  spawn: childProcessMocks.spawn,
}));

vi.mock("../acp/acp-instance-discovery", () => localAcpDiscoveryMock);
vi.mock("../acp/acp-runtime-discovery", () => acpRuntimeDiscoveryMock);

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: disposeDesktopBackendRegistryMock,
  getDesktopBackendRegistry: getDesktopBackendRegistryMock,
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopConfigStore: vi.fn(() => desktopConfigStoreMock),
  getDesktopSettingsService: vi.fn(),
}));

vi.mock("../messaging/messaging-runtime", () => ({
  getDesktopMessagingRuntime: vi.fn(() => runtimeMock),
}));

vi.mock("../messaging/messaging-config", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../messaging/messaging-config")
  >();
  return {
    ...actual,
    loadDesktopMessagingConfigFromSettings:
      messagingConfigMocks.loadDesktopMessagingConfigFromSettings.mockImplementation(
        actual.loadDesktopMessagingConfigFromSettings,
      ),
  };
});

vi.mock("../runtime-messaging-lease", () => ({
  getRuntimeMessagingLeaseCoordinator: vi.fn(() => leaseCoordinatorMock),
}));

vi.mock("@pwragent/messaging-provider-telegram", () => ({
  resolveContact: providerMocks.resolveTelegramContact,
}));

vi.mock("@pwragent/messaging-provider-discord", () => ({
  resolveContact: providerMocks.resolveDiscordContact,
  inspectDiscordThreadPermissions: providerMocks.inspectDiscordThreadPermissions,
  listDiscordThreadPermissionChannels:
    providerMocks.listDiscordThreadPermissionChannels,
  discoverDiscordApplicationId: providerMocks.discoverDiscordApplicationId,
  buildDiscordThreadPermissionRequestUrl:
    providerMocks.buildDiscordThreadPermissionRequestUrl,
}));

vi.mock("@pwragent/messaging-provider-mattermost", () => ({
  resolveContact: providerMocks.resolveMattermostContact,
}));

vi.mock("@pwragent/messaging-provider-slack", () => ({
  resolveContact: providerMocks.resolveSlackContact,
  buildSlackCreateAppUrl: providerMocks.buildSlackCreateAppUrl,
}));

describe("settings ipc", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    handlers.clear();
    disposeDesktopBackendRegistryMock.mockClear();
    invalidateAcpBackendDiscoveryMock.mockClear();
    listBackendsMock.mockClear();
    listThreadsMock.mockClear();
    listThreadsMock.mockResolvedValue([]);
    getDesktopBackendRegistryMock.mockClear();
    providerMocks.resolveTelegramContact.mockReset();
    providerMocks.resolveDiscordContact.mockReset();
    providerMocks.inspectDiscordThreadPermissions.mockReset();
    providerMocks.listDiscordThreadPermissionChannels.mockReset();
    providerMocks.discoverDiscordApplicationId.mockClear();
    providerMocks.buildDiscordThreadPermissionRequestUrl.mockClear();
    providerMocks.resolveMattermostContact.mockReset();
    providerMocks.resolveSlackContact.mockReset();
    providerMocks.buildSlackCreateAppUrl.mockClear();
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings.mockClear();
    leaseCoordinatorMock.applyLatestConfig.mockClear();
    leaseCoordinatorMock.snapshot.mockClear();
    runtimeMock.applyConfig.mockClear();
    runtimeMock.getPlatformCredentialMetadata.mockReset();
    runtimeMock.isEnabled.mockClear();
    runtimeMock.requestCredentialValidation.mockReset();
    childProcessMocks.execFile.mockReset();
    childProcessMocks.spawn.mockReset();
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockReset();
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([]);
    acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities.mockReset();
    acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities.mockResolvedValue({});
    electronMocks.openExternal.mockClear();
    childProcessMocks.execFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: NodeJS.ErrnoException) => void,
      ) => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error);
      },
    );
    childProcessMocks.spawn.mockImplementation(() => {
      throw new Error("unexpected spawn");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unexpected network fetch in settings IPC test");
      }),
    );
  });

  it("registers redacted read and write handlers", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("telegramBotToken", "123456789:secret-token");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore,
      now: () => 20,
    });
    const {
      registerSettingsIpcHandlers,
      disposeSettingsIpcHandlers,
    } = await import("../ipc/settings");
    const {
      SETTINGS_READ_BOOTSTRAP_CHANNEL,
      SETTINGS_READ_CHANNEL,
      SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
      SETTINGS_REPLACE_SECRET_CHANNEL,
      SETTINGS_WRITE_CONFIG_CHANNEL,
    } = await import("../../shared/ipc");
    const refreshCodexDiscovery = vi.spyOn(service, "refreshCodexDiscovery");
    const readSettings = vi.spyOn(service, "readSettingsProjection");

    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_READ_BOOTSTRAP_CHANNEL)?.({}),
    ).resolves.toMatchObject({
      snapshot: {
        version: 1,
        configRevision: "config-revision",
        onboarding: { completed: true },
      },
    });
    expect(readSettings).not.toHaveBeenCalled();

    await expect(
      handlers.get(SETTINGS_READ_CHANNEL)?.({}),
    ).resolves.toMatchObject({
      snapshot: {
        fetchedAt: 20,
        messaging: {
          telegram: {
            botToken: {
              configured: true,
              source: "keychain",
            },
          },
        },
      },
    });
    expect(desktopConfigStoreMock.recordProviderDiscovery).not.toHaveBeenCalled();
    await expect(
      handlers.get(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL)?.({}, {}),
    ).rejects.toThrow("requires a Settings or setup user-action intent");
    await handlers.get(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL)?.({}, {
      discoveryIntent: "settings-user-action",
    });
    expect(refreshCodexDiscovery).toHaveBeenCalledOnce();
    readSettings.mockClear();

    const writeResponse = await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
      {},
      {
        patch: {
          experimental: {
            diffCondensation: {
              enabled: true,
            },
          },
        },
      },
    );
    expect(writeResponse).toMatchObject({
      update: {
        normalizedPatch: {
          experimental: { diffCondensation: { enabled: true } },
        },
        scheduledProviderRefreshes: [],
      },
      snapshot: {
        experimental: {
          diffCondensation: { enabled: { value: true } },
        },
      },
    });
    expect(disposeDesktopBackendRegistryMock).not.toHaveBeenCalled();
    expect(readSettings).toHaveBeenCalledOnce();
    const secretResponse = await handlers.get(SETTINGS_REPLACE_SECRET_CHANNEL)?.(
      {},
      {
        secret: "discordBotToken",
        value: "discord-secret",
      },
    );
    expect(secretResponse).toEqual({
      secret: "discordBotToken",
      state: {
        configured: true,
        source: "keychain",
        writable: true,
      },
    });
    expect(readSettings).toHaveBeenCalledOnce();

    const readResponse = await handlers.get(SETTINGS_READ_CHANNEL)?.({});
    const encoded = JSON.stringify(readResponse);
    expect(encoded).toContain("diffCondensation");
    expect(encoded).not.toContain("123456789:secret-token");
    expect(encoded).not.toContain("discord-secret");
    expect(readSettings).toHaveBeenCalledTimes(2);

    disposeSettingsIpcHandlers();
    expect(handlers.has(SETTINGS_READ_CHANNEL)).toBe(false);
    expect(handlers.has(SETTINGS_READ_BOOTSTRAP_CHANNEL)).toBe(false);
  });

  it("includes live lease state in the targeted messaging projection", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });
    await service.writeConfigPatchTargeted({
      messaging: { enabled: true },
    });
    runtimeMock.isEnabled.mockReturnValue(false);
    leaseCoordinatorMock.snapshot.mockReturnValueOnce({
      instanceId: "test-instance",
      effectiveMessagingEnabled: false,
      leaseHeld: true,
      disabledReason: "Messaging is active in another PwrAgent instance.",
      disabledReasonKind: "lease_held",
      leaseHolder: { instanceId: "other-instance" },
    });
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { SETTINGS_READ_MESSAGING_CHANNEL } = await import("../../shared/ipc");

    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_READ_MESSAGING_CHANNEL)?.({}),
    ).resolves.toMatchObject({
      snapshot: {
        messaging: {
          enabled: { value: true },
        },
        runtime: {
          disabled: true,
          overrideActive: true,
          disabledReasonKind: "lease_held",
          leaseHolder: { instanceId: "other-instance" },
        },
      },
    });
  });

  it("uses startup messaging identity as the last credential result when no manual test ran", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });
    runtimeMock.getPlatformCredentialMetadata.mockReturnValue({
      account: "@pwragent_bot",
      detail: "api.telegram.org",
      observedAt: 1234,
    });
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL } = await import("../../shared/ipc");

    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL)?.(
        {},
        { kind: "telegram" },
      ),
    ).resolves.toMatchObject({
      account: "@pwragent_bot",
      detail: "api.telegram.org",
      kind: "telegram",
      status: "ok",
      testedAt: 1234,
    });
  });

  it("does not rebuild backend clients after targeted model settings changes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { SETTINGS_WRITE_CONFIG_CHANNEL } = await import("../../shared/ipc");

    registerSettingsIpcHandlers(service);

    await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
      {},
      {
        patch: {
          models: {
            codex: {
              profile: "work",
            },
          },
        },
      },
    );
    expect(disposeDesktopBackendRegistryMock).not.toHaveBeenCalled();

    await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
      {},
      {
        patch: {
          models: {
            codex: {
              path: "codex-next",
            },
          },
        },
      },
    );
    await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
      {},
      {
        patch: {
          acpAgents: {
            gemini: {
              enabled: false,
            },
          },
        },
      },
    );
    await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
      {},
      {
        patch: {
          acpAgents: {
            grok: {
              cliPath: "/tmp/pwragent-grok-arm64/grok",
            },
          },
        },
      },
    );

    expect(disposeDesktopBackendRegistryMock).not.toHaveBeenCalled();
    expect(invalidateAcpBackendDiscoveryMock).not.toHaveBeenCalled();
  });

  it("does not run the saved Codex path when discovery rejected it", async () => {
    const service = {
      resolveCodexCommand: vi.fn(async () => {
        throw new Error("Codex CLI is older than the minimum supported version");
      }),
      readSettings: vi.fn(async () => ({
        models: {
          codex: {
            discovery: {
              selectedCommand: undefined,
              candidates: [
                {
                  command: "/opt/homebrew/bin/codex",
                  executable: false,
                  failureReason: "codex_too_old",
                  selected: false,
                  source: "path",
                  version: "0.94.0",
                },
              ],
            },
            path: {
              value: "/opt/homebrew/bin/codex",
            },
          },
        },
      })),
      resolveTelegramBotTokenSync: vi.fn(),
      resolveDiscordBotTokenSync: vi.fn(),
      resolveMattermostBotTokenSync: vi.fn(),
      resolveMattermostServerUrlSync: vi.fn(),
      resolveSlackBotTokenSync: vi.fn(),
      resolveSlackAppTokenSync: vi.fn(),
      resolveLineChannelAccessTokenSync: vi.fn(),
      resolveGrokApiKey: vi.fn(),
    } as unknown as DesktopSettingsService;
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const { SETTINGS_TEST_CREDENTIALS_CHANNEL } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_TEST_CREDENTIALS_CHANNEL)?.(
        {},
        { kind: "codex" },
      ),
    ).resolves.toMatchObject({
      kind: "codex",
      status: "unset",
    });
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();

    disposeSettingsIpcHandlers();
  });

  it("opens the official Slack create-from-manifest URL in the system browser", async () => {
    const service = {
      readSettings: vi.fn(),
    } as unknown as DesktopSettingsService;
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const { SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL)?.({}, { open: true }),
    ).resolves.toMatchObject({
      opened: true,
      oversized: false,
      url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      manifestJson: "{}",
    });
    expect(providerMocks.buildSlackCreateAppUrl).toHaveBeenCalledTimes(1);
    expect(electronMocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
    );

    disposeSettingsIpcHandlers();
  });

  it("opens Slack Apps and returns the manifest for an existing app update", async () => {
    const service = {
      readSettings: vi.fn(),
    } as unknown as DesktopSettingsService;
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const { SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL)?.(
        {},
        { mode: "update", open: true },
      ),
    ).resolves.toMatchObject({
      opened: true,
      oversized: false,
      url: "https://api.slack.com/apps",
      manifestJson: "{}",
    });
    expect(electronMocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://api.slack.com/apps",
    );

    disposeSettingsIpcHandlers();
  });

  it("checks and opens Discord's suggested thread-reply permission request", async () => {
    const service = {
      readSettings: vi.fn(),
    } as unknown as DesktopSettingsService;
    const discordConfig = {
      discord: {
        applicationId: "1480556454498009351",
        botToken: "discord-token",
      },
    };
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings
      .mockResolvedValueOnce(discordConfig)
      .mockResolvedValueOnce(discordConfig)
      .mockResolvedValueOnce(discordConfig)
      .mockResolvedValueOnce({
        discord: {
          botToken: "discord-token",
        },
      });
    providerMocks.listDiscordThreadPermissionChannels.mockResolvedValue({
      channels: [
        {
          id: "1480556454498009352",
          kind: "text",
          name: "general",
        },
      ],
      guildId: "1480556454498009353",
      guildName: "PwrAgent test guild",
      status: "ok",
    });
    providerMocks.inspectDiscordThreadPermissions.mockResolvedValue({
      channelId: "1480556454498009352",
      checkedAt: 1,
      durationMs: 1,
      guildId: "1480556454498009353",
      permissions: [],
      status: "ok",
    });
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const {
      SETTINGS_INSPECT_DISCORD_THREAD_PERMISSIONS_CHANNEL,
      SETTINGS_LIST_DISCORD_THREAD_PERMISSION_CHANNELS_CHANNEL,
      SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL,
    } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_LIST_DISCORD_THREAD_PERMISSION_CHANNELS_CHANNEL)?.(
        {},
        { guildId: "1480556454498009353" },
      ),
    ).resolves.toMatchObject({
      channels: [expect.objectContaining({ name: "general" })],
      status: "ok",
    });
    expect(providerMocks.listDiscordThreadPermissionChannels).toHaveBeenCalledWith({
      botToken: "discord-token",
      guildId: "1480556454498009353",
    });

    await expect(
      handlers.get(SETTINGS_INSPECT_DISCORD_THREAD_PERMISSIONS_CHANNEL)?.(
        {},
        {
          channelId: "1480556454498009352",
          guildId: "1480556454498009353",
        },
      ),
    ).resolves.toMatchObject({ status: "ok" });
    expect(providerMocks.inspectDiscordThreadPermissions).toHaveBeenCalledWith({
      botToken: "discord-token",
      channelId: "1480556454498009352",
      guildId: "1480556454498009353",
    });

    await expect(
      handlers.get(SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL)?.(
        {},
        { guildId: "1480556454498009353", open: true },
      ),
    ).resolves.toMatchObject({ opened: true });
    expect(providerMocks.buildDiscordThreadPermissionRequestUrl).toHaveBeenCalledWith({
      applicationId: "1480556454498009351",
      guildId: "1480556454498009353",
    });
    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      "https://discord.com/oauth2/authorize?client_id=1480556454498009351",
    );
    expect(providerMocks.discoverDiscordApplicationId).not.toHaveBeenCalled();

    await expect(
      handlers.get(SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL)?.(
        {},
        { guildId: "1480556454498009353", open: false },
      ),
    ).resolves.toMatchObject({ opened: false });
    expect(providerMocks.discoverDiscordApplicationId).toHaveBeenCalledWith({
      botToken: "discord-token",
    });
    expect(
      providerMocks.buildDiscordThreadPermissionRequestUrl,
    ).toHaveBeenLastCalledWith({
      applicationId: "1480556454498009351",
      guildId: "1480556454498009353",
    });

    disposeSettingsIpcHandlers();
  });

  it("starts named Codex auth profile login with the browser OAuth flow", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const codexHome = path.join(tempRoot, "codex");
    vi.stubEnv("CODEX_HOME", codexHome);
    const service = {
      resolveCodexCommand: vi.fn(async () => ({
        command: "/Applications/Codex.app/Contents/Resources/codex",
        source: "config" as const,
      })),
    } as unknown as DesktopSettingsService;
    const loginUrl =
      "https://auth.openai.com/oauth/authorize?client_id=codex&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
    childProcessMocks.spawn.mockImplementation(() => {
      return createMockSpawnChild((child) => {
        queueMicrotask(() => {
          child.stdout.emit("data", `If your browser did not open, navigate to:\n${loginUrl}\n`);
        });
      });
    });
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const {
      SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
    } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL)?.(
        {},
        { profile: "work" },
      ),
    ).resolves.toMatchObject({
      codexHome: path.join(codexHome, "profiles", "work"),
      loginUrl,
      profile: "work",
      started: true,
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledExactlyOnceWith(
      "/Applications/Codex.app/Contents/Resources/codex",
      ["login"],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: path.join(codexHome, "profiles", "work"),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(electronMocks.openExternal).toHaveBeenCalledExactlyOnceWith(loginUrl);

    disposeSettingsIpcHandlers();
  });

  it("keeps the newest Codex login process tracked when restarting login", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const codexHome = path.join(tempRoot, "codex");
    vi.stubEnv("CODEX_HOME", codexHome);
    const service = {
      resolveCodexCommand: vi.fn(async () => ({
        command: "/Applications/Codex.app/Contents/Resources/codex",
        source: "config" as const,
      })),
    } as unknown as DesktopSettingsService;
    const loginUrl =
      "https://auth.openai.com/oauth/authorize?client_id=codex&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
    const children: Array<ReturnType<typeof createMockSpawnChild>> = [];
    childProcessMocks.spawn.mockImplementation(() => {
      const child = createMockSpawnChild((spawnedChild) => {
        queueMicrotask(() => {
          spawnedChild.stdout.emit("data", `If your browser did not open:\n${loginUrl}\n`);
        });
      });
      child.pid = 321 + children.length;
      children.push(child);
      return child;
    });
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const {
      SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
    } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await handlers.get(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL)?.(
      {},
      { profile: "work" },
    );
    await handlers.get(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL)?.(
      {},
      { profile: "work" },
    );
    expect(children[0]?.kill).toHaveBeenCalledOnce();

    children[0]?.emit("close", 0);
    disposeSettingsIpcHandlers();

    expect(children[1]?.kill).toHaveBeenCalledOnce();
  });

  it("treats Codex login exit without a link as authenticated when status passes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const codexHome = path.join(tempRoot, "codex");
    vi.stubEnv("CODEX_HOME", codexHome);
    const service = {
      resolveCodexCommand: vi.fn(async () => ({
        command: "/Applications/Codex.app/Contents/Resources/codex",
        source: "config" as const,
      })),
    } as unknown as DesktopSettingsService;
    childProcessMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      if (args.join(" ") === "login status") {
        return createMockSpawnChild((child) => {
          queueMicrotask(() => {
            child.stdout.emit("data", "Logged in as user@example.com");
            child.emit("close", 0);
          });
        });
      }
      return createMockSpawnChild((child) => {
        queueMicrotask(() => {
          child.emit("close", 0);
        });
      });
    });
    const { registerSettingsIpcHandlers, disposeSettingsIpcHandlers } = await import(
      "../ipc/settings"
    );
    const {
      SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
    } = await import("../../shared/ipc");

    disposeSettingsIpcHandlers();
    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL)?.(
        {},
        { profile: "work" },
      ),
    ).resolves.toMatchObject({
      authenticated: true,
      codexHome: path.join(codexHome, "profiles", "work"),
      profile: "work",
      started: false,
    });
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      1,
      "/Applications/Codex.app/Contents/Resources/codex",
      ["login"],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: path.join(codexHome, "profiles", "work"),
        }),
      }),
    );
    expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
      2,
      "/Applications/Codex.app/Contents/Resources/codex",
      ["login", "status"],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: path.join(codexHome, "profiles", "work"),
        }),
      }),
    );

    disposeSettingsIpcHandlers();
  });

  it("hot-applies messaging config writes without defeating a launch disable override", async () => {
    vi.stubEnv("PWRAGENT_DISABLE_MESSAGING", "1");
    runtimeMock.isEnabled.mockReturnValue(false);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("telegramBotToken", "settings-telegram-token");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore,
      now: () => 20,
    });
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { SETTINGS_WRITE_CONFIG_CHANNEL } = await import("../../shared/ipc");

    registerSettingsIpcHandlers(service);

    await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
      {},
      {
        patch: {
          messaging: {
            telegram: {
              enabled: true,
            },
          },
        },
      },
    );

    expect(runtimeMock.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        telegram: expect.objectContaining({
          botToken: "settings-telegram-token",
          authorizedActorIds: [],
        }),
      }),
      { allowStart: false },
    );
    expect(
      messagingConfigMocks.loadDesktopMessagingConfigFromSettings,
    ).toHaveBeenCalledWith(service, process.env, {
      logStartupEligibility: true,
    });
  });

  it("resolves messaging contacts through provider packages", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("telegramBotToken", "telegram-token");
    await secretStore.setSecret("slackBotToken", "slack-token");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore,
      now: () => 20,
    });
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const {
      SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
    } = await import("../../shared/ipc");
    providerMocks.resolveTelegramContact.mockResolvedValue({
      status: "ok",
      id: "8460800771",
      displayName: "<script>alert(1)</script>Harold\u202e",
      handle: "@hunt<haro>",
    });

    registerSettingsIpcHandlers(service);

    await expect(
      handlers.get(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL)?.(
        {},
        {
          platform: "telegram",
          kind: "user",
          id: "8460800771",
        },
      ),
    ).resolves.toMatchObject({
      status: "ok",
      displayName: "Harold",
      handle: "@hunt",
    });
    expect(providerMocks.resolveTelegramContact).toHaveBeenCalledExactlyOnceWith(
      { botToken: "telegram-token" },
      { id: "8460800771", kind: "user" },
    );

    providerMocks.resolveSlackContact.mockResolvedValue({
      status: "ok",
      id: "U079K80HTGS",
      displayName: "Harold Hunt",
      handle: "@hhunt",
    });
    await expect(
      handlers.get(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL)?.(
        {},
        {
          platform: "slack",
          kind: "user",
          id: "U079K80HTGS",
        },
      ),
    ).resolves.toMatchObject({
      status: "ok",
      displayName: "Harold Hunt",
      handle: "@hhunt",
    });
    expect(providerMocks.resolveSlackContact).toHaveBeenCalledExactlyOnceWith(
      { botToken: "slack-token" },
      { id: "U079K80HTGS", kind: "user" },
    );
  });

  it("lists locally discovered ACP agents without a registry install", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([
      {
        backendId: "acp:gemini",
        registryId: "gemini",
        name: "Gemini CLI",
        version: "0.42.0",
        distributionKind: "local",
        distributionSource: "gemini --acp --skip-trust",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-gemini-cli",
        installedAt: 1234,
        updatedAt: 1234,
        launchDescriptor: {
          backendId: "acp:gemini",
          registryId: "gemini",
          distributionKind: "local",
          command: "gemini",
          args: ["--acp", "--skip-trust"],
          env: {},
        },
      },
    ]);
    acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities.mockResolvedValue({
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        discoveredAt: 2222,
        checkedAt: 2222,
        source: "session-new",
        configOptions: [
          {
            id: "permission-mode",
            label: "Permission mode",
            type: "select",
            category: "mode",
            currentValue: "default",
            values: [{ value: "default", label: "Default" }],
          },
        ],
      },
    });
    const { initializeAppState, disposeAppState } = await import("../state/app-state");
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState("bootstrap");
    try {
      registerSettingsIpcHandlers(service);
      // Even before any discovery (cache-only read), all four supported
      // providers render as their own not-installed placeholder entries —
      // known providers never vanish just because they're undiscovered.
      const cached = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: false },
      )) as
        | {
            entries?: Array<{
              registryId: string;
              installed: boolean;
              installStatus: string;
            }>;
          }
        | undefined;
      expect(cached?.entries?.map((entry) => entry.registryId)).toEqual([
        "gemini",
        "kimi",
        "grok",
        "qwen",
      ]);
      expect(
        cached?.entries?.every(
          (entry) =>
            entry.installed === false && entry.installStatus === "not-installed",
        ),
      ).toBe(true);
      const discoveredOnly = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: true, discoveryIntent: "settings-user-action", probeCapabilities: false },
      )) as { entries?: unknown[] } | undefined;
      expect(discoveredOnly?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            backendId: "acp:gemini",
            installed: true,
          }),
        ]),
      );
      expect(
        acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities,
      ).not.toHaveBeenCalled();

      const { applyDesktopSettingsPatch } = await import(
        "../settings/desktop-config"
      );
      applyDesktopSettingsPatch(
        path.join(tempRoot, ".bootstrap", "config.toml"),
        { acpAgents: { gemini: { enabled: true } } },
      );
      const refreshed = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: true, discoveryIntent: "settings-user-action", force: true, registryIds: ["gemini"] },
      )) as { entries?: unknown[] } | undefined;
      expect(refreshed?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            backendId: "acp:gemini",
            registryId: "gemini",
            name: "Gemini CLI",
            distributionKind: "local",
            distributionSource: "gemini --acp --skip-trust",
            installed: true,
            installStatus: "installed",
            installable: false,
            allowlistRuleId: "local-gemini-cli",
            lastDiscoveredAt: 2222,
            runtime: expect.objectContaining({
              discoveredAt: 2222,
            }),
          }),
        ]),
      );
      expect(
        acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ backendId: "acp:gemini" }),
        expect.objectContaining({
          cwd: path.join(
            tempRoot,
            ".bootstrap",
            "state",
            "acp-discovery-workspace",
          ),
          requestTimeoutMs: 10 * 60_000,
        }),
      );
      expect(
        localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabledRegistryIds: ["gemini"] }),
      );
      expect(
        fs.existsSync(path.join(tempRoot, "profiles", "default")),
      ).toBe(false);
    } finally {
      disposeAppState();
    }
  });

  it("never serves a vendor Grok update status for a PwrAgent build", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    const { initializeAppState, disposeAppState, getAppStateDb } = await import(
      "../state/app-state"
    );
    const { AcpAgentStore } = await import("../acp/acp-agent-store");
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState("bootstrap");
    try {
      // A vendor update status left in the durable record from a session where
      // ~/.grok/bin/grok was the runtime, now that a PwrAgent build is active.
      new AcpAgentStore(getAppStateDb()).upsertInstalledAgent({
        backendId: "acp:grok",
        registryId: "grok",
        name: "Grok",
        version: "1.0.4-pwragent.2",
        distributionKind: "local",
        distributionSource: "grok agent stdio",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-grok-cli",
        installedAt: 1234,
        updatedAt: 1234,
        activeCommand: "/pwragent/agents/grok/versions/latest/grok",
        launchDescriptor: {
          backendId: "acp:grok",
          registryId: "grok",
          distributionKind: "local",
          command: "/pwragent/agents/grok/versions/latest/grok",
          args: ["agent", "stdio"],
          env: { GROK_INSTALLER: "pwragent", NO_COLOR: "1" },
        },
        update: {
          status: "available",
          checkedAt: 1000,
          currentVersion: "1.0.3",
          latestVersion: "1.0.5",
        },
        updateCommand: "/Users/me/.grok/bin/grok",
      });
      registerSettingsIpcHandlers(service);

      // `refresh: false` serves the durable record without a discovery pass —
      // the read path the update notice uses, and where the stale vendor
      // status used to reach the renderer.
      const response = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: false },
      )) as
        | {
            entries?: Array<{
              registryId: string;
              pwrAgentManagedRuntime?: boolean;
              update?: unknown;
            }>;
          }
        | undefined;
      const grok = response?.entries?.find(
        (entry) => entry.registryId === "grok",
      );
      expect(grok).toMatchObject({ pwrAgentManagedRuntime: true });
      expect(grok?.update).toBeUndefined();
    } finally {
      disposeAppState();
    }
  });

  it("reports the managed Grok channel and the pin holding it back", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    const managedRoot = path.join(tempRoot, "agents", "grok");
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(managedRoot, "managed-release.json"),
      JSON.stringify({
        asset: "pwragent-grok-1.0.5-pwragent.1-macos-universal.tar.gz",
        checkedAt: 5_000,
        installedAt: 4_000,
        repository: "pwrdrvr/grok-build",
        schemaVersion: 1,
        sha256: "a".repeat(64),
        tag: "pwragent-v1.0.5-pwragent.1",
      }),
    );
    // The operator pinned an older managed version with a manual path, so the
    // newest verified build is installed and never runs.
    const pinnedCommand = path.join(
      managedRoot,
      "versions",
      "pwragent-v1.0.4-pwragent.2",
      "grok",
    );

    const { initializeAppState, disposeAppState, getAppStateDb } = await import(
      "../state/app-state"
    );
    const { AcpAgentStore } = await import("../acp/acp-agent-store");
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    // The pin has to be a real configured override, because that is the cause
    // `pinnedBehind` reports. A bare tag mismatch is not enough.
    fs.writeFileSync(
      path.join(tempRoot, "config.toml"),
      `[acp_agents.grok]\ncli_path = "${pinnedCommand}"\n`,
    );
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState("bootstrap");
    try {
      new AcpAgentStore(getAppStateDb()).upsertInstalledAgent({
        backendId: "acp:grok",
        registryId: "grok",
        name: "Grok",
        version: "1.0.4-pwragent.2",
        distributionKind: "local",
        distributionSource: "grok agent stdio",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-grok-cli",
        installedAt: 1234,
        updatedAt: 1234,
        activeCommand: pinnedCommand,
        instances: [
          { command: pinnedCommand, version: "1.0.4-pwragent.2", source: "override" },
          { command: "/Users/me/.grok/bin/grok", version: "1.0.5", source: "path" },
        ],
        launchDescriptor: {
          backendId: "acp:grok",
          registryId: "grok",
          distributionKind: "local",
          command: pinnedCommand,
          args: ["agent", "stdio"],
          // Deliberately unstamped: discovery only stamps the command the
          // current release check resolved, which a pinned older version is
          // not. Provenance still has to come out right.
          env: { NO_COLOR: "1" },
        },
      });
      registerSettingsIpcHandlers(service);

      const response = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: false },
      )) as { entries?: AcpAgentSettingsEntry[] } | undefined;
      const grok = response?.entries?.find(
        (entry) => entry.registryId === "grok",
      );

      expect(grok).toMatchObject({ pwrAgentManagedRuntime: true });
      expect(grok?.managedBuild).toMatchObject({
        repository: "pwrdrvr/grok-build",
        installedTag: "pwragent-v1.0.5-pwragent.1",
        activeTag: "pwragent-v1.0.4-pwragent.2",
        checkedAt: 5_000,
        pinnedBehind: true,
      });
      expect(grok?.instances).toMatchObject([
        { pwrAgentBuild: true, pwrAgentBuildTag: "pwragent-v1.0.4-pwragent.2" },
        { command: "/Users/me/.grok/bin/grok" },
      ]);
      expect(grok?.instances?.[1]?.pwrAgentBuild).toBeUndefined();
    } finally {
      disposeAppState();
    }
  });

  it("does not report a pin, or a channel, that the config does not have", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    const managedRoot = path.join(tempRoot, "agents", "grok");
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(managedRoot, "managed-release.json"),
      JSON.stringify({
        asset: "pwragent-grok-1.0.5-pwragent.1-macos-universal.tar.gz",
        checkedAt: 5_000,
        installedAt: 4_000,
        repository: "pwrdrvr/grok-build",
        schemaVersion: 1,
        sha256: "a".repeat(64),
        tag: "pwragent-v1.0.5-pwragent.1",
      }),
    );
    const olderCommand = path.join(
      managedRoot,
      "versions",
      "pwragent-v1.0.4-pwragent.2",
      "grok",
    );
    // The managed root is machine-wide, so a sibling instance can install a
    // newer tag while this record still names the older one. That is a tag
    // mismatch with no override behind it, and the durable notice it would
    // feed tells the operator to clear a manual path that does not exist.
    fs.writeFileSync(
      path.join(tempRoot, "config.toml"),
      "[acp_agents.grok]\nmanaged_builds = false\n",
    );

    const { initializeAppState, disposeAppState, getAppStateDb } = await import(
      "../state/app-state"
    );
    const { AcpAgentStore } = await import("../acp/acp-agent-store");
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState("bootstrap");
    try {
      new AcpAgentStore(getAppStateDb()).upsertInstalledAgent({
        backendId: "acp:grok",
        registryId: "grok",
        name: "Grok",
        version: "1.0.4-pwragent.2",
        distributionKind: "local",
        distributionSource: "grok agent stdio",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-grok-cli",
        installedAt: 1234,
        updatedAt: 1234,
        activeCommand: olderCommand,
        instances: [
          { command: olderCommand, version: "1.0.4-pwragent.2", source: "fallback" },
        ],
        launchDescriptor: {
          backendId: "acp:grok",
          registryId: "grok",
          distributionKind: "local",
          command: olderCommand,
          args: ["agent", "stdio"],
          env: { NO_COLOR: "1" },
        },
      });
      registerSettingsIpcHandlers(service);

      const response = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: false },
      )) as { entries?: AcpAgentSettingsEntry[] } | undefined;
      const grok = response?.entries?.find(
        (entry) => entry.registryId === "grok",
      );

      // Managed builds are off, so the pane must not report a channel at all
      // — no installed tag, no "Check for updates" for a channel the operator
      // disabled.
      expect(grok?.managedBuild).toBeUndefined();
      // Provenance survives the channel being off: the binary is still ours,
      // so the vendor updater still must not claim it.
      expect(grok).toMatchObject({ pwrAgentManagedRuntime: true });
      expect(grok?.instances?.[0]).toMatchObject({
        pwrAgentBuild: true,
        pwrAgentBuildTag: "pwragent-v1.0.4-pwragent.2",
      });
    } finally {
      disposeAppState();
    }
  });

  it("persists legacy Kimi diagnostics without probing or retaining models", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    const legacyPath = "/Users/me/.local/bin/kimi";
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([
      {
        backendId: "acp:kimi",
        registryId: "kimi",
        name: "Kimi Code CLI",
        version: "1.46.0",
        distributionKind: "local",
        distributionSource: `${legacyPath} (legacy kimi-cli ignored)`,
        installStatus: "unavailable",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-kimi-cli",
        installedAt: 1234,
        updatedAt: 1234,
        lastError: "Legacy Python kimi-cli was found and ignored.",
        instances: [],
        incompatibleInstances: [
          { command: legacyPath, version: "1.46.0", source: "path" },
        ],
      },
    ]);
    const { initializeAppState, disposeAppState } = await import(
      "../state/app-state"
    );
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState("bootstrap");
    try {
      registerSettingsIpcHandlers(service);
      const refreshed = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: true, discoveryIntent: "settings-user-action" },
      )) as { entries?: Array<Record<string, unknown>> } | undefined;
      expect(refreshed?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            backendId: "acp:kimi",
            installed: false,
            installStatus: "unavailable",
            runtime: undefined,
            incompatibleInstances: [
              expect.objectContaining({ command: legacyPath }),
            ],
          }),
        ]),
      );
      expect(
        acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities,
      ).not.toHaveBeenCalled();
    } finally {
      disposeAppState();
    }
  });

  it("passes configured ACP CLI overrides to explicit local discovery refreshes", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    vi.stubEnv("PWRAGENT_ACP_AGENTS_GROK_CLI_PATH", "/opt/pwragent/bin/grok");
    vi.stubEnv("PWRAGENT_ACP_AGENTS_QWEN_CLI_PATH", "/opt/pwragent/bin/qwen");
    const { initializeAppState, disposeAppState } = await import(
      "../state/app-state"
    );
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: { PATH: "/electron/bin:/usr/bin" },
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
      resolveCodexShellEnv: () => ({
        PATH: "/opt/homebrew/bin:/usr/bin",
      }),
    });

    initializeAppState();
    try {
      registerSettingsIpcHandlers(service);
      await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.({}, { refresh: true, discoveryIntent: "settings-user-action" });

      expect(
        localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledRegistryIds: ["gemini", "grok", "kimi", "qwen"],
          managedGrok: {
            enabled: true,
            checkMode: "once-per-process",
            requirePlatformSignature: false,
          },
          preferences: {
            grok: { overridePath: "/opt/pwragent/bin/grok" },
            qwen: { overridePath: "/opt/pwragent/bin/qwen" },
          },
          env: expect.objectContaining({
            PATH: "/opt/homebrew/bin:/usr/bin",
          }),
        }),
      );
    } finally {
      disposeAppState();
    }
    // Dynamic `import()` of the main app-state graph + IPC discovery round-trip
    // runs right at the 5s default under CI load; give it headroom so the slow
    // setup doesn't flake the suite.
  }, 20_000);

  it("skips local discovery and runtime probes for disabled ACP agents", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    const profileConfigPath = path.join(
      tempRoot,
      "profiles",
      "default",
      "config.toml",
    );
    fs.mkdirSync(path.dirname(profileConfigPath), { recursive: true });
    fs.writeFileSync(
      profileConfigPath,
      [
        "[acp_agents.gemini]",
        "enabled = false",
        "",
        "[acp_agents.kimi]",
        "cli_path = \"/opt/pwragent/bin/kimi\"",
        "",
      ].join("\n"),
    );
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockImplementation(
      async () => [],
    );
    const { initializeAppState, disposeAppState, getAppStateDb } = await import(
      "../state/app-state"
    );
    const { AcpAgentStore } = await import("../acp/acp-agent-store");
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: profileConfigPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState();
    try {
      new AcpAgentStore(getAppStateDb()).upsertInstalledAgent({
        backendId: "acp:gemini",
        registryId: "gemini",
        name: "Gemini CLI",
        version: "0.42.0",
        distributionKind: "local",
        distributionSource: "gemini --acp --skip-trust",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-gemini-cli",
        installedAt: 1234,
        updatedAt: 1234,
        launchDescriptor: {
          backendId: "acp:gemini",
          registryId: "gemini",
          distributionKind: "local",
          command: "gemini",
          args: ["--acp", "--skip-trust"],
          env: {},
        },
      });
      registerSettingsIpcHandlers(service);

      const refreshed = (await handlers
        .get(ACP_AGENTS_LIST_CHANNEL)
        ?.({}, { refresh: true, discoveryIntent: "settings-user-action", force: true })) as
        | { entries?: Array<{ registryId: string; installed: boolean }> }
        | undefined;

      expect(
        localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledRegistryIds: ["grok", "kimi", "qwen"],
          preferences: {
            kimi: { overridePath: "/opt/pwragent/bin/kimi" },
          },
        }),
      );
      expect(
        localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
      ).toHaveBeenCalledWith(
        expect.not.objectContaining({
          preferences: expect.objectContaining({
            gemini: expect.anything(),
          }),
        }),
      );
      expect(
        acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities,
      ).not.toHaveBeenCalled();
      expect(refreshed?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            registryId: "gemini",
            installed: true,
          }),
        ]),
      );
    } finally {
      disposeAppState();
    }
  }, 20_000);

  it("reuses cached ACP capabilities across refreshes and re-probes only when forced", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([
      {
        backendId: "acp:gemini",
        registryId: "gemini",
        name: "Gemini CLI",
        version: "0.42.0",
        distributionKind: "local",
        distributionSource: "gemini --acp --skip-trust",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-gemini-cli",
        installedAt: 1234,
        updatedAt: 1234,
        launchDescriptor: {
          backendId: "acp:gemini",
          registryId: "gemini",
          distributionKind: "local",
          command: "gemini",
          args: ["--acp", "--skip-trust"],
          env: {},
        },
      },
    ]);
    // A recent probe timestamp so the persisted capabilities stay "fresh"
    // across the subsequent refreshes within this test.
    const probedAt = Date.now();
    acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities.mockResolvedValue({
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        discoveredAt: probedAt,
        checkedAt: probedAt,
        source: "session-new",
        configOptions: [],
      },
    });
    const { initializeAppState, disposeAppState } = await import(
      "../state/app-state"
    );
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState();
    try {
      registerSettingsIpcHandlers(service);
      const probe =
        acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities;

      // First refresh: the agent is undiscovered → it must be probed once.
      await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.({}, { refresh: true, discoveryIntent: "settings-user-action" });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.not.objectContaining({ requestTimeoutMs: expect.anything() }),
      );

      // Second refresh: cached capabilities are fresh + version-matched → the
      // expensive probe must be skipped (no new launch).
      await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.({}, { refresh: true, discoveryIntent: "settings-user-action" });
      expect(probe).toHaveBeenCalledTimes(1);

      localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          version: "0.43.0",
          distributionKind: "local",
          distributionSource: "gemini --acp --skip-trust",
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          allowlistRuleId: "local-gemini-cli",
          installedAt: 1234,
          updatedAt: 1234,
          launchDescriptor: {
            backendId: "acp:gemini",
            registryId: "gemini",
            distributionKind: "local",
            command: "gemini",
            args: ["--acp", "--skip-trust"],
            env: {},
          },
        },
      ]);
      const discoveredOnly = (await handlers
        .get(ACP_AGENTS_LIST_CHANNEL)
        ?.({}, { refresh: true, discoveryIntent: "settings-user-action", probeCapabilities: false })) as
        | {
            entries?: Array<{
              registryId: string;
              runtime?: unknown;
              lastDiscoveredAt?: number;
              version?: string;
            }>;
          }
        | undefined;
      expect(probe).toHaveBeenCalledTimes(1);
      expect(
        discoveredOnly?.entries?.find((entry) => entry.registryId === "gemini"),
      ).toMatchObject({
        version: "0.43.0",
        runtime: undefined,
        lastDiscoveredAt: undefined,
      });

      // A discovery-only version change invalidates the old runtime cache, so
      // the next ordinary refresh must probe the upgraded CLI.
      await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.({}, { refresh: true, discoveryIntent: "settings-user-action" });
      expect(probe).toHaveBeenCalledTimes(2);

      // A forced refresh arriving immediately after that probe reuses its
      // result. "Discover new" may bypass older capability freshness, but it
      // must not create a rapid-fire sequential launch.
      await handlers
        .get(ACP_AGENTS_LIST_CHANNEL)
        ?.({}, { refresh: true, discoveryIntent: "settings-user-action", force: true });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      disposeAppState();
    }
    // See the override-discovery test above: the app-state import + repeated
    // discovery round-trips need headroom over the 5s default under CI load.
  }, 20_000);

  it("coalesces forced ACP refreshes across overlapping provider scopes", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([
      {
        backendId: "acp:gemini",
        registryId: "gemini",
        name: "Gemini CLI",
        version: "0.42.0",
        distributionKind: "local",
        distributionSource: "gemini --acp --skip-trust",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-gemini-cli",
        installedAt: 1234,
        updatedAt: 1234,
        launchDescriptor: {
          backendId: "acp:gemini",
          registryId: "gemini",
          distributionKind: "local",
          command: "gemini",
          args: ["--acp", "--skip-trust"],
          env: {},
        },
      },
    ]);
    const probedAt = Date.now();
    acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities.mockResolvedValue({
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        discoveredAt: probedAt,
        checkedAt: probedAt,
        source: "session-new",
        configOptions: [],
      },
    });
    const { initializeAppState, disposeAppState } = await import(
      "../state/app-state"
    );
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENTS_LIST_CHANNEL } = await import("../../shared/ipc");
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });

    initializeAppState();
    try {
      registerSettingsIpcHandlers(service);
      const probe = acpRuntimeDiscoveryMock.discoverAcpRuntimeCapabilities;
      const handler = handlers.get(ACP_AGENTS_LIST_CHANNEL);

      let releaseProbe: (() => void) | undefined;
      probe.mockImplementationOnce(
        async () => await new Promise((resolve) => {
          releaseProbe = () => resolve({});
        }),
      );

      // Force bypasses an old cache, but a forced caller that arrives while
      // the same ordinary probe is active must ride that pass instead of
      // launching the same runtime in parallel.
      const regular = handler?.({}, { refresh: true, discoveryIntent: "settings-user-action" });
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      const forcedFollower = handler?.({}, { refresh: true, discoveryIntent: "settings-user-action", force: true });
      const regularFollower = handler?.({}, { refresh: true, discoveryIntent: "settings-user-action" });
      const targetedForced = handler?.(
        {},
        { refresh: true, discoveryIntent: "settings-user-action", force: true, registryIds: ["gemini"] },
      );
      releaseProbe?.();
      await Promise.all([
        regular,
        forcedFollower,
        regularFollower,
        targetedForced,
      ]);
      expect(probe).toHaveBeenCalledTimes(1);

      // A late duplicate that arrives just after the shared pass completed
      // reuses that same result instead of starting a sequential second probe.
      await handler?.({}, { refresh: true, discoveryIntent: "settings-user-action", force: true });
      expect(probe).toHaveBeenCalledTimes(1);

      // The reverse ordering also coordinates the actual per-provider probe:
      // an all-provider pass may still discover the remaining providers, but
      // it must not launch Gemini again while targeted login is in flight.
      probe.mockImplementationOnce(
        async () => await new Promise((resolve) => {
          releaseProbe = () => resolve({});
        }),
      );
      const targetedFirst = handler?.(
        {},
        { refresh: true, discoveryIntent: "settings-user-action", force: true, registryIds: ["gemini"] },
      );
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
      localAcpDiscoveryMock.discoverLocalAcpAgentRecords.mockResolvedValue([]);
      const allProvidersSecond = handler?.({}, { refresh: true, discoveryIntent: "settings-user-action", force: true });
      releaseProbe?.();
      await Promise.all([targetedFirst, allProvidersSecond]);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(
        localAcpDiscoveryMock.discoverLocalAcpAgentRecords,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabledRegistryIds: ["grok", "kimi", "qwen"],
        }),
      );
    } finally {
      disposeAppState();
    }
  });

  it("persists a version-keyed Grok update acknowledgement", async () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-settings-ipc-"),
    );
    tempRoots.push(tempRoot);
    vi.stubEnv("PWRAGENT_HOME", tempRoot);
    const { initializeAppState, disposeAppState, getAppStateDb } = await import(
      "../state/app-state"
    );
    const { AcpAgentStore } = await import("../acp/acp-agent-store");
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const { ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL } = await import(
      "../../shared/ipc"
    );
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    initializeAppState();
    try {
      const store = new AcpAgentStore(getAppStateDb());
      store.upsertInstalledAgent({
        backendId: "acp:grok",
        registryId: "grok",
        name: "Grok",
        version: "0.2.118",
        distributionKind: "local",
        distributionSource: "grok agent stdio",
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        allowlistRuleId: "local-grok-cli",
        installedAt: 100,
        updatedAt: 100,
        update: {
          status: "available",
          checkedAt: 200,
          currentVersion: "0.2.118",
          latestVersion: "1.0.0",
        },
      });
      registerSettingsIpcHandlers(service);

      await expect(handlers.get(ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL)?.(
        {},
        {
          action: "dismiss",
          backendId: "acp:grok",
          latestVersion: "0.2.119",
        },
      )).resolves.toEqual({ applied: false });
      const response = await handlers.get(
        ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL,
      )?.(
        {},
        {
          action: "snooze",
          backendId: "acp:grok",
          latestVersion: "1.0.0",
        },
      ) as { applied: boolean; update: { snoozedUntil?: number } };

      expect(response.applied).toBe(true);
      expect(response.update.snoozedUntil).toBeGreaterThan(Date.now());
      expect(
        store.getInstalledAgent("acp:grok")?.update?.snoozedUntil,
      ).toBe(response.update.snoozedUntil);
    } finally {
      disposeAppState();
    }
  });

  // The wizard PR (#491) calls this IPC the moment the operator picks
  // a Codex profile model. The handler must (1) persist the wizard
  // signal idempotently, (2) fire the same thread-list prefetch the
  // startup path would have done, and (3) honor `connect: false` for
  // the skip path.
  describe("completeOnboardingCodexBootstrap", () => {
    async function setupOnboardingHandler(initialConfig?: string): Promise<{
      configPath: string;
      onConfigPatchWritten: ReturnType<typeof vi.fn>;
    }> {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "pwragent-onboarding-ipc-"),
      );
      tempRoots.push(tempRoot);
      const configPath = path.join(tempRoot, "config.toml");
      if (initialConfig !== undefined) {
        fs.writeFileSync(configPath, initialConfig, "utf8");
      }
      const service = new DesktopSettingsService({
        configPath,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });
      const onConfigPatchWritten = vi.fn(async () => undefined);
      const { registerSettingsIpcHandlers } = await import("../ipc/settings");
      registerSettingsIpcHandlers(service, { onConfigPatchWritten });
      return { configPath, onConfigPatchWritten };
    }

    it("persists the wizard signal and fires the thread-list prefetch", async () => {
      const { configPath, onConfigPatchWritten } =
        await setupOnboardingHandler(
          ["[onboarding]", "completed = false", ""].join("\n"),
        );
      const { ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL } = await import(
        "../../shared/ipc"
      );

      const response = (await handlers.get(
        ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
      )?.({})) as { connectInitiated: boolean };

      const onDisk = fs.readFileSync(configPath, "utf8");
      expect(onDisk).toContain("completed = true");
      expect(onDisk).toContain('completed_source = "wizard"');
      // Fire-and-forget prefetch; flush the microtask queue so the
      // promise chain inside the handler has a chance to schedule it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(listThreadsMock).toHaveBeenCalledExactlyOnceWith({
        callerReason: "onboarding-bootstrap",
      });
      expect(listBackendsMock).toHaveBeenCalledExactlyOnceWith(
        { includeUnavailable: true, refreshModels: true },
        expect.objectContaining({ intent: "setup-user-action" }),
      );
      expect(response.connectInitiated).toBe(true);
      expect(onConfigPatchWritten).toHaveBeenCalledTimes(1);
    });

    it("skips the prefetch when connect = false (skip path)", async () => {
      const { configPath } = await setupOnboardingHandler(
        ["[onboarding]", "completed = false", ""].join("\n"),
      );
      const { ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL } = await import(
        "../../shared/ipc"
      );

      const response = (await handlers.get(
        ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
      )?.({}, { connect: false })) as { connectInitiated: boolean };

      expect(fs.readFileSync(configPath, "utf8")).toContain("completed = true");
      await new Promise((resolve) => setImmediate(resolve));
      expect(listBackendsMock).not.toHaveBeenCalled();
      expect(listThreadsMock).not.toHaveBeenCalled();
      expect(response.connectInitiated).toBe(false);
    });

    it("is idempotent — calling twice does not double-write or double-prefetch on a no-op", async () => {
      // Already-completed config: the patch writer detects the no-op
      // and skips disk I/O entirely, but the handler still fires the
      // prefetch (the wizard might be re-triggering bootstrap because
      // the renderer lost its prior state).
      const { configPath } = await setupOnboardingHandler(
        [
          "[onboarding]",
          "completed = true",
          'completed_source = "wizard"',
          "",
        ].join("\n"),
      );
      const { ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL } = await import(
        "../../shared/ipc"
      );
      const originalBytes = fs.readFileSync(configPath, "utf8");

      await handlers.get(ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL)?.({});
      await handlers.get(ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL)?.({});

      expect(fs.readFileSync(configPath, "utf8")).toBe(originalBytes);
      await new Promise((resolve) => setImmediate(resolve));
      expect(listThreadsMock).toHaveBeenCalledTimes(2);
      expect(listBackendsMock).toHaveBeenCalledTimes(2);
    });
  });
});
