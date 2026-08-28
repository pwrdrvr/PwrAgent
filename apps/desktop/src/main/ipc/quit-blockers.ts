import { ipcMain, type WebContents } from "electron";
import { parseThreadIdentityKey } from "@pwragent/shared";
import {
  QUIT_BLOCKERS_READ_CHANNEL,
  QUIT_BLOCKER_REVEAL_CHANNEL,
} from "../../shared/ipc";
import {
  quitBlockerItemKey,
  type RevealQuitBlockerRequest,
  type RevealQuitBlockerResponse,
} from "../../shared/quit-blockers";
import {
  getCurrentQuitBlockers,
  readQuitBlockerQueueSnapshot,
} from "../quit-manager";
import { revealIntegratedTerminal } from "./integrated-terminal";
import { requestShowThread } from "../window-show-thread";

export function registerQuitBlockerIpcHandlers(): void {
  ipcMain.removeHandler(QUIT_BLOCKERS_READ_CHANNEL);
  ipcMain.handle(QUIT_BLOCKERS_READ_CHANNEL, readQuitBlockerQueueSnapshot);

  ipcMain.removeHandler(QUIT_BLOCKER_REVEAL_CHANNEL);
  ipcMain.handle(
    QUIT_BLOCKER_REVEAL_CHANNEL,
    async (event, request: RevealQuitBlockerRequest): Promise<RevealQuitBlockerResponse> =>
      revealCurrentQuitBlocker(request, event.sender),
  );
}

export function disposeQuitBlockerIpcHandlers(): void {
  ipcMain.removeHandler(QUIT_BLOCKERS_READ_CHANNEL);
  ipcMain.removeHandler(QUIT_BLOCKER_REVEAL_CHANNEL);
}

export function revealCurrentQuitBlocker(
  request: RevealQuitBlockerRequest,
  sender: WebContents,
): RevealQuitBlockerResponse {
  const requestKey = quitBlockerItemKey(request);
  const item = getCurrentQuitBlockers().items.find(
    (candidate) => quitBlockerItemKey(candidate) === requestKey,
  );
  if (!item) {
    return { revealed: false };
  }
  const parsed = parseThreadIdentityKey(item.threadKey);
  if (!parsed) {
    return { revealed: false };
  }
  const terminal = item.kind === "terminal"
    ? revealIntegratedTerminal(item.threadKey, {
        ...(item.target
          ? { instanceId: item.target.instanceId }
          : {}),
      })
    : undefined;
  requestShowThread(parsed, {
    preferWebContents: terminal?.owner ?? sender,
  });
  return { revealed: true };
}
