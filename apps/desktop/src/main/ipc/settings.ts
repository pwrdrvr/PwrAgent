import { BrowserWindow, dialog, ipcMain } from "electron";
import type {
  ClearDesktopSettingsSecretRequest,
  DesktopSettingsWriteResponse,
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
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
  SETTINGS_PICK_GH_COMMAND_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_TEST_CREDENTIALS_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
} from "../../shared/ipc";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { disposeDesktopBackendRegistry } from "../app-server/backend-registry";
import { CredentialTester } from "../credential-tester/credential-tester";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { validateGhCommand } from "../settings/gh-discovery";

function getService(service?: DesktopSettingsService): DesktopSettingsService {
  return service ?? getDesktopSettingsService();
}

async function refreshModelBackendsIfNeeded(params: {
  patch?: WriteDesktopSettingsConfigRequest["patch"];
  secret?: ReplaceDesktopSettingsSecretRequest["secret"];
}): Promise<void> {
  if (params.patch?.models?.codex?.path !== undefined || params.secret === "grokApiKey") {
    await disposeDesktopBackendRegistry();
  }
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
      snapshot: await getService(service).readSettings(),
    }),
  );

  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.handle(
    SETTINGS_WRITE_CONFIG_CHANNEL,
    async (
      _event,
      request: WriteDesktopSettingsConfigRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const snapshot = await getService(service).writeConfigPatch(request.patch);
      await refreshModelBackendsIfNeeded({ patch: request.patch });
      return { snapshot };
    },
  );

  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_REPLACE_SECRET_CHANNEL,
    async (
      _event,
      request: ReplaceDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const snapshot = await getService(service).replaceSecret(
        request.secret,
        request.value,
      );
      await refreshModelBackendsIfNeeded({ secret: request.secret });
      return { snapshot };
    },
  );

  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_CLEAR_SECRET_CHANNEL,
    async (
      _event,
      request: ClearDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const snapshot = await getService(service).clearSecret(request.secret);
      await refreshModelBackendsIfNeeded({ secret: request.secret });
      return { snapshot };
    },
  );

  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.handle(
    SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
    async (
      _event,
      _request?: RefreshDesktopCodexDiscoveryRequest,
    ): Promise<ReadDesktopSettingsResponse> => ({
      snapshot: await getService(service).readSettings(),
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
      return tester.lastResult(request.kind);
    },
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
  disposeCredentialTester();
}
