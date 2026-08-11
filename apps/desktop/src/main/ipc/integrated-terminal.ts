import { ipcMain, type WebContents } from "electron";
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
import { isRemoteFederationTarget } from "@pwragent/shared";
import {
  byThreadKey,
  IntegratedTerminalService,
} from "../terminal/integrated-terminal-service";
import type { IntegratedTerminalQuitSnapshot } from "../terminal/integrated-terminal-service";
import { isFederationWindowWebContents } from "../window";
import { subscribersForChannel } from "../window-channels";
import {
  FederationTerminalBridge,
  sortSessionsByCreatedAt,
} from "./federation-terminal";

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
    // The renderer replaces its whole list per event, so a main window
    // hosting remote-pinned threads' terminals must see both kinds.
    webContents.send(INTEGRATED_TERMINAL_SESSIONS_CHANNEL, {
      sessions: sortSessionsByCreatedAt([
        ...sessions,
        ...(federationBridge?.listSessions(webContents) ?? []),
      ]),
    });
  }
}

export function registerIntegratedTerminalIpcHandlers(): void {
  service ??= new IntegratedTerminalService({
    onSessionsChanged: broadcastSessions,
  });
  federationBridge ??= new FederationTerminalBridge({
    localSessionsFor: () => service?.listSessions() ?? [],
  });

  ipcMain.removeHandler(INTEGRATED_TERMINAL_CREATE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_CREATE_CHANNEL,
    async (
      event,
      request: IntegratedTerminalCreateRequest,
    ): Promise<IntegratedTerminalCreateResponse> => {
      // A federation window NEVER falls through to a local spawn: the bridge
      // routes to the owning instance and throws when the remote target or
      // capability is missing. A main window routes remotely per request —
      // a remote-pinned thread's terminal names its owning instance.
      if (
        isFederationWindowWebContents(event.sender)
        || (request.federationTarget !== undefined
          && isRemoteFederationTarget(request.federationTarget))
      ) {
        return await federationBridge!.createOrAttach(request, event.sender);
      }
      return await service!.createOrAttach(request, event.sender);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_WRITE_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_WRITE_CHANNEL,
    (event, request: IntegratedTerminalWriteRequest): void => {
      if (
        isFederationWindowWebContents(event.sender)
        || federationBridge?.hasSession(event.sender, request.sessionId)
      ) {
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
      if (
        isFederationWindowWebContents(event.sender)
        || federationBridge?.hasSession(event.sender, request.sessionId)
      ) {
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
      if (
        isFederationWindowWebContents(event.sender)
        || (request.sessionId
          && federationBridge?.hasSession(event.sender, request.sessionId))
        || (request.threadKey
          && federationBridge?.hasThreadSession(event.sender, request.threadKey))
      ) {
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
      return sortSessionsByCreatedAt([
        ...(service?.listSessions() ?? []),
        ...(federationBridge?.listSessions(event.sender) ?? []),
      ]);
    },
  );

  ipcMain.removeHandler(INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL);
  ipcMain.handle(
    INTEGRATED_TERMINAL_SET_PANEL_HIDDEN_CHANNEL,
    (event, request: IntegratedTerminalSetPanelHiddenRequest): void => {
      if (
        isFederationWindowWebContents(event.sender)
        || federationBridge?.hasThreadSession(event.sender, request.threadKey)
      ) {
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
  // Drops the viewer-side registry without sending pty.close for each
  // session: this runs at app shutdown, where the federation runtime is
  // tearing down anyway and the owner's disconnect reap ends the shells.
  federationBridge?.dispose();
  federationBridge = undefined;
}

export function getIntegratedTerminalQuitSnapshot(): IntegratedTerminalQuitSnapshot {
  const local: IntegratedTerminalQuitSnapshot = service?.getQuitSnapshot() ?? {
    count: 0,
    sessionIds: [],
    threads: [],
  };
  // Quitting closes remote sessions too (the bridge ends them when the
  // window dies), so they belong in the blocker — otherwise a shell running
  // a long command on another machine dies without the prompt its local
  // equivalent would get. They cannot be foreground-filtered like local
  // sessions: the process lives on the owner.
  const remote = federationBridge?.quitSnapshotSessions() ?? [];
  if (remote.length === 0) {
    return local;
  }
  return {
    count: local.count + remote.length,
    sessionIds: [
      ...local.sessionIds,
      ...remote.map((session) => session.sessionId),
    ].sort(),
    threads: [
      ...local.threads,
      ...remote.map((session) => ({
        threadKey: session.threadKey,
        target: session.target,
        ...(session.instanceLabel
          ? { instanceLabel: session.instanceLabel }
          : {}),
      })),
    ].sort(byThreadKey),
  };
}

export type IntegratedTerminalRevealResult = {
  revealed: boolean;
  /**
   * A window hosting the revealed session. Callers that follow a reveal with
   * a thread navigation use it so the request lands in a window that actually
   * has the thread. Absent for local sessions, where the reveal is broadcast
   * and no one window owns the thread.
   */
  owner?: WebContents;
};

/**
 * Ask the renderers hosting a thread's shell to open its terminal panel. Used
 * by the quit dialog's "running work" links: clicking a terminal row should
 * land you on the thread with the shell already on screen, whatever the
 * panel's remembered hidden state was.
 *
 * No session, no reveal. The quit dialog renders a snapshot taken when the
 * prompt opened and can sit there indefinitely once the countdown is cancelled,
 * so a listed shell may well have exited by the time the row is clicked.
 * Broadcasting anyway made the renderer open a panel for a thread with no
 * session, which spawned a brand-new login shell in the home directory — a
 * fresh quit blocker, conjured by trying to look at one.
 */
export function revealIntegratedTerminal(
  threadKey: string,
  options: { instanceId?: string } = {},
): IntegratedTerminalRevealResult {
  // A caller naming an instance means a peer's shell, and the local registry
  // can only answer for this machine — checking it first would reveal a local
  // terminal that happens to share the thread key.
  if (!options.instanceId && service?.revealSession(threadKey)) {
    // A local session is hosted by whichever windows show the thread, so the
    // broadcast is the routing.
    for (const webContents of subscribersForChannel(
      INTEGRATED_TERMINAL_REVEAL_CHANNEL,
    )) {
      webContents.send(INTEGRATED_TERMINAL_REVEAL_CHANNEL, { threadKey });
    }
    return { revealed: true };
  }
  // A remote session belongs to the window that opened it — a federation
  // window, or a main window showing a pinned remote thread. Telling every
  // window to open a terminal panel for it would ask windows that do not have
  // the thread to do something they cannot.
  const owners =
    federationBridge?.revealSession(threadKey, options.instanceId) ?? [];
  if (owners.length === 0) {
    return { revealed: false };
  }
  for (const webContents of owners) {
    webContents.send(INTEGRATED_TERMINAL_REVEAL_CHANNEL, { threadKey });
  }
  // Remote mounts allocate a PTY per viewer window, so the same thread can be
  // open in more than one. Any of them demonstrably has the thread, which is
  // more than the focused-or-first fallback can promise.
  return { revealed: true, owner: owners[0] };
}
