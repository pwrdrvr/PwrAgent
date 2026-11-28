import { realpath } from "node:fs/promises";
import { app, ipcMain } from "electron";
import {
  CODEX_USER_UPDATE_EVENT_CHANNEL,
  CODEX_USER_UPDATE_READ_CHANNEL,
  CODEX_USER_UPDATE_START_CHANNEL,
} from "../../../shared/ipc";
import type { CodexUserUpdateState } from "../../../shared/codex-user-update";
import { grokUpdateChecksDisabled } from "../../acp/grok-cli-update";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { CodexUserUpdateService, fetchLatestCodexVersion } from "../../codex-user-update";
import { getMainLogger } from "../../log.js";
import { pathIsExecutable, resolveCommandOnPath } from "../../settings/command-discovery";
import { getDesktopSettingsService } from "../../settings/desktop-settings-singleton";
import { issueProviderDiscoveryPermit } from "../../settings/provider-discovery-permit";
import { isFederationWindowWebContents } from "../window";
import { subscribersForChannel } from "../window-channels";

const log = getMainLogger("codex-user-update");

let current: { service: CodexUserUpdateService; unsubscribe: () => void } | undefined;

function broadcast(state: CodexUserUpdateState): void {
  for (const webContents of subscribersForChannel(CODEX_USER_UPDATE_EVENT_CHANNEL)) {
    if (!webContents.isDestroyed()) {
      webContents.send(CODEX_USER_UPDATE_EVENT_CHANNEL, state);
    }
  }
}

/**
 * Wire the stock Codex update check and Update button. Both act on this
 * machine's Codex, so a Federation viewer window reads nothing and cannot
 * start a run.
 */
export function registerCodexUserUpdateIpc(): void {
  current?.unsubscribe();
  current?.service.dispose();
  const service = new CodexUserUpdateService({
    readTarget: async () => await getDesktopSettingsService().readCodexUpdateTarget(),
    resolvePath: async (command) => await realpath(command).catch(() => undefined),
    resolveEnv: async () => await getDesktopSettingsService().resolveCodexSpawnEnvAsync(),
    fetchLatestVersion: async () => await fetchLatestCodexVersion(),
    rediscover: async () => {
      // The operator pressed Update: that is the same consent as Settings'
      // own rediscovery, and the only way to learn the new version.
      await getDesktopSettingsService().refreshCodexDiscovery(
        issueProviderDiscoveryPermit("settings-user-action"),
      );
    },
    restartCodex: async () => {
      await getDesktopBackendRegistry().invalidateProviderRuntimeSelections({
        acp: false,
        codex: true,
      });
    },
    isExecutable: pathIsExecutable,
    resolveOnPath: resolveCommandOnPath,
    // The predicate that keeps the Grok vendor check out of E2E captures.
    checksDisabled: grokUpdateChecksDisabled({ isPackaged: app?.isPackaged === true }),
    log: (message, fields) => log.warn(message, fields),
  });
  current = { service, unsubscribe: service.subscribe(broadcast) };

  ipcMain.removeHandler(CODEX_USER_UPDATE_READ_CHANNEL);
  ipcMain.handle(CODEX_USER_UPDATE_READ_CHANNEL, async (event): Promise<CodexUserUpdateState> => {
    if (isFederationWindowWebContents(event?.sender)) return {};
    return await service.readState();
  });

  ipcMain.removeHandler(CODEX_USER_UPDATE_START_CHANNEL);
  ipcMain.handle(CODEX_USER_UPDATE_START_CHANNEL, async (event): Promise<CodexUserUpdateState> => {
    if (isFederationWindowWebContents(event?.sender)) {
      throw new Error("A remote window cannot update this machine's Codex.");
    }
    return await service.startUpdate();
  });
}
