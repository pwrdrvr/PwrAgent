import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const tempRoots: string[] = [];
const disposeDesktopBackendRegistryMock = vi.fn(async () => undefined);

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

describe("settings ipc", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    handlers.clear();
    disposeDesktopBackendRegistryMock.mockClear();
  });

  it("registers redacted read and write handlers", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragnt-settings-ipc-"));
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragnt-settings-ipc-"));
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
});
