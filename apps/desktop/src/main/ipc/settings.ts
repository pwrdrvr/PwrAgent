import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  CheckDesktopCodexAuthProfileStatusRequest,
  CheckDesktopCodexAuthProfileStatusResponse,
  ClearDesktopSettingsSecretRequest,
  CreateDesktopCodexAuthProfileRequest,
  CreateDesktopCodexAuthProfileResponse,
  DesktopMessagingContactLookupRequest,
  DesktopMessagingContactLookupResponse,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsWriteResponse,
  DesktopSettingsSnapshot,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  PickGhCommandResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
  SettingsCredentialTestKind,
  SettingsCredentialTestRequest,
  SettingsCredentialTestResult,
  StartDesktopCodexAuthProfileLoginRequest,
  StartDesktopCodexAuthProfileLoginResponse,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import {
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared";
import {
  SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL,
  SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
  SETTINGS_PICK_GH_COMMAND_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
  SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
  SETTINGS_TEST_CREDENTIALS_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
} from "../../shared/ipc";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { disposeDesktopBackendRegistry } from "../app-server/backend-registry";
import { CredentialTester } from "../credential-tester/credential-tester";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "../messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { validateGhCommand } from "../settings/gh-discovery";
import {
  createCodexAuthProfile,
  resolveCodexHomeForProfile,
} from "../settings/codex-profiles";
import { getMainLogger } from "../log";

const settingsIpcLog = getMainLogger("pwragent:settings");
const activeCodexLoginProcesses = new Map<
  string,
  ChildProcess
>();

function getService(service?: DesktopSettingsService): DesktopSettingsService {
  return service ?? getDesktopSettingsService();
}

async function refreshModelBackendsIfNeeded(params: {
  patch?: WriteDesktopSettingsConfigRequest["patch"];
  secret?: ReplaceDesktopSettingsSecretRequest["secret"];
}): Promise<void> {
  if (
    params.patch?.models?.codex?.path !== undefined
    || params.secret === "grokApiKey"
  ) {
    await disposeDesktopBackendRegistry();
  }
}

async function resolveCodexCommandForProfileWorkflow(
  service: DesktopSettingsService,
): Promise<string> {
  const snapshot = await service.readSettings();
  const command = snapshot.models.codex.discovery.selectedCommand;
  if (!command) {
    throw new Error("No Codex command is configured or discoverable.");
  }
  return command;
}

function resolveRequiredCodexProfileHome(profile: string): string {
  const codexHome = resolveCodexHomeForProfile(profile);
  if (!codexHome) {
    throw new Error("A named Codex profile is required.");
  }
  return codexHome;
}

function collectCodexStatus(command: string, codexHome: string): Promise<{
  code: number | null;
  detail: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, ["login", "status"], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: null, detail: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, detail: output.trim() });
    });
  });
}

