import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  DesktopTextSize,
  DesktopSpendAlertPolicy,
  DesktopToolOutputAlertPolicy,
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  DesktopAuthorizedContact,
  DesktopCodexAuthProfileDiscoverySnapshot,
  DesktopCodexCandidateSource,
  DesktopCodexDiscoverySnapshot,
  DesktopCodexProfileModel,
  DesktopFederationMode,
  DesktopGitDiscoverySnapshot,
  DesktopHotCpuProfileStartDelayMs,
  DesktopHotCpuProfileTriggerMode,
  DesktopIntegratedTerminalWindowsShell,
  DesktopMessagingAuthorizationMode,
  DesktopMessagingFullAccessWarningGlobalPolicy,
  DesktopMessagingImageProfile,
  DesktopMessagingSettingsProjection,
  DesktopMessagingResponseMode,
  DesktopMessagingSlackChannelUserAccessMode,
  DesktopMessagingSlackDmAccessMode,
  DesktopMessagingSlackGroupDmAccessMode,
  DesktopOnboardingCompletedSource,
  DesktopOnboardingSnapshot,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
  DesktopUpdateChannel,
  DesktopUpdateTrain,
  DesktopWorktreeStorageLocation,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_BACKGROUND_PR_POLLING,
  DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS,
  DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_TEXT_SIZE_DEFAULT,
  DESKTOP_SPEND_ALERT_POLICY_DEFAULT,
  DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT,
  DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT,
  DESKTOP_CODEX_PROFILE_MODEL_DEFAULT,
  DESKTOP_FEDERATION_MODE_DEFAULT,
  DESKTOP_HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
  DESKTOP_INTEGRATED_TERMINAL_WINDOWS_SHELL_DEFAULT,
  DESKTOP_UPDATE_CHANNEL_DEFAULT,
  DESKTOP_UPDATE_TRAIN_DEFAULT,
  inferDesktopUpdateSelection,
  DESKTOP_WORKTREE_STORAGE_DEFAULT,
  MANAGED_GROK_BUILD_CHANNEL_DEFAULT,
  MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  MAX_REPEATED_LARGE_OUTPUT_CALLS,
  MAX_REPEATED_LARGE_OUTPUT_PERCENT,
  MAX_SPEND_ALERT_THRESHOLD_USD,
  MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  MIN_REPEATED_LARGE_OUTPUT_CALLS,
  MIN_REPEATED_LARGE_OUTPUT_PERCENT,
  MIN_SPEND_ALERT_THRESHOLD_USD,
} from "@pwragent/shared";
import {
  SLACK_CHANNEL_AUTHORIZATION_MODE_DEFAULT,
  SLACK_CHANNEL_USER_ACCESS_MODE_DEFAULT,
  SLACK_DM_ACCESS_MODE_DEFAULT,
  SLACK_GROUP_DM_ACCESS_MODE_DEFAULT,
  SLACK_TEAM_AUTHORIZATION_MODE_DEFAULT,
} from "@pwragent/messaging-interface";
import { DEFAULT_PASTED_IMAGE_MAX_PATCHES } from "../../shared/image-normalization";
import {
  generateFederationIdentityKeyPair,
  publicKeyPemFromPrivateKey,
  type FederationIdentityKeyPair,
} from "../federation/federation-identity";
import {
  generateFederationNoiseStaticKeyPair,
  noisePublicKeyBase64FromPrivateBase64,
  type FederationNoiseStaticKeyPair,
} from "../federation/federation-noise";

import {
  resolveDesktopConfigPath,
  userHomeWorktreesRoot,
  type DesktopSettingsConfig,
} from "./desktop-config";
import { DesktopConfigStore } from "./config-store/desktop-config-store";
import type { ConfigUpdateResult } from "./config-store/desktop-config-store";
import {
  CONFIG_DOMAIN_KEYS,
  resolveSpendAlertPolicy,
  resolveToolOutputAlertPolicy,
  type ConfigDomainMap,
  type ProviderProjection,
} from "./config-store/config-domains";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { resolveMessagingSettingsDomain } from "../messaging/messaging-settings-domain";
import type { DesktopSecretStore } from "./desktop-secret-store";
import {
  CHAT_REPLY_COMPOSER_ENV,
  ACP_AGENTS_GEMINI_CLI_PATH_ENV,
  ACP_AGENTS_GROK_CLI_PATH_ENV,
  ACP_AGENTS_KIMI_CLI_PATH_ENV,
  ACP_AGENTS_QWEN_CLI_PATH_ENV,
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
  readEnvBoolean,
  readEnvInteger,
  readEnvList,
  readEnvMessagingImageProfile,
  readEnvMessagingPdfProfile,
  readEnvString,
  readEnvWorktreeStorage,
} from "./desktop-settings-env";
import {
  TOKEN_MISER_ACTIVATION_FILENAME,
  type TokenMiserActivationStatus,
} from "../token-miser/token-miser-types";
import { TokenMiserStore } from "../token-miser/token-miser-store";
import {
  discoverCodexAuthProfiles,
  resolveCodexHomeForProfile,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";
import { discoverDesktopApplications } from "./application-discovery";
import { GIT_COMMAND_ENV, discoverGitCommands } from "./git-discovery";
import { discoverGhCommands } from "./gh-discovery";
import { getMainLogger } from "../log";
import {
  buildPwrAgentChildProcessEnv,
  mergePwrAgentChildProcessEnv,
} from "../child-process-env";
// Login-shell PATH hydration is now shared via @pwrdrvr/agent-transport (it was
// extracted FROM this file). Behavior-identical: same `mergeLoginShellEnvIntoEnv`
// shape + the `resolveShellEnv` test seam; the kit takes an injected logger
// (passed below) where the in-tree copy hardcoded `getMainLogger`.
import { mergeLoginShellEnvIntoEnv } from "@pwrdrvr/agent-transport";
import {
  CODEX_DISCOVERY_NOT_INSTALLED_TTL_MS,
  CODEX_DISCOVERY_SUCCESS_TTL_MS,
  CodexDiscoveryCoordinator,
} from "../codex-discovery-coordinator";
import {
  assertProviderDiscoveryPermit,
  type ProviderDiscoveryPermit,
} from "./provider-discovery-permit";
import { providerLastKnownGoodMatchesConfig } from "./config-store/config-domains";
import type {
  ManagedCodexCheckMode,
  ManagedCodexRuntime,
} from "../codex-managed-runtime";

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
  codexDiscoveryCoordinator?: Pick<
    CodexDiscoveryCoordinator,
    "discover" | "invalidate" | "resolve"
  > & Partial<Pick<CodexDiscoveryCoordinator, "peek">>;
  configPath?: string;
  configStore?: DesktopConfigStore;
  defaultDeveloperMode?: boolean;
  defaultManagedGrokBuilds?: boolean;
  ensureManagedCodexRuntime?: (options: {
    checkMode: ManagedCodexCheckMode;
    signal?: AbortSignal;
    waitForUpdate?: boolean;
  }) => Promise<ManagedCodexRuntime>;
  resolveActiveManagedGrokCommand?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  secretStore: DesktopSecretStore;
  now?: () => number;
  resolveCodexShellEnv?: (
    env: NodeJS.ProcessEnv
  ) => NodeJS.ProcessEnv | undefined;
  appVersion?: string;
  resolveAppVersion?: () => string;
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
    sidebarTextSize: DesktopTextSize;
    transcriptTextSize: DesktopTextSize;
  }) => void;
  onManagedCodexRuntimeSwitchComplete?: () => void;
};

export const MANAGED_CODEX_UPDATE_POLL_INTERVAL_MS = 60 * 60_000;

export type ManagedCodexSelectionChange = {
  enabled: boolean;
  reason: "availability" | "update";
  runtime?: ManagedCodexRuntime;
};

type ConfigReadResult = {
  config: DesktopSettingsConfig;
  error?: string;
};

function providerConfigSection(provider: ProviderProjection): {
  cliPath?: string;
  enabled?: boolean;
  managedBuilds?: boolean;
  managedBuildChannel?: DesktopUpdateChannel;
} {
  return {
    enabled: provider.configured.enabled,
    ...(provider.configured.commandOverride
      ? { cliPath: provider.configured.commandOverride }
      : {}),
    ...(provider.configured.managedBuilds !== undefined
      ? { managedBuilds: provider.configured.managedBuilds }
      : {}),
    ...(provider.configured.managedBuildChannel !== undefined
      ? { managedBuildChannel: provider.configured.managedBuildChannel }
      : {}),
  };
}

function codexDiscoveryFromProvider(
  provider: ProviderProjection,
): DesktopCodexDiscoverySnapshot {
  const lastKnownGood = providerLastKnownGoodMatchesConfig(provider)
    ? provider.lastKnownGood
    : undefined;
  const selectedCommand = lastKnownGood?.selectedCommand;
  const sourceIsValid = (
    source: string,
  ): source is DesktopCodexCandidateSource =>
    source === "env"
    || source === "config"
    || source === "path"
    || source === "application";
  const candidates = (lastKnownGood?.candidates ?? [])
    .filter((candidate) => sourceIsValid(candidate.source))
    .map((candidate) => ({
      command: candidate.command,
      source: candidate.source as DesktopCodexCandidateSource,
      executable: !candidate.failureReason,
      selected: candidate.command === selectedCommand,
      ...(candidate.version ? { version: candidate.version } : {}),
      ...(candidate.failureReason
        ? { failureReason: candidate.failureReason }
        : {}),
    }));
  return {
    candidates,
    ...(selectedCommand ? { selectedCommand } : {}),
    ...(provider.validation.error ? { error: provider.validation.error } : {}),
  };
}

