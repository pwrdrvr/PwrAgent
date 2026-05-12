import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const tempRoots: string[] = [];
const disposeDesktopBackendRegistryMock = vi.fn(async () => undefined);
const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));
const providerMocks = vi.hoisted(() => ({
  resolveTelegramContact: vi.fn(),
  resolveDiscordContact: vi.fn(),
  resolveMattermostContact: vi.fn(),
  resolveSlackContact: vi.fn(),
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
  })),
}));

vi.mock("electron", () => ({
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
}));

vi.mock("node:child_process", () => ({
  execFile: childProcessMocks.execFile,
}));

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: disposeDesktopBackendRegistryMock,
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
}));

vi.mock("@pwragent/messaging-provider-mattermost", () => ({
  resolveContact: providerMocks.resolveMattermostContact,
}));

vi.mock("@pwragent/messaging-provider-slack", () => ({
  resolveContact: providerMocks.resolveSlackContact,
}));

describe("settings ipc", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    handlers.clear();
    disposeDesktopBackendRegistryMock.mockClear();
    providerMocks.resolveTelegramContact.mockReset();
    providerMocks.resolveDiscordContact.mockReset();
    providerMocks.resolveMattermostContact.mockReset();
    providerMocks.resolveSlackContact.mockReset();
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings.mockClear();
    leaseCoordinatorMock.applyLatestConfig.mockClear();
    leaseCoordinatorMock.snapshot.mockClear();
    runtimeMock.applyConfig.mockClear();
    runtimeMock.getPlatformCredentialMetadata.mockReset();
    runtimeMock.isEnabled.mockClear();
    runtimeMock.requestCredentialValidation.mockReset();
    childProcessMocks.execFile.mockReset();
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
      SETTINGS_READ_CHANNEL,
      SETTINGS_REPLACE_SECRET_CHANNEL,
      SETTINGS_WRITE_CONFIG_CHANNEL,
    } = await import("../../shared/ipc");

    registerSettingsIpcHandlers(service);

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

    await handlers.get(SETTINGS_WRITE_CONFIG_CHANNEL)?.(
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
    expect(disposeDesktopBackendRegistryMock).not.toHaveBeenCalled();
    await handlers.get(SETTINGS_REPLACE_SECRET_CHANNEL)?.(
      {},
      {
        secret: "discordBotToken",
        value: "discord-secret",
      },
    );

    const readResponse = await handlers.get(SETTINGS_READ_CHANNEL)?.({});
    const encoded = JSON.stringify(readResponse);
    expect(encoded).toContain("diffCondensation");
    expect(encoded).not.toContain("123456789:secret-token");
    expect(encoded).not.toContain("discord-secret");

    disposeSettingsIpcHandlers();
    expect(handlers.has(SETTINGS_READ_CHANNEL)).toBe(false);
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

  it("disposes backend clients after model settings change", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const service = new DesktopSettingsService({
      configPath: path.join(tempRoot, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 20,
    });
    const { registerSettingsIpcHandlers } = await import("../ipc/settings");
    const {
      SETTINGS_CLEAR_SECRET_CHANNEL,
      SETTINGS_WRITE_CONFIG_CHANNEL,
    } = await import("../../shared/ipc");

    registerSettingsIpcHandlers(service);

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
    await handlers.get(SETTINGS_CLEAR_SECRET_CHANNEL)?.(
      {},
      {
        secret: "grokApiKey",
      },
    );

    expect(disposeDesktopBackendRegistryMock).toHaveBeenCalledTimes(2);
  });

  it("does not run the saved Codex path when discovery rejected it", async () => {
    const service = {
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
});
