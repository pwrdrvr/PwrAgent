import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const tempRoots: string[] = [];
const disposeDesktopBackendRegistryMock = vi.fn(async () => undefined);
const providerMocks = vi.hoisted(() => ({
  resolveTelegramContact: vi.fn(),
  resolveDiscordContact: vi.fn(),
  resolveMattermostContact: vi.fn(),
}));
const runtimeMock = vi.hoisted(() => ({
  applyConfig: vi.fn(async () => undefined),
  isEnabled: vi.fn(() => false),
  requestCredentialValidation: vi.fn(),
}));
const messagingConfigMocks = vi.hoisted(() => ({
  loadDesktopMessagingConfigFromSettings: vi.fn(),
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

vi.mock("@pwragent/messaging-provider-telegram", () => ({
  resolveContact: providerMocks.resolveTelegramContact,
}));

vi.mock("@pwragent/messaging-provider-discord", () => ({
  resolveContact: providerMocks.resolveDiscordContact,
}));

vi.mock("@pwragent/messaging-provider-mattermost", () => ({
  resolveContact: providerMocks.resolveMattermostContact,
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
    messagingConfigMocks.loadDesktopMessagingConfigFromSettings.mockClear();
    runtimeMock.applyConfig.mockClear();
    runtimeMock.isEnabled.mockClear();
    runtimeMock.requestCredentialValidation.mockReset();
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
            chatReplyComposer: "custom-widget-chips",
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
    expect(encoded).toContain("custom-widget-chips");
    expect(encoded).not.toContain("123456789:secret-token");
    expect(encoded).not.toContain("discord-secret");

    disposeSettingsIpcHandlers();
    expect(handlers.has(SETTINGS_READ_CHANNEL)).toBe(false);
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
  });
});