function emptyApplicationsSnapshot(): DesktopApplicationsSnapshot {
  return {
    editors: [],
    terminals: [],
    preferredEditorId: { value: "", source: "default" },
    preferredTerminalId: { value: "", source: "default" },
    gh: {
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
    git: {
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
  };
}

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
            env: buildPwrAgentChildProcessEnv(env),
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
        return buildPwrAgentChildProcessEnv(shellEnv);
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
  private readonly configStore: DesktopConfigStore;
  private readonly configWriteListeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly startupCodexHome?: string;
  private loggedObsoleteComposerConfig = false;
  private loggedObsoleteComposerEnv = false;
  // Git/applications discovery remains process-lifetime memoized. Codex uses a
  // bounded coordinator shared with app-server launch so Settings and launch
  // cannot select different binaries.
  // Scoped to the cache entry rather than kept in a shared field, so a probe
  // that is already obsolete by the time it resolves writes into its own
  // entry and can never overwrite a newer snapshot. Same shape as
  // `ghDiscoveryCache` below, and for the same reason.
  private gitDiscoveryCache?: {
    key: string;
    promise: Promise<DesktopGitDiscoverySnapshot>;
    result?: DesktopGitDiscoverySnapshot;
  };
  private applicationsDiscoveryPromise?: Promise<DesktopApplicationsSnapshot>;
  private applicationsDiscovery?: DesktopApplicationsSnapshot;
  private codexProfiles: DesktopCodexAuthProfileDiscoverySnapshot;
  private managedCodexError?: string;
  private readonly codexDiscoveryCoordinator: Pick<
    CodexDiscoveryCoordinator,
    "discover" | "invalidate" | "resolve"
  > & Partial<Pick<CodexDiscoveryCoordinator, "peek">>;
  private ghDiscoveryCache?: {
    key: string;
    promise: ReturnType<typeof discoverGhCommands>;
    result?: Awaited<ReturnType<typeof discoverGhCommands>>;
  };
  private codexSpawnEnv?: NodeJS.ProcessEnv;
  private codexSpawnEnvHydratedAt?: number;
  private codexSpawnEnvHydrationSucceeded = false;
  private codexSpawnEnvHydrationPromise?: Promise<NodeJS.ProcessEnv>;
  private terminalSpawnEnv?: NodeJS.ProcessEnv;
  private terminalSpawnEnvHydrationPromise?: Promise<NodeJS.ProcessEnv>;
  private managedCodexRuntime?: ManagedCodexRuntime;
  private readonly managedCodexSelectionListeners = new Set<(
    change: ManagedCodexSelectionChange,
  ) => Promise<unknown> | unknown>();
  private managedCodexUpdateAbortController?: AbortController;
  private managedCodexRuntimeSwitchPending = false;
  private managedCodexRuntimeSwitchAttempt?: Promise<void>;
  private startupDiscoveryAttempted = false;
  private startupDiscoveryPromise?: Promise<void>;
  // The Codex leg of discovery, tracked apart from `startupDiscoveryPromise`
  // (which also bundles gh, git, and the desktop-application scan). Codex
  // callers must never wait on those, and the pending signal must not stay
  // set while only they are outstanding.
  private codexDiscoveryPromise?: Promise<void>;
  private codexDiscoverySettled = false;

  constructor(private readonly options: DesktopSettingsServiceOptions) {
    this.env = options.env ?? process.env;
    this.argv = options.argv ?? process.argv;
    this.configPath =
      options.configPath ??
      resolveDesktopConfigPath({ argv: this.argv, env: this.env });
    this.configStore = options.configStore ?? new DesktopConfigStore({
      configPath: this.configPath,
    });
    this.now = options.now ?? Date.now;
    this.startupCodexHome = resolveCodexHomeForProfile(
      this.configStore.read("models").codex?.profile,
      { env: this.env },
    );
    this.codexProfiles = normalizeCodexProfilesSnapshot(
      discoverCodexAuthProfiles({
        configuredProfile: this.configStore.read("models").codex?.profile,
        env: this.env,
      }),
    );
    this.codexDiscoveryCoordinator =
      options.codexDiscoveryCoordinator
      ?? new CodexDiscoveryCoordinator({
        now: this.now,
        resolveEnv: async () => await this.resolveCodexSpawnEnvAsync(),
      });
  }

  async readSettingsProjection(): Promise<DesktopSettingsSnapshot> {
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
    const federationInstancePrivateKey = await this.readSecretState(
      "federationInstancePrivateKey",
      undefined,
      secretStorage.available,
    );
    const federationNoiseStaticPrivateKey = await this.readSecretState(
      "federationNoiseStaticPrivateKey",
      undefined,
      secretStorage.available,
    );
    const federationCloudflareClientCertificate = await this.readSecretState(
      "federationCloudflareClientCertificate",
      undefined,
      secretStorage.available,
    );
    const federationCloudflareClientPrivateKey = await this.readSecretState(
      "federationCloudflareClientPrivateKey",
      undefined,
      secretStorage.available,
    );
    const federationCloudflareAccessClientId = await this.readSecretState(
      "federationCloudflareAccessClientId",
      undefined,
      secretStorage.available,
    );
    const federationCloudflareAccessClientSecret = await this.readSecretState(
      "federationCloudflareAccessClientSecret",
      undefined,
      secretStorage.available,
    );
    const managedCodexRuntime = this.managedCodexRuntime;
    const managedCodexError = this.managedCodexError;
    const codexDiscoveryCommand = this.resolveActiveCodexCommand(config);
    const codexDiscovery = this.codexDiscoveryCoordinator.peek?.(
      codexDiscoveryCommand,
    ) ?? codexDiscoveryFromProvider(this.configStore.read("providers").codex);
    const codexProfiles = this.codexProfiles;
    const ghDiscovery = this.ghDiscoveryCache?.result ?? { candidates: [] };
    const gitDiscovery = this.gitDiscoveryCache?.result ?? { candidates: [] };
    const applications = this.applicationsDiscovery
      ?? emptyApplicationsSnapshot();
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
    );
    const slackChannelAuthorizationMode = this.resolveSlackChannelAuthorizationMode(
      config.messaging?.slack?.channelAuthorizationMode,
    );
    const slackDmAccessMode = this.resolveSlackDmAccessMode(
      config.messaging?.slack?.dmAccessMode,
    );
    const slackGroupDmAccessMode = this.resolveSlackGroupDmAccessMode(
      config.messaging?.slack?.groupDmAccessMode,
    );
    const slackChannelUserAccessMode = this.resolveSlackChannelUserAccessMode(
      config.messaging?.slack?.channelUserAccessMode,
    );
    const tokenMiserUsage = await new TokenMiserStore(
      path.join(
        path.dirname(this.configPath),
        "state",
        "token-miser",
        "objects",
      ),
    ).summarizeUsage().catch(() => ({
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
    }));
    const tokenMiserActivation = await this.readTokenMiserActivation();

    return {
      fetchedAt: this.now(),
      configPath: this.configPath,
      configError: error,
      runtime: {
        tokenMiser: tokenMiserActivation
          ? {
              ...tokenMiserUsage,
              activation: tokenMiserActivation,
              ...(managedCodexRuntime
                ? {
                    managedCodex: {
                      state: this.managedCodexRuntimeSwitchPending
                        ? "pending-switch" as const
                        : "ready" as const,
                      version: managedCodexRuntime.metadata.version,
                    },
                  }
                : managedCodexError
                  ? {
                      managedCodex: {
                        state: "unavailable" as const,
                        reason: managedCodexError,
                      },
                    }
                  : {}),
            }
          : {
              ...tokenMiserUsage,
              ...(managedCodexRuntime
                ? {
                    managedCodex: {
                      state: this.managedCodexRuntimeSwitchPending
                        ? "pending-switch" as const
                        : "ready" as const,
                      version: managedCodexRuntime.metadata.version,
                    },
                  }
                : managedCodexError
                  ? {
                      managedCodex: {
                        state: "unavailable" as const,
                        reason: managedCodexError,
                      },
                    }
                  : {}),
            },
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
        // Default on: with the Attention lens ranked by turn start, leaving
        // this off would park a long-running turn below a short one that
        // started later, which reads oddly for a review queue.
        attentionPromoteOnTurnEnd: this.resolveConfigBoolean(
          config.general?.attentionPromoteOnTurnEnd,
          true,
        ),
        pdfAnalysisEnabled: this.resolveConfigBoolean(
          config.general?.pdfAnalysisEnabled,
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
        toolOutputAlerts: {
          outputCapHitsEnabled: this.resolveConfigBoolean(
            config.general?.toolOutputAlerts?.outputCapHitsEnabled,
            DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.outputCapHitsEnabled,
          ),
          repeatedLargeOutputsEnabled: this.resolveConfigBoolean(
            config.general?.toolOutputAlerts?.repeatedLargeOutputsEnabled,
            DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedLargeOutputsEnabled,
          ),
          repeatedLargeOutputMinimumCalls: this.resolveBoundedConfigInteger(
            config.general?.toolOutputAlerts?.repeatedLargeOutputMinimumCalls,
            DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedLargeOutputMinimumCalls,
            MIN_REPEATED_LARGE_OUTPUT_CALLS,
            MAX_REPEATED_LARGE_OUTPUT_CALLS,
          ),
          repeatedLargeOutputMinimumPercent: this.resolveBoundedConfigInteger(
            config.general?.toolOutputAlerts?.repeatedLargeOutputMinimumPercent,
            DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedLargeOutputMinimumPercent,
            MIN_REPEATED_LARGE_OUTPUT_PERCENT,
            MAX_REPEATED_LARGE_OUTPUT_PERCENT,
          ),
          repeatedQueuedChecksEnabled: this.resolveConfigBoolean(
            config.general?.toolOutputAlerts?.repeatedQueuedChecksEnabled,
            DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT.repeatedQueuedChecksEnabled,
          ),
        },
        spendAlerts: {
          activeTurnSpendEnabled: this.resolveConfigBoolean(
            config.general?.spendAlerts?.activeTurnSpendEnabled,
            DESKTOP_SPEND_ALERT_POLICY_DEFAULT.activeTurnSpendEnabled,
          ),
          activeTurnSpendThresholdUsd: this.resolveBoundedConfigAmount(
            config.general?.spendAlerts?.activeTurnSpendThresholdUsd,
            DESKTOP_SPEND_ALERT_POLICY_DEFAULT.activeTurnSpendThresholdUsd,
            MIN_SPEND_ALERT_THRESHOLD_USD,
            MAX_SPEND_ALERT_THRESHOLD_USD,
          ),
          threadSpendEnabled: this.resolveConfigBoolean(
            config.general?.spendAlerts?.threadSpendEnabled,
            DESKTOP_SPEND_ALERT_POLICY_DEFAULT.threadSpendEnabled,
          ),
          threadSpendThresholdUsd: this.resolveBoundedConfigAmount(
            config.general?.spendAlerts?.threadSpendThresholdUsd,
            DESKTOP_SPEND_ALERT_POLICY_DEFAULT.threadSpendThresholdUsd,
            MIN_SPEND_ALERT_THRESHOLD_USD,
            MAX_SPEND_ALERT_THRESHOLD_USD,
          ),
        },
        appearance: {
          theme: this.resolveAppearanceTheme(
            config.general?.appearance?.theme,
          ),
          density: this.resolveAppearanceDensity(
            config.general?.appearance?.density,
          ),
          sidebarTextSize: this.resolveTextSize(
            config.general?.appearance?.sidebarTextSize,
          ),
          transcriptTextSize: this.resolveTextSize(
            config.general?.appearance?.transcriptTextSize,
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
        markdownMathRendering: this.resolveConfigBoolean(
          config.experimental?.markdownMathRendering,
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
        tokenMiserEnabled: this.resolveConfigBoolean(
          config.experimental?.tokenMiserEnabled,
          false,
        ),
        tokenMiserDefaultEnabled: this.resolveConfigBoolean(
          config.experimental?.tokenMiserDefaultEnabled,
          true,
        ),
        threadToolAccounting: this.resolveConfigBoolean(
          config.experimental?.threadToolAccounting,
          false,
        ),
        codexDefaultModeRequestUserInput: this.resolveConfigBoolean(
          config.experimental?.codexDefaultModeRequestUserInput,
          false,
        ),
        managedReview: this.resolveConfigBoolean(
          config.experimental?.managedReview,
          false,
        ),
        diffCondensation: {
          enabled: this.resolveDiffCondensationEnabled(
            config.experimental?.diffCondensation?.enabled,
          ),
        },
      },
      imageUploads: {
        pastedImageMaxPatches: this.resolvePastedImageMaxPatches(
          config.imageUploads?.pastedImageMaxPatches,
        ),
      },
      updates: this.resolveUpdateSelection(config.updates),
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
      federation: {
        mode: this.resolveFederationMode(config.federation?.mode),
        instanceLabel: this.resolveConfigString(config.federation?.instanceLabel),
        instanceNotes: this.resolveConfigString(config.federation?.instanceNotes),
        listenHost: this.resolveConfigStringWithDefault(
          config.federation?.listenHost,
          "127.0.0.1",
        ),
        listenPort: this.resolveConfigNumber(config.federation?.listenPort, 47830),
        publicUrl: this.resolveConfigString(config.federation?.publicUrl),
        gatewayUrl: this.resolveConfigString(config.federation?.gatewayUrl),
        gatewayEndpoints: this.resolveFederationEndpointList(
          config.federation?.gatewayEndpoints,
          config.federation?.gatewayUrl,
        ),
        advertisedEndpoints: this.resolveFederationEndpointList(
          config.federation?.advertisedEndpoints,
        ),
        cloudflareEndpoint: this.resolveConfigString(
          config.federation?.cloudflareEndpoint,
        ),
        cloudflareMtlsEnabled: this.resolveConfigBoolean(
          config.federation?.cloudflareMtlsEnabled,
          false,
        ),
        cloudflareAccessServiceAuthEnabled: this.resolveConfigBoolean(
          config.federation?.cloudflareAccessServiceAuthEnabled,
          false,
        ),
        instancePrivateKey: federationInstancePrivateKey,
        noiseStaticPrivateKey: federationNoiseStaticPrivateKey,
        cloudflareClientCertificate: federationCloudflareClientCertificate,
        cloudflareClientPrivateKey: federationCloudflareClientPrivateKey,
        cloudflareAccessClientId: federationCloudflareAccessClientId,
        cloudflareAccessClientSecret: federationCloudflareAccessClientSecret,
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
        managerToolUpdateMode: this.resolveToolUpdateMode(
          config.messaging?.managerToolUpdateMode,
          "show_none",
        ),
        showStreamingOption: this.resolveConfigBoolean(
          config.messaging?.showStreamingOption,
          false,
        ),
        attachments: {
          imageProfile: this.resolveMessagingImageProfile(
            config.messaging?.attachments?.imageProfile,
          ),
          pdfProfile: this.resolveMessagingPdfProfile(
            config.messaging?.attachments?.pdfProfile,
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
          responseMode: this.resolveConfigMessagingResponseMode(
            config.messaging?.discord?.responseMode,
            "every_message",
          ),
          responseModeOverrides: this.resolveConfigList(
            config.messaging?.discord?.responseModeOverrides,
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
          liveWorkingCards: this.resolveConfigBoolean(
            config.messaging?.slack?.liveWorkingCards,
            false,
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
          groupDmAccessMode: slackGroupDmAccessMode,
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
        providerDefaults: config.models?.providerDefaults ?? {},
        providerThreadMigrations:
          config.models?.providerThreadMigrations ?? {},
        codex: {
          path: this.resolveString(config.models?.codex?.path, CODEX_COMMAND_ENV),
          profile: this.resolveConfigString(config.models?.codex?.profile),
          allowFast: this.resolveConfigBoolean(
            config.models?.codex?.allowFast,
            true,
          ),
          discovery: codexDiscovery,
          profiles: codexProfiles,
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
          managedBuilds:
            config.acpAgents?.grok?.managedBuilds
            ?? this.options.defaultManagedGrokBuilds
            ?? true,
          managedBuildChannel:
            config.acpAgents?.grok?.managedBuildChannel
            ?? MANAGED_GROK_BUILD_CHANNEL_DEFAULT,
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
          path: this.resolveString(
            config.applications?.git?.path,
            GIT_COMMAND_ENV,
          ),
          discovery: gitDiscovery,
        },
      },
      git: {
        backgroundPrPolling: this.resolveConfigBoolean(
          config.git?.backgroundPrPolling,
          DEFAULT_BACKGROUND_PR_POLLING,
        ),
        prAutoDispatchAllowed: this.resolveConfigBoolean(
          config.git?.prAutoDispatchAllowed,
          DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
        ),
        defaultPrAutoDispatchEnabled: this.resolveConfigBoolean(
          config.git?.defaultPrAutoDispatchEnabled,
          DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS,
        ),
        prAutoDispatchBudgetCapacity: this.resolvePrAutoDispatchBudgetNumber(
          config.git?.prAutoDispatchBudgetCapacity,
          DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
          MIN_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
          MAX_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
        ),
        prAutoDispatchBudgetRefillPerMinute:
          this.resolvePrAutoDispatchBudgetNumber(
            config.git?.prAutoDispatchBudgetRefillPerMinute,
            DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
            MIN_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
            MAX_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
          ),
        pausePrAutoDispatchWhenBudgetEmpty: this.resolveConfigBoolean(
          config.git?.pausePrAutoDispatchWhenBudgetEmpty,
          DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
        ),
      },
      worktrees: this.resolveWorktrees(config.worktrees?.storage),
    };
  }

  readMessagingConfig(): ConfigDomainMap["messaging"] {
    return this.configStore.read("messaging");
  }

  readMessagingSettings(): DesktopSettingsSnapshot["messaging"] {
    return resolveMessagingSettingsDomain(this.readMessagingConfig(), this.env);
  }

  async readMessagingProjection(): Promise<DesktopMessagingSettingsProjection> {
    const override = resolveRuntimeMessagingOverride({
      argv: this.argv,
      env: this.env,
    });
    const secretStorageAvailable = this.options.secretStore.describe().available;
    const [
      telegramBotToken,
      discordBotToken,
      mattermostBotToken,
      mattermostHmacSecret,
      slackBotToken,
      slackAppToken,
      slackSigningSecret,
      feishuAppId,
      feishuAppSecret,
      feishuEncryptKey,
      feishuVerificationToken,
      lineChannelAccessToken,
      lineChannelSecret,
    ] = await Promise.all([
      this.readSecretState(
        "telegramBotToken",
        TELEGRAM_BOT_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "discordBotToken",
        DISCORD_BOT_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "mattermostBotToken",
        MATTERMOST_BOT_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "mattermostHmacSecret",
        MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "slackBotToken",
        SLACK_BOT_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "slackAppToken",
        SLACK_APP_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "slackSigningSecret",
        SLACK_SIGNING_SECRET_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "feishuAppId",
        FEISHU_APP_ID_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "feishuAppSecret",
        FEISHU_APP_SECRET_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "feishuEncryptKey",
        FEISHU_ENCRYPT_KEY_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "feishuVerificationToken",
        FEISHU_VERIFICATION_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "lineChannelAccessToken",
        LINE_CHANNEL_ACCESS_TOKEN_ENV,
        secretStorageAvailable,
      ),
      this.readSecretState(
        "lineChannelSecret",
        LINE_CHANNEL_SECRET_ENV,
        secretStorageAvailable,
      ),
    ]);
    const messaging = this.readMessagingSettings();
    return {
      fetchedAt: this.now(),
      messaging: {
        ...messaging,
        telegram: { ...messaging.telegram, botToken: telegramBotToken },
        discord: { ...messaging.discord, botToken: discordBotToken },
        mattermost: {
          ...messaging.mattermost,
          botToken: mattermostBotToken,
          hmacSecret: mattermostHmacSecret,
        },
        slack: {
          ...messaging.slack,
          botToken: slackBotToken,
          appToken: slackAppToken,
          signingSecret: slackSigningSecret,
        },
        feishu: {
          ...messaging.feishu,
          appId: feishuAppId,
          appSecret: feishuAppSecret,
          encryptKey: feishuEncryptKey,
          verificationToken: feishuVerificationToken,
        },
        line: {
          ...messaging.line,
          channelAccessToken: lineChannelAccessToken,
          channelSecret: lineChannelSecret,
        },
      },
      runtime: {
        disabled: override.disabled,
        overrideActive: override.disabled,
        ...(override.disabled
          ? { disabledReasonKind: "explicit_override" as const }
          : {}),
        ...(override.reason ? { disabledReason: override.reason } : {}),
      },
    };
  }

  readFullAccessRiskWarningDismissed(): boolean {
    return this.readExperimentalConfig().fullAccessRiskWarningDismissed
      ?? false;
  }

  readGeneralConfig(): ConfigDomainMap["general"]["settings"] {
    return this.configStore.read("general").settings;
  }

  readExperimentalConfig(): ConfigDomainMap["experimental"] {
    return this.configStore.read("experimental");
  }

  readFederationConfig(): ConfigDomainMap["federation"] {
    return this.configStore.read("federation");
  }

  readModelsConfig(): ConfigDomainMap["models"] {
    return this.configStore.read("models");
  }

  readProvidersConfig(): ConfigDomainMap["providers"] {
    return this.configStore.read("providers");
  }

  readCodexProfiles(): DesktopCodexAuthProfileDiscoverySnapshot {
    return structuredClone(this.codexProfiles);
  }

  // Applications discovery is config-independent (depends only on this.env
  // + filesystem), so memoize the promise per instance to avoid re-spawning the
  // same probe child processes on every readSettings() call. See the cache
  // field declarations for the Windows-timeout motivation.
  //
  // Git discovery takes the configured path, so it is keyed by it the same way
  // gh discovery is: selecting a different git in Settings has to re-probe,
  // or the pane would keep showing the previous selection as live.
  private discoverGitCommandsCached(
    configuredCommand?: string,
  ): Promise<DesktopGitDiscoverySnapshot> {
    const key = configuredCommand?.trim() ?? "";
    if (this.gitDiscoveryCache?.key !== key) {
      const promise = discoverGitCommands({ configuredCommand, env: this.env });
      const cache: NonNullable<typeof this.gitDiscoveryCache> = { key, promise };
      void promise.then((result) => {
        cache.result = result;
      });
      this.gitDiscoveryCache = cache;
    }
    return this.gitDiscoveryCache.promise;
  }

  private discoverDesktopApplicationsCached(): Promise<DesktopApplicationsSnapshot> {
    this.applicationsDiscoveryPromise ??= discoverDesktopApplications({
      env: this.env,
    }).then((result) => {
      this.applicationsDiscovery = result;
      return result;
    });
    return this.applicationsDiscoveryPromise;
  }

  private discoverGhCommandsCached(
    configuredCommand: string | undefined,
  ): ReturnType<typeof discoverGhCommands> {
    const key = configuredCommand ?? "";
    if (this.ghDiscoveryCache?.key !== key) {
      const promise = discoverGhCommands({ configuredCommand, env: this.env });
      const cache: NonNullable<typeof this.ghDiscoveryCache> = { key, promise };
      void promise.then((result) => {
        cache.result = result;
      });
      this.ghDiscoveryCache = cache;
    }
    return this.ghDiscoveryCache.promise;
  }

  resolveWorktreeStorage(): DesktopWorktreeStorageLocation {
    const storage = this.configStore.read("worktrees").storage;
    return this.resolveWorktrees(storage)
      .storage.value;
  }

  resolveUpdateChannel(): DesktopUpdateChannel {
    const updates = this.configStore.read("updates");
    return this.resolveUpdateSelection(updates).channel
      .value;
  }

  resolveUpdateTrain(): DesktopUpdateTrain {
    const updates = this.configStore.read("updates");
    return this.resolveUpdateSelection(updates).train
      .value;
  }

  resolveDeveloperMode(): boolean {
    return this.resolveConfigBoolean(
      this.readGeneralConfig().developerMode,
      this.defaultDeveloperMode(),
    ).value;
  }

  resolveHotCpuProfilingEnabled(): boolean {
    return this.resolveConfigBoolean(
      this.readGeneralConfig().hotCpuProfilingEnabled,
      false,
    ).value;
  }

  resolveHotCpuProfilingCaptureHeapSnapshot(): boolean {
    return this.resolveConfigBoolean(
      this.readGeneralConfig().hotCpuProfilingCaptureHeapSnapshot,
      false,
    ).value;
  }

  resolveHotCpuProfilingStartDelayMs(): DesktopHotCpuProfileStartDelayMs {
    return this.resolveHotCpuProfileStartDelayMs(
      this.readGeneralConfig().hotCpuProfilingStartDelayMs,
    ).value;
  }

  resolveHotCpuProfilingTriggerMode(): DesktopHotCpuProfileTriggerMode {
    return this.resolveHotCpuProfileTriggerMode(
      this.readGeneralConfig().hotCpuProfilingTriggerMode,
    ).value;
  }

  resolveHotCpuProfilingSlowburnThresholdPercent(): number {
    return this.resolveHotCpuSlowburnThresholdPercent(
      this.readGeneralConfig().hotCpuProfilingSlowburnThresholdPercent,
    ).value;
  }

  resolveHotCpuProfilingHeapSnapshotLimit(): number {
    return this.resolveHotCpuHeapSnapshotLimit(
      this.readGeneralConfig().hotCpuProfilingHeapSnapshotLimit,
    ).value;
  }

  resolveIntegratedTerminalWindowsShell(): DesktopIntegratedTerminalWindowsShell {
    const windowsShell = this.configStore.read("integratedTerminal").windowsShell;
    return this.resolveIntegratedTerminalWindowsShellValue(
      windowsShell,
    ).value;
  }

  resolveConfirmQuitWithInProgressThreads(): boolean {
    return this.resolveConfigBoolean(
      this.readGeneralConfig().confirmQuitWithInProgressThreads,
      true,
    ).value;
  }

  resolvePdfAnalysisEnabled(): boolean {
    return this.resolveConfigBoolean(
      this.readGeneralConfig().pdfAnalysisEnabled,
      true,
    ).value;
  }

  resolveNotificationsEnabled(): boolean {
    return this.resolveConfigBoolean(
      this.readGeneralConfig().notificationsEnabled,
      false,
    ).value;
  }

  resolveTokenMiserEnabled(): boolean {
    return this.configStore.read("experimental").tokenMiserEnabled ?? false;
  }

  resolveTokenMiserDefaultEnabled(): boolean {
    return this.configStore.read("experimental").tokenMiserDefaultEnabled
      ?? true;
  }

  resolveToolOutputAlertPolicy(): DesktopToolOutputAlertPolicy {
    return resolveToolOutputAlertPolicy(this.configStore.read("general"));
  }

  resolveSpendAlertPolicy(): DesktopSpendAlertPolicy {
    return resolveSpendAlertPolicy(this.configStore.read("general"));
  }

  resolveCodexDefaultModeRequestUserInput(): boolean {
    return this.resolveConfigBoolean(
      this.readExperimentalConfig().codexDefaultModeRequestUserInput,
      false,
    ).value;
  }

  resolveManagedReviewEnabled(): boolean {
    return this.resolveConfigBoolean(
      this.readExperimentalConfig().managedReview,
      false,
    ).value;
  }

  resolveDefaultPrAutoDispatchEnabled(): boolean {
    const git = this.configStore.read("git");
    return this.resolveConfigBoolean(
      git?.defaultPrAutoDispatchEnabled,
      DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS,
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
    return this.configStore.read("onboarding").completed;
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

  async writeConfigPatchTargeted(
    patch: DesktopSettingsConfigPatch,
    discoveryPermit?: ProviderDiscoveryPermit,
  ): Promise<ConfigUpdateResult<keyof ConfigDomainMap>> {
    const fileStatus = this.configStore.fileStatus();
    if (fileStatus.kind === "invalid") {
      throw new Error(
        `Cannot save settings because ${this.configPath} could not be parsed: ${fileStatus.error}`,
      );
    }
    const tokenMiserEnabled =
      this.configStore.read("experimental").tokenMiserEnabled ?? false;
    const enablingTokenMiser =
      patch.experimental?.tokenMiserEnabled === true
      && !tokenMiserEnabled;
    const disablingTokenMiser =
      patch.experimental?.tokenMiserEnabled === false
      && tokenMiserEnabled;
    // The switch is a transaction from the operator's perspective: acquire a
    // usable managed Codex first, then persist availability. A failed first
    // install leaves the feature off instead of selecting an arbitrary Codex.
    if (enablingTokenMiser && this.options.ensureManagedCodexRuntime) {
      assertProviderDiscoveryPermit(discoveryPermit, [
        "settings-user-action",
        "setup-user-action",
      ]);
      await this.ensureManagedCodexRuntime("force");
    }
    if (disablingTokenMiser) {
      this.abortManagedCodexUpdate();
    }
    const update = await this.configStore.write(patch, CONFIG_DOMAIN_KEYS);
    if (
      patch.models?.codex?.path !== undefined
      || patch.experimental?.tokenMiserEnabled !== undefined
    ) {
      this.codexDiscoveryCoordinator.invalidate();
    }
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
        || appearancePatch.density !== undefined
        || appearancePatch.sidebarTextSize !== undefined
        || appearancePatch.transcriptTextSize !== undefined)
    ) {
      const next = update.values.general?.appearance;
      this.options.onAppearanceChange?.({
        theme: next?.theme ?? DESKTOP_APPEARANCE_THEME_DEFAULT,
        density: next?.density ?? DESKTOP_APPEARANCE_DENSITY_DEFAULT,
        sidebarTextSize:
          next?.sidebarTextSize ?? DESKTOP_TEXT_SIZE_DEFAULT,
        transcriptTextSize:
          next?.transcriptTextSize ?? DESKTOP_TEXT_SIZE_DEFAULT,
      });
    }
    // Any successful write notifies generic listeners so main-process services
    // (e.g. the background PR poller) can react to a changed experimental flag
    // without waiting for the next navigation snapshot to re-read settings.
    for (const listener of this.configWriteListeners) {
      try {
        listener();
      } catch {
        // Listeners are best-effort side effects; never fail a settings write.
      }
    }
    if (patch.experimental?.tokenMiserEnabled !== undefined) {
      await this.managedCodexRuntimeSwitchAttempt;
    }
    return update;
  }

  /**
   * Subscribe to successful config writes. Returns an unsubscribe function.
   * Fires after the write lands, so a listener that re-reads settings sees the
   * new value. Kept generic (not keyed to a section) — callers cheaply re-read
   * only what they care about.
   */
  onConfigWritten(listener: () => void): () => void {
    this.configWriteListeners.add(listener);
    return () => {
      this.configWriteListeners.delete(listener);
    };
  }

  async replaceSecret(
    secret: DesktopSettingsSecretName,
    value: string,
  ): Promise<DesktopSettingsSecretState> {
    await this.options.secretStore.setSecret(secret, value);
    return await this.readAndPublishSecretState(secret);
  }

  async clearSecret(
    secret: DesktopSettingsSecretName,
  ): Promise<DesktopSettingsSecretState> {
    await this.options.secretStore.deleteSecret(secret);
    return await this.readAndPublishSecretState(secret);
  }

  async getOrCreateFederationIdentityKeyPair(): Promise<FederationIdentityKeyPair> {
    const existing = await this.options.secretStore.getSecret(
      "federationInstancePrivateKey",
    );
    if (existing) {
      return {
        privateKeyPem: existing,
        publicKeyPem: publicKeyPemFromPrivateKey(existing),
      };
    }
    this.assertFederationKeyMaterialWritable("federationInstancePrivateKey");
    const keyPair = generateFederationIdentityKeyPair();
    await this.options.secretStore.setSecret(
      "federationInstancePrivateKey",
      keyPair.privateKeyPem,
    );
    return keyPair;
  }

  /**
   * Refuse to mint a replacement federation key when a stored one exists
   * but cannot be read, or when secret storage cannot persist a new one.
   * Silently generating a fresh key here is how a previously-working
   * pairing turns into "the key was invalid": every peer that pinned the
   * old key rejects the new identity with no explanation. Failing loudly
   * lets the operator rotate deliberately (Forget gateway + fresh invite)
   * instead of by accident.
   */
  private assertFederationKeyMaterialWritable(
    name: "federationInstancePrivateKey" | "federationNoiseStaticPrivateKey",
  ): void {
    const accessError = this.options.secretStore.getSecretAccessError?.(name);
    if (accessError) {
      throw new Error(
        `The stored federation key cannot be decrypted (${accessError}) ` +
          "PwrAgent will not silently replace it because peers pin this key. " +
          "To rotate deliberately, forget the gateway pairing in Settings → Federation and import a fresh invite.",
      );
    }
    const storage = this.options.secretStore.describe();
    if (!storage.available) {
      throw new Error(
        "Federation requires secret storage for its key material, but secret storage is unavailable" +
          `${storage.unavailableReason ? `: ${storage.unavailableReason}` : "."}`,
      );
    }
  }

  async resolveFederationCloudflareCredentials(): Promise<{
    clientCertificate?: string;
    clientPrivateKey?: string;
    accessClientId?: string;
    accessClientSecret?: string;
  }> {
    const [
      clientCertificate,
      clientPrivateKey,
      accessClientId,
      accessClientSecret,
    ] = await Promise.all([
      this.options.secretStore.getSecret(
        "federationCloudflareClientCertificate",
      ),
      this.options.secretStore.getSecret(
        "federationCloudflareClientPrivateKey",
      ),
      this.options.secretStore.getSecret(
        "federationCloudflareAccessClientId",
      ),
      this.options.secretStore.getSecret(
        "federationCloudflareAccessClientSecret",
      ),
    ]);
    return {
      clientCertificate,
      clientPrivateKey,
      accessClientId,
      accessClientSecret,
    };
  }

  async getOrCreateFederationNoiseStaticKeyPair(): Promise<FederationNoiseStaticKeyPair> {
    const existing = await this.options.secretStore.getSecret(
      "federationNoiseStaticPrivateKey",
    );
    if (existing) {
      return {
        privateKeyBase64: existing,
        publicKeyBase64: noisePublicKeyBase64FromPrivateBase64(existing),
      };
    }
    this.assertFederationKeyMaterialWritable("federationNoiseStaticPrivateKey");
    const keyPair = generateFederationNoiseStaticKeyPair();
    await this.options.secretStore.setSecret(
      "federationNoiseStaticPrivateKey",
      keyPair.privateKeyBase64,
    );
    return keyPair;
  }

  async resolvePwrSnapMcpCredential(): Promise<string | undefined> {
    return await this.options.secretStore.getSecret("pwrsnapMcpCredential");
  }

  async savePwrSnapMcpCredential(value: string): Promise<void> {
    await this.options.secretStore.setSecret("pwrsnapMcpCredential", value);
  }

  async clearPwrSnapMcpCredential(): Promise<void> {
    await this.options.secretStore.deleteSecret("pwrsnapMcpCredential");
  }

  async resolvePwrGitMcpCredential(): Promise<string | undefined> {
    return await this.options.secretStore.getSecret("pwrgitMcpCredential");
  }

  async savePwrGitMcpCredential(value: string): Promise<void> {
    await this.options.secretStore.setSecret("pwrgitMcpCredential", value);
  }

  async clearPwrGitMcpCredential(): Promise<void> {
    await this.options.secretStore.deleteSecret("pwrgitMcpCredential");
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
      ?? this.readMessagingConfig().mattermost?.serverUrl
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
    const config = this.readMessagingConfig().feishu;
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

  resolveCodexCommandPreference(): string | undefined {
    return this.resolveCodexCommandPreferenceFromConfig({
      models: this.readModelsConfig(),
    });
  }

  /** Codex home pinned when this process started; config changes need restart. */
  resolveStartupCodexHome(): string | undefined {
    return this.startupCodexHome;
  }

  async refreshStartupDiscovery(
    permit: ProviderDiscoveryPermit,
  ): Promise<DesktopSettingsSnapshot> {
    assertProviderDiscoveryPermit(permit, ["startup"]);
    if (!this.startupDiscoveryAttempted) {
      this.startupDiscoveryAttempted = true;
      const applications = this.configStore.read("applications");
      const configuredGhCommand = applications.gh?.path;
      this.startupDiscoveryPromise = Promise.allSettled([
        this.runCodexDiscovery(permit),
        this.discoverGhCommandsCached(configuredGhCommand),
        this.discoverGitCommandsCached(applications.git?.path),
        this.discoverDesktopApplicationsCached(),
      ]).then(() => undefined).finally(() => {
        this.startupDiscoveryPromise = undefined;
      });
    }
    await this.startupDiscoveryPromise;
    return await this.readSettingsProjection();
  }

  /**
   * Re-probes git candidates and returns the refreshed projection.
   *
   * Needed for two reasons the memoized startup probe cannot serve: the
   * "Re-check" button (which previously only re-read the projection, so
   * it re-rendered the same memoized snapshot), and a change to the
   * configured path, which has to re-run selection before the pane can
   * show which git is now live.
   */
  async refreshGitDiscovery(): Promise<DesktopSettingsSnapshot> {
    this.gitDiscoveryCache = undefined;
    await this.discoverGitCommandsCached(
      this.configStore.read("applications").git?.path,
    );
    return await this.readSettingsProjection();
  }

  async refreshCodexDiscovery(
    permit: ProviderDiscoveryPermit,
  ): Promise<DesktopSettingsSnapshot> {
    assertProviderDiscoveryPermit(permit, [
      "settings-user-action",
      "setup-user-action",
    ]);
    await this.runCodexDiscovery(permit);
    return await this.readSettingsProjection();
  }

  private async runCodexDiscovery(
    permit: ProviderDiscoveryPermit,
  ): Promise<void> {
    assertProviderDiscoveryPermit(permit);
    const attempt = this.runCodexDiscoveryAttempt(permit).finally(() => {
      // Settled marks the attempt, not its outcome. A discovery that ran and
      // found nothing is a real answer that surfaces must be free to act on;
      // only a discovery that has not run yet leaves them without one.
      this.codexDiscoverySettled = true;
      if (this.codexDiscoveryPromise === attempt) {
        this.codexDiscoveryPromise = undefined;
      }
    });
    this.codexDiscoveryPromise = attempt;
    await attempt;
  }

  private async runCodexDiscoveryAttempt(
    permit: ProviderDiscoveryPermit,
  ): Promise<void> {
    this.codexSpawnEnvHydratedAt = undefined;
    const config = this.readConfig().config;
    const checkMode = permit.intent === "startup" ? "ttl" : "force";
    const previousManagedCommand =
      this.managedCodexRuntime?.command
      ?? this.configStore.read("providers").codex.lastKnownGood?.selectedCommand;
    try {
      this.managedCodexRuntime = await this.resolveManagedCodexRuntime(
        config,
        checkMode,
      );
      this.managedCodexError = undefined;
    } catch (error) {
      this.managedCodexError = error instanceof Error
        ? error.message
        : String(error);
    }
    if (
      this.managedCodexRuntime
      && this.resolveTokenMiserEnabled()
      && this.managedCodexRuntime.command !== previousManagedCommand
    ) {
      this.managedCodexRuntimeSwitchPending = true;
      await this.publishManagedCodexSelectionChange({
        enabled: true,
        reason: "update",
        runtime: this.managedCodexRuntime,
      });
    }
    const configuredCommand = this.resolveActiveCodexCommand(config);
    const discovery = await this.codexDiscoveryCoordinator.discover(
      configuredCommand,
      {
        allowStaleSuccess: permit.intent === "startup",
        force: permit.intent !== "startup",
      },
    );
    this.codexProfiles = normalizeCodexProfilesSnapshot(
      discoverCodexAuthProfiles({
        configuredProfile: config.models?.codex?.profile,
        env: this.env,
      }),
    );
    const selected = discovery.candidates.find((candidate) => candidate.selected);
    this.configStore.recordProviderDiscovery("codex", {
      candidates: discovery.candidates.map((candidate) => ({
        command: candidate.command,
        source: candidate.source,
        ...(candidate.version ? { version: candidate.version } : {}),
        ...(candidate.failureReason || candidate.versionFailureReason
          ? {
              failureReason:
                candidate.failureReason ?? candidate.versionFailureReason,
            }
          : {}),
      })),
      ...(discovery.error ? { error: discovery.error } : {}),
      ...(discovery.selectedCommand
        ? { selectedCommand: discovery.selectedCommand }
        : {}),
      ...(selected?.version ? { selectedVersion: selected.version } : {}),
    });
  }

  async resolveCodexCommand(): Promise<ResolvedCodexCommandCandidate> {
    const resolved = this.readSelectedCodexCommand();
    if (resolved) {
      return resolved;
    }
    // A Codex discovery is already running and is the authority for this
    // profile's selection. Waiting for the answer in flight is not a retry:
    // the durable last-known-good read above is an optimization that is
    // legitimately empty on a cold profile, after a provider fingerprint
    // change, and for the whole window between process start and the first
    // published discovery. Background callers that land inside that window —
    // archived binding cleanup is the routine one — were otherwise told to
    // "Refresh Codex in Settings" about a Codex that was seconds from
    // resolving normally.
    //
    // This waits on the Codex leg alone, never on `startupDiscoveryPromise`,
    // which also bundles gh, git, and the desktop-application scan: a Codex
    // spawn must not block on probes it does not use.
    //
    // Re-entrancy: `publishManagedCodexSelectionChange` can reach this method
    // from inside the discovery it would await. That is safe only because
    // `readSelectedCodexCommand()` above returns the managed runtime, which
    // `runCodexDiscoveryAttempt` assigns before publishing. Any future caller
    // reached earlier in that function would await its own discovery — resolve
    // it from state, not by awaiting here.
    const codexDiscovery = this.codexDiscoveryPromise;
    if (codexDiscovery) {
      await codexDiscovery;
      const discovered = this.readSelectedCodexCommand();
      if (discovered) {
        return discovered;
      }
    }
    throw new Error(
      "Codex discovery has not selected an executable. Refresh Codex in Settings.",
    );
  }

  /**
   * The currently selected Codex executable, or `undefined` when no discovery
   * has published one yet. Never probes the machine.
   */
  private readSelectedCodexCommand():
    | ResolvedCodexCommandCandidate
    | undefined {
    const managedRuntime = this.managedCodexRuntime;
    if (managedRuntime) {
      return {
        command: managedRuntime.command,
        source: "config",
        version: managedRuntime.metadata.version,
      };
    }
    const configuredCommand = this.resolveCodexCommandPreference();
    const cached = this.codexDiscoveryCoordinator.peek?.(configuredCommand)
      ?? codexDiscoveryFromProvider(this.configStore.read("providers").codex);
    const selected = cached.candidates.find((candidate) => candidate.selected);
    if (!selected) {
      return undefined;
    }
    return {
      command: selected.command,
      source: selected.source,
      ...(selected.version ? { version: selected.version } : {}),
    };
  }

  /**
   * Whether a Codex discovery still owes this profile an answer. The desktop
   * uses it to keep a startup surface pending rather than reporting a
   * configured profile as having no provider.
   *
   * Deliberately keyed on discovery state alone, never on
   * `readSelectedCodexCommand()`. That resolver answers from the managed
   * runtime and the coordinator cache, which `runCodexDiscoveryAttempt`
   * populates seconds before it publishes `lastKnownGood` — and
   * `lastKnownGood` is what `readCodexBackendSummary` derives `available`
   * from. Consulting the resolver here made the two disagree for the length
   * of a version probe, dropping the pending flag while the summary was still
   * unavailable: exactly the window this flag exists to cover.
   */
  isCodexDiscoveryPending(): boolean {
    return this.codexDiscoveryPromise !== undefined
      || !this.codexDiscoverySettled;
  }

  /**
   * Record that no startup Codex discovery is coming in this process, so
   * surfaces stop waiting for one.
   *
   * A bootstrap or onboarding-incomplete boot never requests startup
   * discovery, and nothing re-requests it when the wizard completes in the
   * same process. Without this, `isCodexDiscoveryPending()` would stay true
   * for the life of that process and every consumer would wait forever for an
   * answer that was never scheduled.
   */
  markStartupCodexDiscoverySkipped(): void {
    if (this.codexDiscoveryPromise) {
      return;
    }
    this.codexDiscoverySettled = true;
  }

  /**
   * Commands whose containing directories must lead PATH in a newly opened
   * human-facing integrated terminal. This is intentionally separate from the
   * agent subprocess environments: an operator running `codex mcp login` or a
   * Grok command in PwrAgent should reach the same selected runtime PwrAgent
   * launches for threads.
   */
  resolveIntegratedTerminalCommands(): string[] {
    // Reads the two sections it needs rather than `readConfig()`, which
    // `structuredClone`s every section — this runs on each terminal open. The
    // store hands back its live objects, so `models` is cloned before it
    // leaves; `providerConfigSection` already returns a fresh object built
    // from three primitives, so cloning its input would guard nothing and
    // would copy the projection's candidate and validation history.
    const grok = providerConfigSection(this.configStore.read("providers").grok);
    const grokEnabled = grok.enabled !== false;
    const grokOverride = grokEnabled
      ? this.resolveString(grok.cliPath, ACP_AGENTS_GROK_CLI_PATH_ENV)
        .value
        .trim() || undefined
      : undefined;
    const shouldResolveManagedGrok =
      grokEnabled
      && !grokOverride
      && (
        grok.managedBuilds
        ?? this.options.defaultManagedGrokBuilds
        ?? true
      );
    const codexCommand = this.resolveActiveCodexCommand({
      models: structuredClone(this.configStore.read("models")),
    });
    const grokCommand = grokOverride
      ?? (shouldResolveManagedGrok
        ? this.options.resolveActiveManagedGrokCommand?.()
        : undefined);
    return [codexCommand, grokCommand].filter(
      (command): command is string => command !== undefined,
    );
  }

  /**
   * Publish already-completed managed Codex selections to runtime owners.
   *
   * This observer is intentionally passive. It must never install, update,
   * probe, or launch Codex. Those operations are admitted only by an explicit
   * startup, Settings, or setup discovery permit.
   */
  watchManagedCodexRuntime(
    listener: (
      change: ManagedCodexSelectionChange,
    ) => Promise<unknown> | unknown,
    _options: { intervalMs?: number } = {},
  ): () => void {
    let enabled = this.resolveTokenMiserEnabled();
    this.managedCodexSelectionListeners.add(listener);
    const onExperimentalChanged = () => {
      const nextEnabled = this.resolveTokenMiserEnabled();
      if (nextEnabled === enabled) return;
      enabled = nextEnabled;
      if (enabled) {
        this.managedCodexRuntimeSwitchPending = true;
      } else {
        this.abortManagedCodexUpdate();
        this.managedCodexRuntimeSwitchPending = false;
        this.managedCodexRuntime = undefined;
      }
      void this.publishManagedCodexSelectionChange({
        enabled,
        reason: "availability",
        ...(enabled && this.managedCodexRuntime
          ? { runtime: this.managedCodexRuntime }
          : {}),
      });
    };
    const unsubscribe = this.configStore.subscribe(
      ["experimental"],
      onExperimentalChanged,
    );

    return () => {
      this.managedCodexSelectionListeners.delete(listener);
      unsubscribe();
    };
  }

  private async publishManagedCodexSelectionChange(
    change: ManagedCodexSelectionChange,
  ): Promise<void> {
    const attempt = Promise.all(
      [...this.managedCodexSelectionListeners].map(async (listener) => {
        try {
          await listener(change);
        } catch (error) {
          getMainLogger("pwragent:managed-codex").warn(
            "managed-codex-selection-change-failed",
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      }),
    ).then(() => undefined);
    this.managedCodexRuntimeSwitchAttempt = attempt;
    await attempt;
  }

  requiresManagedTokenMiserActivation(): boolean {
    return Boolean(
      this.options.ensureManagedCodexRuntime
      && this.resolveTokenMiserEnabled(),
    );
  }

  markManagedCodexRuntimeSwitchComplete(): void {
    this.managedCodexRuntimeSwitchPending = false;
    this.options.onManagedCodexRuntimeSwitchComplete?.();
  }

  resolveProviderModelDefaults() {
    return this.readModelsConfig().providerDefaults ?? {};
  }

  resolveProviderThreadModelMigrations() {
    return this.readModelsConfig().providerThreadMigrations ?? {};
  }

  resolveCodexFastAllowed(): boolean {
    return this.resolveConfigBoolean(
      this.readModelsConfig().codex?.allowFast,
      true,
    ).value;
  }

  resolveCodexSpawnEnv(): NodeJS.ProcessEnv {
    if (this.options.resolveCodexShellEnv) {
      return this.withStartupCodexHome(
        buildPwrAgentChildProcessEnv(
          mergeLoginShellEnvIntoEnv(buildPwrAgentChildProcessEnv(this.env), {
            resolveShellEnv: this.options.resolveCodexShellEnv,
            // Preserve the in-tree copy's diagnostic logging (the kit defaults to
            // no-op when no logger is injected).
            logger: getMainLogger("pwragent:shell-environment"),
          }),
        ),
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
    const hydrationTtlMs = this.codexSpawnEnvHydrationSucceeded
      ? CODEX_DISCOVERY_SUCCESS_TTL_MS
      : CODEX_DISCOVERY_NOT_INSTALLED_TTL_MS;
    if (
      this.codexSpawnEnvHydratedAt !== undefined
      && this.now() - this.codexSpawnEnvHydratedAt < hydrationTtlMs
    ) {
      return targetEnv;
    }

    const hydrationPromise = resolveInteractiveLoginShellEnvAsync(this.env)
      .then((shellEnv) => {
        const logger = getMainLogger("pwragent:shell-environment");
        if (!shellEnv || Object.keys(shellEnv).length === 0) {
          this.codexSpawnEnvHydratedAt = this.now();
          this.codexSpawnEnvHydrationSucceeded = false;
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
        mergePwrAgentChildProcessEnv(targetEnv, shellEnv);
        if (this.startupCodexHome) {
          targetEnv.CODEX_HOME = this.startupCodexHome;
        }
        this.codexSpawnEnvHydratedAt = this.now();
        this.codexSpawnEnvHydrationSucceeded = true;
        return targetEnv;
      });
    this.codexSpawnEnvHydrationPromise = hydrationPromise;
    try {
      return await hydrationPromise;
    } finally {
      if (this.codexSpawnEnvHydrationPromise === hydrationPromise) {
        this.codexSpawnEnvHydrationPromise = undefined;
      }
    }
  }

  async resolveTerminalSpawnEnvAsync(): Promise<NodeJS.ProcessEnv> {
    if (this.options.resolveCodexShellEnv) {
      return this.withStartupCodexHome(
        buildPwrAgentChildProcessEnv(
          mergeLoginShellEnvIntoEnv(buildPwrAgentChildProcessEnv(this.env), {
            resolveShellEnv: this.options.resolveCodexShellEnv,
            logger: getMainLogger("pwragent:shell-environment"),
          }),
        ),
      );
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
      mergePwrAgentChildProcessEnv(targetEnv, shellEnv);
      if (this.startupCodexHome) {
        targetEnv.CODEX_HOME = this.startupCodexHome;
      }
      return targetEnv;
    });

    return await this.terminalSpawnEnvHydrationPromise;
  }

  private ensureBaseCodexSpawnEnv(): NodeJS.ProcessEnv {
    this.codexSpawnEnv ??= this.withStartupCodexHome(
      buildPwrAgentChildProcessEnv(this.env),
    );
    return this.codexSpawnEnv;
  }

  /**
   * The Codex command PwrAgent launches right now. Gating this on
   * `experimental.tokenMiserEnabled` instead would answer `undefined` while
   * the managed runtime is still installing or after it failed, even though a
   * thread started at that moment falls back to the configured command.
   */
  private resolveActiveCodexCommand(
    config: Pick<DesktopSettingsConfig, "models">,
  ): string | undefined {
    return this.managedCodexRuntime?.command
      ?? this.resolveCodexCommandPreferenceFromConfig(config);
  }

  private resolveCodexCommandPreferenceFromConfig(
    config: Pick<DesktopSettingsConfig, "models">,
  ): string | undefined {
    return (
      readEnvString(this.env, CODEX_COMMAND_ENV)
      || config.models?.codex?.path
      || undefined
    );
  }

  private async resolveManagedCodexRuntime(
    config: DesktopSettingsConfig,
    checkMode: ManagedCodexCheckMode,
    options: {
      signal?: AbortSignal;
      waitForUpdate?: boolean;
    } = {},
  ): Promise<ManagedCodexRuntime | undefined> {
    if (
      !this.options.ensureManagedCodexRuntime
      || !this.resolveConfigBoolean(
        config.experimental?.tokenMiserEnabled,
        false,
      ).value
    ) {
      return undefined;
    }
    return await this.ensureManagedCodexRuntime(checkMode, {
      signal: options.signal ?? this.resolveManagedCodexUpdateSignal(),
      ...(options.waitForUpdate !== undefined
        ? { waitForUpdate: options.waitForUpdate }
        : {}),
    });
  }

  private async ensureManagedCodexRuntime(
    checkMode: ManagedCodexCheckMode,
    options: {
      signal?: AbortSignal;
      waitForUpdate?: boolean;
    } = {},
  ): Promise<ManagedCodexRuntime> {
    if (!this.options.ensureManagedCodexRuntime) {
      throw new Error("Managed Codex installation is unavailable.");
    }
    const runtime = await this.options.ensureManagedCodexRuntime({
      checkMode,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.waitForUpdate !== undefined
        ? { waitForUpdate: options.waitForUpdate }
        : {}),
    });
    this.managedCodexRuntime = runtime;
    return runtime;
  }

  private resolveManagedCodexUpdateSignal(): AbortSignal {
    if (
      !this.managedCodexUpdateAbortController
      || this.managedCodexUpdateAbortController.signal.aborted
    ) {
      this.managedCodexUpdateAbortController = new AbortController();
    }
    return this.managedCodexUpdateAbortController.signal;
  }

  private abortManagedCodexUpdate(): void {
    this.managedCodexUpdateAbortController?.abort();
    this.managedCodexUpdateAbortController = undefined;
  }

  private ensureBaseTerminalSpawnEnv(): NodeJS.ProcessEnv {
    this.terminalSpawnEnv ??= this.withStartupCodexHome(
      buildPwrAgentChildProcessEnv(this.env),
    );
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
    const configured = this.configStore.read("applications").gh?.path;
    return (
      readEnvString(this.env, GH_COMMAND_ENV)
      || configured
      || undefined
    );
  }

  /**
   * The git the main process should spawn, or `undefined` when the
   * operator has expressed no preference and `PATH` should decide.
   * Installed as the `git-command` resolver at startup, so every git
   * spawn honours the Settings pane's selection.
   *
   * A configured path the last discovery run found unusable is dropped.
   * Discovery's own selection already skips a non-executable candidate, so
   * without this the Settings pane would show one git as "In use" while
   * every direct `getGitCommand()` spawn ran a different, broken one — the
   * realistic case being an OS update that re-arms the Xcode license
   * prompt under an operator who had chosen Apple's git. Env override is
   * exempt: it is an explicit escape hatch and must not be second-guessed,
   * and a path we have not probed is trusted rather than ignored.
   */
  resolveGitCommandPreference(): string | undefined {
    const envOverride = readEnvString(this.env, GIT_COMMAND_ENV);
    if (envOverride) {
      return envOverride;
    }

    const configured = this.configStore.read("applications").git?.path?.trim();
    if (!configured) {
      return undefined;
    }

    const probed = this.gitDiscoveryCache?.result?.candidates.find(
      (candidate) => candidate.command === configured,
    );
    return probed && !probed.executable ? undefined : configured;
  }

  private readConfig(): ConfigReadResult {
    const providers = this.configStore.read("providers");
    const onboarding = this.configStore.read("onboarding");
    const fileStatus = this.configStore.fileStatus();
    return {
      config: structuredClone({
        general: this.configStore.read("general").settings,
        onboarding: onboarding.completedSource === "migrated"
          ? {}
          : {
              completed: onboarding.completed,
              ...(onboarding.completedSource
                ? { completedSource: onboarding.completedSource }
                : {}),
            },
        experimental: this.configStore.read("experimental"),
        messaging: this.configStore.read("messaging"),
        federation: this.configStore.read("federation"),
        models: this.configStore.read("models"),
        acpAgents: {
          gemini: providerConfigSection(providers.gemini),
          grok: providerConfigSection(providers.grok),
          kimi: providerConfigSection(providers.kimi),
          qwen: providerConfigSection(providers.qwen),
        },
        applications: this.configStore.read("applications"),
        git: this.configStore.read("git"),
        updates: this.configStore.read("updates"),
        worktrees: this.configStore.read("worktrees"),
        ui: this.configStore.read("ui"),
        integratedTerminal: this.configStore.read("integratedTerminal"),
        imageUploads: this.configStore.read("imageUploads"),
      } satisfies DesktopSettingsConfig),
      ...(fileStatus.kind === "invalid" ? { error: fileStatus.error } : {}),
    };
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

  private resolveMessagingPdfProfile(
    configValue: DesktopMessagingImageProfile | undefined,
  ): DesktopSettingsValue<DesktopMessagingImageProfile> {
    const envValue = readEnvMessagingPdfProfile(this.env);
    if (envValue.value) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "high",
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

  private resolvePrAutoDispatchBudgetNumber(
    configValue: number | undefined,
    defaultValue: number,
    minValue: number,
    maxValue: number,
  ): DesktopSettingsValue<number> {
    const normalized =
      configValue !== undefined && Number.isFinite(configValue)
        ? Math.min(maxValue, Math.max(minValue, Math.floor(configValue)))
        : undefined;
    return {
      value: normalized ?? defaultValue,
      source: normalized === undefined ? "default" : "config",
    };
  }

  private currentAppVersion(): string {
    return this.options.appVersion
      ?? this.options.resolveAppVersion?.()
      ?? "";
  }

  private resolveUpdateSelection(updates?: {
    channel?: DesktopUpdateChannel;
    train?: DesktopUpdateTrain;
  }): {
    channel: DesktopSettingsValue<DesktopUpdateChannel>;
    train: DesktopSettingsValue<DesktopUpdateTrain>;
  } {
    // Infer the version-derived pair only when neither key exists. A
    // pre-train config with only `channel = "prerelease"` must stay on
    // Stable so installing a 1.1.0-beta binary does not silently move
    // that operator onto Beta Prerelease / alphas.
    if (updates?.channel === undefined && updates?.train === undefined) {
      const inferred = inferDesktopUpdateSelection(this.currentAppVersion());
      return {
        channel: { value: inferred.channel, source: "default" },
        train: { value: inferred.train, source: "default" },
      };
    }
    return {
      channel: {
        value: updates.channel ?? DESKTOP_UPDATE_CHANNEL_DEFAULT,
        source: updates.channel === undefined ? "default" : "config",
      },
      train: {
        value: updates.train ?? DESKTOP_UPDATE_TRAIN_DEFAULT,
        source: updates.train === undefined ? "default" : "config",
      },
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

  private resolveTextSize(
    configValue: DesktopTextSize | undefined,
  ): DesktopSettingsValue<DesktopTextSize> {
    return {
      value: configValue ?? DESKTOP_TEXT_SIZE_DEFAULT,
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

  private resolveFederationMode(
    configValue: DesktopFederationMode | undefined,
  ): DesktopSettingsValue<DesktopFederationMode> {
    return {
      value: configValue ?? DESKTOP_FEDERATION_MODE_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveFederationEndpointList(
    configValue: string[] | undefined,
    fallbackUrl?: string,
  ): DesktopSettingsValue<string[]> {
    const configured = configValue
      ?.map((endpoint) => endpoint.trim())
      .filter((endpoint) => endpoint.length > 0);
    if (configured && configured.length > 0) {
      return { value: configured, source: "config" };
    }
    const fallback = fallbackUrl?.trim();
    if (fallback) {
      return { value: [fallback], source: "config" };
    }
    return { value: [], source: "default" };
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

  private resolveConfigStringWithDefault(
    configValue: string | undefined,
    defaultValue: string,
  ): DesktopSettingsValue<string> {
    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveConfigNumber(
    configValue: number | undefined,
    defaultValue: number,
  ): DesktopSettingsValue<number> {
    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveBoundedConfigInteger(
    configValue: number | undefined,
    defaultValue: number,
    minValue: number,
    maxValue: number,
  ): DesktopSettingsValue<number> {
    const normalized =
      configValue !== undefined && Number.isFinite(configValue)
        ? Math.min(maxValue, Math.max(minValue, Math.round(configValue)))
        : undefined;
    return {
      value: normalized ?? defaultValue,
      source: normalized === undefined ? "default" : "config",
    };
  }

  private resolveBoundedConfigAmount(
    configValue: number | undefined,
    defaultValue: number,
    minValue: number,
    maxValue: number,
  ): DesktopSettingsValue<number> {
    const normalized =
      configValue !== undefined && Number.isFinite(configValue)
        ? Math.min(
            maxValue,
            Math.max(minValue, Math.round(configValue * 100) / 100),
          )
        : undefined;
    return {
      value: normalized ?? defaultValue,
      source: normalized === undefined ? "default" : "config",
    };
  }

  private resolveToolUpdateMode(
    configValue: MessagingToolUpdateMode | undefined,
    defaultValue: MessagingToolUpdateMode = "show_some",
  ): DesktopSettingsValue<MessagingToolUpdateMode> {
    return {
      value: configValue ?? defaultValue,
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
  ): DesktopSettingsValue<DesktopMessagingAuthorizationMode> {
    return {
      value: configValue ?? SLACK_TEAM_AUTHORIZATION_MODE_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackChannelAuthorizationMode(
    configValue: DesktopMessagingAuthorizationMode | undefined,
  ): DesktopSettingsValue<DesktopMessagingAuthorizationMode> {
    return {
      value: configValue ?? SLACK_CHANNEL_AUTHORIZATION_MODE_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackDmAccessMode(
    configValue: DesktopMessagingSlackDmAccessMode | undefined,
  ): DesktopSettingsValue<DesktopMessagingSlackDmAccessMode> {
    return {
      value: configValue ?? SLACK_DM_ACCESS_MODE_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  /**
   * Last recorded Codex-side activation result. Absent on a profile that has
   * never tried to activate, which reads as "no claim either way" rather than
   * as a failure.
   */
  private async readTokenMiserActivation(): Promise<
    TokenMiserActivationStatus | undefined
  > {
    try {
      const raw = await readFile(
        path.join(
          path.dirname(this.configPath),
          "state",
          "token-miser",
          TOKEN_MISER_ACTIVATION_FILENAME,
        ),
        "utf8",
      );
      const parsed = JSON.parse(raw) as TokenMiserActivationStatus;
      if (parsed.state !== "active" && parsed.state !== "unavailable") {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private resolveSlackChannelUserAccessMode(
    configValue: DesktopMessagingSlackChannelUserAccessMode | undefined,
  ): DesktopSettingsValue<DesktopMessagingSlackChannelUserAccessMode> {
    return {
      value: configValue ?? SLACK_CHANNEL_USER_ACCESS_MODE_DEFAULT,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveSlackGroupDmAccessMode(
    configValue: DesktopMessagingSlackGroupDmAccessMode | undefined,
  ): DesktopSettingsValue<DesktopMessagingSlackGroupDmAccessMode> {
    return {
      value: configValue ?? SLACK_GROUP_DM_ACCESS_MODE_DEFAULT,
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
    // The profile database is shared by processes. Sample presence for every
    // projection so a secret created outside Settings cannot stay cached as
    // absent; secret values themselves are never read here.
    const state = await this.loadSecretState(secret, envKey, storageAvailable);
    this.configStore.recordSecretPresence(secret, state);
    return state;
  }

  private async loadSecretState(
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

  private async readAndPublishSecretState(
    secret: DesktopSettingsSecretName,
  ): Promise<DesktopSettingsSecretState> {
    return await this.readSecretState(
      secret,
      secretEnvironmentKey(secret),
      this.options.secretStore.describe().available,
    );
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

function secretEnvironmentKey(
  secret: DesktopSettingsSecretName,
): string | undefined {
  switch (secret) {
    case "telegramBotToken":
      return TELEGRAM_BOT_TOKEN_ENV;
    case "discordBotToken":
      return DISCORD_BOT_TOKEN_ENV;
    case "mattermostBotToken":
      return MATTERMOST_BOT_TOKEN_ENV;
    case "mattermostHmacSecret":
      return MATTERMOST_CALLBACK_HMAC_SECRET_ENV;
    case "slackBotToken":
      return SLACK_BOT_TOKEN_ENV;
    case "slackAppToken":
      return SLACK_APP_TOKEN_ENV;
    case "slackSigningSecret":
      return SLACK_SIGNING_SECRET_ENV;
    case "feishuAppId":
      return FEISHU_APP_ID_ENV;
    case "feishuAppSecret":
      return FEISHU_APP_SECRET_ENV;
    case "feishuEncryptKey":
      return FEISHU_ENCRYPT_KEY_ENV;
    case "feishuVerificationToken":
      return FEISHU_VERIFICATION_TOKEN_ENV;
    case "lineChannelAccessToken":
      return LINE_CHANNEL_ACCESS_TOKEN_ENV;
    case "lineChannelSecret":
      return LINE_CHANNEL_SECRET_ENV;
    case "federationInstancePrivateKey":
    case "federationNoiseStaticPrivateKey":
    case "federationCloudflareClientCertificate":
    case "federationCloudflareClientPrivateKey":
    case "federationCloudflareAccessClientId":
    case "federationCloudflareAccessClientSecret":
    case "pwrsnapMcpCredential":
    case "pwrgitMcpCredential":
      return undefined;
  }
}

function feishuTenantUrlForRegion(region: "feishu" | "lark"): string {
  return region === "lark" ? LARK_DEFAULT_TENANT_URL : FEISHU_DEFAULT_TENANT_URL;
}
