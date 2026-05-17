import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

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

describe("DesktopSettingsService", () => {
  it("loads TOML values from the desktop config path", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        'chat_reply_composer = "tiptap-chips"',
        "",
        "[messaging]",
        "allow_full_access_thread_resume = false",
        "allow_full_access_escalation = false",
        'full_access_warning = "always"',
        "input_debounce_ms = 750",
        'tool_update_mode = "show_more"',
        "",
        "[image_uploads]",
        "pasted_image_max_patches = 4096",
        "",
        "[updates]",
        'channel = "prerelease"',
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

    const snapshot = await service.readSettings();

    expect(snapshot.fetchedAt).toBe(10);
    expect(snapshot.experimental.chatReplyComposer).toEqual({
      value: "tiptap-wysiwyg-markdown-chips",
      source: "default",
    });
    expect(snapshot.messaging.toolUpdateMode).toEqual({
      value: "show_more",
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

  it("defaults the update channel and only persists prerelease", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettings();
    expect(initial.updates.channel).toEqual({
      value: "latest",
      source: "default",
    });
    expect(service.resolveUpdateChannel()).toBe("latest");

    await service.writeConfigPatch({
      updates: {
        channel: "prerelease",
      },
    });

    const afterPrerelease = fs.readFileSync(configPath, "utf8");
    expect(afterPrerelease).toContain("[updates]");
    expect(afterPrerelease).toContain('channel = "prerelease"');
    expect((await service.readSettings()).updates.channel).toEqual({
      value: "prerelease",
      source: "config",
    });
    expect(service.resolveUpdateChannel()).toBe("prerelease");

    await service.writeConfigPatch({
      updates: {
        channel: "latest",
      },
    });

    const afterDefault = fs.readFileSync(configPath, "utf8");
    expect(afterDefault).not.toContain("channel");
    expect((await service.readSettings()).updates.channel).toEqual({
      value: "latest",
      source: "default",
    });
  });

  it("defaults the image upload profile and only persists non-default values", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettings();
    expect(initial.messaging.attachments.imageProfile).toEqual({
      value: "medium",
      source: "default",
    });

    await service.writeConfigPatch({
      messaging: {
        attachments: { imageProfile: "actual" },
      },
    });

    const afterActual = fs.readFileSync(configPath, "utf8");
    expect(afterActual).toContain("[messaging.attachments]");
    expect(afterActual).toContain('image_profile = "actual"');
    expect((await service.readSettings()).messaging.attachments.imageProfile).toEqual({
      value: "actual",
      source: "config",
    });

    await service.writeConfigPatch({
      messaging: {
        attachments: { imageProfile: "medium" },
      },
    });

    const afterDefault = fs.readFileSync(configPath, "utf8");
    expect(afterDefault).not.toContain("image_profile");
    expect((await service.readSettings()).messaging.attachments.imageProfile).toEqual({
      value: "medium",
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

    const initial = await service.readSettings();
    expect(initial.imageUploads.pastedImageMaxPatches).toEqual({
      value: 1536,
      source: "default",
    });

    await service.writeConfigPatch({
      imageUploads: {
        pastedImageMaxPatches: 1024,
      },
    });

    const afterCompact = fs.readFileSync(configPath, "utf8");
    expect(afterCompact).toContain("[image_uploads]");
    expect(afterCompact).toContain("pasted_image_max_patches = 1024");
    expect((await service.readSettings()).imageUploads.pastedImageMaxPatches).toEqual({
      value: 1024,
      source: "config",
    });

    await service.writeConfigPatch({
      imageUploads: {
        pastedImageMaxPatches: 1536,
      },
    });

    const afterDefault = fs.readFileSync(configPath, "utf8");
    expect(afterDefault).not.toContain("pasted_image_max_patches");
    expect((await service.readSettings()).imageUploads.pastedImageMaxPatches).toEqual({
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

    await service.writeConfigPatch({
      messaging: {
        toolUpdateMode: "show_all",
      },
    });

    const contents = fs.readFileSync(configPath, "utf8");
    expect(contents).toContain(
      "# pwragent-legacy-settings key=chat_reply_composer shape=string-enum used_through=1.0.0-alpha.8 kept_for_older_clients obsolete_no_replacement ignored_by_current_clients remove_when_convenient",
    );
    expect(contents).toContain('chat_reply_composer = "custom-widget-chips"');
    expect(contents).toContain('tool_update_mode = "show_all"');
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

    const snapshot = await service.readSettings();

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

    const snapshot = await service.readSettings();

    expect(snapshot.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "Harold" },
    ]);
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

    const before = await service.readSettings();
    expect(before.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "" },
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      'authorized_user_ids = ["111111111"]',
    );

    await service.writeConfigPatch({
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

    const after = await service.readSettings();
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

    const before = await service.readSettings();
    expect(before.messaging.telegram.authorizedUserIds.value).toEqual([
      { id: "111111111", displayName: "Harold" },
    ]);

    await service.writeConfigPatch({
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

    const snapshot = await service.readSettings();

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

    const snapshot = await service.readSettings();

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

    await service.writeConfigPatch({ worktrees: { storage: "in-repo" } });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[worktrees]");
    expect(tomlOnDisk).toContain('storage = "in-repo"');

    const snapshot = await service.readSettings();
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

    await service.writeConfigPatch({ models: { codex: { profile: "work" } } });

    const tomlOnDisk = fs.readFileSync(configPath, "utf8");
    expect(tomlOnDisk).toContain("[models.codex]");
    expect(tomlOnDisk).toContain('profile = "work"');

    const snapshot = await service.readSettings();
    expect(snapshot.models.codex.profile).toEqual({
      value: "work",
      source: "config",
    });
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
    });

    expect(service.resolveCodexSpawnEnv().CODEX_HOME).toBe(
      path.join(root, "codex", "profiles", "work"),
    );
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
    });

    await service.writeConfigPatch({
      models: { codex: { profile: "personal" } },
    });

    const snapshot = await service.readSettings();
    expect(snapshot.models.codex.profile.value).toBe("personal");
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

  it("applies env overrides above TOML and keeps the Grok API key in keychain", async () => {
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
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("grokApiKey", "xai-keychain");

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
        XAI_API_KEY: "xai-env",
      },
      secretStore,
    });

    const snapshot = await service.readSettings();

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
    expect(snapshot.models.grok.apiKey).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });
    expect(await service.resolveGrokApiKey()).toBe("xai-keychain");
    expect(service.resolveCodexCommandPreference()).toBe("codex-env");
    expect(service.resolveGhCommandPreference()).toBe("/custom/bin/gh");
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

    await service.writeConfigPatch({
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
    const snapshot = await service.readSettings();

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

    const snapshot = await service.readSettings();

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

    const snapshot = await service.readSettings();

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

    const snapshot = await service.readSettings();

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
      service.writeConfigPatch({
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

    await service.writeConfigPatch({
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

    const snapshot = await service.readSettings();
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

    const snapshot = await service.readSettings();
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

    const snapshot = await service.readSettings();
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

    const snapshot = await service.readSettings();

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

    const snapshot = await service.readSettings();

    expect(snapshot.secretStorage.available).toBe(false);
    expect(snapshot.models.grok.apiKey).toMatchObject({
      configured: false,
      source: "unset",
      writable: false,
      unavailableReason: "No secure backend",
    });
    await expect(service.replaceSecret("grokApiKey", "xai-secret")).rejects.toThrow(
      "No secure backend",
    );
  });

  it("defaults diff condensation to disabled / auto and round-trips a custom value", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettings();
    expect(initial.experimental.diffCondensation).toEqual({
      enabled: { value: false, source: "default" },
      model: { value: "auto", source: "default" },
    });

    await service.writeConfigPatch({
      experimental: {
        diffCondensation: { enabled: true, model: "grok-3" },
      },
    });

    const updated = await service.readSettings();
    expect(updated.experimental.diffCondensation).toEqual({
      enabled: { value: true, source: "config" },
      model: { value: "grok-3", source: "config" },
    });

    await service.writeConfigPatch({
      experimental: {
        diffCondensation: { model: "auto" },
      },
    });

    const reverted = await service.readSettings();
    expect(reverted.experimental.diffCondensation.model.value).toBe("auto");
    // enabled stays true because the patch only updated model
    expect(reverted.experimental.diffCondensation.enabled.value).toBe(true);
  });

  it("defaults Full Access risk warning dismissal to false and persists it", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const initial = await service.readSettings();
    expect(initial.experimental.fullAccessRiskWarningDismissed).toEqual({
      value: false,
      source: "default",
    });

    await service.writeConfigPatch({
      experimental: {
        fullAccessRiskWarningDismissed: true,
      },
    });

    const updated = await service.readSettings();
    expect(updated.experimental.fullAccessRiskWarningDismissed).toEqual({
      value: true,
      source: "config",
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "full_access_risk_warning_dismissed = true",
    );
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

    await service.writeConfigPatch({
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

    const snapshot = await service.readSettings();
    expect(snapshot.configError).toBeUndefined();
    expect(snapshot.messaging.telegram.enabled.value).toBe(true);
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

    await service.writeConfigPatch({
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
