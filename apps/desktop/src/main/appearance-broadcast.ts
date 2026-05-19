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

import type { BootstrapAppearance } from "./settings/appearance-bootstrap";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";

export function broadcastAppearanceChange(
  appearance: BootstrapAppearance,
): void {
  for (const webContents of subscribersForChannel(
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  )) {
    webContents.send(APPEARANCE_CHANGED_EVENT_CHANNEL, appearance);
  }
}
