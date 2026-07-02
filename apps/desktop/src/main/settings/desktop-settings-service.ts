import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  DesktopAuthorizedContact,
  DesktopCodexAuthProfileDiscoverySnapshot,
  DesktopCodexProfileModel,
  DesktopGitDiscoverySnapshot,
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopIntegratedTerminalWindowsShell,
  DesktopMessagingAuthorizationMode,
  DesktopMessagingFullAccessWarningGlobalPolicy,
  DesktopMessagingImageProfile,
  DesktopMessagingResponseMode,
  DesktopMessagingSlackChannelUserAccessMode,
  DesktopMessagingSlackDmAccessMode,
  DesktopOnboardingCompletedSource,
  DesktopOnboardingSnapshot,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
  DesktopUpdateChannel,
  DesktopWorktreeStorageLocation,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import { execFile } from "node:child_process";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT,
  DESKTOP_CODEX_PROFILE_MODEL_DEFAULT,
  DESKTOP_HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
  DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT,
  DESKTOP_UPDATE_CHANNEL_DEFAULT,
  DESKTOP_WORKTREE_STORAGE_DEFAULT,
} from "@pwragent/shared";
import { DEFAULT_PASTED_IMAGE_MAX_PATCHES } from "../../shared/image-normalization";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
  userHomeWorktreesRoot,
  type DesktopSettingsConfig,
} from "./desktop-config";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import type { DesktopSecretStore } from "./desktop-secret-store";
import {
  CHAT_REPLY_COMPOSER_ENV,
  ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  ACP_AGENTS_GROK_CLI_PATH_ENV,
  ACP_AGENTS_KIMI_CLI_PATH_ENV,
  ACP_AGENTS_QWEN_CLI_PATH_ENV,
  AGENT_CORE_GROK_ENV,
  CODEX_COMMAND_ENV,
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_GUILDS_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  FEISHU_APP_ID_ENV,
  FEISHU_APP_SECRET_ENV,
  FEISHU_AUTHORIZED_CHATS_ENV,
  FEISHU_AUTHORIZED_TENANTS_ENV,
  FEISHU_AUTHORIZED_USER_IDS_ENV,
  FEISHU_CALLBACK_BASE_URL_ENV,
  FEISHU_ENABLED_ENV,
  FEISHU_ENCRYPT_KEY_ENV,
  FEISHU_INBOUND_MODE_ENV,
  FEISHU_REGISTER_SLASH_COMMANDS_ENV,
  FEISHU_SLASH_COMMAND_PREFIX_ENV,
  FEISHU_STREAMING_RESPONSES_ENV,
  FEISHU_TENANT_REGION_ENV,
  FEISHU_TENANT_URL_ENV,
  FEISHU_VERIFICATION_TOKEN_ENV,
  GH_COMMAND_ENV,
  LINE_AUTHORIZED_GROUPS_ENV,
  LINE_AUTHORIZED_ROOMS_ENV,
  LINE_AUTHORIZED_USER_IDS_ENV,
  LINE_BOT_USER_ID_ENV,
  LINE_CALLBACK_BASE_URL_ENV,
  LINE_CHANNEL_ACCESS_TOKEN_ENV,
  LINE_CHANNEL_SECRET_ENV,
  LINE_ENABLED_ENV,
  LINE_STREAMING_RESPONSES_ENV,
  LINE_WEBHOOK_URL_ENV,
  MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV,
  MATTERMOST_AUTHORIZED_TEAMS_ENV,
  MATTERMOST_AUTHORIZED_USER_IDS_ENV,
  MATTERMOST_BOT_TOKEN_ENV,
  MATTERMOST_CALLBACK_BASE_URL_ENV,
  MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
  MATTERMOST_ENABLED_ENV,
  MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
  MATTERMOST_SERVER_URL_ENV,
  MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
  MATTERMOST_STREAMING_RESPONSES_ENV,
  MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  SLACK_APP_TOKEN_ENV,
  SLACK_AUTHORIZED_USER_IDS_ENV,
  SLACK_AUTHORIZED_WORKSPACES_ENV,
  SLACK_BOT_TOKEN_ENV,
  SLACK_ENABLED_ENV,
  SLACK_INBOUND_MODE_ENV,
  SLACK_REGISTER_SLASH_COMMANDS_ENV,
  SLACK_SIGNING_SECRET_ENV,
  SLACK_SLASH_COMMAND_PREFIX_ENV,
  SLACK_STREAMING_RESPONSES_ENV,
  SLACK_WORKSPACE_URL_ENV,
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
  WORKTREE_STORAGE_ENV,
  readEnvBoolean,
  readEnvInteger,
  readEnvList,
  readEnvMessagingImageProfile,
  readEnvString,
  readEnvWorktreeStorage,
} from "./desktop-settings-env";
import { discoverCodexCommands } from "@pwrdrvr/codex-discovery";
import {
  discoverCodexAuthProfiles,
  resolveCodexHomeForProfile,
} from "@pwrdrvr/codex-discovery";
import { discoverDesktopApplications } from "./application-discovery";
import { discoverGitCommands } from "./git-discovery";
import { discoverGhCommands } from "./gh-discovery";
import { getMainLogger } from "../log";
// Login-shell PATH hydration is now shared via @pwrdrvr/agent-transport (it was
// extracted FROM this file). Behavior-identical: same `mergeLoginShellEnvIntoEnv`
// shape + the `resolveShellEnv` test seam; the kit takes an injected logger
// (passed below) where the in-tree copy hardcoded `getMainLogger`.
import { mergeLoginShellEnvIntoEnv } from "@pwrdrvr/agent-transport";

const LOGIN_SHELL_ENV_MARKER_START = "__PWRAGENT_LOGIN_SHELL_ENV_START__";
const LOGIN_SHELL_ENV_MARKER_END = "__PWRAGENT_LOGIN_SHELL_ENV_END__";
const LOGIN_SHELL_ENV_TIMEOUT_MS = 2_500;
const LOGIN_SHELL_ENV_MAX_BUFFER = 1024 * 1024;

// Codex home/profile paths come back from `@pwrdrvr/codex-discovery` via
// `path.join`/`path.resolve`, which emit backslashes on Windows
// (`C:\Users\…\.codex\profiles\work`). These strings are surfaced as
// stable directory identifiers in the settings snapshot, so normalize them
// to forward slashes on all platforms. No-op on POSIX (no backslashes to
// replace); on Windows this keeps `effectiveCodexHome`/`profileRoot`/
// per-profile `codexHome` identifiers consistent with the rest of the app's
// forward-slashed directory ids. This only touches the returned identifier
// strings — the discovery package still does its fs reads against the
// native (possibly backslashed) paths internally.
function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeCodexProfilesSnapshot(
  snapshot: DesktopCodexAuthProfileDiscoverySnapshot,
): DesktopCodexAuthProfileDiscoverySnapshot {
  return {
    ...snapshot,
    profileRoot: toForwardSlashes(snapshot.profileRoot),
    effectiveCodexHome: toForwardSlashes(snapshot.effectiveCodexHome),
    profiles: snapshot.profiles.map((profile) => ({
      ...profile,
      codexHome: toForwardSlashes(profile.codexHome),
    })),
  };
}

type DesktopSettingsServiceOptions = {
  configPath?: string;
  defaultDeveloperMode?: boolean;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  secretStore: DesktopSecretStore;
  now?: () => number;
  resolveCodexShellEnv?: (
    env: NodeJS.ProcessEnv
  ) => NodeJS.ProcessEnv | undefined;
  /**
   * Side-effect hook invoked from `writeConfigPatch` whenever a write
   * touched `[general.appearance]`. The production wiring routes this
   * to `broadcastAppearanceChange` so secondary windows (changelog,
   * app-log, license, messaging activity) can re-apply
   * `<html data-theme/data-density>` live. Tests can omit it (or
   * provide a spy) without coupling the service to the window layer.
   */
  onAppearanceChange?: (appearance: {
    theme: DesktopAppearanceTheme;
    density: DesktopAppearanceDensity;
  }) => void;
};

type ConfigReadResult = {
  config: DesktopSettingsConfig;
  error?: string;
};

