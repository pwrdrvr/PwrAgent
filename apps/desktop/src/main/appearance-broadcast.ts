/**
 * Fan out an appearance change to every open BrowserWindow that
 * registered for the `APPEARANCE_CHANGED_EVENT_CHANNEL`. Called from
 * `DesktopSettingsService.writeConfigPatch` after a TOML write that
 * touched `[general.appearance]`.
 *
 * The main window already updates locally via its `useAppearance` hook
 * (it's the one that initiated the write); the broadcast is what makes
 * the aux windows (changelog, app-log, license, messaging activity)
 * follow along. Without this they stay stuck on whatever theme they
 * bootstrapped with at window creation.
 */

import { BrowserWindow } from "electron";
import type { BootstrapAppearance } from "./settings/appearance-bootstrap";
import { themedTitleBarOverlay } from "./settings/appearance-bootstrap";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";

const isWindows = process.platform === "win32";

export function broadcastAppearanceChange(
  appearance: BootstrapAppearance,
): void {
  const overlay = isWindows ? themedTitleBarOverlay(appearance) : undefined;
  for (const webContents of subscribersForChannel(
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  )) {
    webContents.send(APPEARANCE_CHANGED_EVENT_CHANNEL, appearance);
    // On Windows, re-color the OS caption-button overlay so min/max/close
    // match the new theme. Only windows created with `titleBarOverlay` accept
    // this; for any that weren't, setTitleBarOverlay throws — ignore those.
    if (overlay) {
      const window = BrowserWindow.fromWebContents(webContents);
      try {
        window?.setTitleBarOverlay({
          color: overlay.color,
          symbolColor: overlay.symbolColor,
        });
      } catch {
        // Window has no Window Controls Overlay (e.g. not yet converted).
      }
    }
  }
}
