import type { WebContents } from "electron";
import { WINDOW_SHOW_QUIT_BLOCKERS_CHANNEL } from "../shared/ipc";
import type { QuitBlockerQueueSnapshot } from "../shared/quit-blockers";

export function requestShowQuitBlockers(
  webContents: WebContents,
  snapshot: QuitBlockerQueueSnapshot,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send(WINDOW_SHOW_QUIT_BLOCKERS_CHANNEL, snapshot);
}
