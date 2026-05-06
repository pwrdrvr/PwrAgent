import { ipcMain } from "electron";
import type {
  ClearDesktopSettingsSecretRequest,
  DesktopSettingsWriteResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
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
 */
let credentialTesterInstance: CredentialTester | undefined;

function getCredentialTester(
  service: DesktopSettingsService,
): CredentialTester {
  if (!credentialTesterInstance) {
    credentialTesterInstance = new CredentialTester({
      resolveTelegramBotToken: () => service.resolveTelegramBotTokenSync(),
      resolveDiscordBotToken: () => service.resolveDiscordBotTokenSync(),
      resolveGrokApiKey: () => service.resolveGrokApiKey(),
      resolveCodexCommand: async () => {
        const snapshot = await service.readSettings();
        return (
          snapshot.models.codex.discovery.selectedCommand
          ?? snapshot.models.codex.path.value
          ?? undefined
        );
      },
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

  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.handle(
    SETTINGS_TEST_CREDENTIALS_CHANNEL,
    async (
      _event,
      request: SettingsCredentialTestRequest,
    ): Promise<SettingsCredentialTestResult> => {
      const tester = getCredentialTester(getService(service));
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
      const tester = getCredentialTester(getService(service));
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
  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  disposeCredentialTester();
}