async function checkCodexProfileAuthStatus(
  service: DesktopSettingsService,
  request: CheckDesktopCodexAuthProfileStatusRequest,
): Promise<CheckDesktopCodexAuthProfileStatusResponse> {
  const profile = request.profile.trim();
  const codexHome = resolveRequiredCodexProfileHome(profile);
  const command = await resolveCodexCommandForProfileWorkflow(service);
  const result = await collectCodexStatus(command, codexHome);
  const authenticated = result.code === 0;
  return {
    profile,
    codexHome,
    authenticated,
    status:
      result.code === null
        ? "failed"
        : authenticated
          ? "authenticated"
          : "unauthenticated",
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

function parseCodexLoginPrompt(output: string): {
  loginUrl?: string;
} {
  return {
    loginUrl: output.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\S+/)?.[0],
  };
}

async function startCodexProfileLoginProcess(params: {
  codexHome: string;
  command: string;
  profile: string;
}): Promise<StartDesktopCodexAuthProfileLoginResponse> {
  activeCodexLoginProcesses.get(params.profile)?.kill();
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, ["login"], {
      env: {
        ...process.env,
        CODEX_HOME: params.codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeCodexLoginProcesses.set(params.profile, child);

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const prompt = parseCodexLoginPrompt(output);
      settingsIpcLog.warn("codex login prompt did not appear before timeout", {
        profile: params.profile,
        pid: child.pid,
      });
      resolve({
        profile: params.profile,
        codexHome: params.codexHome,
        started: true,
        pid: child.pid,
        ...prompt,
        ...(output.trim() ? { detail: output.trim() } : {}),
      });
    }, 8_000);

    const maybeResolve = () => {
      if (settled) return;
      const prompt = parseCodexLoginPrompt(output);
      if (!prompt.loginUrl) return;
      settled = true;
      clearTimeout(timeout);
      void shell.openExternal(prompt.loginUrl).catch((error) => {
        settingsIpcLog.warn("failed to open codex login URL", {
          error: error instanceof Error ? error.message : String(error),
          profile: params.profile,
        });
      });
      resolve({
        profile: params.profile,
        codexHome: params.codexHome,
        started: true,
        pid: child.pid,
        ...prompt,
        detail: output.trim(),
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      maybeResolve();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      maybeResolve();
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (activeCodexLoginProcesses.get(params.profile) === child) {
        activeCodexLoginProcesses.delete(params.profile);
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        void (async () => {
          const status = await collectCodexStatus(params.command, params.codexHome);
          if (status.code === 0) {
            resolve({
              profile: params.profile,
              codexHome: params.codexHome,
              started: false,
              pid: child.pid,
              authenticated: true,
              ...(status.detail ? { detail: status.detail } : {}),
            });
            return;
          }
          reject(
            new Error(
              output.trim()
                || status.detail
                || `Codex login exited before emitting a login link (code ${code ?? "unknown"}).`,
            ),
          );
        })();
      }
    });
  });
}

function messagingPatchTouchesRuntime(
  patch: DesktopSettingsConfigPatch | undefined,
): boolean {
  return patch?.messaging !== undefined;
}

function messagingSecretTouchesRuntime(
  secret: DesktopSettingsSecretName,
): boolean {
  return secret === "telegramBotToken"
    || secret === "discordBotToken"
    || secret === "mattermostBotToken"
    || secret === "mattermostHmacSecret"
    || secret === "slackBotToken"
    || secret === "slackAppToken"
    || secret === "slackSigningSecret"
    || secret === "feishuAppId"
    || secret === "feishuAppSecret"
    || secret === "feishuEncryptKey"
    || secret === "feishuVerificationToken";
}

async function applyLatestMessagingRuntimeConfig(
  service: DesktopSettingsService,
): Promise<void> {
  const runtime = getDesktopMessagingRuntime();
  const runtimeOverride = resolveRuntimeMessagingOverride();
  await getRuntimeMessagingLeaseCoordinator().applyLatestConfig(
    runtime,
    (options) =>
      loadDesktopMessagingConfigFromSettings(service, process.env, options),
    {
      logStartupEligibility: true,
      allowStart: !runtimeOverride.disabled || runtime.isEnabled(),
    },
  );
}

function applyRuntimeMessagingSnapshot(
  snapshot: DesktopSettingsSnapshot,
): DesktopSettingsSnapshot {
  const leaseSnapshot = getRuntimeMessagingLeaseCoordinator().snapshot();
  const leaseOverrideActive = leaseSnapshot.disabledReasonKind === "lease_held";
  const overrideActive =
    snapshot.runtime.messaging.overrideActive === true || leaseOverrideActive;
  const runtimeEnabled = overrideActive
    ? getDesktopMessagingRuntime().isEnabled()
    : snapshot.messaging.enabled.value;
  const disabledReason =
    leaseSnapshot.disabledReason ?? snapshot.runtime.messaging.disabledReason;
  const disabledReasonKind =
    leaseSnapshot.disabledReasonKind
    ?? snapshot.runtime.messaging.disabledReasonKind;
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      messaging: {
        ...snapshot.runtime.messaging,
        disabled: overrideActive
          ? !runtimeEnabled
          : snapshot.messaging.enabled.value === false,
        overrideActive,
        ...(disabledReason ? { disabledReason } : {}),
        ...(disabledReasonKind ? { disabledReasonKind } : {}),
        ...(leaseSnapshot.leaseHolder
          ? { leaseHolder: leaseSnapshot.leaseHolder }
          : {}),
      },
    },
  };
}

