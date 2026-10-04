import { dialog, type BrowserWindow, type RenderProcessGoneDetails } from "electron";
import {
  MAX_AUTOMATIC_RENDERER_RECOVERIES,
  RENDERER_RECOVERY_DELAY_MS,
} from "../shared/renderer-recovery";
import { getMainLogger } from "./log";

const recoveryLog = getMainLogger("pwragent:renderer:recovery");

/** Recover the existing shell, retaining its channels, peer target and bounds. */
export function attachRendererProcessRecovery(window: BrowserWindow): void {
  let automaticAttempts = 0;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prompting = false;
  const contents = window.webContents;
  const usable = (): boolean => !closing && !window.isDestroyed() && !contents.isDestroyed();
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const offerManualRecovery = async (): Promise<void> => {
    if (!usable() || prompting) return;
    prompting = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: "error",
        title: "PwrAgent window recovery",
        message: "This window stopped unexpectedly.",
        detail: "Automatic recovery could not restore it. Running agents and connections continue. Reload this window to try again. Edits since the last draft save may be lost.",
        buttons: ["Reload window", "Leave window"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0 && usable()) {
        recoveryLog.info("manual reload", { webContentsId: contents.id, automaticAttempts });
        contents.reload();
      }
    } catch (error) {
      recoveryLog.error("manual recovery failed", error);
    } finally {
      prompting = false;
    }
  };
  const reload = (): void => {
    clearTimer();
    if (!usable()) return;
    try {
      contents.reload();
    } catch (error) {
      recoveryLog.error("reload failed", error);
      void offerManualRecovery();
    }
  };

  contents.on("render-process-gone", (_event, details: RenderProcessGoneDetails) => {
    clearTimer();
    if (details.reason === "clean-exit" || !usable()) return;
    const automatic = automaticAttempts < MAX_AUTOMATIC_RENDERER_RECOVERIES;
    if (automatic) automaticAttempts += 1;
    // Native termination cannot supply a React stack or flush renderer memory.
    // Log the process evidence before reloading; never close/recreate the shell.
    recoveryLog.error("renderer terminated", {
      webContentsId: contents.id,
      reason: details.reason,
      exitCode: details.exitCode,
      action: automatic ? "automatic-reload" : "stopped",
      attempt: automaticAttempts,
      limit: MAX_AUTOMATIC_RENDERER_RECOVERIES,
    });
    if (automatic) timer = setTimeout(reload, RENDERER_RECOVERY_DELAY_MS);
    else void offerManualRecovery();
  });
  // A reload that cannot load the bundle needs a native fallback as well.
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (automaticAttempts > 0 && isMainFrame && code !== -3) {
      clearTimer();
      void offerManualRecovery();
    }
  });
  // A close attempt may be cancelled (e.g. during quit confirmation). Cancel
  // the queued reload without permanently disabling a surviving window.
  window.on("close", clearTimer);
  window.once("closed", () => {
    closing = true;
    clearTimer();
  });
}
