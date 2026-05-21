import { app, ipcMain } from "electron";
import type { DesktopBootInfo } from "@pwragent/shared";
import { APP_GET_BOOT_INFO_CHANNEL, APP_QUIT_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";
import { resolveActiveProfileName } from "../profile";
import { getAppStateMode, getBootDecision } from "../state/app-state";

const bootInfoLog = getMainLogger("pwragent:boot-info");

/**
 * Build the `DesktopBootInfo` snapshot for the renderer. Mirrors
 * `getBootDecision()` (set once at startup by index.ts) into a
 * shape the wizard can use to pick its entry mode. Specifically:
 *
 *   - `mode: "bootstrap"` means the wizard is running against the
 *     throwaway `.bootstrap/` profile and its Finish path must
 *     graduate to a real profile (see `graduateBootstrapToProfile`).
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
  }
}

export function registerBootInfoIpcHandlers(): void {
  ipcMain.removeHandler(APP_GET_BOOT_INFO_CHANNEL);
  ipcMain.handle(
    APP_GET_BOOT_INFO_CHANNEL,
    async (): Promise<DesktopBootInfo> => buildBootInfo(),
  );

  // `quitApp` is the wizard's exit hatch — fires from the
  // bootstrap-confirm screen's "Quit PwrAgent" button AND from the
  // wizard's post-graduation flow (after openPwrAgentProfile spawns
  // the new profile's window). `app.quit()` fires before-quit so
  // app-state shutdown runs cleanly and `.bootstrap/` cleanup
  // happens on the next boot.
  //
  // Dev-mode exception: skip the quit when NODE_ENV !== "production".
  // The dev-server race is real — when the bootstrap process exits,
  // the parent `electron-vite` (or similar dev harness) often tears
  // down the Vite dev server too, leaving the spawned profile
  // window's renderer with chrome-error://chromewebdata/. Production
  // builds (signed DMG) load the renderer from `file://`, no dev
  // server involved, so the quit is safe there. In dev the operator
  // closes the bootstrap window manually after the new window is up.
  ipcMain.removeHandler(APP_QUIT_CHANNEL);
  ipcMain.handle(APP_QUIT_CHANNEL, async (): Promise<void> => {
    if (process.env.NODE_ENV !== "production") {
      bootInfoLog.info(
        "quitApp skipped in dev — close the bootstrap window manually",
      );
      return;
    }
    app.quit();
  });
}

export function disposeBootInfoIpcHandlers(): void {
  ipcMain.removeHandler(APP_GET_BOOT_INFO_CHANNEL);
  ipcMain.removeHandler(APP_QUIT_CHANNEL);
}