const DEFAULT_MESSAGING_INPUT_DEBOUNCE_MS = 500;
const MAX_MESSAGING_INPUT_DEBOUNCE_MS = 5_000;
const DEFAULT_HOT_CPU_HEAP_SNAPSHOT_LIMIT = 2;
const MIN_HOT_CPU_HEAP_SNAPSHOT_LIMIT = 2;
const MAX_HOT_CPU_HEAP_SNAPSHOT_LIMIT = 3;

/**
 * Feature gate for the deferred Codex `listThreads` probe.
 *
 * When `false` (current default), `isCodexBootstrapDeferred()` always
 * returns `false` regardless of what's persisted under `[onboarding]` in
 * the per-profile `config.toml`. Brand-new profiles still receive their
 * Codex thread list at startup exactly as they did before this gate
 * landed; the `[onboarding] completed = false` marker is written to disk
 * but has no read-side effect.
 *
 * Flip to `true` in the first-run wizard PR (#491) once the wizard UI
 * is in place to drive the operator through Shared / Isolated / Multiple
 * and call `completeOnboardingCodexBootstrap()`. Until then this stays
 * dormant so a fresh profile created via Settings → Profiles (or
 * `PWRAGENT_PROFILE=<new>`) without the wizard does not get stranded
 * with an empty sidebar.
 *
 * Tests that exercise the gate's effect inject `isCodexBootstrapDeferred`
 * directly via the backend-registry constructor option or mock the
 * settings singleton, so this constant does not block test coverage.
 */
// Flipped on rebase by the first-run wizard PR (#491) to activate the
// gate. With the wizard now shipping, brand-new profiles get a deferred
// Codex `listThreads` probe until the operator clicks Finish or Skip and
// the wizard calls `completeOnboardingCodexBootstrap`. Pre-existing
// profiles read as `completedSource = "migrated"` and bypass the gate.
export const ONBOARDING_CODEX_GATE_ENABLED = true;
const FEISHU_DEFAULT_TENANT_URL = "https://open.feishu.cn";
const LARK_DEFAULT_TENANT_URL = "https://open.larksuite.com";
const FEISHU_DEFAULT_CALLBACK_BASE_URL = "http://127.0.0.1:47823";
const settingsLog = getMainLogger("pwragent:settings");

function clampInteger(value: number, maxValue: number): number {
  return Math.min(Math.max(value, 0), maxValue);
}

function defaultLoginShellCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.SHELL?.trim(),
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ].filter((shell): shell is string => Boolean(shell));
}

function extractMarkedEnv(output: string): NodeJS.ProcessEnv | undefined {
  const lines = output.split(/\r?\n/);
  const startIndex = lines.indexOf(LOGIN_SHELL_ENV_MARKER_START);
  const endIndex = lines.indexOf(LOGIN_SHELL_ENV_MARKER_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  const shellEnv: NodeJS.ProcessEnv = {};
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    shellEnv[line.slice(0, equalsIndex)] = line.slice(equalsIndex + 1);
  }
  return shellEnv;
}

