import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { managedGrokBuildsEnabledForRuntime } from "../settings/desktop-config";
import {
  MemoryDesktopSecretStore,
  type DesktopSecretStore,
} from "../settings/desktop-secret-store";
import { readBootstrapAppearance } from "../settings/appearance-bootstrap";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

// `DesktopSettingsService` builds a real `CodexDiscoveryCoordinator` unless the
// test injects one, and the kit's probe runs `codex --version` against every
// install location on this machine. See the stub for what it reproduces.
vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import(
    "./helpers/codex-discovery-stub"
  );
  return stubbedCodexDiscovery(
    await importOriginal<typeof import("@pwrdrvr/codex-discovery")>(),
  );
});

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-settings-"));
  tempRoots.push(root);
  return root;
}

function existsOrEmpty(filePath: string): boolean {
  return !fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") === "";
}

describe("DesktopSettingsService", () => {
  it("resolves routine runtime settings from narrow store domains", () => {
    const root = createTempRoot();
    const configPath = path.join(root, "missing-config.toml");
    const domains = {
      applications: { gh: { path: "/store/bin/gh" } },
      experimental: {
        codexDefaultModeRequestUserInput: true,
        managedReview: true,
      },
      general: {
        appearance: {
          theme: "system",
          density: "mission-control",
          sidebarTextSize: "md",
          transcriptTextSize: "md",
        },
        settings: {
          confirmQuitWithInProgressThreads: false,
          developerMode: true,
          notificationsEnabled: true,
          pdfAnalysisEnabled: false,
        },
      },
      git: { defaultPrAutoDispatchEnabled: false },
      integratedTerminal: { windowsShell: "pwsh" },
      messaging: {
        feishu: { tenantRegion: "lark" },
        mattermost: { serverUrl: "https://chat.example.com" },
      },
      models: {
        codex: { allowFast: false, path: "/store/bin/codex" },
        providerDefaults: { codex: { model: "gpt-test" } },
        providerThreadMigrations: { codex: { fromModel: "old", toModel: "new" } },
      },
      onboarding: { completed: false, completedSource: "" },
      updates: { channel: "prerelease", train: "beta" },
      worktrees: { storage: "in-repo" },
    };
    const read = vi.fn((domain: keyof typeof domains) => domains[domain]);
    const service = new DesktopSettingsService({
      configPath,
      configStore: { read } as never,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect(service.resolveCodexCommandPreference()).toBe("/store/bin/codex");
    expect(service.resolveCodexFastAllowed()).toBe(false);
    expect(service.resolveConfirmQuitWithInProgressThreads()).toBe(false);
    expect(service.resolveDeveloperMode()).toBe(true);
    expect(service.resolveGhCommandPreference()).toBe("/store/bin/gh");
    expect(service.resolveIntegratedTerminalWindowsShell()).toBe("pwsh");
    expect(service.resolveManagedReviewEnabled()).toBe(true);
    expect(service.resolveMattermostServerUrlSync()).toBe(
      "https://chat.example.com",
    );
    expect(service.resolveNotificationsEnabled()).toBe(true);
    expect(service.resolveOnboardingCompleted()).toBe(false);
    expect(service.resolvePdfAnalysisEnabled()).toBe(false);
    expect(service.resolveUpdateChannel()).toBe("prerelease");
    expect(service.resolveUpdateTrain()).toBe("beta");
    expect(service.resolveWorktreeStorage()).toBe("in-repo");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("runs discovery only for a permitted refresh", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const discover = vi.fn(async () => ({
      candidates: [
        {
          command: "/opt/codex",
          executable: true,
          selected: true,
          source: "config" as const,
          version: "0.126.0",
        },
      ],
      selectedCommand: "/opt/codex",
      selectedSource: "config" as const,
    }));
    const invalidate = vi.fn();
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover,
        invalidate,
        resolve: vi.fn(async () => ({
          command: "/opt/codex",
          source: "config" as const,
          version: "0.126.0",
        })),
      },
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.readSettingsProjection();
    expect(discover).not.toHaveBeenCalled();
    await service.refreshCodexDiscovery(
      issueProviderDiscoveryPermit("settings-user-action"),
    );
    expect(discover).toHaveBeenCalledWith(undefined, {
      allowStaleSuccess: false,
      force: true,
    });

    await service.writeConfigPatchTargeted({
      models: { codex: { path: "/opt/codex" } },
    });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledOnce();
  });

  it("loads TOML values from the desktop config path", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        'chat_reply_composer = "tiptap-chips"',
        "",
        "[general]",
        "confirm_quit_with_in_progress_threads = false",
        "developer_mode = true",
        "notifications_enabled = true",
        "",
        "[messaging]",
        "allow_full_access_thread_resume = false",
        "allow_full_access_escalation = false",
        'full_access_warning = "always"',
        "input_debounce_ms = 750",
        'tool_update_mode = "show_more"',
        "show_streaming_option = true",
        "",
        "[image_uploads]",
        "pasted_image_max_patches = 4096",
        "",
        "[updates]",
        'channel = "prerelease"',
        "",
        "[federation]",
        'mode = "gateway"',
        'listen_host = "127.0.0.1"',
        "listen_port = 47830",
        'public_url = "https://pwragent.example.com"',
        'gateway_url = "https://pwragent.example.com"',
        "cloudflare_mtls_enabled = true",
        "cloudflare_access_service_auth_enabled = true",
        "",
        "[messaging.attachments]",
        'image_profile = "high"',
        "",
        "[messaging.telegram]",
        "enabled = true",
        "streaming_responses = true",
        'authorized_user_ids = ["111111111", "222222222"]',
        "authorized_supergroups = []",
        "",
        "[messaging.discord]",
        "streaming_responses = true",
        'application_id = "123456789012345678"',
        'authorized_guilds = ["guild-one"]',
        "",
        "[models.codex]",
        'path = "codex-beta"',
        'profile = "work"',
        "",
        "[applications.editor]",
        'preferred_id = "vscode"',
        "",
        "[applications.terminal]",
        'preferred_id = "ghostty"',
        "",
        "[applications.gh]",
        'path = "/opt/homebrew/bin/gh"',
      ].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 10,
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.fetchedAt).toBe(10);
    expect(snapshot.experimental.chatReplyComposer).toEqual({
      value: "tiptap-wysiwyg-markdown-chips",
      source: "default",
    });
    expect(snapshot.general.developerMode).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.general.confirmQuitWithInProgressThreads).toEqual({
      value: false,
      source: "config",
    });
    expect(snapshot.general.notificationsEnabled).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.toolUpdateMode).toEqual({
      value: "show_more",
      source: "config",
    });
    expect(snapshot.messaging.managerToolUpdateMode).toEqual({
      value: "show_none",
      source: "default",
    });
    expect(snapshot.messaging.showStreamingOption).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.inputDebounceMs).toEqual({
      value: 750,
      source: "config",
    });
    expect(snapshot.messaging.allowFullAccessThreadResume).toEqual({
      value: false,
      source: "config",
    });
    expect(snapshot.messaging.allowFullAccessEscalation).toEqual({
      value: false,
      source: "config",
    });
    expect(snapshot.messaging.fullAccessWarning).toEqual({
      value: "always",
      source: "config",
    });
    expect(snapshot.imageUploads.pastedImageMaxPatches).toEqual({
      value: 4096,
      source: "config",
    });
    expect(snapshot.updates.channel).toEqual({
      value: "prerelease",
      source: "config",
    });
    expect(snapshot.updates.train).toEqual({
      value: "stable",
      source: "default",
    });
    expect(snapshot.federation).toMatchObject({
      mode: { value: "gateway", source: "config" },
      listenHost: { value: "127.0.0.1", source: "config" },
      listenPort: { value: 47830, source: "config" },
      publicUrl: {
        value: "https://pwragent.example.com",
        source: "config",
      },
      gatewayUrl: {
        value: "https://pwragent.example.com",
        source: "config",
      },
      cloudflareMtlsEnabled: { value: true, source: "config" },
      cloudflareAccessServiceAuthEnabled: { value: true, source: "config" },
      instancePrivateKey: { configured: false, source: "unset", writable: true },
      noiseStaticPrivateKey: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareClientCertificate: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareClientPrivateKey: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareAccessClientId: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareAccessClientSecret: {
        configured: false,
        source: "unset",
        writable: true,
      },
    });
    expect(snapshot.messaging.attachments.imageProfile).toEqual({
      value: "high",
      source: "config",
    });
    expect(snapshot.messaging.telegram.enabled).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.telegram.streamingResponses).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "" },
      { id: "222222222", displayName: "" },
    ]);
    expect(snapshot.messaging.telegram.authorizedSupergroups.value).toEqual([]);
    expect(snapshot.messaging.discord.applicationId.value).toBe(
      "123456789012345678",
    );
    expect(snapshot.messaging.discord.streamingResponses).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.discord.authorizedGuilds.value).toEqual([
      { id: "guild-one", displayName: "" },
    ]);
    expect(snapshot.models.codex.path).toEqual({
      value: "codex-beta",
      source: "config",
    });
    expect(snapshot.models.codex.profile).toEqual({
      value: "work",
      source: "config",
    });
    expect(snapshot.models.codex.profiles.effectiveCodexHome).toMatch(
      /\.codex\/profiles\/work$/,
    );
    expect(snapshot.applications.preferredEditorId).toEqual({
      value: "vscode",
      source: "config",
    });
    expect(snapshot.applications.preferredTerminalId).toEqual({
      value: "ghostty",
      source: "config",
    });
    expect(snapshot.applications.gh.path).toEqual({
      value: "/opt/homebrew/bin/gh",
      source: "config",
    });
    expect(snapshot.worktrees.storage).toEqual({
      value: "user-home",
      source: "default",
    });
    expect(snapshot.worktrees.effectivePath).toMatch(
      /\.pwragent\/worktrees$/,
    );
  });

  it("defaults the update channel from the running app version", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.updates.channel).toEqual({
      value: "latest",
      source: "default",
    });
    expect(initial.updates.train).toEqual({
      value: "stable",
      source: "default",
    });
    expect(service.resolveUpdateChannel()).toBe("latest");
    expect(service.resolveUpdateTrain()).toBe("stable");

    await service.writeConfigPatchTargeted({
      updates: {
        channel: "prerelease",
        train: "beta",
      },
    });

    const afterPrerelease = fs.readFileSync(configPath, "utf8");
    expect(afterPrerelease).toContain("[updates]");
    expect(afterPrerelease).toContain('channel = "prerelease"');
    expect(afterPrerelease).toContain('train = "beta"');
    expect((await service.readSettingsProjection()).updates.channel).toEqual({
      value: "prerelease",
      source: "config",
    });
    expect((await service.readSettingsProjection()).updates.train).toEqual({
      value: "beta",
      source: "config",
    });
    expect(service.resolveUpdateChannel()).toBe("prerelease");
    expect(service.resolveUpdateTrain()).toBe("beta");

    await service.writeConfigPatchTargeted({
      updates: {
        channel: "latest",
        train: "stable",
      },
    });

    const afterDefault = fs.readFileSync(configPath, "utf8");
    expect(afterDefault).toContain('channel = "latest"');
    expect(afterDefault).toContain('train = "stable"');
    expect((await service.readSettingsProjection()).updates.channel).toEqual({
      value: "latest",
      source: "config",
    });
    expect((await service.readSettingsProjection()).updates.train).toEqual({
      value: "stable",
      source: "config",
    });
  });

  it("round-trips the Discord response-mode hierarchy", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        discord: {
          responseMode: "mention_only",
          authorizedGuilds: [
            {
              id: "1480556454498009351",
              displayName: "Test server",
              responseMode: "every_message",
            },
          ],
          responseModeOverrides: [
            {
              id: "1480556454498009352",
              displayName: "release-chat",
              responseMode: "mention_only",
            },
          ],
        },
      },
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.messaging.discord.responseMode).toEqual({
      value: "mention_only",
      source: "config",
    });
    expect(snapshot.messaging.discord.authorizedGuilds.value).toEqual([
      {
        id: "1480556454498009351",
        displayName: "Test server",
        responseMode: "every_message",
      },
    ]);
    expect(snapshot.messaging.discord.responseModeOverrides.value).toEqual([
      {
        id: "1480556454498009352",
        displayName: "release-chat",
        responseMode: "mention_only",
      },
    ]);

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain('response_mode = "mention_only"');
    expect(contents).toContain("[[messaging.discord.authorized_guilds]]");
    expect(contents).toContain("[[messaging.discord.response_mode_overrides]]");
  });

  it("infers Beta Prerelease from an alpha desktop version", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      appVersion: "1.1.0-alpha.7",
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.updates.train).toEqual({
      value: "beta",
      source: "default",
    });
    expect(snapshot.updates.channel).toEqual({
      value: "prerelease",
      source: "default",
    });
    expect(service.resolveUpdateTrain()).toBe("beta");
    expect(service.resolveUpdateChannel()).toBe("prerelease");
  });

  it("keeps a legacy prerelease config on the Stable train", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      ["[updates]", 'channel = "prerelease"', ""].join("\n"),
    );
    const service = new DesktopSettingsService({
      appVersion: "1.1.0-beta.2",
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.updates.channel).toEqual({
      value: "prerelease",
      source: "config",
    });
    expect(snapshot.updates.train).toEqual({
      value: "stable",
      source: "default",
    });
    expect(service.resolveUpdateTrain()).toBe("stable");
    expect(service.resolveUpdateChannel()).toBe("prerelease");
  });

  it("keeps an explicit Stable choice on a Beta binary", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      appVersion: "1.1.0-beta.2",
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect(service.resolveUpdateTrain()).toBe("beta");
    await service.writeConfigPatchTargeted({
      updates: {
        train: "stable",
        channel: "latest",
      },
    });
    expect(service.resolveUpdateTrain()).toBe("stable");
    expect(service.resolveUpdateChannel()).toBe("latest");
    expect(fs.readFileSync(configPath, "utf8")).toContain('train = "stable"');
  });

  it("persists and reuses a federation Noise static keypair", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const secretStore = new MemoryDesktopSecretStore();
    const service = new DesktopSettingsService({ configPath, env: {}, secretStore });
    const beforeCreation = await service.readSettingsProjection();
    expect(beforeCreation.federation.noiseStaticPrivateKey.configured).toBe(false);

    const first = await service.getOrCreateFederationNoiseStaticKeyPair();
    expect(first.privateKeyBase64.length).toBeGreaterThan(0);
    expect(Buffer.from(first.publicKeyBase64, "base64").length).toBe(32);
    const afterCreation = await service.readSettingsProjection();
    expect(afterCreation.federation.noiseStaticPrivateKey.configured).toBe(true);

    // A fresh service over the same secret store reuses the persisted key.
    const reopened = new DesktopSettingsService({ configPath, env: {}, secretStore });
    const second = await reopened.getOrCreateFederationNoiseStaticKeyPair();
    expect(second.privateKeyBase64).toBe(first.privateKeyBase64);
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);

    // Stored under its own secret name, distinct from the Ed25519 identity.
    expect(await secretStore.getSecret("federationNoiseStaticPrivateKey")).toBe(
      first.privateKeyBase64,
    );
    expect(
      await secretStore.getSecret("federationInstancePrivateKey"),
    ).toBeUndefined();
  });

  it("defaults federation settings and exposes stored federation secrets", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const secretStore = new MemoryDesktopSecretStore();
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore,
    });

    const initial = await service.readSettingsProjection();
    expect(initial.federation).toMatchObject({
      mode: { value: "disabled", source: "default" },
      listenHost: { value: "127.0.0.1", source: "default" },
      listenPort: { value: 47830, source: "default" },
      publicUrl: { value: "", source: "default" },
      gatewayUrl: { value: "", source: "default" },
      cloudflareMtlsEnabled: { value: false, source: "default" },
      cloudflareAccessServiceAuthEnabled: {
        value: false,
        source: "default",
      },
      instancePrivateKey: { configured: false, source: "unset", writable: true },
      noiseStaticPrivateKey: {
        configured: false,
        source: "unset",
        writable: true,
      },
    });

    await service.writeConfigPatchTargeted({
      federation: {
        mode: "client",
        gatewayUrl: "https://pwragent.example.com",
      },
    });
    await service.replaceSecret("federationInstancePrivateKey", "private-key");

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.federation).toMatchObject({
      mode: { value: "client", source: "config" },
      gatewayUrl: {
        value: "https://pwragent.example.com",
        source: "config",
      },
      instancePrivateKey: {
        configured: true,
        source: "keychain",
        writable: true,
      },
    });
  });

  it("defaults developer mode from the app packaging mode and persists overrides", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      defaultDeveloperMode: false,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.general.developerMode).toEqual({
      value: false,
      source: "default",
    });
    expect(service.resolveDeveloperMode()).toBe(false);

    await service.writeConfigPatchTargeted({
      general: {
        developerMode: true,
      },
    });

    const saved = fs.readFileSync(configPath, "utf8");
    expect(saved).toContain("[general]");
    expect(saved).toContain("developer_mode = true");
    expect((await service.readSettingsProjection()).general.developerMode).toEqual({
      value: true,
      source: "config",
    });
    expect(service.resolveDeveloperMode()).toBe(true);
  });

  it("defaults PDF analysis on and persists its opt-out", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).general.pdfAnalysisEnabled).toEqual({
      value: true,
      source: "default",
    });
    expect(service.resolvePdfAnalysisEnabled()).toBe(true);

    await service.writeConfigPatchTargeted({
      general: { pdfAnalysisEnabled: false },
    });

    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "pdf_analysis_enabled = false",
    );
    expect((await service.readSettingsProjection()).general.pdfAnalysisEnabled).toEqual({
      value: false,
      source: "config",
    });
    expect(service.resolvePdfAnalysisEnabled()).toBe(false);

    await service.writeConfigPatchTargeted({
      general: { pdfAnalysisEnabled: true },
    });

    expect(fs.readFileSync(configPath, "utf8")).not.toContain("pdf_analysis_enabled");
    expect((await service.readSettingsProjection()).general.pdfAnalysisEnabled).toEqual({
      value: true,
      source: "default",
    });
  });

  it("defaults hot CPU profiling to disabled and persists overrides", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.general.hotCpuProfilingEnabled).toEqual({
      value: false,
      source: "default",
    });
    expect(initial.general.hotCpuProfilingStartDelayMs).toEqual({
      value: 0,
      source: "default",
    });
    expect(initial.general.hotCpuProfilingTriggerMode).toEqual({
      value: "sustained",
      source: "default",
    });
    expect(initial.general.hotCpuProfilingSlowburnThresholdPercent).toEqual({
      value: 15,
      source: "default",
    });
    expect(initial.general.hotCpuProfilingCaptureHeapSnapshot).toEqual({
      value: false,
      source: "default",
    });
    expect(initial.general.hotCpuProfilingHeapSnapshotLimit).toEqual({
      value: 2,
      source: "default",
    });
    expect(service.resolveHotCpuProfilingEnabled()).toBe(false);
    expect(service.resolveHotCpuProfilingStartDelayMs()).toBe(0);
    expect(service.resolveHotCpuProfilingTriggerMode()).toBe("sustained");
    expect(service.resolveHotCpuProfilingSlowburnThresholdPercent()).toBe(15);
    expect(service.resolveHotCpuProfilingCaptureHeapSnapshot()).toBe(false);
    expect(service.resolveHotCpuProfilingHeapSnapshotLimit()).toBe(2);

    await service.writeConfigPatchTargeted({
      general: {
        hotCpuProfilingEnabled: true,
        hotCpuProfilingStartDelayMs: 5000,
        hotCpuProfilingTriggerMode: "slowburn",
        hotCpuProfilingSlowburnThresholdPercent: 20,
        hotCpuProfilingCaptureHeapSnapshot: true,
        hotCpuProfilingHeapSnapshotLimit: 3,
      },
    });

    const saved = fs.readFileSync(configPath, "utf8");
    expect(saved).toContain("[general]");
    expect(saved).toContain("hot_cpu_profiling_enabled = true");
    expect(saved).toContain("hot_cpu_profiling_start_delay_ms = 5000");
    expect(saved).toContain('hot_cpu_profiling_trigger_mode = "slowburn"');
    expect(saved).toContain("hot_cpu_profiling_slowburn_threshold_percent = 20");
    expect(saved).toContain("hot_cpu_profiling_capture_heap_snapshot = true");
    expect(saved).toContain("hot_cpu_profiling_heap_snapshot_limit = 3");
    expect((await service.readSettingsProjection()).general.hotCpuProfilingEnabled).toEqual({
      value: true,
      source: "config",
    });
    expect(
      (await service.readSettingsProjection()).general.hotCpuProfilingStartDelayMs,
    ).toEqual({
      value: 5000,
      source: "config",
    });
    expect(
      (await service.readSettingsProjection()).general.hotCpuProfilingTriggerMode,
    ).toEqual({
      value: "slowburn",
      source: "config",
    });
    expect(
      (await service.readSettingsProjection()).general.hotCpuProfilingSlowburnThresholdPercent,
    ).toEqual({
      value: 20,
      source: "config",
    });
    expect(
      (await service.readSettingsProjection()).general.hotCpuProfilingCaptureHeapSnapshot,
    ).toEqual({
      value: true,
      source: "config",
    });
    expect(
      (await service.readSettingsProjection()).general.hotCpuProfilingHeapSnapshotLimit,
    ).toEqual({
      value: 3,
      source: "config",
    });
    expect(service.resolveHotCpuProfilingEnabled()).toBe(true);
    expect(service.resolveHotCpuProfilingStartDelayMs()).toBe(5000);
    expect(service.resolveHotCpuProfilingTriggerMode()).toBe("slowburn");
    expect(service.resolveHotCpuProfilingSlowburnThresholdPercent()).toBe(20);
    expect(service.resolveHotCpuProfilingCaptureHeapSnapshot()).toBe(true);
    expect(service.resolveHotCpuProfilingHeapSnapshotLimit()).toBe(3);
  });

  it("defaults notifications to disabled and persists overrides", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.general.notificationsEnabled).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      general: {
        notificationsEnabled: true,
      },
    });

    const saved = fs.readFileSync(configPath, "utf8");
    expect(saved).toContain("[general]");
    expect(saved).toContain("notifications_enabled = true");
    expect((await service.readSettingsProjection()).general.notificationsEnabled).toEqual({
      value: true,
      source: "config",
    });
  });

  it("defaults tool-output alert triggers off and persists independent opt-ins", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).general.toolOutputAlerts).toEqual({
      outputCapHitsEnabled: { value: false, source: "default" },
      repeatedLargeOutputsEnabled: { value: false, source: "default" },
      repeatedLargeOutputMinimumCalls: { value: 5, source: "default" },
      repeatedLargeOutputMinimumPercent: { value: 50, source: "default" },
      repeatedQueuedChecksEnabled: { value: false, source: "default" },
    });

    await service.writeConfigPatchTargeted({
      general: {
        toolOutputAlerts: {
          repeatedLargeOutputsEnabled: true,
          repeatedLargeOutputMinimumCalls: 7,
          repeatedLargeOutputMinimumPercent: 65,
        },
      },
    });

    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "repeated_large_outputs_enabled = true",
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "repeated_large_output_minimum_calls = 7",
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "repeated_large_output_minimum_percent = 65",
    );
    expect(service.resolveToolOutputAlertPolicy()).toEqual({
      outputCapHitsEnabled: false,
      repeatedLargeOutputsEnabled: true,
      repeatedLargeOutputMinimumCalls: 7,
      repeatedLargeOutputMinimumPercent: 65,
      repeatedQueuedChecksEnabled: false,
    });
  });

  // Token Miser fails open, so an inert gate looks exactly like a thread with
  // nothing worth gating. The activation record is what lets Settings say the
  // feature is switched on but not actually running.
  it("surfaces a recorded Token Miser activation failure", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const stateDir = path.join(root, "state", "token-miser");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "activation.json"),
      JSON.stringify({
        observedAt: 1_800_000_000_000,
        reason: "marketplace 'pwragent-local' is already added from a different source",
        state: "unavailable",
      }),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.runtime.tokenMiser?.activation).toMatchObject({
      state: "unavailable",
    });
    expect(snapshot.runtime.tokenMiser?.activation?.reason)
      .toContain("already added from a different source");
  });

  it("reports no activation claim when the profile never tried", async () => {
    const root = createTempRoot();
    const service = new DesktopSettingsService({
      configPath: path.join(root, "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).runtime.tokenMiser?.activation)
      .toBeUndefined();
  });

  it("defaults Token Miser unavailable with inherited thread use on", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).experimental.tokenMiserEnabled).toEqual({
      value: false,
      source: "default",
    });
    expect(service.resolveTokenMiserEnabled()).toBe(false);
    expect(
      (await service.readSettingsProjection()).experimental.tokenMiserDefaultEnabled,
    ).toEqual({
      value: true,
      source: "default",
    });
    expect(service.resolveTokenMiserDefaultEnabled()).toBe(true);

    await service.writeConfigPatchTargeted({
      experimental: {
        tokenMiserEnabled: true,
        tokenMiserDefaultEnabled: false,
      },
    });

    expect(fs.readFileSync(configPath, "utf8")).toContain([
      "[experimental]",
      "token_miser_enabled = true",
      "token_miser_default_enabled = false",
    ].join("\n"));
    expect(service.resolveTokenMiserEnabled()).toBe(true);
    expect(service.resolveTokenMiserDefaultEnabled()).toBe(false);
  });

  it("acquires and durably selects managed Codex when Token Miser becomes available", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const discover = vi.fn(async (configuredCommand?: string) => ({
      candidates: configuredCommand
        ? [{
            command: configuredCommand,
            executable: true,
            selected: true,
            source: "config" as const,
            version: "0.200.0-pwragent.1",
          }]
        : [],
      ...(configuredCommand
        ? {
            selectedCommand: configuredCommand,
            selectedSource: "config" as const,
          }
        : {}),
    }));
    const resolve = vi.fn(async () => ({
      command: "/usr/local/bin/codex",
      source: "path" as const,
      version: "0.999.0",
    }));
    const invalidate = vi.fn();
    const ensureManaged = vi.fn(async () => ({
      appServerCommand: "/managed/codex-app-server",
      codeModeHostCommand: "/managed/codex-code-mode-host",
      command: "/managed/codex",
      metadata: {
        asset: "pwragent-codex-0.200.0-pwragent.1-linux-x86_64.tar.gz",
        checkedAt: 1,
        installedAt: 1,
        repository: "pwrdrvr/codex",
        schemaVersion: 1,
        sha256: "a".repeat(64),
        tag: "pwragent-v0.200.0-pwragent.1",
        version: "0.200.0-pwragent.1",
      },
    }));
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: { discover, invalidate, resolve },
      configPath,
      ensureManagedCodexRuntime: ensureManaged,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.readSettingsProjection();
    expect(ensureManaged).not.toHaveBeenCalled();

    await service.writeConfigPatchTargeted(
      { experimental: { tokenMiserEnabled: true } },
      issueProviderDiscoveryPermit("settings-user-action"),
    );

    expect(ensureManaged).toHaveBeenNthCalledWith(1, { checkMode: "force" });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(discover).not.toHaveBeenCalled();
    await expect(service.resolveCodexCommand()).resolves.toEqual({
      command: "/managed/codex",
      source: "config",
      version: "0.200.0-pwragent.1",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "token_miser_enabled = true",
    );
  });

  it("leaves Token Miser off when the first managed Codex install fails", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const invalidate = vi.fn();
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({ candidates: [] })),
        invalidate,
        resolve: vi.fn(async () => {
          throw new Error("not installed");
        }),
      },
      configPath,
      ensureManagedCodexRuntime: vi.fn(async () => {
        throw new Error("No compatible signed Codex release is available.");
      }),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await expect(service.writeConfigPatchTargeted(
      { experimental: { tokenMiserEnabled: true } },
      issueProviderDiscoveryPermit("settings-user-action"),
    )).rejects.toThrow("No compatible signed Codex release");

    expect(service.resolveTokenMiserEnabled()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    expect(existsOrEmpty(configPath)).toBe(true);
  });

  it("keeps Settings readable without falling back when managed Codex is unavailable", async () => {
    const configPath = path.join(createTempRoot(), "config.toml");
    fs.writeFileSync(configPath, [
      "[experimental]",
      "token_miser_enabled = true",
      "",
    ].join("\n"));
    const discover = vi.fn(async () => ({ candidates: [] }));
    const resolve = vi.fn(async () => ({
      command: "/path/codex",
      source: "path" as const,
    }));
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover,
        invalidate: vi.fn(),
        resolve,
      },
      configPath,
      ensureManagedCodexRuntime: vi.fn(async () => {
        throw new Error("Verified managed Codex is temporarily unavailable.");
      }),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await expect(service.readSettingsProjection()).resolves.not.toMatchObject({
      runtime: {
        tokenMiser: {
          managedCodex: {
            state: "unavailable",
            reason: "Verified managed Codex is temporarily unavailable.",
          },
        },
      },
    });
    expect(discover).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    await service.refreshStartupDiscovery(
      issueProviderDiscoveryPermit("startup"),
    );
    await expect(service.readSettingsProjection()).resolves.toMatchObject({
      runtime: {
        tokenMiser: {
          managedCodex: {
            state: "unavailable",
            reason: "Verified managed Codex is temporarily unavailable.",
          },
        },
      },
    });
    await expect(service.resolveCodexCommand()).rejects.toThrow(
      "Refresh Codex in Settings",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns to ordinary Codex discovery without checking managed releases when disabled", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, [
      "[experimental]",
      "token_miser_enabled = true",
      "",
      "[models.codex]",
      'path = "/operator/codex"',
      "",
    ].join("\n"));
    const ensureManaged = vi.fn(async () => ({
      appServerCommand: "/managed/codex-app-server",
      codeModeHostCommand: "/managed/codex-code-mode-host",
      command: "/managed/codex",
      metadata: {
        asset: "pwragent-codex-0.200.0-pwragent.1-linux-x86_64.tar.gz",
        checkedAt: 1,
        installedAt: 1,
        repository: "pwrdrvr/codex",
        schemaVersion: 1,
        sha256: "a".repeat(64),
        tag: "pwragent-v0.200.0-pwragent.1",
        version: "0.200.0-pwragent.1",
      },
    }));
    const discover = vi.fn(async (configuredCommand?: string) => ({
      candidates: configuredCommand
        ? [{
            command: configuredCommand,
            executable: true,
            selected: true,
            source: "config" as const,
          }]
        : [],
      ...(configuredCommand
        ? {
            selectedCommand: configuredCommand,
            selectedSource: "config" as const,
          }
        : {}),
    }));
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover,
        invalidate: vi.fn(),
        resolve: vi.fn(async (command) => ({
          command: command ?? "/path/codex",
          source: command ? "config" as const : "path" as const,
          version: "0.999.0",
        })),
      },
      configPath,
      ensureManagedCodexRuntime: ensureManaged,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.refreshStartupDiscovery(
      issueProviderDiscoveryPermit("startup"),
    );
    await expect(service.resolveCodexCommand()).resolves.toMatchObject({
      command: "/managed/codex",
    });
    ensureManaged.mockClear();

    await service.writeConfigPatchTargeted({
      experimental: { tokenMiserEnabled: false },
    });
    await service.refreshCodexDiscovery(
      issueProviderDiscoveryPermit("settings-user-action"),
    );
    await expect(service.resolveCodexCommand()).resolves.toMatchObject({
      command: "/operator/codex",
    });
    expect(ensureManaged).not.toHaveBeenCalled();
    expect(discover).toHaveBeenLastCalledWith("/operator/codex", {
      allowStaleSuccess: false,
      force: true,
    });
  });

  it("never polls managed Codex from the passive runtime observer", async () => {
    vi.useFakeTimers();
    try {
      const configPath = path.join(createTempRoot(), "config.toml");
      const ensureManaged = vi.fn(async () => ({
        appServerCommand: "/managed/codex-app-server",
        codeModeHostCommand: "/managed/codex-code-mode-host",
        command: "/managed/codex",
        metadata: {
          asset: "pwragent-codex-0.200.0-pwragent.1-linux-x86_64.tar.gz",
          checkedAt: 1,
          installedAt: 1,
          repository: "pwrdrvr/codex",
          schemaVersion: 1 as const,
          sha256: "a".repeat(64),
          tag: "pwragent-v0.200.0-pwragent.1",
          version: "0.200.0-pwragent.1",
        },
      }));
      const service = new DesktopSettingsService({
        codexDiscoveryCoordinator: {
          discover: vi.fn(async () => ({ candidates: [] })),
          invalidate: vi.fn(),
          resolve: vi.fn(async () => ({
            command: "/path/codex",
            source: "path" as const,
          })),
        },
        configPath,
        ensureManagedCodexRuntime: ensureManaged,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });
      const changes = vi.fn();
      const stop = service.watchManagedCodexRuntime(changes, {
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(ensureManaged).not.toHaveBeenCalled();

      await service.writeConfigPatchTargeted(
        { experimental: { tokenMiserEnabled: true } },
        issueProviderDiscoveryPermit("settings-user-action"),
      );
      expect(changes).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        reason: "availability",
      }));
      ensureManaged.mockClear();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(ensureManaged).not.toHaveBeenCalled();

      await service.writeConfigPatchTargeted({
        experimental: { tokenMiserEnabled: false },
      });
      expect(changes).toHaveBeenCalledWith({
        enabled: false,
        reason: "availability",
      });
      ensureManaged.mockClear();

      await vi.advanceTimersByTimeAsync(3_000);
      expect(ensureManaged).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces managed Codex recovery only after an admitted refresh", async () => {
    const configPath = path.join(createTempRoot(), "config.toml");
    fs.writeFileSync(configPath, [
      "[experimental]",
      "token_miser_enabled = true",
      "",
    ].join("\n"));
    const runtime = {
      appServerCommand: "/managed/codex-app-server",
      codeModeHostCommand: "/managed/codex-code-mode-host",
      command: "/managed/codex",
      metadata: {
        asset: "pwragent-codex-0.200.0-pwragent.1-linux-x86_64.tar.gz",
        checkedAt: 1,
        installedAt: 1,
        repository: "pwrdrvr/codex",
        schemaVersion: 1 as const,
        sha256: "a".repeat(64),
        tag: "pwragent-v0.200.0-pwragent.1",
        version: "0.200.0-pwragent.1",
      },
    };
    const ensureManaged = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(runtime);
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({ candidates: [] })),
        invalidate: vi.fn(),
        resolve: vi.fn(async () => ({
          command: "/path/codex",
          source: "path" as const,
        })),
      },
      configPath,
      ensureManagedCodexRuntime: ensureManaged,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });
    const changes = vi.fn();
    const stop = service.watchManagedCodexRuntime(changes);

    await service.refreshStartupDiscovery(
      issueProviderDiscoveryPermit("startup"),
    );
    expect(changes).not.toHaveBeenCalled();
    await service.refreshCodexDiscovery(
      issueProviderDiscoveryPermit("settings-user-action"),
    );

    expect(changes).toHaveBeenCalledWith({
      enabled: true,
      reason: "update",
      runtime,
    });
    stop();
  });

  it("does not announce an unchanged durable managed runtime at startup", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, [
      "[experimental]",
      "token_miser_enabled = true",
      "",
    ].join("\n"));
    const runtime = {
      appServerCommand: "/managed/codex-app-server",
      codeModeHostCommand: "/managed/codex-code-mode-host",
      command: "/managed/codex",
      metadata: {
        asset: "pwragent-codex-0.200.0-pwragent.1-test.tar.gz",
        checkedAt: 1,
        installedAt: 1,
        repository: "pwrdrvr/codex",
        schemaVersion: 1 as const,
        sha256: "a".repeat(64),
        tag: "pwragent-v0.200.0-pwragent.1",
        version: "0.200.0-pwragent.1",
      },
    };
    const configStore = new DesktopConfigStore({ configPath });
    configStore.recordProviderDiscovery("codex", {
      candidates: [{
        command: runtime.command,
        source: "config",
        version: runtime.metadata.version,
      }],
      selectedCommand: runtime.command,
      selectedVersion: runtime.metadata.version,
    });
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({
          candidates: [{
            command: runtime.command,
            executable: true,
            selected: true,
            source: "config" as const,
            version: runtime.metadata.version,
          }],
          selectedCommand: runtime.command,
          selectedSource: "config" as const,
        })),
        invalidate: vi.fn(),
        resolve: vi.fn(async () => ({
          command: runtime.command,
          source: "config" as const,
          version: runtime.metadata.version,
        })),
      },
      configPath,
      configStore,
      ensureManagedCodexRuntime: vi.fn(async () => runtime),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });
    const changes = vi.fn();
    const stop = service.watchManagedCodexRuntime(changes);

    await service.refreshStartupDiscovery(
      issueProviderDiscoveryPermit("startup"),
    );

    expect(changes).not.toHaveBeenCalled();
    await expect(service.resolveCodexCommand()).resolves.toMatchObject({
      command: runtime.command,
    });
    stop();
    configStore.dispose();
  });

  it("does not start a managed Codex update from a passive observer", async () => {
    const configPath = path.join(createTempRoot(), "config.toml");
    fs.writeFileSync(configPath, [
      "[experimental]",
      "token_miser_enabled = true",
      "",
    ].join("\n"));
    const ensureManaged = vi.fn();
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({ candidates: [] })),
        invalidate: vi.fn(),
        resolve: vi.fn(async () => ({
          command: "/path/codex",
          source: "path" as const,
        })),
      },
      configPath,
      ensureManagedCodexRuntime: ensureManaged,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });
    const changes = vi.fn();
    const stop = service.watchManagedCodexRuntime(changes);
    await Promise.resolve();
    expect(ensureManaged).not.toHaveBeenCalled();

    await service.writeConfigPatchTargeted({
      experimental: { tokenMiserEnabled: false },
    });

    expect(ensureManaged).not.toHaveBeenCalled();
    expect(changes).toHaveBeenCalledWith({
      enabled: false,
      reason: "availability",
    });
    expect(changes).not.toHaveBeenCalledWith(expect.objectContaining({
      reason: "update",
    }));
    stop();
  });

  it("waits for an idle managed Codex switch before returning the enabled snapshot", async () => {
    const configPath = path.join(createTempRoot(), "config.toml");
    const managedRuntime = {
      appServerCommand: "/managed/codex-app-server",
      codeModeHostCommand: "/managed/codex-code-mode-host",
      command: "/managed/codex",
      metadata: {
        asset: "pwragent-codex-0.200.0-pwragent.1-linux-x86_64.tar.gz",
        checkedAt: 1,
        installedAt: 1,
        repository: "pwrdrvr/codex",
        schemaVersion: 1 as const,
        sha256: "a".repeat(64),
        tag: "pwragent-v0.200.0-pwragent.1",
        version: "0.200.0-pwragent.1",
      },
    };
    const onManagedCodexRuntimeSwitchComplete = vi.fn();
    const service = new DesktopSettingsService({
      codexDiscoveryCoordinator: {
        discover: vi.fn(async () => ({ candidates: [] })),
        invalidate: vi.fn(),
        resolve: vi.fn(async () => ({
          command: "/path/codex",
          source: "path" as const,
        })),
      },
      configPath,
      ensureManagedCodexRuntime: vi.fn(async () => managedRuntime),
      env: {},
      onManagedCodexRuntimeSwitchComplete,
      secretStore: new MemoryDesktopSecretStore(),
    });
    let finishSwitch: (() => void) | undefined;
    const selectionChanged = vi.fn(() => new Promise<void>((resolve) => {
      finishSwitch = resolve;
    }));
    const stop = service.watchManagedCodexRuntime(selectionChanged);

    let writeSettled = false;
    const write = service.writeConfigPatchTargeted(
      { experimental: { tokenMiserEnabled: true } },
      issueProviderDiscoveryPermit("settings-user-action"),
    ).then(async () => {
      writeSettled = true;
      return await service.readSettingsProjection();
    });
    await vi.waitFor(() => expect(selectionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, reason: "availability" }),
    ));
    expect(writeSettled).toBe(false);

    service.markManagedCodexRuntimeSwitchComplete();
    expect(onManagedCodexRuntimeSwitchComplete).toHaveBeenCalledOnce();
    finishSwitch?.();
    await expect(write).resolves.toMatchObject({
      runtime: {
        tokenMiser: {
          managedCodex: {
            state: "ready",
            version: "0.200.0-pwragent.1",
          },
        },
      },
    });
    stop();
  });

  it("does not install or announce updates from an ordinary settings read", async () => {
    vi.useFakeTimers();
    try {
      const configPath = path.join(createTempRoot(), "config.toml");
      fs.writeFileSync(configPath, [
        "[experimental]",
        "token_miser_enabled = true",
        "",
      ].join("\n"));
      const runtime = (version: string) => ({
        appServerCommand: `/managed/${version}/codex-app-server`,
        codeModeHostCommand: `/managed/${version}/codex-code-mode-host`,
        command: `/managed/${version}/codex`,
        metadata: {
          asset: `pwragent-codex-${version}-linux-x86_64.tar.gz`,
          checkedAt: 1,
          installedAt: 1,
          repository: "pwrdrvr/codex",
          schemaVersion: 1 as const,
          sha256: "a".repeat(64),
          tag: `pwragent-v${version}`,
          version,
        },
      });
      let selectedRuntime = runtime("0.200.0-pwragent.1");
      const ensureManaged = vi.fn(async () => selectedRuntime);
      const service = new DesktopSettingsService({
        codexDiscoveryCoordinator: {
          discover: vi.fn(async () => ({ candidates: [] })),
          invalidate: vi.fn(),
          resolve: vi.fn(async () => ({
            command: "/path/codex",
            source: "path" as const,
          })),
        },
        configPath,
        ensureManagedCodexRuntime: ensureManaged,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });
      const changes = vi.fn();
      await service.refreshStartupDiscovery(
        issueProviderDiscoveryPermit("startup"),
      );
      ensureManaged.mockClear();
      const stop = service.watchManagedCodexRuntime(changes, {
        intervalMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(changes).not.toHaveBeenCalled();

      selectedRuntime = runtime("0.201.0-pwragent.1");
      await service.readSettingsProjection();
      changes.mockClear();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(ensureManaged).not.toHaveBeenCalled();
      expect(changes).not.toHaveBeenCalled();
      await expect(service.readSettingsProjection()).resolves.toMatchObject({
        runtime: {
          tokenMiser: {
            managedCodex: {
              state: "pending-switch",
              version: "0.200.0-pwragent.1",
            },
          },
        },
      });
      service.markManagedCodexRuntimeSwitchComplete();
      await expect(service.readSettingsProjection()).resolves.toMatchObject({
        runtime: {
          tokenMiser: {
            managedCodex: { state: "ready" },
          },
        },
      });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads and lazily mirrors the legacy general Token Miser opt-in", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, [
      "[general]",
      "token_miser_enabled = true",
      "untouched = \"keep\"",
    ].join("\n"));
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).experimental.tokenMiserEnabled).toEqual({
      value: true,
      source: "config",
    });

    await service.writeConfigPatchTargeted({
      experimental: { tokenMiserEnabled: false },
    });

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain(
      "# pwragent-legacy-settings key=token_miser_enabled shape=boolean used_through=1.1.0-alpha.1 kept_for_older_clients\ntoken_miser_enabled = false",
    );
    expect(contents).toContain("[experimental]\ntoken_miser_enabled = false");
    expect(contents).toContain("untouched = \"keep\"");
  });

  it("persists bounded active-turn and thread spend alerts", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).general.spendAlerts).toEqual({
      activeTurnSpendEnabled: { value: false, source: "default" },
      activeTurnSpendThresholdUsd: { value: 5, source: "default" },
      threadSpendEnabled: { value: true, source: "default" },
      threadSpendThresholdUsd: { value: 25, source: "default" },
    });

    await service.writeConfigPatchTargeted({
      general: {
        spendAlerts: {
          activeTurnSpendEnabled: false,
          activeTurnSpendThresholdUsd: 7.499,
          threadSpendThresholdUsd: 40,
        },
      },
    });

    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "active_turn_spend_threshold_usd = 7.499",
    );
    expect(service.resolveSpendAlertPolicy()).toEqual({
      activeTurnSpendEnabled: false,
      activeTurnSpendThresholdUsd: 7.5,
      threadSpendEnabled: true,
      threadSpendThresholdUsd: 40,
    });
  });

  it("defaults quit confirmation to enabled and persists overrides", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.general.confirmQuitWithInProgressThreads).toEqual({
      value: true,
      source: "default",
    });
    expect(service.resolveConfirmQuitWithInProgressThreads()).toBe(true);

    await service.writeConfigPatchTargeted({
      general: {
        confirmQuitWithInProgressThreads: false,
      },
    });

    const saved = fs.readFileSync(configPath, "utf8");
    expect(saved).toContain("[general]");
    expect(saved).toContain("confirm_quit_with_in_progress_threads = false");
    expect(
      (await service.readSettingsProjection()).general.confirmQuitWithInProgressThreads,
    ).toEqual({
      value: false,
      source: "config",
    });
    expect(service.resolveConfirmQuitWithInProgressThreads()).toBe(false);
  });

  it("defaults the Attention end-of-turn promotion on and persists overrides", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.general.attentionPromoteOnTurnEnd).toEqual({
      value: true,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      general: {
        attentionPromoteOnTurnEnd: false,
      },
    });

    const saved = fs.readFileSync(configPath, "utf8");
    expect(saved).toContain("[general]");
    expect(saved).toContain("attention_promote_on_turn_end = false");
    expect(
      (await service.readSettingsProjection()).general.attentionPromoteOnTurnEnd,
    ).toEqual({
      value: false,
      source: "config",
    });
  });

  it("round-trips appearance through writeConfigPatch + readSettings + readBootstrapAppearance", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    // Fresh config: defaults everywhere. The bootstrap path (which the
    // BrowserWindow uses pre-mount) must agree with the service path
    // (which the renderer reads later via IPC) — they read the same
    // TOML, so any divergence here is a contract bug.
    const initialSettings = await service.readSettingsProjection();
    expect(initialSettings.general.appearance.theme).toEqual({
      value: "system",
      source: "default",
    });
    expect(initialSettings.general.appearance.density).toEqual({
      value: "mission-control",
      source: "default",
    });
    expect(readBootstrapAppearance(configPath)).toEqual({
      theme: "system",
      density: "mission-control",
      sidebarTextSize: "md",
      transcriptTextSize: "md",
    });

    // Write non-default values. The byte-preserving patch path should
    // create `[general.appearance]` with all three keys.
    await service.writeConfigPatchTargeted({
      general: {
        appearance: {
          theme: "light",
          density: "compact",
          sidebarTextSize: "lg",
        },
      },
    });

    const writtenFile = fs.readFileSync(configPath, "utf8");
    expect(writtenFile).toContain("[general.appearance]");
    expect(writtenFile).toContain('theme = "light"');
    expect(writtenFile).toContain('density = "compact"');
    expect(writtenFile).toContain('sidebar_text_size = "lg"');

    const afterWrite = await service.readSettingsProjection();
    expect(afterWrite.general.appearance.theme).toEqual({
      value: "light",
      source: "config",
    });
    expect(afterWrite.general.appearance.density).toEqual({
      value: "compact",
      source: "config",
    });
    expect(afterWrite.general.appearance.sidebarTextSize).toEqual({
      value: "lg",
      source: "config",
    });
    expect(readBootstrapAppearance(configPath)).toEqual({
      theme: "light",
      density: "compact",
      sidebarTextSize: "lg",
      transcriptTextSize: "md",
    });

    // Restore to defaults: the patch path should DELETE the keys
    // (defaults aren't written to disk) so the file stays minimal.
    await service.writeConfigPatchTargeted({
      general: {
        appearance: {
          theme: "system",
          density: "mission-control",
          sidebarTextSize: "md",
        },
      },
    });

    const restoredFile = fs.readFileSync(configPath, "utf8");
    expect(restoredFile).not.toContain('theme = "');
    expect(restoredFile).not.toContain('density = "');
    expect(restoredFile).not.toContain('sidebar_text_size = "');

    const afterRestore = await service.readSettingsProjection();
    expect(afterRestore.general.appearance.theme.source).toBe("default");
    expect(afterRestore.general.appearance.density.source).toBe("default");
    expect(afterRestore.general.appearance.sidebarTextSize.source).toBe(
      "default",
    );
    expect(readBootstrapAppearance(configPath)).toEqual({
      theme: "system",
      density: "mission-control",
      sidebarTextSize: "md",
      transcriptTextSize: "md",
    });
  });

  it("fires onAppearanceChange only when writeConfigPatch touches general.appearance", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const onAppearanceChange = vi.fn();
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      onAppearanceChange,
    });

    // Patches that don't touch appearance must NOT fire the broadcast.
    // The production wiring routes this to all-window IPC fan-out, so
    // every unrelated settings save (update channel, image patches,
    // messaging) would needlessly churn every aux window if we fired
    // on every write.
    await service.writeConfigPatchTargeted({ updates: { channel: "prerelease" } });
    expect(onAppearanceChange).not.toHaveBeenCalled();

    // Patch that explicitly sets non-default appearance values fires
    // with the resolved post-write values.
    await service.writeConfigPatchTargeted({
      general: {
        appearance: {
          theme: "light",
          density: "compact",
        },
      },
    });
    expect(onAppearanceChange).toHaveBeenCalledTimes(1);
    expect(onAppearanceChange).toHaveBeenLastCalledWith({
      theme: "light",
      density: "compact",
      sidebarTextSize: "md",
      transcriptTextSize: "md",
    });

    // Patch that restores defaults still fires (the renderer needs to
    // know to drop the data-* attributes back to bare-:root values).
    // The byte-preserving patch path deletes the keys from disk; the
    // broadcast payload resolves through the same fallback the read
    // path uses, so subscribers see the defaults.
    await service.writeConfigPatchTargeted({
      general: {
        appearance: {
          theme: "system",
          density: "mission-control",
        },
      },
    });
    expect(onAppearanceChange).toHaveBeenCalledTimes(2);
    expect(onAppearanceChange).toHaveBeenLastCalledWith({
      theme: "system",
      density: "mission-control",
      sidebarTextSize: "md",
      transcriptTextSize: "md",
    });

    // Patch with `general` but only developerMode (not appearance) must
    // NOT fire — the guard is "did this patch touch the appearance
    // sub-block", not "did it touch the general block".
    await service.writeConfigPatchTargeted({
      general: { developerMode: true },
    });
    expect(onAppearanceChange).toHaveBeenCalledTimes(2);

    // Patch with `general.appearance` but only one field set still fires
    // — the broadcast carries the FULL resolved appearance so subscribers
    // get the complete post-write state.
    await service.writeConfigPatchTargeted({
      general: {
        appearance: { theme: "dark" },
      },
    });
    expect(onAppearanceChange).toHaveBeenCalledTimes(3);
    expect(onAppearanceChange).toHaveBeenLastCalledWith({
      theme: "dark",
      density: "mission-control",
      sidebarTextSize: "md",
      transcriptTextSize: "md",
    });
  });

  it("notifies onConfigWritten subscribers after every successful write", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const listener = vi.fn();
    const unsubscribe = service.onConfigWritten(listener);

    // Fires for the Git setting the background poller cares about — this is
    // what makes the toggle take effect without a restart.
    await service.writeConfigPatchTargeted({
      git: { backgroundPrPolling: true },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    // The listener runs AFTER the write lands, so a re-read sees the new value.
    expect(
      (await service.readSettingsProjection()).git.backgroundPrPolling.value,
    ).toBe(true);

    // Generic: fires for unrelated writes too (cheap; the poller just re-reads).
    await service.writeConfigPatchTargeted({ updates: { channel: "prerelease" } });
    expect(listener).toHaveBeenCalledTimes(2);

    // Unsubscribe stops delivery.
    unsubscribe();
    await service.writeConfigPatchTargeted({
      git: { backgroundPrPolling: false },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps writes alive when an onConfigWritten listener throws", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    service.onConfigWritten(() => {
      throw new Error("listener boom");
    });

    // A throwing side-effect listener must not fail the settings write.
    await expect(
      service.writeConfigPatchTargeted({ git: { backgroundPrPolling: true } }),
    ).resolves.toBeDefined();
    expect(
      (await service.readSettingsProjection()).git.backgroundPrPolling.value,
    ).toBe(true);
  });

  it("defaults attachment profiles and only persists non-default values", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.messaging.attachments.imageProfile).toEqual({
      value: "medium",
      source: "default",
    });
    expect(initial.messaging.attachments.pdfProfile).toEqual({
      value: "high",
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        attachments: { imageProfile: "actual" },
      },
    });

    const afterActual = fs.readFileSync(configPath, "utf8");
    expect(afterActual).toContain("[messaging.attachments]");
    expect(afterActual).toContain('image_profile = "actual"');
    expect((await service.readSettingsProjection()).messaging.attachments.imageProfile).toEqual({
      value: "actual",
      source: "config",
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        attachments: { imageProfile: "medium" },
      },
    });

    const afterDefault = fs.readFileSync(configPath, "utf8");
    expect(afterDefault).not.toContain("image_profile");
    expect((await service.readSettingsProjection()).messaging.attachments.imageProfile).toEqual({
      value: "medium",
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        attachments: { pdfProfile: "actual" },
      },
    });

    const afterPdfActual = fs.readFileSync(configPath, "utf8");
    expect(afterPdfActual).toContain('pdf_profile = "actual"');
    expect((await service.readSettingsProjection()).messaging.attachments.pdfProfile).toEqual({
      value: "actual",
      source: "config",
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        attachments: { pdfProfile: "high" },
      },
    });

    const afterPdfDefault = fs.readFileSync(configPath, "utf8");
    expect(afterPdfDefault).not.toContain("pdf_profile");
    expect((await service.readSettingsProjection()).messaging.attachments.pdfProfile).toEqual({
      value: "high",
      source: "default",
    });
  });

  it("defaults the pasted image patch budget and only persists non-default values", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.imageUploads.pastedImageMaxPatches).toEqual({
      value: 1536,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      imageUploads: {
        pastedImageMaxPatches: 1024,
      },
    });

    const afterCompact = fs.readFileSync(configPath, "utf8");
    expect(afterCompact).toContain("[image_uploads]");
    expect(afterCompact).toContain("pasted_image_max_patches = 1024");
    expect((await service.readSettingsProjection()).imageUploads.pastedImageMaxPatches).toEqual({
      value: 1024,
      source: "config",
    });

    await service.writeConfigPatchTargeted({
      imageUploads: {
        pastedImageMaxPatches: 1536,
      },
    });

    const afterDefault = fs.readFileSync(configPath, "utf8");
    expect(afterDefault).not.toContain("pasted_image_max_patches");
    expect((await service.readSettingsProjection()).imageUploads.pastedImageMaxPatches).toEqual({
      value: 1536,
      source: "default",
    });
  });

  it("marks legacy chat reply composer config when another setting is saved", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        'chat_reply_composer = "custom-widget-chips"',
        "",
        "[messaging]",
        'tool_update_mode = "show_some"',
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        toolUpdateMode: "show_all",
        managerToolUpdateMode: "show_more",
        showStreamingOption: true,
      },
    });

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain(
      "# pwragent-legacy-settings key=chat_reply_composer shape=string-enum used_through=1.0.0-alpha.8 kept_for_older_clients obsolete_no_replacement ignored_by_current_clients remove_when_convenient",
    );
    expect(contents).toContain('chat_reply_composer = "custom-widget-chips"');
    expect(contents).toContain('tool_update_mode = "show_all"');
    expect(contents).toContain('manager_tool_update_mode = "show_more"');
    expect(contents).toContain("show_streaming_option = true");
  });

  it("reads authorized contacts from TOML array-of-tables", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[messaging.telegram]",
        "enabled = true",
        "",
        "[[messaging.telegram.authorized_users]]",
        'id = "111111111"',
        'display_name = "Harold"',
        'full_access_warning = "always"',
        "full_access_warning_dismissed = true",
        "",
        "[[messaging.telegram.authorized_supergroups]]",
        'id = "-1003841603622"',
        'display_name = "PwrAgent ops"',
      ].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.messaging.telegram.authorizedUserIds.value).toEqual([
      {
        id: "111111111",
        displayName: "Harold",
        fullAccessWarningOverride: "always",
        fullAccessWarningDismissed: true,
      },
    ]);
    expect(snapshot.messaging.telegram.authorizedSupergroups.value).toEqual([
      { id: "-1003841603622", displayName: "PwrAgent ops" },
    ]);
  });

  it("round-trips normalized authorized contact usernames", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[[messaging.slack.authorized_users]]",
        'id = "U079K80HTGS"',
        'display_name = "Harold Hunt"',
        'username = "@hhunt"',
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const before = await service.readSettingsProjection();
    expect(before.messaging.slack.authorizedUserIds.value).toEqual([{
      id: "U079K80HTGS",
      displayName: "Harold Hunt",
      username: "hhunt",
    }]);

    await service.writeConfigPatchTargeted({
      messaging: {
        slack: {
          authorizedUserIds: before.messaging.slack.authorizedUserIds.value,
        },
      },
    });

    expect(fs.readFileSync(configPath, "utf8")).toContain('username = "hhunt"');
    const after = await service.readSettingsProjection();
    expect(after.messaging.slack.authorizedUserIds.value).toEqual([{
      id: "U079K80HTGS",
      displayName: "Harold Hunt",
      username: "hhunt",
    }]);
  });

  it("sanitizes authorized contact display names read from config", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const unsafeDisplayName = "<script>alert(1)</script>Harold\u202e";
    fs.writeFileSync(
      configPath,
      [
        "[[messaging.telegram.authorized_users]]",
        'id = "111111111"',
        `display_name = "${unsafeDisplayName}"`,
      ].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "Harold" },
    ]);
  });

  it("defaults Slack Live Working Cards off without persisting the default", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.messaging.slack.liveWorkingCards).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      messaging: { slack: { workspaceUrl: "https://example.slack.com" } },
    });
    expect(fs.readFileSync(configPath, "utf8")).not.toContain(
      "live_working_cards",
    );

    await service.writeConfigPatchTargeted({
      messaging: { slack: { liveWorkingCards: true } },
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "live_working_cards = true",
    );
  });

  it("migrates legacy authorized user arrays when the list is next saved", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[messaging.telegram]",
        'authorized_user_ids = ["111111111"]',
        "streaming_responses = true",
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const before = await service.readSettingsProjection();
    expect(before.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "" },
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      'authorized_user_ids = ["111111111"]',
    );

    await service.writeConfigPatchTargeted({
      messaging: {
        telegram: {
          authorizedUserIds: [{ id: "111111111", displayName: "Harold" }],
        },
      },
    });

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain(
      "# pwragent-legacy-settings key=authorized_user_ids shape=string-array used_through=1.0.0-alpha.9 kept_for_older_clients",
    );
    expect(contents).toContain('authorized_user_ids = ["111111111"]');
    expect(contents).toContain("[[messaging.telegram.authorized_users]]");
    expect(contents).not.toContain("[[messaging.telegram.authorized_user_ids_list]]");
    expect(contents).toContain('id = "111111111"');
    expect(contents).toContain('display_name = "Harold"');
    expect(contents).toContain("streaming_responses = true");

    const after = await service.readSettingsProjection();
    expect(after.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "Harold" },
    ]);
  });

  it("migrates interim authorized user list tables to the canonical name", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[messaging.telegram]",
        "streaming_responses = true",
        "",
        "[[messaging.telegram.authorized_user_ids_list]]",
        'id = "111111111"',
        'display_name = "Harold"',
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const before = await service.readSettingsProjection();
    expect(before.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "Harold" },
    ]);

    await service.writeConfigPatchTargeted({
      messaging: {
        telegram: {
          authorizedUserIds: [{ id: "111111111", displayName: "Harold" }],
        },
      },
    });

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("[[messaging.telegram.authorized_users]]");
    expect(contents).not.toContain(
      "[[messaging.telegram.authorized_user_ids_list]]",
    );
    expect(contents).not.toContain("authorized_user_ids =");
    expect(contents).toContain("streaming_responses = true");
  });

  it("loads the worktree storage location from TOML and exposes the effective path", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      ["[worktrees]", 'storage = "in-repo"'].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.worktrees.storage).toEqual({
      value: "in-repo",
      source: "config",
    });
    expect(snapshot.worktrees.effectivePath).toBe(".worktrees");
    expect(service.resolveWorktreeStorage()).toBe("in-repo");
  });

  it("treats PWRAGENT_WORKTREE_STORAGE as a high-precedence override", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      ["[worktrees]", 'storage = "in-repo"'].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: { PWRAGENT_WORKTREE_STORAGE: "user-home" },
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.worktrees.storage).toMatchObject({
      value: "user-home",
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.worktrees.effectivePath).toMatch(
      /\.pwragent\/worktrees$/,
    );
  });

  it("round-trips the worktree storage setting through write + read", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.writeConfigPatchTargeted({ worktrees: { storage: "in-repo" } });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[worktrees]");
    expect(tomlOnDisk).toContain('storage = "in-repo"');

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.worktrees.storage.value).toBe("in-repo");
  });

  it("round-trips the Codex auth profile through write + read", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.writeConfigPatchTargeted({ models: { codex: { profile: "work" } } });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[models.codex]");
    expect(tomlOnDisk).toContain('profile = "work"');

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.models.codex.profile).toEqual({
      value: "work",
      source: "config",
    });
  });

  it("round-trips ACP agent CLI path overrides through write + read", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.writeConfigPatchTargeted({
      acpAgents: {
        grok: { cliPath: "/custom/grok" },
        qwen: { cliPath: "/custom/qwen" },
      },
    });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[acp_agents.grok]");
    expect(tomlOnDisk).toContain('cli_path = "/custom/grok"');
    expect(tomlOnDisk).toContain("[acp_agents.qwen]");
    expect(tomlOnDisk).toContain('cli_path = "/custom/qwen"');

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.acpAgents.grok.cliPath).toEqual({
      value: "/custom/grok",
      source: "config",
    });
    expect(snapshot.acpAgents.qwen.cliPath).toEqual({
      value: "/custom/qwen",
      source: "config",
    });
  });

  it("defaults ACP agents to enabled and round-trips a disable through write + read", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    // Unset → enabled by default (on-by-default policy).
    const initial = await service.readSettingsProjection();
    expect(initial.acpAgents.gemini.enabled).toBe(true);
    expect(initial.acpAgents.kimi.enabled).toBe(true);

    await service.writeConfigPatchTargeted({
      acpAgents: { kimi: { enabled: false } },
    });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[acp_agents.kimi]");
    expect(tomlOnDisk).toContain("enabled = false");

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.acpAgents.kimi.enabled).toBe(false);
    // Untouched agents stay enabled.
    expect(snapshot.acpAgents.gemini.enabled).toBe(true);
  });

  it("defaults managed Grok builds on and round-trips the opt-out", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).acpAgents.grok.managedBuilds).toBe(true);

    const packagedDefault = new DesktopSettingsService({
      configPath: path.join(root, "packaged-config.toml"),
      defaultManagedGrokBuilds: false,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });
    expect(
      (await packagedDefault.readSettingsProjection()).acpAgents.grok.managedBuilds,
    ).toBe(false);

    await service.writeConfigPatchTargeted({
      acpAgents: { grok: { managedBuilds: false } },
    });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[acp_agents.grok]");
    expect(tomlOnDisk).toContain("managed_builds = false");
    expect((await service.readSettingsProjection()).acpAgents.grok.managedBuilds).toBe(false);
  });

  it("suppresses managed Grok builds only for unpackaged E2E runtimes", () => {
    const config = {
      acpAgents: { grok: { managedBuilds: true } },
    } as Parameters<typeof managedGrokBuildsEnabledForRuntime>[0];
    const e2eEnv = { PWRAGENT_E2E: "1" };

    expect(managedGrokBuildsEnabledForRuntime(config, {
      env: e2eEnv,
      isPackaged: false,
    })).toBe(false);
    expect(managedGrokBuildsEnabledForRuntime(config, {
      env: e2eEnv,
      isPackaged: true,
    })).toBe(true);
    expect(managedGrokBuildsEnabledForRuntime(config, {
      env: {},
      isPackaged: false,
    })).toBe(true);
  });

  it("sets CODEX_HOME for the selected Codex auth profile", () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      ["[models.codex]", 'profile = "work"'].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: { CODEX_HOME: path.join(root, "codex") } as NodeJS.ProcessEnv,
      secretStore: new MemoryDesktopSecretStore(),
      resolveCodexShellEnv: () => ({}),
    });

    expect(service.resolveCodexSpawnEnv().CODEX_HOME).toBe(
      path.join(root, "codex", "profiles", "work"),
    );
  });

  it("sets the selected Codex auth profile on integrated terminal shells", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const codexRoot = path.join(root, "codex");
    fs.writeFileSync(
      configPath,
      ["[models.codex]", 'profile = "work"'].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: { CODEX_HOME: codexRoot } as NodeJS.ProcessEnv,
      secretStore: new MemoryDesktopSecretStore(),
      resolveCodexShellEnv: () => ({
        CODEX_HOME: path.join(root, "login-shell-default"),
        PATH: "/opt/homebrew/bin:/usr/bin",
      }),
    });

    await expect(service.resolveTerminalSpawnEnvAsync()).resolves.toMatchObject({
      CODEX_HOME: path.join(codexRoot, "profiles", "work"),
      PATH: "/opt/homebrew/bin:/usr/bin",
    });
  });

  it("keeps CODEX_HOME fixed to the startup Codex auth profile", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      ["[models.codex]", 'profile = "work"'].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: { CODEX_HOME: path.join(root, "codex") } as NodeJS.ProcessEnv,
      secretStore: new MemoryDesktopSecretStore(),
      resolveCodexShellEnv: () => ({}),
    });

    await service.writeConfigPatchTargeted({
      models: { codex: { profile: "personal" } },
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.models.codex.profile.value).toBe("personal");
    expect(service.resolveStartupCodexHome()).toBe(
      path.join(root, "codex", "profiles", "work"),
    );
    expect(service.resolveCodexSpawnEnv().CODEX_HOME).toBe(
      path.join(root, "codex", "profiles", "work"),
    );
  });

  it("adds login shell PATH entries to the Codex app-server spawn env", () => {
    const service = new DesktopSettingsService({
      env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
      secretStore: new MemoryDesktopSecretStore(),
      resolveCodexShellEnv: () => ({
        NVM_DIR: "/Users/alice/.nvm",
        PATH: "/Users/alice/.sdkman/candidates/sbt/current/bin:/usr/bin",
      }),
    });

    expect(service.resolveCodexSpawnEnv().PATH).toBe(
      "/Users/alice/.sdkman/candidates/sbt/current/bin:/usr/bin",
    );
    expect(service.resolveCodexSpawnEnv().NVM_DIR).toBe("/Users/alice/.nvm");
  });

  it("keeps the PwrAgent renderer URL out of Codex and terminal child environments", async () => {
    const service = new DesktopSettingsService({
      env: {
        ELECTRON_RENDERER_URL: "http://localhost:5173",
        PATH: "/usr/bin:/bin",
      } as NodeJS.ProcessEnv,
      secretStore: new MemoryDesktopSecretStore(),
      resolveCodexShellEnv: () => ({
        ELECTRON_RENDERER_URL: "http://localhost:5175",
        PATH: "/opt/homebrew/bin:/usr/bin",
        NVM_DIR: "/Users/alice/.nvm",
      }),
    });

    const codexEnv = service.resolveCodexSpawnEnv();
    const terminalEnv = await service.resolveTerminalSpawnEnvAsync();

    expect(codexEnv).not.toHaveProperty("ELECTRON_RENDERER_URL");
    expect(terminalEnv).not.toHaveProperty("ELECTRON_RENDERER_URL");
    expect(codexEnv).toMatchObject({
      PATH: "/opt/homebrew/bin:/usr/bin",
      NVM_DIR: "/Users/alice/.nvm",
    });
    expect(terminalEnv).toMatchObject({
      PATH: "/opt/homebrew/bin:/usr/bin",
      NVM_DIR: "/Users/alice/.nvm",
    });
  });

  it("applies env overrides above TOML", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        'chat_reply_composer = "textarea"',
        "",
        "[messaging.telegram]",
        "enabled = false",
        'authorized_user_ids = ["111111111"]',
        "",
        "[models.codex]",
        'path = "codex-config"',
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {
        PWRAGENT_EXPERIMENTAL_CHAT_REPLY_COMPOSER: "custom-widget-chips",
        PWRAGENT_MESSAGING_INPUT_DEBOUNCE_MS: "250",
        PWRAGENT_MESSAGING_TELEGRAM_ENABLED: "true",
        PWRAGENT_MESSAGING_TELEGRAM_STREAMING_RESPONSES: "true",
        PWRAGENT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS: "222222222,333333333",
        PWRAGENT_CODEX_COMMAND: "codex-env",
        PWRAGENT_GH_COMMAND: "/custom/bin/gh",
      },
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.experimental.chatReplyComposer).toEqual({
      value: "tiptap-wysiwyg-markdown-chips",
      source: "default",
    });
    expect(snapshot.messaging.telegram.enabled).toMatchObject({
      value: true,
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.messaging.inputDebounceMs).toMatchObject({
      value: 250,
      source: "env",
      overriddenByEnv: false,
    });
    expect(snapshot.messaging.telegram.streamingResponses).toMatchObject({
      value: true,
      source: "env",
      overriddenByEnv: false,
    });
    expect(snapshot.messaging.telegram.authorizedUserIds).toMatchObject({
      value: [
        { id: "222222222", displayName: "" },
        { id: "333333333", displayName: "" },
      ],
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.models.codex.path).toMatchObject({
      value: "codex-env",
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.applications.gh.path).toMatchObject({
      value: "/custom/bin/gh",
      source: "env",
    });
    expect(service.resolveCodexCommandPreference()).toBe("codex-env");
    expect(service.resolveGhCommandPreference()).toBe("/custom/bin/gh");
  });

  it("rereads secret metadata without decrypting stored values", async () => {
    const getSecret = vi.fn(async () => {
      throw new Error("secret values should not be decrypted for settings snapshots");
    });
    const getSecretSync = vi.fn(() => {
      throw new Error("secret values should not be decrypted for settings snapshots");
    });
    const hasSecret = vi.fn(async (name) => name === "telegramBotToken");
    const secretStore: DesktopSecretStore = {
      describe: () => ({
        available: true,
        backend: "safeStorage",
        encrypted: true,
      }),
      hasSecret,
      getSecret,
      getSecretSync,
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore,
    });

    const snapshot = await service.readSettingsProjection();
    const secretMetadataReads = hasSecret.mock.calls.length;
    const repeatedSnapshot = await service.readSettingsProjection();

    expect(snapshot.messaging.telegram.botToken).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });
    expect(repeatedSnapshot.messaging.telegram.botToken).toEqual(
      snapshot.messaging.telegram.botToken,
    );
    expect(hasSecret).toHaveBeenCalledWith("telegramBotToken");
    expect(hasSecret).toHaveBeenCalledTimes(secretMetadataReads * 2);
    expect(getSecret).not.toHaveBeenCalled();
    expect(getSecretSync).not.toHaveBeenCalled();
  });

  it("surfaces secret access errors on settings snapshots", async () => {
    const secretStore: DesktopSecretStore = {
      describe: () => ({
        available: true,
        backend: "safeStorage",
        encrypted: true,
      }),
      getSecretAccessError: vi.fn(
        (name) =>
          name === "telegramBotToken"
            ? "PwrAgent could not unlock secret storage."
            : undefined,
      ),
      hasSecret: vi.fn(async () => false),
      getSecret: vi.fn(),
      getSecretSync: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore,
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.messaging.telegram.botToken).toMatchObject({
      configured: false,
      source: "unset",
      writable: true,
      unavailableReason: "PwrAgent could not unlock secret storage.",
    });
  });

  it("writes non-secret patches without writing plaintext secrets to TOML", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const secretStore = new MemoryDesktopSecretStore();
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore,
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        inputDebounceMs: 1250,
        toolUpdateMode: "show_less",
        telegram: {
          enabled: true,
          streamingResponses: true,
          authorizedUserIds: [{ id: "111111111", displayName: "Harold" }],
          authorizedSupergroups: [],
        },
      },
      models: {
        codex: {
          path: "codex",
        },
      },
      applications: {
        terminal: {
          preferredId: "ghostty",
        },
        gh: {
          path: "/opt/homebrew/bin/gh",
        },
      },
    });
    await service.replaceSecret("telegramBotToken", "123456789:secret-token");

    const contents = fs.readFileSync(configPath, "utf8");
    const snapshot = await service.readSettingsProjection();

    expect(contents).toContain("[messaging.telegram]");
    expect(contents).toContain("[messaging]");
    expect(contents).toContain("input_debounce_ms = 1250");
    expect(contents).toContain('tool_update_mode = "show_less"');
    expect(contents).toContain("streaming_responses = true");
    expect(contents).not.toContain("authorized_user_ids =");
    expect(contents).toContain("[[messaging.telegram.authorized_users]]");
    expect(contents).toContain('id = "111111111"');
    expect(contents).toContain('display_name = "Harold"');
    expect(contents).toContain("[applications.terminal]");
    expect(contents).toContain('preferred_id = "ghostty"');
    expect(contents).toContain("[applications.gh]");
    expect(contents).toContain('path = "/opt/homebrew/bin/gh"');
    expect(contents).not.toContain("123456789:secret-token");
    expect(JSON.stringify(snapshot)).not.toContain("123456789:secret-token");
    expect(snapshot.messaging.telegram.botToken).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });
  });

  it("treats empty comma-separated env lists as empty lists", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {
        PWRAGENT_MESSAGING_DISCORD_AUTHORIZED_GUILDS: " , ",
      },
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.messaging.discord.authorizedGuilds).toEqual({
      value: [],
      source: "env",
      overriddenByEnv: false,
    });
  });

  it("reports process-level messaging disable overrides", async () => {
    const service = new DesktopSettingsService({
      argv: ["electron", "--disable-messaging"],
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.runtime.messaging).toEqual({
      disabled: true,
      overrideActive: true,
      disabledReasonKind: "explicit_override",
      disabledReason: "--disable-messaging was provided at startup",
    });
  });

  it("reports malformed TOML without throwing from readSettings", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, "[experimental]\nchat_reply_composer\n", "utf8");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.configError).toContain("Invalid TOML line");
    expect(snapshot.experimental.chatReplyComposer).toEqual({
      value: "tiptap-wysiwyg-markdown-chips",
      source: "default",
    });
  });

  it("refuses to overwrite malformed TOML on save", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      "[experimental]\nchat_reply_composer\n[messaging.telegram]\nenabled = true\n",
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await expect(
      service.writeConfigPatchTargeted({
        experimental: {
          diffCondensation: {
            enabled: true,
          },
        },
      }),
    ).rejects.toThrow("could not be parsed");
    expect(fs.readFileSync(configPath, "utf8")).toContain("chat_reply_composer");
    expect(fs.readFileSync(configPath, "utf8")).toContain("enabled = true");
  });

  it("round-trips Mattermost settings through TOML and exposes them in the snapshot", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const secretStore = new MemoryDesktopSecretStore();
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore,
      now: () => 1,
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        mattermost: {
          enabled: true,
          streamingResponses: true,
          serverUrl: "https://chat.example.com",
          callbackBaseUrl: "https://tunnel.example.com/mm",
          slashCommandPrefix: "agent_",
          registerSlashCommands: true,
          authorizedUserIds: [
            { id: "userA", displayName: "Alice" },
            { id: "userB", displayName: "Bob" },
          ],
          authorizedTeams: [
            { id: "teamabcdefghijklmnopqrstu1", displayName: "Dev Team" },
          ],
          authorizedConversations: [
            { id: "channelabcdefghijklmn12345", displayName: "Town Square" },
          ],
        },
      },
    });

    await service.replaceSecret("mattermostBotToken", "token-abc");
    await service.replaceSecret("mattermostHmacSecret", "hmac-secret");

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("[messaging.mattermost]");
    expect(contents).toContain('server_url = "https://chat.example.com"');
    expect(contents).toContain("register_slash_commands = true");
    expect(contents).not.toContain("callback_port");
    expect(contents).toContain('slash_command_prefix = "agent_"');
    expect(contents).not.toContain("authorized_user_ids =");
    expect(contents).toContain("[[messaging.mattermost.authorized_users]]");
    expect(contents).toContain('id = "userA"');
    expect(contents).toContain('display_name = "Alice"');
    expect(contents).toContain("[[messaging.mattermost.authorized_teams]]");
    expect(contents).toContain('id = "teamabcdefghijklmnopqrstu1"');
    expect(contents).toContain("[[messaging.mattermost.authorized_conversations]]");
    expect(contents).toContain('id = "channelabcdefghijklmn12345"');
    // Bot token + HMAC secret never written to TOML
    expect(contents).not.toContain("token-abc");
    expect(contents).not.toContain("hmac-secret");

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.messaging.mattermost.enabled).toMatchObject({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.mattermost.streamingResponses).toMatchObject({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.mattermost.serverUrl.value).toBe(
      "https://chat.example.com",
    );
    expect(snapshot.messaging.mattermost.callbackBaseUrl.value).toBe(
      "https://tunnel.example.com/mm",
    );
    expect(snapshot.messaging.mattermost.slashCommandPrefix.value).toBe(
      "agent_",
    );
    expect(snapshot.messaging.mattermost.registerSlashCommands.value).toBe(
      true,
    );
    expect(snapshot.messaging.mattermost.authorizedUserIds.value).toEqual([
      { id: "userA", displayName: "Alice" },
      { id: "userB", displayName: "Bob" },
    ]);
    expect(snapshot.messaging.mattermost.authorizedTeams.value).toEqual([
      { id: "teamabcdefghijklmnopqrstu1", displayName: "Dev Team" },
    ]);
    expect(snapshot.messaging.mattermost.authorizedConversations.value).toEqual([
      { id: "channelabcdefghijklmn12345", displayName: "Town Square" },
    ]);
    expect(snapshot.messaging.mattermost.botToken).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });
    expect(snapshot.messaging.mattermost.hmacSecret).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });

    expect(service.resolveMattermostBotTokenSync()).toBe("token-abc");
    expect(service.resolveMattermostHmacSecretSync()).toBe("hmac-secret");
    expect(service.resolveMattermostServerUrlSync()).toBe(
      "https://chat.example.com",
    );
  });

  it("reports unset Mattermost defaults and uses pwragent_ as the slash prefix default", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.messaging.mattermost.enabled).toMatchObject({
      value: false,
      source: "default",
    });
    expect(snapshot.messaging.mattermost.slashCommandPrefix).toMatchObject({
      value: "pwragent_",
      source: "default",
    });
    expect(snapshot.messaging.mattermost.registerSlashCommands).toMatchObject({
      value: false,
      source: "default",
    });
    expect(snapshot.messaging.mattermost.botToken.configured).toBe(false);
    expect(snapshot.messaging.mattermost.hmacSecret.configured).toBe(false);
  });

  it("env Mattermost overrides flag overriddenByEnv on the snapshot", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {
        PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN: "env-token",
        PWRAGENT_MESSAGING_MATTERMOST_SERVER_URL: "https://env.example.com",
        PWRAGENT_MESSAGING_MATTERMOST_REGISTER_SLASH_COMMANDS: "true",
      },
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.messaging.mattermost.botToken).toMatchObject({
      configured: true,
      source: "env",
      writable: false,
      overriddenByEnv: true,
    });
    expect(snapshot.messaging.mattermost.serverUrl).toMatchObject({
      value: "https://env.example.com",
      source: "env",
    });
    expect(snapshot.messaging.mattermost.registerSlashCommands).toMatchObject({
      value: true,
      source: "env",
    });
    expect(service.resolveMattermostBotTokenSync()).toBe("env-token");
    expect(service.resolveMattermostServerUrlSync()).toBe(
      "https://env.example.com",
    );
  });

  it("defaults Feishu tenant URL from the selected tenant region", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[messaging.feishu]",
        'tenant_region = "lark"',
        'tenant_url = "https://open.larksuite.com"',
        'callback_base_url = "http://127.0.0.1:47823"',
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.messaging.feishu.tenantRegion).toEqual({
      value: "lark",
      source: "config",
    });
    expect(snapshot.messaging.feishu.inboundMode).toEqual({
      value: "persistent",
      source: "default",
    });
    expect(snapshot.messaging.feishu.tenantUrl).toEqual({
      value: "",
      source: "default",
    });
    expect(snapshot.messaging.feishu.callbackBaseUrl).toEqual({
      value: "",
      source: "default",
    });
    expect(service.resolveFeishuTenantUrlSync()).toBe("https://open.larksuite.com");
  });

  it("reports unavailable secret storage and blocks secret writes", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore({
        available: false,
        backend: "unavailable",
        encrypted: false,
        unavailableReason: "No secure backend",
      }),
    });

    const snapshot = await service.readSettingsProjection();

    expect(snapshot.secretStorage.available).toBe(false);
    expect(snapshot.messaging.telegram.botToken).toMatchObject({
      configured: false,
      source: "unset",
      writable: false,
      unavailableReason: "No secure backend",
    });
    await expect(service.replaceSecret("telegramBotToken", "bot-secret")).rejects.toThrow(
      "No secure backend",
    );
  });

  it("defaults diff condensation to disabled and persists the toggle", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.diffCondensation).toEqual({
      enabled: { value: false, source: "default" },
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        diffCondensation: { enabled: true },
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.diffCondensation).toEqual({
      enabled: { value: true, source: "config" },
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        diffCondensation: { enabled: false },
      },
    });

    const reverted = await service.readSettingsProjection();
    expect(reverted.experimental.diffCondensation.enabled.value).toBe(false);
  });

  it("defaults Full Access risk warning dismissal to false and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.fullAccessRiskWarningDismissed).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        fullAccessRiskWarningDismissed: true,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.fullAccessRiskWarningDismissed).toEqual({
      value: true,
      source: "config",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "full_access_risk_warning_dismissed = true",
    );
  });

  it("defaults live transcript event filtering to false and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.liveTranscriptEventFiltering).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        liveTranscriptEventFiltering: true,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.liveTranscriptEventFiltering).toEqual({
      value: true,
      source: "config",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "live_transcript_event_filtering = true",
    );
  });

  it("defaults lightweight navigation refresh to false and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.lightweightNavigationRefresh).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        lightweightNavigationRefresh: true,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.lightweightNavigationRefresh).toEqual({
      value: true,
      source: "config",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "lightweight_navigation_refresh = true",
    );
  });

  it("defaults Markdown math rendering to false and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.markdownMathRendering).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        markdownMathRendering: true,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.markdownMathRendering).toEqual({
      value: true,
      source: "config",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "markdown_math_rendering = true",
    );
  });

  it("defaults Git background PR polling to on and persists an explicit opt-out", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    // With the flag absent, background polling is enabled by default.
    const initial = await service.readSettingsProjection();
    expect(initial.git.backgroundPrPolling).toEqual({
      value: true,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      git: {
        backgroundPrPolling: false,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.git.backgroundPrPolling).toEqual({
      value: false,
      source: "config",
    });
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("[git]\nbackground_pr_polling = false");
    expect(contents).not.toContain("[experimental]");
  });

  it("defaults GitHub PR automation to on and persists its global choices", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.git.prAutoDispatchAllowed).toEqual({
      value: true,
      source: "default",
    });
    expect(initial.git.defaultPrAutoDispatchEnabled).toEqual({
      value: true,
      source: "default",
    });
    expect(initial.git.prAutoDispatchBudgetCapacity).toEqual({
      value: 30,
      source: "default",
    });
    expect(initial.git.prAutoDispatchBudgetRefillPerMinute).toEqual({
      value: 1,
      source: "default",
    });
    expect(initial.git.pausePrAutoDispatchWhenBudgetEmpty).toEqual({
      value: true,
      source: "default",
    });
    expect(service.resolveDefaultPrAutoDispatchEnabled()).toBe(true);

    await service.writeConfigPatchTargeted({
      git: {
        prAutoDispatchAllowed: false,
        defaultPrAutoDispatchEnabled: false,
        prAutoDispatchBudgetCapacity: 42,
        prAutoDispatchBudgetRefillPerMinute: 3,
        pausePrAutoDispatchWhenBudgetEmpty: false,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.git.prAutoDispatchAllowed).toEqual({
      value: false,
      source: "config",
    });
    expect(updated.git.defaultPrAutoDispatchEnabled).toEqual({
      value: false,
      source: "config",
    });
    expect(updated.git.prAutoDispatchBudgetCapacity).toEqual({
      value: 42,
      source: "config",
    });
    expect(updated.git.prAutoDispatchBudgetRefillPerMinute).toEqual({
      value: 3,
      source: "config",
    });
    expect(updated.git.pausePrAutoDispatchWhenBudgetEmpty).toEqual({
      value: false,
      source: "config",
    });
    expect(service.resolveDefaultPrAutoDispatchEnabled()).toBe(false);
    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("pr_auto_dispatch_allowed = false");
    expect(contents).toContain("default_pr_auto_dispatch_enabled = false");
    expect(contents).toContain("pr_auto_dispatch_budget_capacity = 42");
    expect(contents).toContain("pr_auto_dispatch_budget_refill_per_minute = 3");
    expect(contents).toContain("pause_pr_auto_dispatch_when_budget_empty = false");
  });

  it("reads the canonical Git background PR polling key", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[git]",
        "background_pr_polling = false",
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).git.backgroundPrPolling).toEqual({
      value: false,
      source: "config",
    });
  });

  it("reads the legacy experimental background PR polling key when Git is absent", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        "background_pr_polling = false",
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).git.backgroundPrPolling).toEqual({
      value: false,
      source: "config",
    });
  });

  it("falls back to the legacy polling key when the canonical Git value is malformed", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[git]",
        'background_pr_polling = "not-a-boolean"',
        "",
        "[experimental]",
        "background_pr_polling = false",
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).git.backgroundPrPolling).toEqual({
      value: false,
      source: "config",
    });
  });

  it("migrates legacy background PR polling lazily without losing config context", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        "# Keep the older opt-out for downgrade clients.",
        "background_pr_polling = false",
        "",
        "[general]",
        "# Keep this unrelated comment too.",
        "developer_mode = true",
      ].join("\n"),
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await service.writeConfigPatchTargeted({
      git: { backgroundPrPolling: true },
    });

    let contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain(
      [
        "# Keep the older opt-out for downgrade clients.",
        "# pwragent-legacy-settings key=background_pr_polling shape=boolean used_through=1.0.0-beta.50 kept_for_older_clients",
        "background_pr_polling = true",
      ].join("\n"),
    );
    expect(contents).toContain("[git]\nbackground_pr_polling = true");
    expect(contents).toContain("# Keep this unrelated comment too.");
    expect(contents).toContain("developer_mode = true");
    expect(
      contents.match(/pwragent-legacy-settings key=background_pr_polling/g),
    ).toHaveLength(1);

    await service.writeConfigPatchTargeted({
      git: { backgroundPrPolling: false },
    });

    contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain("[git]\nbackground_pr_polling = false");
    expect(
      contents.match(/pwragent-legacy-settings key=background_pr_polling/g),
    ).toHaveLength(1);
  });

  it("defaults thread pricing summary to true and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.threadPricingSummary).toEqual({
      value: true,
      source: "default",
    });
    expect(initial.experimental.threadPricingDisplayUsd).toEqual({
      value: true,
      source: "default",
    });
    expect(initial.experimental.threadPricingDisplayCodexCredits).toEqual({
      value: false,
      source: "default",
    });
    expect(initial.experimental.threadToolAccounting).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatchTargeted({
      experimental: {
        threadPricingSummary: false,
        threadPricingDisplayUsd: false,
        threadPricingDisplayCodexCredits: true,
        threadToolAccounting: true,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.threadPricingSummary).toEqual({
      value: false,
      source: "config",
    });
    expect(updated.experimental.threadPricingDisplayUsd).toEqual({
      value: false,
      source: "config",
    });
    expect(updated.experimental.threadPricingDisplayCodexCredits).toEqual({
      value: true,
      source: "config",
    });
    expect(updated.experimental.threadToolAccounting).toEqual({
      value: true,
      source: "config",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "thread_pricing_summary = false",
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "thread_pricing_display_usd = false",
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "thread_pricing_display_codex_credits = true",
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "thread_tool_accounting = true",
    );
  });

  it("defaults Codex default-mode request_user_input to false and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettingsProjection();
    expect(initial.experimental.codexDefaultModeRequestUserInput).toEqual({
      value: false,
      source: "default",
    });
    expect(service.resolveCodexDefaultModeRequestUserInput()).toBe(false);

    await service.writeConfigPatchTargeted({
      experimental: {
        codexDefaultModeRequestUserInput: true,
      },
    });

    const updated = await service.readSettingsProjection();
    expect(updated.experimental.codexDefaultModeRequestUserInput).toEqual({
      value: true,
      source: "config",
    });
    expect(service.resolveCodexDefaultModeRequestUserInput()).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "codex_default_mode_request_user_input = true",
    );
  });

  it("keeps the retired managed-review flag readable and writable", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, [
      "# keep this operator comment",
      "[experimental]",
      "thread_tool_accounting = true",
      "",
    ].join("\n"));
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    expect((await service.readSettingsProjection()).experimental.managedReview).toEqual({
      value: false,
      source: "default",
    });
    expect(service.resolveManagedReviewEnabled()).toBe(false);

    await service.writeConfigPatchTargeted({
      experimental: { managedReview: true },
    });

    expect((await service.readSettingsProjection()).experimental.managedReview).toEqual({
      value: true,
      source: "config",
    });
    expect(service.resolveManagedReviewEnabled()).toBe(true);
    const written = fs.readFileSync(configPath, "utf8");
    expect(written).toContain("# keep this operator comment");
    expect(written).toContain("thread_tool_accounting = true");
    expect(written).toContain("managed_review = true");
  });

  it("preserves unknown sections written by other builds when saving a patch", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const original = [
      "# config edited by hand — comments must survive",
      "[messaging.telegram]",
      "enabled = true",
      "",
      "# Mattermost block written by a future build the current code doesn't know about",
      "[messaging.mattermost]",
      'server_url = "https://chat.example.com"',
      'callback_base_url = "https://callbacks.example.com"',
      'authorized_user_ids = ["abc-123", "def-456"]',
      "",
      "[unknown.future.section]",
      'opaque_field = "preserve me"',
      "",
    ].join("\n");
    fs.writeFileSync(configPath, original, "utf8");

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 0,
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        telegram: { enabled: false },
      },
    });

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("# config edited by hand — comments must survive");
    expect(after).toContain("[messaging.mattermost]");
    expect(after).toContain('server_url = "https://chat.example.com"');
    expect(after).toContain('callback_base_url = "https://callbacks.example.com"');
    expect(after).toContain('authorized_user_ids = ["abc-123", "def-456"]');
    expect(after).toContain("[unknown.future.section]");
    expect(after).toContain('opaque_field = "preserve me"');
    expect(after).toContain("enabled = false");
  });

  it("reads a config that contains inline-table-array values in unknown sections without erroring", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[messaging.telegram]",
        "enabled = true",
        "",
        "# Future schema (unknown to current code) — must parse, not throw.",
        "[messaging.mattermost]",
        'server_url = "https://chat.example.com"',
        "authorized_users = [",
        '  { id = "-1001234567890", label = "Mom\'s group" },',
        '  { id = "-1009876543210", label = "Work team" },',
        "]",
        "",
      ].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 0,
    });

    const snapshot = await service.readSettingsProjection();
    expect(snapshot.configError).toBeUndefined();
    expect(snapshot.messaging.telegram.enabled.value).toBe(true);
  });

  // Gate for the deferred Codex `listThreads` probe. The reader rule is
  // "missing [onboarding] table = migrated", so pre-existing v1.x users
  // upgrade with no regression while brand-new profiles carry an explicit
  // `completed = false` marker that the wizard later flips to true.
  describe("onboarding gate", () => {
    it("treats a missing [onboarding] section as a migrated profile", async () => {
      const root = createTempRoot();
      const configPath = path.join(root, "config.toml");
      fs.writeFileSync(
        configPath,
        ["[general]", "developer_mode = true", ""].join("\n"),
        "utf8",
      );

      const service = new DesktopSettingsService({
        configPath,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });

      const snapshot = await service.readSettingsProjection();
      expect(snapshot.onboarding.completed).toEqual({
        value: true,
        source: "default",
      });
      expect(snapshot.onboarding.completedSource).toEqual({
        value: "migrated",
        source: "default",
      });
      expect(service.resolveOnboardingCompleted()).toBe(true);
    });

    it("treats an empty config as a brand-new profile awaiting the wizard", async () => {
      const root = createTempRoot();
      const configPath = path.join(root, "config.toml");
      // A real fresh profile gets `[onboarding] completed = false`
      // written by `ensureNamedProfileExists`; an absent file follows the
      // same migrated-default path because there is nothing to read.
      // Profile-create-side coverage lives in profile.test.ts.

      const service = new DesktopSettingsService({
        configPath,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });

      const snapshot = await service.readSettingsProjection();
      expect(snapshot.onboarding.completed.value).toBe(true);
      expect(snapshot.onboarding.completedSource.value).toBe("migrated");
    });

    it("honors an explicit completed = false marker as gate-on", async () => {
      const root = createTempRoot();
      const configPath = path.join(root, "config.toml");
      fs.writeFileSync(
        configPath,
        ["[onboarding]", "completed = false", ""].join("\n"),
        "utf8",
      );

      const service = new DesktopSettingsService({
        configPath,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });

      const snapshot = await service.readSettingsProjection();
      expect(snapshot.onboarding.completed).toEqual({
        value: false,
        source: "config",
      });
      expect(snapshot.onboarding.completedSource).toEqual({
        value: "",
        source: "default",
      });
      expect(service.resolveOnboardingCompleted()).toBe(false);
    });

    // The wizard PR (#491) flipped `ONBOARDING_CODEX_GATE_ENABLED` to
    // true now that the wizard UI exists to drive past the gate. This
    // test pins the active behavior: persisted `completed = false`
    // defers the Codex listThreads probe until the wizard calls
    // `completeOnboardingCodexBootstrap`. Pre-existing profiles (no
    // `[onboarding]` table) read as `completedSource = "migrated"` —
    // covered by a separate test below.
    it("isCodexBootstrapDeferred returns true when completed = false (gate active)", async () => {
      const root = createTempRoot();
      const configPath = path.join(root, "config.toml");
      fs.writeFileSync(
        configPath,
        ["[onboarding]", "completed = false", ""].join("\n"),
        "utf8",
      );

      const service = new DesktopSettingsService({
        configPath,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });

      expect(service.resolveOnboardingCompleted()).toBe(false);
      expect(service.isCodexBootstrapDeferred()).toBe(true);
    });

    it("round-trips a wizard completion through writeConfigPatch", async () => {
      const root = createTempRoot();
      const configPath = path.join(root, "config.toml");
      fs.writeFileSync(
        configPath,
        ["[onboarding]", "completed = false", ""].join("\n"),
        "utf8",
      );

      const service = new DesktopSettingsService({
        configPath,
        env: {},
        secretStore: new MemoryDesktopSecretStore(),
      });

      expect(service.resolveOnboardingCompleted()).toBe(false);

      await service.writeConfigPatchTargeted({
        onboarding: { completed: true, completedSource: "wizard" },
      });

      const onDisk = fs.readFileSync(configPath, "utf8");
      expect(onDisk).toContain("[onboarding]");
      expect(onDisk).toContain("completed = true");
      expect(onDisk).toContain('completed_source = "wizard"');

      const snapshot = await service.readSettingsProjection();
      expect(snapshot.onboarding.completed).toEqual({
        value: true,
        source: "config",
      });
      expect(snapshot.onboarding.completedSource).toEqual({
        value: "wizard",
        source: "config",
      });
      expect(service.resolveOnboardingCompleted()).toBe(true);
    });
  });

  it("leaves the file byte-identical when a patch sets values that already match", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const original = [
      "[messaging.telegram]",
      "enabled = true",
      "streaming_responses = false",
      "",
    ].join("\n");
    fs.writeFileSync(configPath, original, "utf8");

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 0,
    });

    await service.writeConfigPatchTargeted({
      messaging: {
        telegram: {
          enabled: true,
          streamingResponses: false,
        },
      },
    });

    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });
});
