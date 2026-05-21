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
import {
  assertUnreachableProfileBootDecision,
  findLiveProfileRuntimeMarkers,
  isValidProfileName,
  resolveActiveProfileName,
} from "../profile";
import { getAppStateMode, getBootDecision } from "../state/app-state";

const bootInfoLog = getMainLogger("pwragent:boot-info");

/**
 * Build the `DesktopBootInfo` snapshot for the renderer. Mirrors
 * `getBootDecision()` (set once at startup by index.ts) into a
 * shape the wizard can use to pick its entry mode. Specifically:
 *
 *   - `mode: "bootstrap"` means the wizard is running against the
 *     throwaway `.bootstrap/` profile and its Finish path must
 *     graduate to a real profile (see `graduateBootstrapConfigToProfile`).
 *   - `decisionKind: "missing-named-profile"` + `requestedProfileName`
 *     means the operator launched with `--profile=foo` or
 *     `PWRAGENT_PROFILE=foo` and `foo` doesn't exist. The wizard
 *     pre-populates that name and shows a "set up `foo`?" prompt.
 *
 * If app-state was reset (e.g. tests) and the boot decision is
 * unrecorded, this falls back to a safe "active-profile, open"
 * shape so the wizard's "first-run mode" code path still works.
 */
export function buildBootInfo(): DesktopBootInfo {
  const mode = getAppStateMode() ?? "active-profile";
  const decision = getBootDecision();
  // In active-profile mode the active profile name is the wizard's
  // target for buffered-secret graduation when the operator picks
  // Shared mode (or runs via Help → Replay Onboarding) — no new
  // profile gets created, so we write secrets straight to the
  // profile the renderer is already bound to. In bootstrap mode
  // this stays undefined; the wizard picks per-profile targets
  // through the Multiple/Isolated naming step instead.
  const activeProfileName =
    mode === "active-profile" ? resolveActiveProfileName() : undefined;

  if (!decision) {
    return {
      mode,
      decisionKind: "open",
      ...(activeProfileName ? { activeProfileName } : {}),
    };
  }

  switch (decision.kind) {
    case "open":
      return {
        mode,
        decisionKind: "open",
        ...(activeProfileName ? { activeProfileName } : {}),
      };
    case "missing-named-profile":
      return {
        mode,
        decisionKind: "missing-named-profile",
        requestedProfileName: decision.requestedName,
      };
    case "missing-default-profile":
      return {
        mode,
        decisionKind: "missing-default-profile",
        configuredDefaultName: decision.configuredName,
      };
    case "no-profile-configured":
      return { mode, decisionKind: "no-profile-configured" };
    default:
      // See note on `assertUnreachableProfileBootDecision`. Adding
      // a new ProfileBootDecision variant without extending
      // `DesktopBootInfo['decisionKind']` is a compile error here.
      return assertUnreachableProfileBootDecision(decision);
  }
}

export function registerBootInfoIpcHandlers(): void {
  ipcMain.removeHandler(APP_GET_BOOT_INFO_CHANNEL);
  ipcMain.handle(
    APP_GET_BOOT_INFO_CHANNEL,
    async (): Promise<DesktopBootInfo> => buildBootInfo(),
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
      const profile = request.profile.trim();
      if (!isValidProfileName(profile)) {
        throw new Error(`Invalid profile name "${profile}".`);
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
