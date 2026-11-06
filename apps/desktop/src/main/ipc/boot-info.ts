import { app, ipcMain } from "electron";
import type {
  DesktopBootInfo,
  WaitForDesktopProfileAliveRequest,
  WaitForDesktopProfileAliveResponse,
} from "@pwragent/shared";
import {
  APP_GET_BOOT_INFO_CHANNEL,
  APP_QUIT_CHANNEL,
  APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL,
} from "../../shared/ipc";
import { getMainLogger } from "../log";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import {
  findLiveProfileRuntimeMarkers,
  normalizeProfileName,
} from "../profile";
import { buildBootInfo } from "../profile-service";

export { buildBootInfo } from "../profile-service";

const bootInfoLog = getMainLogger("pwragent:boot-info");

export function registerBootInfoIpcHandlers(options?: {
  requestQuit?: () => Promise<void> | void;
}): void {
  ipcMain.removeHandler(APP_GET_BOOT_INFO_CHANNEL);
  ipcMain.handle(
    APP_GET_BOOT_INFO_CHANNEL,
    async (): Promise<DesktopBootInfo> =>
      await timeStartupProfileOperation({
        type: "ipc-main:getBootInfo",
        operation: async () => buildBootInfo(),
      }),
  );

  // `quitApp` fires from the wizard's bootstrap-confirm "Quit
  // PwrAgent" button AND from the post-graduation flow (after
  // `openPwrAgentProfile` spawns the new profile's window and
  // `waitForProfileAlive` confirms it loaded). `app.quit()` fires
  // before-quit so app-state shutdown runs cleanly. The dev-mode
  // Vite-dev-server race that earlier motivated a no-op quit is
  // now sidestepped by `waitForProfileAlive`: the wizard doesn't
  // call quit until the new process has fully loaded its renderer,
  // by which point the dev server's lifecycle no longer matters.
  ipcMain.removeHandler(APP_QUIT_CHANNEL);
  ipcMain.handle(APP_QUIT_CHANNEL, async (): Promise<void> => {
    if (options?.requestQuit) {
      await options.requestQuit();
      return;
    }
    app.quit();
  });

  // Wait for another PwrAgent process to be alive on a given profile.
  // The spawned Electron writes a runtime-instance heartbeat marker
  // shortly after `initializeAppState` runs — usually within ~500ms
  // of `spawn()` returning. This IPC polls every 200ms and resolves
  // as soon as the marker shows up. The wizard's graduation path
  // uses this to delay its own quit until the new window is up.
  ipcMain.removeHandler(APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL);
  ipcMain.handle(
    APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL,
    async (
      _event,
      request: WaitForDesktopProfileAliveRequest,
    ): Promise<WaitForDesktopProfileAliveResponse> => {
      const profile = normalizeProfileName(request.profile);
      if (!profile) {
        throw new Error(
          `Profile name "${request.profile}" must contain at least one letter or number.`,
        );
      }
      const timeoutMs = request.timeoutMs ?? 10_000;
      const pollIntervalMs = 200;
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (findLiveProfileRuntimeMarkers(profile).length > 0) {
          return {
            profile,
            alive: true,
            waitedMs: Date.now() - startedAt,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      bootInfoLog.warn("waitForProfileAlive timeout", { profile, timeoutMs });
      return { profile, alive: false, waitedMs: Date.now() - startedAt };
    },
  );
}

export function disposeBootInfoIpcHandlers(): void {
  ipcMain.removeHandler(APP_GET_BOOT_INFO_CHANNEL);
  ipcMain.removeHandler(APP_QUIT_CHANNEL);
  ipcMain.removeHandler(APP_WAIT_FOR_PROFILE_ALIVE_CHANNEL);
}