async function resolveMessagingContact(
  service: DesktopSettingsService,
  request: DesktopMessagingContactLookupRequest,
): Promise<DesktopMessagingContactLookupResponse> {
  const id = request.id.trim();
  if (!id) {
    return {
      status: "failed",
      id,
      errorMessage: "ID is required.",
    };
  }

  switch (request.platform) {
    case "telegram": {
      if (request.kind !== "user" && request.kind !== "supergroup") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveTelegramBotTokenSync();
      if (!botToken) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-telegram");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken },
          { id, kind: request.kind },
        ),
      );
    }
    case "discord": {
      if (request.kind !== "user" && request.kind !== "guild") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveDiscordBotTokenSync();
      if (!botToken) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-discord");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken },
          { id, kind: request.kind },
        ),
      );
    }
    case "mattermost": {
      if (request.kind !== "user") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveMattermostBotTokenSync();
      const serverUrl = service.resolveMattermostServerUrlSync();
      if (!botToken || !serverUrl) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-mattermost");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken, serverUrl },
          { id, kind: request.kind },
        ),
      );
    }
    case "slack": {
      if (request.kind !== "user" && request.kind !== "workspace") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveSlackBotTokenSync();
      if (!botToken) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-slack");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken },
          { id, kind: request.kind },
        ),
      );
    }
    case "feishu": {
      if (
        request.kind !== "user"
        && request.kind !== "chat"
        && request.kind !== "tenant"
      ) {
        return unsupportedLookup(request);
      }
      const appId = service.resolveFeishuAppIdSync();
      const appSecret = service.resolveFeishuAppSecretSync();
      const tenantUrl = service.resolveFeishuTenantUrlSync();
      if (!appId || !appSecret || !tenantUrl) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-feishu");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { appId, appSecret, tenantUrl },
          { id, kind: request.kind },
        ),
      );
    }
    case "line": {
      return unsupportedLookup(request);
    }
  }
}

function sanitizeMessagingContactLookupResponse(
  response: DesktopMessagingContactLookupResponse,
): DesktopMessagingContactLookupResponse {
  const displayName = sanitizeMessagingContactLabel(response.displayName);
  const handle = sanitizeMessagingContactHandle(response.handle);
  return {
    ...response,
    displayName: displayName || undefined,
    handle: handle ? `@${handle}` : undefined,
  };
}

function unsupportedLookup(
  request: DesktopMessagingContactLookupRequest,
): DesktopMessagingContactLookupResponse {
  return {
    status: "unsupported",
    id: request.id.trim(),
    errorMessage: `${request.platform} cannot resolve ${request.kind} contacts.`,
  };
}

/**
 * Process-singleton credential tester. Reads its dependencies from
 * the active settings service so each probe uses the freshest token /
 * path even after a config rewrite. Cached `lastResult` survives
 * IPC handler re-registration (e.g. test-suite reloads), but resets
 * on full process restart — that's the right granularity for a
 * "manually run" diagnostic.
 *
 * All resolvers (settings + messaging-runtime) are GETTERS, not
 * captured references. The tester is constructed once per process
 * but the underlying singletons can be replaced (profile switch,
 * hot-reload during dev, test-suite re-init); resolving lazily on
 * each call ensures the tester always talks to the live instance.
 * Capturing `service` directly at construction would silently call
 * into a stale settings service after a swap.
 */
let credentialTesterInstance: CredentialTester | undefined;

