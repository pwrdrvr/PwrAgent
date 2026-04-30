import { ipcMain } from "electron";
import type {
  ClearDesktopSettingsSecretRequest,
  DesktopSettingsWriteResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
  WriteDesktopSettingsConfigRequest,
} from "@pwragnt/shared";
import {
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
} from "../../shared/ipc";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";

function getService(service?: DesktopSettingsService): DesktopSettingsService {
  return service ?? getDesktopSettingsService();
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
    ): Promise<DesktopSettingsWriteResponse> => ({
      snapshot: await getService(service).writeConfigPatch(request.patch),
    }),
  );

  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_REPLACE_SECRET_CHANNEL,
    async (
      _event,
      request: ReplaceDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => ({
      snapshot: await getService(service).replaceSecret(
        request.secret,
        request.value,
      ),
    }),
  );

  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_CLEAR_SECRET_CHANNEL,
    async (
      _event,
      request: ClearDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => ({
      snapshot: await getService(service).clearSecret(request.secret),
    }),
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
}

export function disposeSettingsIpcHandlers(): void {
  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
}
