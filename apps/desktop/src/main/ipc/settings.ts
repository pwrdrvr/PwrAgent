import { BrowserWindow, dialog, ipcMain } from "electron";
import type {
  ClearDesktopSettingsSecretRequest,
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
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import {
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared";
import {
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
  SETTINGS_PICK_GH_COMMAND_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
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
import { validateGhCommand } from "../settings/gh-discovery";

function getService(service?: DesktopSettingsService): DesktopSettingsService {
  return service ?? getDesktopSettingsService();
}

async function refreshModelBackendsIfNeeded(params: {
  patch?: WriteDesktopSettingsConfigRequest["patch"];
  secret?: ReplaceDesktopSettingsSecretRequest["secret"];
}): Promise<void> {
  if (
    params.patch?.models?.codex?.path !== undefined
    || params.patch?.models?.codex?.profile !== undefined
    || params.secret === "grokApiKey"
  ) {
    await disposeDesktopBackendRegistry();
  }
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
    || secret === "slackSigningSecret";
}

async function applyLatestMessagingRuntimeConfig(
  service: DesktopSettingsService,
): Promise<void> {
  const runtime = getDesktopMessagingRuntime();
  const runtimeOverride = resolveRuntimeMessagingOverride();
  await runtime.applyConfig(
    await loadDesktopMessagingConfigFromSettings(service, process.env, {
      logStartupEligibility: true,
    }),
    {
      allowStart: !runtimeOverride.disabled || runtime.isEnabled(),
    },
  );
}

function applyRuntimeMessagingSnapshot(
  snapshot: DesktopSettingsSnapshot,
): DesktopSettingsSnapshot {
  const overrideActive = snapshot.runtime.messaging.overrideActive === true;
  const runtimeEnabled = overrideActive
    ? getDesktopMessagingRuntime().isEnabled()
    : snapshot.messaging.enabled.value;
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      messaging: {
        ...snapshot.runtime.messaging,
        disabled: overrideActive
          ? !runtimeEnabled
          : snapshot.messaging.enabled.value === false,
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
      resolveGrokApiKey: () => resolveService().resolveGrokApiKey(),
      resolveCodexCommand: async () => {
        const snapshot = await resolveService().readSettings();
        return (
          snapshot.models.codex.discovery.selectedCommand
          ?? snapshot.models.codex.path.value
          ?? undefined
        );
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
  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.removeHandler(SETTINGS_PICK_GH_COMMAND_CHANNEL);
  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  ipcMain.removeHandler(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL);
  disposeCredentialTester();
}