function getCredentialTester(
  service?: DesktopSettingsService,
): CredentialTester {
  if (!credentialTesterInstance) {
    const resolveService = (): DesktopSettingsService =>
      service ?? getDesktopSettingsService();
    credentialTesterInstance = new CredentialTester({
      resolveTelegramBotToken: () =>
        resolveService().resolveTelegramBotTokenSync(),
      resolveDiscordBotToken: () =>
        resolveService().resolveDiscordBotTokenSync(),
      resolveMattermostBotToken: () =>
        resolveService().resolveMattermostBotTokenSync(),
      resolveMattermostServerUrl: () =>
        resolveService().resolveMattermostServerUrlSync(),
      resolveSlackBotToken: () =>
        resolveService().resolveSlackBotTokenSync(),
      resolveFeishuAppId: () =>
        resolveService().resolveFeishuAppIdSync(),
      resolveFeishuAppSecret: () =>
        resolveService().resolveFeishuAppSecretSync(),
      resolveFeishuTenantUrl: () =>
        resolveService().resolveFeishuTenantUrlSync(),
      resolveLineChannelAccessToken: () =>
        resolveService().resolveLineChannelAccessTokenSync(),
      resolveGrokApiKey: () => resolveService().resolveGrokApiKey(),
      resolveCodexCommand: async () => {
        const snapshot = await resolveService().readSettings();
        return snapshot.models.codex.discovery.selectedCommand ?? undefined;
      },
      validateMessagingCredentials: (request) =>
        getDesktopMessagingRuntime().requestCredentialValidation(request),
    });
  }
  return credentialTesterInstance;
}

function startupCredentialResult(
  kind: SettingsCredentialTestKind,
): SettingsCredentialTestResult | undefined {
  if (
    kind !== "telegram"
    && kind !== "discord"
    && kind !== "mattermost"
    && kind !== "slack"
    && kind !== "feishu"
  ) {
    return undefined;
  }
  const metadata = getDesktopMessagingRuntime().getPlatformCredentialMetadata(kind);
  if (!metadata) return undefined;
  return {
    kind,
    status: "ok",
    testedAt: metadata.observedAt,
    durationMs: 0,
    ...(metadata.account !== undefined ? { account: metadata.account } : {}),
    ...(metadata.detail !== undefined ? { detail: metadata.detail } : {}),
  };
}

/** For tests / shutdown — reset the singleton tester. */
function disposeCredentialTester(): void {
  credentialTesterInstance = undefined;
}

