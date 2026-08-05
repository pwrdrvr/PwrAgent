import { ipcMain } from "electron";
import {
  INTEGRATED_TERMINAL_CLOSE_CHANNEL,
  INTEGRATED_TERMINAL_CREATE_CHANNEL,
  INTEGRATED_TERMINAL_LIST_CHANNEL,
  INTEGRATED_TERMINAL_RESIZE_CHANNEL,
  INTEGRATED_TERMINAL_REVEAL_CHANNEL,
  INTEGRATED_TERMINAL_SESSIONS_CHANNEL,
  INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL,
  INTEGRATED_TERMINAL_WRITE_CHANNEL,
} from "../../shared/ipc";
import type {
  IntegratedTerminalCloseRequest,
  IntegratedTerminalCreateRequest,
  IntegratedTerminalCreateResponse,
  IntegratedTerminalResizeRequest,
  IntegratedTerminalSessionSummary,
  IntegratedTerminalSetPanelHiddenRequest,
  IntegratedTerminalWriteRequest,
} from "../../shared/integrated-terminal";
import { IntegratedTerminalService } from "../terminal/integrated-terminal-service";
import type { IntegratedTerminalQuitSnapshot } from "../terminal/integrated-terminal-service";
import { isFederationWindowWebContents } from "../window";
import { subscribersForChannel } from "../window-channels";
import { FederationTerminalBridge } from "./federation-terminal";

let service: IntegratedTerminalService | undefined;
let federationBridge: FederationTerminalBridge | undefined;

function broadcastSessions(
  sessions: IntegratedTerminalSessionSummary[],
): void {
  for (const webContents of subscribersForChannel(
    INTEGRATED_TERMINAL_SESSIONS_CHANNEL,
  )) {
    // A federation window mirrors REMOTE sessions (its bridge sends those
    // directly); the local PTY list would let this machine's shells leak
    // into a window branded as the peer.
    if (isFederationWindowWebContents(webContents)) continue;
    webContents.send(INTEGRATED_TERMINAL_SESSIONS_CHANNEL, { sessions });
  }
}

export function registerIntegratedTerminalIpcHandlers(): void {
  service ??= new IntegratedTerminalService({
    onSessionsChanged: broadcastSessions,
  });
  federationBridge ??= new FederationTerminalBridge();

  ipcMain.removeHandler(INTEGRATED_TERMINAL_CREATE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_CREATE_CHANNEL,
    async (
      event,
      request: IntegratedTerminalCreateRequest,
    ): Promise<IntegratedTerminalCreateResponse> => {
      // A federation window NEVER falls through to a local spawn: the bridge
      // routes to the owning instance and throws when the remote target or
      // capability is missing.
      if (isFederationWindowWebContents(event.sender)) {
        return await federationBridge!.createOrAttach(request, event.sender);
      }
      return await service!.createOrAttach(request, event.sender);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_WRITE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_WRITE_CHANNEL,
    (event, request: IntegratedTerminalWriteRequest): void => {
      if (isFederationWindowWebContents(event.sender)) {
        federationBridge?.write(request, event.sender);
        return;
      }
      service?.write(request);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_RESIZE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_RESIZE_CHANNEL,
    (event, request: IntegratedTerminalResizeRequest): void => {
      if (isFederationWindowWebContents(event.sender)) {
        federationBridge?.resize(request, event.sender);
        return;
      }
      service?.resize(request);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_CLOSE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_CLOSE_CHANNEL,
    (event, request: IntegratedTerminalCloseRequest): void => {
      if (isFederationWindowWebContents(event.sender)) {
        federationBridge?.close(request, event.sender);
        return;
      }
      service?.close(request);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_LIST_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_LIST_CHANNEL,
    (event): IntegratedTerminalSessionSummary[] => {
      if (isFederationWindowWebContents(event.sender)) {
        return federationBridge?.listSessions(event.sender) ?? [];
      }
      return service?.listSessions() ?? [];
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL,
    (event, request: IntegratedTerminalSetPanelHiddenRequest): void => {
      if (isFederationWindowWebContents(event.sender)) {
        federationBridge?.setPanelHidden(request, event.sender);
        return;
      }
      service?.setPanelHidden(request);
    },
  );
}

export function disposeIntegratedTerminalIpcHandlers(): void {
  ipcMain.removeHandler(INTEGRATED_TERMINAL_CREATE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_WRITE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_RESIZE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_CLOSE_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_LIST_CHANNEL);
  ipcMain.removeHandler(INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL);
  service?.dispose();
  service = undefined;
  federationBridge?.dispose();
  federationBridge = undefined;
}

export function getIntegratedTerminalQuitSnapshot(): IntegratedTerminalQuitSnapshot {
  return (
    service?.getQuitSnapshot() ?? {
      count: 0,
      sessionIds: [],
      threadKeys: [],
    }
  );
}

/**
 * Ask every subscribed renderer to open a thread's terminal panel. Used by the
 * quit dialog's "running work" links: clicking a terminal row should land you
 * on the thread with the shell already on screen, whatever the panel's
 * remembered hidden state was.
 *
 * No session, no reveal. The quit dialog renders a snapshot taken when the
 * prompt opened and can sit there indefinitely once the countdown is cancelled,
 * so a listed shell may well have exited by the time the row is clicked.
 * Broadcasting anyway made the renderer open a panel for a thread with no
 * session, which spawned a brand-new login shell in the home directory — a
 * fresh quit blocker, conjured by trying to look at one.
 */
export function revealIntegratedTerminal(threadKey: string): boolean {
  const revealed = service?.revealSession(threadKey) ?? false;
  if (!revealed) {
    return false;
  }
  for (const webContents of subscribersForChannel(
    INTEGRATED_TERMINAL_REVEAL_CHANNEL,
  )) {
    webContents.send(INTEGRATED_TERMINAL_REVEAL_CHANNEL, { threadKey });
  }
  return true;
}