async function resolveInteractiveLoginShellEnvAsync(
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }

  const command = [
    `command printf '${LOGIN_SHELL_ENV_MARKER_START}\\n'`,
    "command env",
    `command printf '${LOGIN_SHELL_ENV_MARKER_END}\\n'`,
  ].join("; ");
  const failures: Array<{ error: string; shell: string }> = [];

  for (const shell of defaultLoginShellCandidates(env)) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          shell,
          ["-ilc", command],
          {
            encoding: "utf8",
            env,
            maxBuffer: LOGIN_SHELL_ENV_MAX_BUFFER,
            timeout: LOGIN_SHELL_ENV_TIMEOUT_MS,
          },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout);
          },
        );
      });
      const shellEnv = extractMarkedEnv(output);
      if (shellEnv) {
        return shellEnv;
      }
      failures.push({ shell, error: "missing env markers" });
    } catch (error) {
      failures.push({
        shell,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getMainLogger("pwragent:shell-environment").warn("login-shell-env-failed", {
    failures,
  });
  return undefined;
}

export class DesktopSettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly argv: readonly string[];
  private readonly configPath: string;
  private readonly now: () => number;
  private readonly startupCodexHome?: string;
  private loggedObsoleteComposerConfig = false;
  private loggedObsoleteComposerEnv = false;
  // Per-instance memoization for executable discovery. Each discovery is a
  // pure function of `this.env` (fixed at construction), the filesystem, and a
  // handful of config strings — so re-running them on every readSettings() just
  // re-spawns the same probe child processes. That's wasteful everywhere and,
  // on Windows where process spawn is far slower, multiple readSettings() calls
  // in a single unit test could blow past the 5s test timeout. Caching is
  // behavior-preserving: git/applications are config-independent (cached as a
  // single promise), while codex/gh are keyed on the exact config input they
  // consume, so a test that changes that input still triggers a fresh probe.
  private gitDiscoveryPromise?: Promise<DesktopGitDiscoverySnapshot>;
  private applicationsDiscoveryPromise?: Promise<DesktopApplicationsSnapshot>;
  private codexDiscoveryCache?: {
    key: string;
    promise: ReturnType<typeof discoverCodexCommands>;
  };
  private ghDiscoveryCache?: {
    key: string;
    promise: ReturnType<typeof discoverGhCommands>;
  };
  private codexSpawnEnv?: NodeJS.ProcessEnv;
  private codexSpawnEnvHydrationPromise?: Promise<NodeJS.ProcessEnv>;
  private terminalSpawnEnv?: NodeJS.ProcessEnv;
  private terminalSpawnEnvHydrationPromise?: Promise<NodeJS.ProcessEnv>;

  constructor(private readonly options: DesktopSettingsServiceOptions) {
    this.env = options.env ?? process.env;
    this.argv = options.argv ?? process.argv;
    this.configPath =
      options.configPath ??
      resolveDesktopConfigPath({ argv: this.argv, env: this.env });
    this.now = options.now ?? Date.now;
    this.startupCodexHome = resolveCodexHomeForProfile(
      this.readConfig().config.models?.codex?.profile,
      { env: this.env },
    );
  }

  async readSettings(): Promise<DesktopSettingsSnapshot> {
    const { config, error } = this.readConfig();
    const secretStorage = this.options.secretStore.describe();

    const telegramBotToken = await this.readSecretState(
      "telegramBotToken",
      TELEGRAM_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const discordBotToken = await this.readSecretState(
      "discordBotToken",
      DISCORD_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const mattermostBotToken = await this.readSecretState(
      "mattermostBotToken",
      MATTERMOST_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const mattermostHmacSecret = await this.readSecretState(
      "mattermostHmacSecret",
      MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
      secretStorage.available,
    );
    const slackBotToken = await this.readSecretState(
      "slackBotToken",
      SLACK_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const slackAppToken = await this.readSecretState(
      "slackAppToken",
      SLACK_APP_TOKEN_ENV,
      secretStorage.available,
    );
    const slackSigningSecret = await this.readSecretState(
      "slackSigningSecret",
      SLACK_SIGNING_SECRET_ENV,
      secretStorage.available,
    );
    const feishuAppId = await this.readSecretState(
      "feishuAppId",
      FEISHU_APP_ID_ENV,
      secretStorage.available,
    );
    const feishuAppSecret = await this.readSecretState(
      "feishuAppSecret",
      FEISHU_APP_SECRET_ENV,
      secretStorage.available,
    );
    const feishuEncryptKey = await this.readSecretState(
      "feishuEncryptKey",
      FEISHU_ENCRYPT_KEY_ENV,
      secretStorage.available,
    );
    const feishuVerificationToken = await this.readSecretState(
      "feishuVerificationToken",
      FEISHU_VERIFICATION_TOKEN_ENV,
      secretStorage.available,
    );
    const lineChannelAccessToken = await this.readSecretState(
      "lineChannelAccessToken",
      LINE_CHANNEL_ACCESS_TOKEN_ENV,
      secretStorage.available,
    );
    const lineChannelSecret = await this.readSecretState(
      "lineChannelSecret",
      LINE_CHANNEL_SECRET_ENV,
      secretStorage.available,
    );
    const grokApiKey = await this.readSecretState(
      "grokApiKey",
      undefined,
      secretStorage.available,
    );
    const codexDiscovery = await this.discoverCodexCommandsCached(
      config.models?.codex?.path,
    );
    const codexProfiles = normalizeCodexProfilesSnapshot(
      discoverCodexAuthProfiles({
        configuredProfile: config.models?.codex?.profile,
        env: this.env,
      }),
    );
    const ghDiscovery = await this.discoverGhCommandsCached(
      config.applications?.gh?.path,
    );
    const gitDiscovery = await this.discoverGitCommandsCached();
    const applications = await this.discoverDesktopApplicationsCached();
    const preferredEditorId = this.resolveConfigString(
      config.applications?.editor?.preferredId,
    );
    const preferredTerminalId = this.resolveConfigString(
      config.applications?.terminal?.preferredId,
    );
    const messagingOverride = resolveRuntimeMessagingOverride({
      argv: this.argv,
      env: this.env,
    });
    const feishuTenantRegion = this.resolveFeishuTenantRegion(
      config.messaging?.feishu?.tenantRegion,
    );
    const slackAuthorizedWorkspaces = this.resolveList(
      config.messaging?.slack?.authorizedWorkspaces,
      SLACK_AUTHORIZED_WORKSPACES_ENV,
    );
    const slackAuthorizedChannels = this.resolveConfigList(
      config.messaging?.slack?.authorizedChannels,
    );
    const slackTeamAuthorizationMode = this.resolveSlackTeamAuthorizationMode(
      config.messaging?.slack?.teamAuthorizationMode,
      slackAuthorizedWorkspaces.value,
    );
    const slackChannelAuthorizationMode = this.resolveSlackChannelAuthorizationMode(
      config.messaging?.slack?.channelAuthorizationMode,
      slackAuthorizedWorkspaces.value,
      slackAuthorizedChannels.value,
    );
    const slackDmAccessMode = this.resolveSlackDmAccessMode(
      config.messaging?.slack?.dmAccessMode,
    );
    const slackChannelUserAccessMode = this.resolveSlackChannelUserAccessMode(
      config.messaging?.slack?.channelUserAccessMode,
    );

    return {
      fetchedAt: this.now(),
      configPath: this.configPath,
      configError: error,
      runtime: {
        messaging: {
          disabled: messagingOverride.disabled,
          overrideActive: messagingOverride.disabled,
          ...(messagingOverride.disabled
            ? { disabledReasonKind: "explicit_override" as const }
            : {}),
          ...(messagingOverride.reason
            ? { disabledReason: messagingOverride.reason }
            : {}),
        },
      },
      secretStorage,
      general: {
        confirmQuitWithInProgressThreads: this.resolveConfigBoolean(
          config.general?.confirmQuitWithInProgressThreads,
          true,
        ),
        developerMode: this.resolveConfigBoolean(
          config.general?.developerMode,
          this.defaultDeveloperMode(),
        ),
        hotCpuProfilingEnabled: this.resolveConfigBoolean(
          config.general?.hotCpuProfilingEnabled,
          false,
        ),
        hotCpuProfilingStartDelayMs: this.resolveHotCpuProfileStartDelayMs(
          config.general?.hotCpuProfilingStartDelayMs,
        ),
        hotCpuProfilingTriggerMode: this.resolveHotCpuProfileTriggerMode(
          config.general?.hotCpuProfilingTriggerMode,
        ),
        hotCpuProfilingSlowburnThresholdPercent: this.resolveHotCpuSlowburnThresholdPercent(
          config.general?.hotCpuProfilingSlowburnThresholdPercent,
        ),
        hotCpuProfilingCaptureHeapSnapshot: this.resolveConfigBoolean(
          config.general?.hotCpuProfilingCaptureHeapSnapshot,
          false,
        ),
        hotCpuProfilingHeapSnapshotLimit: this.resolveHotCpuHeapSnapshotLimit(
          config.general?.hotCpuProfilingHeapSnapshotLimit,
        ),
        notificationsEnabled: this.resolveConfigBoolean(
          config.general?.notificationsEnabled,
          false,
        ),
        appearance: {
          theme: this.resolveAppearanceTheme(
            config.general?.appearance?.theme,
          ),
          density: this.resolveAppearanceDensity(
            config.general?.appearance?.density,
          ),
        },
        codexProfileModel: this.resolveCodexProfileModel(
          config.general?.codexProfileModel,
        ),
        messagingAcknowledgment: {
          value: config.general?.messagingAcknowledgment ?? null,
          source:
            config.general?.messagingAcknowledgment === undefined
              ? "default"
              : "config",
        },
      },
      onboarding: this.resolveOnboarding(config.onboarding),
      experimental: {
        chatReplyComposer: this.resolveComposer(
          config.experimental?.chatReplyComposer,
        ),
        fullAccessRiskWarningDismissed: this.resolveConfigBoolean(
          config.experimental?.fullAccessRiskWarningDismissed,
          false,
        ),
        liveTranscriptEventFiltering: this.resolveConfigBoolean(
          config.experimental?.liveTranscriptEventFiltering,
          false,
        ),
        lightweightNavigationRefresh: this.resolveConfigBoolean(
          config.experimental?.lightweightNavigationRefresh,
          false,
        ),
        threadPricingSummary: this.resolveConfigBoolean(
          config.experimental?.threadPricingSummary,
          true,
        ),
        threadPricingDisplayUsd: this.resolveConfigBoolean(
          config.experimental?.threadPricingDisplayUsd,
          true,
        ),
        threadPricingDisplayCodexCredits: this.resolveConfigBoolean(
          config.experimental?.threadPricingDisplayCodexCredits,
          false,
        ),
        codexDefaultModeRequestUserInput: this.resolveConfigBoolean(
          config.experimental?.codexDefaultModeRequestUserInput,
          false,
        ),
        diffCondensation: {
          enabled: this.resolveDiffCondensationEnabled(
            config.experimental?.diffCondensation?.enabled,
          ),
          model: this.resolveDiffCondensationModel(
            config.experimental?.diffCondensation?.model,
          ),
        },
        agentCoreGrok: this.resolveBoolean(
          config.experimental?.agentCoreGrok,
          false,
          AGENT_CORE_GROK_ENV,
        ),
      },
      imageUploads: {
        pastedImageMaxPatches: this.resolvePastedImageMaxPatches(
          config.imageUploads?.pastedImageMaxPatches,
        ),
      },
      updates: {
        channel: this.resolveUpdateChannelValue(config.updates?.channel),
      },
      integratedTerminal: {
        windowsShell: this.resolveIntegratedTerminalWindowsShellValue(
          config.integratedTerminal?.windowsShell,
        ),
      },
      ui: {
        sidebarHidden: this.resolveConfigBoolean(
          config.ui?.sidebarHidden,
          false,
        ),
        // Default the context rail to pinned-open so first-run users discover
        // it exists. An explicit unpin persists `false` (see the inverted
        // sentinel in desktopSettingsPatchToEdits); absence means "never set".
        contextRailPinned: this.resolveConfigBoolean(
          config.ui?.contextRailPinned,
          true,
        ),
        activeContextTab: {
          value: config.ui?.activeContextTab ?? "info",
          source: config.ui?.activeContextTab === undefined ? "default" : "config",
        },
        editedFilesDock: {
          value: config.ui?.editedFilesDock ?? "above",
          source: config.ui?.editedFilesDock === undefined ? "default" : "config",
        },
        actionRunsDock: {
          value: config.ui?.actionRunsDock ?? "above",
          source: config.ui?.actionRunsDock === undefined ? "default" : "config",
        },
      },
      messaging: {
        enabled: this.resolveConfigBoolean(config.messaging?.enabled, true),
        allowFullAccessEscalation: this.resolveConfigBoolean(
          config.messaging?.allowFullAccessEscalation,
          true,
        ),
        allowFullAccessThreadResume: this.resolveConfigBoolean(
          config.messaging?.allowFullAccessThreadResume,
          true,
        ),
        fullAccessWarning: this.resolveConfigFullAccessWarningPolicy(
          config.messaging?.fullAccessWarning,
        ),
        inputDebounceMs: this.resolveClampedNumber(
          config.messaging?.inputDebounceMs,
          DEFAULT_MESSAGING_INPUT_DEBOUNCE_MS,
          MESSAGING_INPUT_DEBOUNCE_MS_ENV,
          MAX_MESSAGING_INPUT_DEBOUNCE_MS,
        ),
        toolUpdateMode: this.resolveToolUpdateMode(
          config.messaging?.toolUpdateMode,
        ),
        attachments: {
          imageProfile: this.resolveMessagingImageProfile(
            config.messaging?.attachments?.imageProfile,
          ),
          maxAttachmentBytes: this.resolveNumber(
            config.messaging?.attachments?.maxAttachmentBytes,
            10 * 1024 * 1024,
            MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
          ),
          maxAttachmentCount: this.resolveNumber(
            config.messaging?.attachments?.maxAttachmentCount,
            4,
            MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
          ),
        },
        telegram: {
          enabled: this.resolveBoolean(
            config.messaging?.telegram?.enabled,
            false,
            TELEGRAM_ENABLED_ENV,
          ),
          responseMode: this.resolveConfigMessagingResponseMode(
            config.messaging?.telegram?.responseMode,
            "every_message",
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.telegram?.streamingResponses,
            false,
            TELEGRAM_STREAMING_RESPONSES_ENV,
          ),
          botToken: telegramBotToken,
          authorizedUserIds: this.resolveList(
            config.messaging?.telegram?.authorizedUserIds,
            TELEGRAM_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedSupergroups: this.resolveList(
            config.messaging?.telegram?.authorizedSupergroups,
            TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
          ),
        },
        discord: {
          enabled: this.resolveBoolean(
            config.messaging?.discord?.enabled,
            false,
            DISCORD_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.discord?.streamingResponses,
            false,
            DISCORD_STREAMING_RESPONSES_ENV,
          ),
          botToken: discordBotToken,
          applicationId: this.resolveString(
            config.messaging?.discord?.applicationId,
            DISCORD_APPLICATION_ID_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.discord?.authorizedUserIds,
            DISCORD_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedGuilds: this.resolveList(
            config.messaging?.discord?.authorizedGuilds,
            DISCORD_AUTHORIZED_GUILDS_ENV,
          ),
        },
        mattermost: {
          enabled: this.resolveBoolean(
            config.messaging?.mattermost?.enabled,
            false,
            MATTERMOST_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.mattermost?.streamingResponses,
            false,
            MATTERMOST_STREAMING_RESPONSES_ENV,
          ),
          botToken: mattermostBotToken,
          hmacSecret: mattermostHmacSecret,
          serverUrl: this.resolveString(
            config.messaging?.mattermost?.serverUrl,
            MATTERMOST_SERVER_URL_ENV,
          ),
          callbackBaseUrl: this.resolveString(
            config.messaging?.mattermost?.callbackBaseUrl,
            MATTERMOST_CALLBACK_BASE_URL_ENV,
          ),
          slashCommandPrefix: this.resolveStringWithDefault(
            config.messaging?.mattermost?.slashCommandPrefix,
            "pwragent_",
            MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
          ),
          registerSlashCommands: this.resolveBoolean(
            config.messaging?.mattermost?.registerSlashCommands,
            false,
            MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.mattermost?.authorizedUserIds,
            MATTERMOST_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedTeams: this.resolveList(
            config.messaging?.mattermost?.authorizedTeams,
            MATTERMOST_AUTHORIZED_TEAMS_ENV,
          ),
          authorizedConversations: this.resolveList(
            config.messaging?.mattermost?.authorizedConversations,
            MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV,
          ),
        },
        slack: {
          enabled: this.resolveBoolean(
            config.messaging?.slack?.enabled,
            false,
            SLACK_ENABLED_ENV,
          ),
          responseMode: this.resolveConfigMessagingResponseMode(
            config.messaging?.slack?.responseMode,
            "mention_only",
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.slack?.streamingResponses,
            false,
            SLACK_STREAMING_RESPONSES_ENV,
          ),
          botToken: slackBotToken,
          appToken: slackAppToken,
          signingSecret: slackSigningSecret,
          workspaceUrl: this.resolveString(
            config.messaging?.slack?.workspaceUrl,
            SLACK_WORKSPACE_URL_ENV,
          ),
          inboundMode: this.resolveSlackInboundMode(
            config.messaging?.slack?.inboundMode,
          ),
          teamAuthorizationMode: slackTeamAuthorizationMode,
          channelAuthorizationMode: slackChannelAuthorizationMode,
          dmAccessMode: slackDmAccessMode,
          channelUserAccessMode: slackChannelUserAccessMode,
          slashCommandPrefix: this.resolveStringWithDefault(
            config.messaging?.slack?.slashCommandPrefix,
            "pwragent_",
            SLACK_SLASH_COMMAND_PREFIX_ENV,
          ),
          registerSlashCommands: this.resolveBoolean(
            config.messaging?.slack?.registerSlashCommands,
            false,
            SLACK_REGISTER_SLASH_COMMANDS_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.slack?.authorizedUserIds,
            SLACK_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedWorkspaces: slackAuthorizedWorkspaces,
          authorizedChannels: slackAuthorizedChannels,
        },
        feishu: {
          enabled: this.resolveBoolean(
            config.messaging?.feishu?.enabled,
            false,
            FEISHU_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.feishu?.streamingResponses,
            false,
            FEISHU_STREAMING_RESPONSES_ENV,
          ),
          appId: feishuAppId,
          appSecret: feishuAppSecret,
          encryptKey: feishuEncryptKey,
          verificationToken: feishuVerificationToken,
          inboundMode: this.resolveFeishuInboundMode(
            config.messaging?.feishu?.inboundMode,
          ),
          tenantRegion: feishuTenantRegion,
          tenantUrl: this.resolveFeishuTenantUrl(
            config.messaging?.feishu?.tenantUrl,
            feishuTenantRegion.value,
          ),
          callbackBaseUrl: this.resolveFeishuCallbackBaseUrl(
            config.messaging?.feishu?.callbackBaseUrl,
            FEISHU_CALLBACK_BASE_URL_ENV,
          ),
          slashCommandPrefix: this.resolveStringWithDefault(
            config.messaging?.feishu?.slashCommandPrefix,
            "pwragent_",
            FEISHU_SLASH_COMMAND_PREFIX_ENV,
          ),
          registerSlashCommands: this.resolveBoolean(
            config.messaging?.feishu?.registerSlashCommands,
            false,
            FEISHU_REGISTER_SLASH_COMMANDS_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.feishu?.authorizedUserIds,
            FEISHU_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedChats: this.resolveList(
            config.messaging?.feishu?.authorizedChats,
            FEISHU_AUTHORIZED_CHATS_ENV,
          ),
          authorizedTenants: this.resolveList(
            config.messaging?.feishu?.authorizedTenants,
            FEISHU_AUTHORIZED_TENANTS_ENV,
          ),
        },
        line: {
          enabled: this.resolveBoolean(
            config.messaging?.line?.enabled,
            false,
            LINE_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.line?.streamingResponses,
            false,
            LINE_STREAMING_RESPONSES_ENV,
          ),
          channelAccessToken: lineChannelAccessToken,
          channelSecret: lineChannelSecret,
          webhookUrl: this.resolveString(
            config.messaging?.line?.webhookUrl,
            LINE_WEBHOOK_URL_ENV,
          ),
          callbackBaseUrl: this.resolveStringWithDefault(
            config.messaging?.line?.callbackBaseUrl,
            "http://127.0.0.1:47822",
            LINE_CALLBACK_BASE_URL_ENV,
          ),
          botUserId: this.resolveString(
            config.messaging?.line?.botUserId,
            LINE_BOT_USER_ID_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.line?.authorizedUserIds,
            LINE_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedGroups: this.resolveList(
            config.messaging?.line?.authorizedGroups,
            LINE_AUTHORIZED_GROUPS_ENV,
          ),
          authorizedRooms: this.resolveList(
            config.messaging?.line?.authorizedRooms,
            LINE_AUTHORIZED_ROOMS_ENV,
          ),
        },
      },
      models: {
        codex: {
          path: this.resolveString(config.models?.codex?.path, CODEX_COMMAND_ENV),
          profile: this.resolveConfigString(config.models?.codex?.profile),
          discovery: codexDiscovery,
          profiles: codexProfiles,
        },
        grok: {
          apiKey: grokApiKey,
        },
      },
      acpAgents: {
        gemini: {
          cliPath: this.resolveString(
            config.acpAgents?.gemini?.cliPath,
            ACP_AGENTS_GEMINI_CLI_PATH_ENV,
          ),
          enabled: config.acpAgents?.gemini?.enabled ?? true,
        },
        grok: {
          cliPath: this.resolveString(
            config.acpAgents?.grok?.cliPath,
            ACP_AGENTS_GROK_CLI_PATH_ENV,
          ),
          enabled: config.acpAgents?.grok?.enabled ?? true,
        },
        kimi: {
          cliPath: this.resolveString(
            config.acpAgents?.kimi?.cliPath,
            ACP_AGENTS_KIMI_CLI_PATH_ENV,
          ),
          enabled: config.acpAgents?.kimi?.enabled ?? true,
        },
        qwen: {
          cliPath: this.resolveString(
            config.acpAgents?.qwen?.cliPath,
            ACP_AGENTS_QWEN_CLI_PATH_ENV,
          ),
          enabled: config.acpAgents?.qwen?.enabled ?? true,
        },
      },
      applications: {
        ...applications,
        preferredEditorId,
        preferredTerminalId,
        gh: {
          path: this.resolveString(config.applications?.gh?.path, GH_COMMAND_ENV),
          discovery: ghDiscovery,
        },
        git: {
          discovery: gitDiscovery,
        },
      },
      worktrees: this.resolveWorktrees(config.worktrees?.storage),
    };
  }

  // git/applications discovery is config-independent (depends only on this.env
  // + filesystem), so memoize the promise per instance to avoid re-spawning the
  // same probe child processes on every readSettings() call. See the cache
  // field declarations for the Windows-timeout motivation.
  private discoverGitCommandsCached(): Promise<DesktopGitDiscoverySnapshot> {
    this.gitDiscoveryPromise ??= discoverGitCommands({ env: this.env });
    return this.gitDiscoveryPromise;
  }

  private discoverDesktopApplicationsCached(): Promise<DesktopApplicationsSnapshot> {
    this.applicationsDiscoveryPromise ??= discoverDesktopApplications({
      env: this.env,
    });
    return this.applicationsDiscoveryPromise;
  }

  // codex/gh discovery depends on a single config string. Cache keyed on that
  // string so repeated readSettings() with unchanged config skip the re-spawn,
  // while a test that mutates the configured path re-probes (cache miss).
  private discoverCodexCommandsCached(
    configuredCommand: string | undefined,
  ): ReturnType<typeof discoverCodexCommands> {
    const key = configuredCommand ?? "";
    if (this.codexDiscoveryCache?.key !== key) {
      this.codexDiscoveryCache = {
        key,
        promise: discoverCodexCommands({ configuredCommand, env: this.env }),
      };
    }
    return this.codexDiscoveryCache.promise;
  }

  private discoverGhCommandsCached(
    configuredCommand: string | undefined,
  ): ReturnType<typeof discoverGhCommands> {
    const key = configuredCommand ?? "";
    if (this.ghDiscoveryCache?.key !== key) {
      this.ghDiscoveryCache = {
        key,
        promise: discoverGhCommands({ configuredCommand, env: this.env }),
      };
    }
    return this.ghDiscoveryCache.promise;
  }

  resolveWorktreeStorage(): DesktopWorktreeStorageLocation {
    return this.resolveWorktrees(this.readConfig().config.worktrees?.storage)
      .storage.value;
  }

  resolveUpdateChannel(): DesktopUpdateChannel {
    return this.resolveUpdateChannelValue(this.readConfig().config.updates?.channel)
      .value;
  }

  resolveDeveloperMode(): boolean {
    return this.resolveConfigBoolean(
      this.readConfig().config.general?.developerMode,
      this.defaultDeveloperMode(),
    ).value;
  }

  resolveHotCpuProfilingEnabled(): boolean {
    return this.resolveConfigBoolean(
      this.readConfig().config.general?.hotCpuProfilingEnabled,
      false,
    ).value;
  }

  resolveHotCpuProfilingCaptureHeapSnapshot(): boolean {
    return this.resolveConfigBoolean(
      this.readConfig().config.general?.hotCpuProfilingCaptureHeapSnapshot,
      false,
    ).value;
  }

  resolveHotCpuProfilingStartDelayMs(): DesktopHotCpuProfileStartDelayMs {
    return this.resolveHotCpuProfileStartDelayMs(
      this.readConfig().config.general?.hotCpuProfilingStartDelayMs,
    ).value;
  }

  resolveHotCpuProfilingTriggerMode(): DesktopHotCpuProfileTriggerMode {
    return this.resolveHotCpuProfileTriggerMode(
      this.readConfig().config.general?.hotCpuProfilingTriggerMode,
    ).value;
  }

  resolveHotCpuProfilingSlowburnThresholdPercent(): number {
    return this.resolveHotCpuSlowburnThresholdPercent(
      this.readConfig().config.general?.hotCpuProfilingSlowburnThresholdPercent,
    ).value;
  }

  resolveHotCpuProfilingHeapSnapshotLimit(): number {
    return this.resolveHotCpuHeapSnapshotLimit(
      this.readConfig().config.general?.hotCpuProfilingHeapSnapshotLimit,
    ).value;
  }

  resolveIntegratedTerminalWindowsShell(): DesktopIntegratedTerminalWindowsShell {
    return this.resolveIntegratedTerminalWindowsShellValue(
      this.readConfig().config.integratedTerminal?.windowsShell,
    ).value;
  }

  resolveConfirmQuitWithInProgressThreads(): boolean {
    return this.resolveConfigBoolean(
      this.readConfig().config.general?.confirmQuitWithInProgressThreads,
      true,
    ).value;
  }

  resolveNotificationsEnabled(): boolean {
    return this.resolveConfigBoolean(
      this.readConfig().config.general?.notificationsEnabled,
      false,
    ).value;
  }

  resolveCodexDefaultModeRequestUserInput(): boolean {
    return this.resolveConfigBoolean(
      this.readConfig().config.experimental?.codexDefaultModeRequestUserInput,
      false,
    ).value;
  }

  /**
   * Raw read of the persisted onboarding-completed state. Returns
   * `true` when the wizard has run or when the profile predates the
   * `[onboarding]` table (treated as `"migrated"`). Returns `false`
   * only when the per-profile `config.toml` contains an explicit
   * `[onboarding] completed = false` marker — which is written exactly
   * once, when the profile dir is newly created. See
   * `ensureNamedProfileExists` in `profile.ts`.
   *
   * Callers that want the *gate* behavior (defer the Codex
   * `listThreads` probe) should call `isCodexBootstrapDeferred()`
   * instead — it consults `ONBOARDING_CODEX_GATE_ENABLED` first so the
   * gate stays dormant until the wizard PR flips the constant.
   */
  resolveOnboardingCompleted(): boolean {
    return this.resolveOnboarding(this.readConfig().config.onboarding)
      .completed.value;
  }

  /**
   * Gate for the deferred Codex `listThreads` probe. Returns `true`
   * only when (a) the gate feature is enabled and (b) the persisted
   * onboarding state says the wizard has not yet completed. Defaults
   * to `false` while the gate is dormant so call sites have no
   * behavior change between this PR and the wizard PR's rebase.
   */
  isCodexBootstrapDeferred(): boolean {
    if (!ONBOARDING_CODEX_GATE_ENABLED) {
      return false;
    }
    return !this.resolveOnboardingCompleted();
  }

  async writeConfigPatch(
    patch: DesktopSettingsConfigPatch,
  ): Promise<DesktopSettingsSnapshot> {
    const current = this.readConfig();
    if (current.error) {
      throw new Error(
        `Cannot save settings because ${this.configPath} could not be parsed: ${current.error}`,
      );
    }
    applyDesktopSettingsPatch(this.configPath, patch);
    // Fan out appearance updates to every open window so aux surfaces
    // (changelog, app-log, license, messaging activity) re-apply their
    // <html data-*> attributes live instead of staying stuck on
    // whatever theme they bootstrapped with at window creation. We
    // only fire when the patch *touches* appearance — most settings
    // writes are unrelated and shouldn't churn other windows.
    const appearancePatch = patch.general?.appearance;
    if (
      appearancePatch
      && (appearancePatch.theme !== undefined
        || appearancePatch.density !== undefined)
    ) {
      const next = this.readConfig().config.general?.appearance;
      this.options.onAppearanceChange?.({
        theme: next?.theme ?? DESKTOP_APPEARANCE_THEME_DEFAULT,
        density: next?.density ?? DESKTOP_APPEARANCE_DENSITY_DEFAULT,
      });
    }
    return this.readSettings();
  }

  async replaceSecret(
    secret: DesktopSettingsSecretName,
    value: string,
  ): Promise<DesktopSettingsSnapshot> {
    await this.options.secretStore.setSecret(secret, value);
    return this.readSettings();
  }

  async clearSecret(
    secret: DesktopSettingsSecretName,
  ): Promise<DesktopSettingsSnapshot> {
    await this.options.secretStore.deleteSecret(secret);
    return this.readSettings();
  }

  async resolveGrokApiKey(): Promise<string | undefined> {
    return await this.options.secretStore.getSecret("grokApiKey");
  }

  resolveTelegramBotTokenSync(): string | undefined {
    return this.resolveSecretSync("telegramBotToken", TELEGRAM_BOT_TOKEN_ENV);
  }

  resolveDiscordBotTokenSync(): string | undefined {
    return this.resolveSecretSync("discordBotToken", DISCORD_BOT_TOKEN_ENV);
  }

  resolveMattermostBotTokenSync(): string | undefined {
    return this.resolveSecretSync(
      "mattermostBotToken",
      MATTERMOST_BOT_TOKEN_ENV,
    );
  }

  resolveMattermostHmacSecretSync(): string | undefined {
    return this.resolveSecretSync(
      "mattermostHmacSecret",
      MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
    );
  }

  resolveMattermostServerUrlSync(): string | undefined {
    return (
      readEnvString(this.env, MATTERMOST_SERVER_URL_ENV)
      ?? this.readConfig().config.messaging?.mattermost?.serverUrl
      ?? undefined
    );
  }

  resolveSlackBotTokenSync(): string | undefined {
    return this.resolveSecretSync("slackBotToken", SLACK_BOT_TOKEN_ENV);
  }

  resolveSlackAppTokenSync(): string | undefined {
    return this.resolveSecretSync("slackAppToken", SLACK_APP_TOKEN_ENV);
  }

  resolveSlackSigningSecretSync(): string | undefined {
    return this.resolveSecretSync("slackSigningSecret", SLACK_SIGNING_SECRET_ENV);
  }

  resolveFeishuAppIdSync(): string | undefined {
    return this.resolveSecretSync("feishuAppId", FEISHU_APP_ID_ENV);
  }

  resolveFeishuAppSecretSync(): string | undefined {
    return this.resolveSecretSync("feishuAppSecret", FEISHU_APP_SECRET_ENV);
  }

  resolveFeishuEncryptKeySync(): string | undefined {
    return this.resolveSecretSync("feishuEncryptKey", FEISHU_ENCRYPT_KEY_ENV);
  }

  resolveFeishuVerificationTokenSync(): string | undefined {
    return this.resolveSecretSync(
      "feishuVerificationToken",
      FEISHU_VERIFICATION_TOKEN_ENV,
    );
  }

  resolveFeishuTenantUrlSync(): string | undefined {
    const config = this.readConfig().config.messaging?.feishu;
    const tenantRegion = this.resolveFeishuTenantRegion(config?.tenantRegion).value;
    const configTenantUrl =
      config?.tenantUrl === FEISHU_DEFAULT_TENANT_URL ||
        config?.tenantUrl === LARK_DEFAULT_TENANT_URL
        ? undefined
        : config?.tenantUrl;
    return (
      readEnvString(this.env, FEISHU_TENANT_URL_ENV)
      ?? configTenantUrl
      ?? feishuTenantUrlForRegion(tenantRegion)
    );
  }

  resolveLineChannelAccessTokenSync(): string | undefined {
    return this.resolveSecretSync(
      "lineChannelAccessToken",
      LINE_CHANNEL_ACCESS_TOKEN_ENV,
    );
  }

  resolveLineChannelSecretSync(): string | undefined {
    return this.resolveSecretSync("lineChannelSecret", LINE_CHANNEL_SECRET_ENV);
  }

  resolveGrokApiKeySync(): string | undefined {
    return this.options.secretStore.getSecretSync?.("grokApiKey");
  }

  resolveCodexCommandPreference(): string | undefined {
    return (
      readEnvString(this.env, CODEX_COMMAND_ENV)
      || this.readConfig().config.models?.codex?.path
      || undefined
    );
  }

  resolveCodexSpawnEnv(): NodeJS.ProcessEnv {
    if (this.options.resolveCodexShellEnv) {
      return this.withStartupCodexHome(
        mergeLoginShellEnvIntoEnv(this.env, {
          resolveShellEnv: this.options.resolveCodexShellEnv,
          // Preserve the in-tree copy's diagnostic logging (the kit defaults to
          // no-op when no logger is injected).
          logger: getMainLogger("pwragent:shell-environment"),
        }),
      );
    }

    const targetEnv = this.ensureBaseCodexSpawnEnv();
    void this.resolveCodexSpawnEnvAsync();
    return targetEnv;
  }

  async resolveCodexSpawnEnvAsync(): Promise<NodeJS.ProcessEnv> {
    if (this.options.resolveCodexShellEnv) {
      return this.resolveCodexSpawnEnv();
    }

    if (this.codexSpawnEnvHydrationPromise) {
      return await this.codexSpawnEnvHydrationPromise;
    }

    const targetEnv = this.ensureBaseCodexSpawnEnv();
    this.codexSpawnEnvHydrationPromise = resolveInteractiveLoginShellEnvAsync(this.env)
      .then((shellEnv) => {
        const logger = getMainLogger("pwragent:shell-environment");
        if (!shellEnv || Object.keys(shellEnv).length === 0) {
          logger.warn("login-shell-env-merge-empty", {
            parentPathLength: this.env.PATH?.length ?? 0,
            parentShell: this.env.SHELL,
            shellCandidates: defaultLoginShellCandidates(this.env),
          });
          return targetEnv;
        }

        logger.info("login-shell-env-merged", {
          keys: Object.keys(shellEnv).length,
          parentPathLength: this.env.PATH?.length ?? 0,
          hydratedPathLength: shellEnv.PATH?.length ?? 0,
          hadNvmDir: Boolean(shellEnv.NVM_DIR),
          hadHomebrewPrefix: Boolean(shellEnv.HOMEBREW_PREFIX),
        });
        Object.assign(targetEnv, shellEnv);
        if (this.startupCodexHome) {
          targetEnv.CODEX_HOME = this.startupCodexHome;
        }
        return targetEnv;
      });

    return await this.codexSpawnEnvHydrationPromise;
  }

  async resolveTerminalSpawnEnvAsync(): Promise<NodeJS.ProcessEnv> {
    if (this.options.resolveCodexShellEnv) {
      return mergeLoginShellEnvIntoEnv(this.env, {
        resolveShellEnv: this.options.resolveCodexShellEnv,
        logger: getMainLogger("pwragent:shell-environment"),
      });
    }

    if (this.terminalSpawnEnvHydrationPromise) {
      return await this.terminalSpawnEnvHydrationPromise;
    }

    const targetEnv = this.ensureBaseTerminalSpawnEnv();
    this.terminalSpawnEnvHydrationPromise = resolveInteractiveLoginShellEnvAsync(
      this.env,
    ).then((shellEnv) => {
      const logger = getMainLogger("pwragent:shell-environment");
      if (!shellEnv || Object.keys(shellEnv).length === 0) {
        logger.warn("terminal-login-shell-env-merge-empty", {
          parentPathLength: this.env.PATH?.length ?? 0,
          parentShell: this.env.SHELL,
          shellCandidates: defaultLoginShellCandidates(this.env),
        });
        return targetEnv;
      }

      logger.info("terminal-login-shell-env-merged", {
        keys: Object.keys(shellEnv).length,
        parentPathLength: this.env.PATH?.length ?? 0,
        hydratedPathLength: shellEnv.PATH?.length ?? 0,
        hadNvmDir: Boolean(shellEnv.NVM_DIR),
        hadHomebrewPrefix: Boolean(shellEnv.HOMEBREW_PREFIX),
      });
      Object.assign(targetEnv, shellEnv);
      return targetEnv;
    });

    return await this.terminalSpawnEnvHydrationPromise;
  }

  private ensureBaseCodexSpawnEnv(): NodeJS.ProcessEnv {
    this.codexSpawnEnv ??= this.withStartupCodexHome({ ...this.env });
    return this.codexSpawnEnv;
  }

  private ensureBaseTerminalSpawnEnv(): NodeJS.ProcessEnv {
    this.terminalSpawnEnv ??= { ...this.env };
    return this.terminalSpawnEnv;
  }

  private withStartupCodexHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!this.startupCodexHome) return env;
    return {
      ...env,
      CODEX_HOME: this.startupCodexHome,
    };
  }

  resolveGhCommandPreference(): string | undefined {
    return (
      readEnvString(this.env, GH_COMMAND_ENV)
      || this.readConfig().config.applications?.gh?.path
      || undefined
    );
  }

  private readConfig(): ConfigReadResult {
    try {
      return {
        config: readDesktopSettingsConfig(this.configPath),
      };
    } catch (error) {
      return {
        config: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private defaultDeveloperMode(): boolean {
    return this.options.defaultDeveloperMode ?? this.env.NODE_ENV !== "production";
  }

  private resolveComposer(
    configValue: string | undefined,
  ): DesktopSettingsValue<DesktopChatReplyComposer> {
    const envValue = readEnvString(this.env, CHAT_REPLY_COMPOSER_ENV);
    if (configValue && !this.loggedObsoleteComposerConfig) {
      this.loggedObsoleteComposerConfig = true;
      settingsLog.warn(
        "experimental.chat_reply_composer is obsolete and ignored; remove it from settings when convenient",
        { configValue },
      );
    }
    if (envValue && !this.loggedObsoleteComposerEnv) {
      this.loggedObsoleteComposerEnv = true;
      settingsLog.warn(
        `${CHAT_REPLY_COMPOSER_ENV} is obsolete and ignored; remove it from the launch environment when convenient`,
        { envValue },
      );
    }

    return {
      value: DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT,
      source: "default",
    };
  }

  private resolveDiffCondensationEnabled(
    configValue: boolean | undefined,
  ): DesktopSettingsValue<boolean> {
    return {
      value: configValue ?? false,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveDiffCondensationModel(
    configValue: string | undefined,
  ): DesktopSettingsValue<string> {
    const trimmed = configValue?.trim();
    return {
      value: trimmed && trimmed.length > 0 ? trimmed : "auto",
      source: trimmed && trimmed.length > 0 ? "config" : "default",
    };
  }

  private resolveBoolean(
    configValue: boolean | undefined,
    defaultValue: boolean,
    envKey: string,
  ): DesktopSettingsValue<boolean> {
    const envValue = readEnvBoolean(this.env, envKey);
    if (envValue.value !== undefined) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveConfigBoolean(
    configValue: boolean | undefined,
    defaultValue: boolean,
  ): DesktopSettingsValue<boolean> {
    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveMessagingImageProfile(
    configValue: DesktopMessagingImageProfile | undefined,
  ): DesktopSettingsValue<DesktopMessagingImageProfile> {
    const envValue = readEnvMessagingImageProfile(this.env);
    if (envValue.value) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "medium",
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolvePastedImageMaxPatches(
    configValue: number | undefined,
  ): DesktopSettingsValue<number> {
    const normalized =
      configValue !== undefined && Number.isFinite(configValue)
        ? Math.max(0, Math.floor(configValue))
        : undefined;
    return {
      value: normalized ?? DEFAULT_PASTED_IMAGE_MAX_PATCHES,
      source: normalized === undefined ? "default" : "config",
    };
  }

  private resolveUpdateChannelValue(
    configValue: DesktopUpdateChannel | undefined,
  ): DesktopSettingsValue<DesktopUpdateChannel> {
    return {
      value: configValue ?? DESKTOP_UPDATE_CHANNEL_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveAppearanceTheme(
    configValue: DesktopAppearanceTheme | undefined,
  ): DesktopSettingsValue<DesktopAppearanceTheme> {
    return {
      value: configValue ?? DESKTOP_APPEARANCE_THEME_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveAppearanceDensity(
    configValue: DesktopAppearanceDensity | undefined,
  ): DesktopSettingsValue<DesktopAppearanceDensity> {
    return {
      value: configValue ?? DESKTOP_APPEARANCE_DENSITY_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveIntegratedTerminalWindowsShellValue(
    configValue: DesktopIntegratedTerminalWindowsShell | undefined,
  ): DesktopSettingsValue<DesktopIntegratedTerminalWindowsShell> {
    return {
      value:
        configValue ?? DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveOnboarding(
    configValue: {
      completed?: boolean;
      completedSource?: DesktopOnboardingCompletedSource;
    } | undefined,
  ): DesktopOnboardingSnapshot {
    // Reader rule: missing `[onboarding]` table is the migration signal.
    // Pre-existing profiles have no marker, so they keep the historical
    // behavior (Codex prewarm runs at startup). A freshly created profile
    // gets `completed = false` written at create time; the wizard flips
    // it to `true` with `completed_source = "wizard"` when done.
    const completedFromConfig = configValue?.completed;
    const sourceFromConfig = configValue?.completedSource;
    const inferredMigrated =
      completedFromConfig === undefined && sourceFromConfig === undefined;
    const completed: DesktopSettingsValue<boolean> =
      completedFromConfig === undefined
        ? { value: inferredMigrated, source: "default" }
        : { value: completedFromConfig, source: "config" };
    const completedSource: DesktopSettingsValue<
      DesktopOnboardingCompletedSource | ""
    > = sourceFromConfig !== undefined
      ? { value: sourceFromConfig, source: "config" }
      : inferredMigrated
        ? { value: "migrated", source: "default" }
        : { value: "", source: "default" };
    return { completed, completedSource };
  }

  private resolveCodexProfileModel(
    configValue: DesktopCodexProfileModel | undefined,
  ): DesktopSettingsValue<DesktopCodexProfileModel> {
    return {
      value: configValue ?? DESKTOP_CODEX_PROFILE_MODEL_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveNumber(
    configValue: number | undefined,
    defaultValue: number,
    envKey: string,
  ): DesktopSettingsValue<number> {
    const envValue = readEnvInteger(this.env, envKey);
    if (envValue.value !== undefined) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveClampedNumber(
    configValue: number | undefined,
    defaultValue: number,
    envKey: string,
    maxValue: number,
  ): DesktopSettingsValue<number> {
    const envValue = readEnvInteger(this.env, envKey);
    if (envValue.value !== undefined) {
      return {
        value: clampInteger(envValue.value, maxValue),
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: clampInteger(configValue ?? defaultValue, maxValue),
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveHotCpuHeapSnapshotLimit(
    configValue: number | undefined,
  ): DesktopSettingsValue<number> {
    const rounded =
      configValue === undefined
        ? DEFAULT_HOT_CPU_HEAP_SNAPSHOT_LIMIT
        : Math.round(configValue);
    return {
      value: Math.min(
        Math.max(rounded, MIN_HOT_CPU_HEAP_SNAPSHOT_LIMIT),
        MAX_HOT_CPU_HEAP_SNAPSHOT_LIMIT,
      ),
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveHotCpuProfileStartDelayMs(
    configValue: DesktopHotCpuProfileStartDelayMs | undefined,
  ): DesktopSettingsValue<DesktopHotCpuProfileStartDelayMs> {
    return {
      value: configValue ?? DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveHotCpuProfileTriggerMode(
    configValue: DesktopHotCpuProfileTriggerMode | undefined,
  ): DesktopSettingsValue<DesktopHotCpuProfileTriggerMode> {
    return {
      value: configValue ?? DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveHotCpuSlowburnThresholdPercent(
    configValue: number | undefined,
  ): DesktopSettingsValue<number> {
    const rounded =
      configValue === undefined
        ? DESKTOP_HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT
        : Math.round(configValue);
    return {
      value: Math.min(Math.max(rounded, 1), 100),
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveString(
    configValue: string | undefined,
    envKey: string,
  ): DesktopSettingsValue<string> {
    const envValue = readEnvString(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveStringWithDefault(
    configValue: string | undefined,
    defaultValue: string,
    envKey: string,
  ): DesktopSettingsValue<string> {
    const envValue = readEnvString(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackInboundMode(
    configValue: "socket" | "events" | undefined,
  ): DesktopSettingsValue<"socket" | "events"> {
    const envValue = readEnvString(this.env, SLACK_INBOUND_MODE_ENV);
    if (envValue === "socket" || envValue === "events") {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "socket",
      source: configValue === undefined ? "default" : "config",
      ...(envValue !== undefined
        ? { error: `Invalid Slack inbound mode for ${SLACK_INBOUND_MODE_ENV}` }
        : {}),
    };
  }

  private resolveFeishuTenantRegion(
    configValue: "feishu" | "lark" | undefined,
  ): DesktopSettingsValue<"feishu" | "lark"> {
    const envValue = readEnvString(this.env, FEISHU_TENANT_REGION_ENV);
    if (envValue === "feishu" || envValue === "lark") {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "feishu",
      source: configValue === undefined ? "default" : "config",
      ...(envValue !== undefined
        ? { error: `Invalid Feishu tenant region for ${FEISHU_TENANT_REGION_ENV}` }
        : {}),
    };
  }

  private resolveFeishuInboundMode(
    configValue: "persistent" | "webhook" | undefined,
  ): DesktopSettingsValue<"persistent" | "webhook"> {
    const envValue = readEnvString(this.env, FEISHU_INBOUND_MODE_ENV);
    if (envValue === "persistent" || envValue === "webhook") {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "persistent",
      source: configValue === undefined ? "default" : "config",
      ...(envValue !== undefined
        ? { error: `Invalid Feishu / Lark inbound mode for ${FEISHU_INBOUND_MODE_ENV}` }
        : {}),
    };
  }

  private resolveFeishuTenantUrl(
    configValue: string | undefined,
    tenantRegion: "feishu" | "lark",
  ): DesktopSettingsValue<string> {
    const envValue = readEnvString(this.env, FEISHU_TENANT_URL_ENV);
    if (envValue !== undefined) {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }
    if (
      configValue === FEISHU_DEFAULT_TENANT_URL ||
      configValue === LARK_DEFAULT_TENANT_URL ||
      configValue === feishuTenantUrlForRegion(tenantRegion)
    ) {
      return {
        value: "",
        source: "default",
      };
    }

    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveFeishuCallbackBaseUrl(
    configValue: string | undefined,
    envKey: string,
  ): DesktopSettingsValue<string> {
    const envValue = readEnvString(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }
    if (configValue === FEISHU_DEFAULT_CALLBACK_BASE_URL) {
      return {
        value: "",
        source: "default",
      };
    }

    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveConfigString(
    configValue: string | undefined,
  ): DesktopSettingsValue<string> {
    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveToolUpdateMode(
    configValue: MessagingToolUpdateMode | undefined,
  ): DesktopSettingsValue<MessagingToolUpdateMode> {
    return {
      value: configValue ?? "show_some",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveConfigFullAccessWarningPolicy(
    configValue: DesktopMessagingFullAccessWarningGlobalPolicy | undefined,
  ): DesktopSettingsValue<DesktopMessagingFullAccessWarningGlobalPolicy> {
    return {
      value: configValue ?? "dismissable",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveConfigMessagingResponseMode(
    configValue: DesktopMessagingResponseMode | undefined,
    defaultValue: DesktopMessagingResponseMode,
  ): DesktopSettingsValue<DesktopMessagingResponseMode> {
    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
    };
  }

  // Locked-down defaults: a fresh Slack setup responds to no one until the
  // operator pairs/approves a team, channel, and/or user. Adding entries no
  // longer silently flips the mode — the mode is an explicit choice.
  private resolveSlackTeamAuthorizationMode(
    configValue: DesktopMessagingAuthorizationMode | undefined,
    _authorizedWorkspaces: DesktopAuthorizedContact[],
  ): DesktopSettingsValue<DesktopMessagingAuthorizationMode> {
    return {
      value: configValue ?? "approved_only",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackChannelAuthorizationMode(
    configValue: DesktopMessagingAuthorizationMode | undefined,
    _authorizedWorkspaces: DesktopAuthorizedContact[],
    _authorizedChannels: DesktopAuthorizedContact[],
  ): DesktopSettingsValue<DesktopMessagingAuthorizationMode> {
    return {
      value: configValue ?? "approved_only",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackDmAccessMode(
    configValue: DesktopMessagingSlackDmAccessMode | undefined,
  ): DesktopSettingsValue<DesktopMessagingSlackDmAccessMode> {
    return {
      value: configValue ?? "authorized_users",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackChannelUserAccessMode(
    configValue: DesktopMessagingSlackChannelUserAccessMode | undefined,
  ): DesktopSettingsValue<DesktopMessagingSlackChannelUserAccessMode> {
    return {
      value: configValue ?? "authorized_users",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveWorktrees(
    configValue: DesktopWorktreeStorageLocation | undefined,
  ): {
    storage: DesktopSettingsValue<DesktopWorktreeStorageLocation>;
    effectivePath: string;
  } {
    const envValue = readEnvWorktreeStorage(this.env);
    const resolved: DesktopSettingsValue<DesktopWorktreeStorageLocation> =
      envValue.value !== undefined
        ? {
            value: envValue.value,
            source: "env",
            overriddenByEnv: configValue !== undefined,
          }
        : {
            value: configValue ?? DESKTOP_WORKTREE_STORAGE_DEFAULT,
            source: configValue === undefined ? "default" : "config",
            error: envValue.error,
          };
    return {
      storage: resolved,
      effectivePath:
        resolved.value === "user-home"
          ? toForwardSlashes(userHomeWorktreesRoot())
          : ".worktrees",
    };
  }

  private resolveList(
    configValue: DesktopAuthorizedContact[] | undefined,
    envKey: string,
  ): DesktopSettingsValue<DesktopAuthorizedContact[]> {
    const envValue = readEnvList(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue.map((id) => ({ id, displayName: "" })),
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? [],
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveConfigList(
    configValue: DesktopAuthorizedContact[] | undefined,
  ): DesktopSettingsValue<DesktopAuthorizedContact[]> {
    return {
      value: configValue ?? [],
      source: configValue === undefined ? "default" : "config",
    };
  }

  private async readSecretState(
    secret: DesktopSettingsSecretName,
    envKey: string | undefined,
    storageAvailable: boolean,
  ): Promise<DesktopSettingsSecretState> {
    if (envKey && readEnvString(this.env, envKey)) {
      return {
        configured: true,
        source: "env",
        writable: false,
        overriddenByEnv: true,
      };
    }

    const storageState = this.options.secretStore.describe();
    if (!storageAvailable) {
      return {
        configured: false,
        source: "unset",
        writable: false,
        unavailableReason: storageState.unavailableReason,
      };
    }

    try {
      const configured = await this.options.secretStore.hasSecret(secret);
      const accessError = this.options.secretStore.getSecretAccessError?.(secret);
      return {
        configured,
        source: configured ? "keychain" : "unset",
        writable: true,
        ...(accessError ? { unavailableReason: accessError } : {}),
      };
    } catch (error) {
      return {
        configured: false,
        source: "unset",
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveSecretSync(
    secret: DesktopSettingsSecretName,
    envKey: string | undefined,
  ): string | undefined {
    return (
      (envKey ? readEnvString(this.env, envKey) : undefined)
      ?? this.options.secretStore.getSecretSync?.(secret)
    );
  }
}

function feishuTenantUrlForRegion(region: "feishu" | "lark"): string {
  return region === "lark" ? LARK_DEFAULT_TENANT_URL : FEISHU_DEFAULT_TENANT_URL;
}