export function registerSettingsIpcHandlers(
  service?: DesktopSettingsService,
  options?: {
    onConfigPatchWritten?: (
      patch: DesktopSettingsConfigPatch,
      snapshot: DesktopSettingsSnapshot,
    ) => void | Promise<void>;
  },
): void {
  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.handle(
    SETTINGS_READ_CHANNEL,
    async (
      _event,
      _request?: ReadDesktopSettingsRequest,
    ): Promise<ReadDesktopSettingsResponse> => ({
      snapshot: applyRuntimeMessagingSnapshot(
        await getService(service).readSettings(),
      ),
    }),
  );

  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.handle(
    SETTINGS_WRITE_CONFIG_CHANNEL,
    async (
      _event,
      request: WriteDesktopSettingsConfigRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const activeService = getService(service);
      const snapshot = await activeService.writeConfigPatch(request.patch);
      await options?.onConfigPatchWritten?.(request.patch, snapshot);
      await refreshModelBackendsIfNeeded({ patch: request.patch });
      if (messagingPatchTouchesRuntime(request.patch)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { snapshot: applyRuntimeMessagingSnapshot(snapshot) };
    },
  );

  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_REPLACE_SECRET_CHANNEL,
    async (
      _event,
      request: ReplaceDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const activeService = getService(service);
      const snapshot = await activeService.replaceSecret(
        request.secret,
        request.value,
      );
      await refreshModelBackendsIfNeeded({ secret: request.secret });
      if (messagingSecretTouchesRuntime(request.secret)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { snapshot: applyRuntimeMessagingSnapshot(snapshot) };
    },
  );

  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_CLEAR_SECRET_CHANNEL,
    async (
      _event,
      request: ClearDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const activeService = getService(service);
      const snapshot = await activeService.clearSecret(request.secret);
      await refreshModelBackendsIfNeeded({ secret: request.secret });
      if (messagingSecretTouchesRuntime(request.secret)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { snapshot: applyRuntimeMessagingSnapshot(snapshot) };
    },
  );

  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.handle(
    SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
    async (
      _event,
      _request?: RefreshDesktopCodexDiscoveryRequest,
    ): Promise<ReadDesktopSettingsResponse> => ({
      snapshot: applyRuntimeMessagingSnapshot(
        await getService(service).readSettings(),
      ),
    }),
  );

  ipcMain.removeHandler(SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL);
  ipcMain.handle(
    SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL,
    async (
      _event,
      request: CreateDesktopCodexAuthProfileRequest,
    ): Promise<CreateDesktopCodexAuthProfileResponse> =>
      createCodexAuthProfile(request.profile),
  );

  ipcMain.removeHandler(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL);
  ipcMain.handle(
    SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
    async (
      _event,
      request: StartDesktopCodexAuthProfileLoginRequest,
    ): Promise<StartDesktopCodexAuthProfileLoginResponse> => {
      const profile = request.profile.trim();
      const codexHome = resolveRequiredCodexProfileHome(profile);
      const command = await resolveCodexCommandForProfileWorkflow(
        getService(service),
      );
      return await startCodexProfileLoginProcess({
        codexHome,
        command,
        profile,
      });
    },
  );

  ipcMain.removeHandler(SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL);
  ipcMain.handle(
    SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
    async (
      _event,
      request: CheckDesktopCodexAuthProfileStatusRequest,
    ): Promise<CheckDesktopCodexAuthProfileStatusResponse> =>
      await checkCodexProfileAuthStatus(getService(service), request),
  );

  ipcMain.removeHandler(SETTINGS_PICK_GH_COMMAND_CHANNEL);
  ipcMain.handle(
    SETTINGS_PICK_GH_COMMAND_CHANNEL,
    async (event): Promise<PickGhCommandResponse> => {
      const window = BrowserWindow.fromWebContents(event.sender)
        ?? BrowserWindow.getFocusedWindow()
        ?? undefined;
      const result = window
        ? await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            title: "Choose gh",
          })
        : await dialog.showOpenDialog({
            properties: ["openFile"],
            title: "Choose gh",
          });
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true };
      }

      const selectedPath = result.filePaths[0];
      const candidate = await validateGhCommand({
        command: selectedPath,
        env: process.env,
      });
      if (!candidate.executable || !candidate.version) {
        return {
          canceled: false,
          path: selectedPath,
          candidate,
          error:
            candidate.failureReason
            ?? candidate.versionFailureReason
            ?? "Selected file did not respond to gh --version.",
        };
      }

      return {
        canceled: false,
        path: selectedPath,
        candidate,
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.handle(
    SETTINGS_TEST_CREDENTIALS_CHANNEL,
    async (
      _event,
      request: SettingsCredentialTestRequest,
    ): Promise<SettingsCredentialTestResult> => {
      const tester = getCredentialTester(service);
      return await tester.test(request.kind);
    },
  );

  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  ipcMain.handle(
    SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
    async (
      _event,
      request: { kind: SettingsCredentialTestKind },
    ): Promise<SettingsCredentialTestResult | undefined> => {
      const tester = getCredentialTester(service);
      return tester.lastResult(request.kind) ?? startupCredentialResult(request.kind);
    },
  );

  ipcMain.removeHandler(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL);
  ipcMain.handle(
    SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
    async (
      _event,
      request: DesktopMessagingContactLookupRequest,
    ): Promise<DesktopMessagingContactLookupResponse> =>
      await resolveMessagingContact(getService(service), request),
  );
}

export function disposeSettingsIpcHandlers(): void {
  for (const child of activeCodexLoginProcesses.values()) {
    child.kill();
  }
  activeCodexLoginProcesses.clear();
  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL);
  ipcMain.removeHandler(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_PICK_GH_COMMAND_CHANNEL);
  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  ipcMain.removeHandler(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL);
  disposeCredentialTester();
}
