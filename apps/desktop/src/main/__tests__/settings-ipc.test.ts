import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const tempRoots: string[] = [];
const disposeDesktopBackendRegistryMock = vi.fn(async () => undefined);
const listThreadsMock = vi.fn(async () => [] as unknown[]);
const getDesktopBackendRegistryMock = vi.fn(() => ({
  listThreads: listThreadsMock,
}));
const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
const localAcpDiscoveryMock = vi.hoisted(() => ({
  discoverLocalAcpAgents: vi.fn(async () => [] as unknown[]),
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

function createMockSpawnChild(
  schedule: (child: EventEmitter & {
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  }) => void,
): EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
} {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  };
  child.pid = 321;
  child.kill = vi.fn();
  child.stdout = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  child.stderr = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();
  schedule(child);
  return child;
}

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
  shell: {
    openExternal: electronMocks.openExternal,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: childProcessMocks.execFile,
  spawn: childProcessMocks.spawn,
}));

vi.mock("../acp/acp-local-discovery", () => localAcpDiscoveryMock);
vi.mock("../acp/acp-runtime-discovery", () => acpRuntimeDiscoveryMock);

vi.mock("../app-server/backend-registry", () => ({
  disposeDesktopBackendRegistry: disposeDesktopBackendRegistryMock,
  getDesktopBackendRegistry: getDesktopBackendRegistryMock,
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
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    handlers.clear();
    disposeDesktopBackendRegistryMock.mockClear();
    listThreadsMock.mockClear();
    listThreadsMock.mockResolvedValue([]);
    getDesktopBackendRegistryMock.mockClear();
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
    childProcessMocks.spawn.mockReset();
    localAcpDiscoveryMock.discoverLocalAcpAgents.mockReset();
    localAcpDiscoveryMock.discoverLocalAcpAgents.mockResolvedValue([]);
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

  it("starts named Codex auth profile login with the browser OAuth flow", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-ipc-"));
    tempRoots.push(tempRoot);
    const codexHome = path.join(tempRoot, "codex");
    vi.stubEnv("CODEX_HOME", codexHome);
    const service = {
      readSettings: vi.fn(async () => ({
        models: {
          codex: {
            discovery: {
              selectedCommand: "/Applications/Codex.app/Contents/Resources/codex",
            },
          },
        },
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
      readSettings: vi.fn(async () => ({
        models: {
          codex: {
            discovery: {
              selectedCommand: "/Applications/Codex.app/Contents/Resources/codex",
            },
          },
        },
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
      readSettings: vi.fn(async () => ({
        models: {
          codex: {
            discovery: {
              selectedCommand: "/Applications/Codex.app/Contents/Resources/codex",
            },
          },
        },
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
    localAcpDiscoveryMock.discoverLocalAcpAgents.mockResolvedValue([
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

    initializeAppState();
    try {
      registerSettingsIpcHandlers(service);
      await expect(
        handlers.get(ACP_AGENTS_LIST_CHANNEL)?.({}, { refresh: false }),
      ).resolves.toMatchObject({
        entries: [],
      });
      const refreshed = (await handlers.get(ACP_AGENTS_LIST_CHANNEL)?.(
        {},
        { refresh: true },
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
          cwd: expect.stringContaining("acp-discovery-workspace"),
        }),
      );
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
    });
  });
});
