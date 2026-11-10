import { broadcastInboundPreview } from "./ipc/messaging-status";
import { broadcastManagedRuntimeProgress } from "./managed-runtime-progress-broadcast";
import { broadcastManagedGrokSignatureRejection } from "./managed-grok-signature-broadcast";
import { broadcastAgentEvent, broadcastCodexEnvironmentSetupProgress } from "./ipc/agent-ipc";
import { createOpenThreadInUi } from "./native-voice/open-thread-in-ui";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { createStorageMaintenanceView } from "./storage-maintenance-window";
import { app, BrowserWindow, dialog, nativeImage, safeStorage, shell, utilityProcess } from "electron";
import type { OwnerHostServices } from "../owner-host";
import { broadcastAppearanceChange } from "./appearance-broadcast";
import { syncThemedDockIcon } from "./themed-dock-icon";
import { subscribersForChannel } from "./window-channels";
import { requestShowThread } from "./window-show-thread";
import { requestOpenThreadMaintenance } from "./window-open-thread-maintenance";
import { getDesktopNotificationService } from "./notifications/desktop-notification-service";
import { checkForAppUpdatesNow, installDownloadedAppUpdate, readAppUpdateStatus } from "./auto-updater";
import { requestQuit } from "./quit-manager";
import { sendStarMapCommand } from "./star-map/star-map-command-bus";
import { readStarMapView } from "./star-map/star-map-view-registry";
import { readOperatorFocus } from "./native-voice/operator-focus-registry";
import { createReplayClientsFromEnv } from "./testing/replay-runtime";

/** Electron implements the owner contracts; owner modules never import this file. */
export function createDesktopOwnerHostServices(): OwnerHostServices {
  return {
    application: {
      getVersion: () => app.getVersion(),
      get isPackaged() { return app.isPackaged; },
      getPath: (name) => app.getPath(name),
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
    },
    secrets: safeStorage,
    links: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
      trashItem: (path) => shell.trashItem(path),
    },
    images: { createFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer) },
    renderer: { subscribers: subscribersForChannel, agentEvent: (event) => broadcastAgentEvent(event), environmentSetupProgress: (event) => broadcastCodexEnvironmentSetupProgress(event), inboundPreview: (message) => broadcastInboundPreview(message), managedRuntimeProgress: (event) => broadcastManagedRuntimeProgress(event), managedGrokSignatureRejected: (event) => broadcastManagedGrokSignatureRejection(event) },
    appearance: { broadcast: broadcastAppearanceChange, syncDock: syncThemedDockIcon },
    threads: { showThread: requestShowThread, openMaintenance: requestOpenThreadMaintenance, openThread: createOpenThreadInUi({ localInstanceId: async () => (await getDesktopFederationRuntime().health()).instanceId }) },
    notifications: {
      notifyAttention: (params) => getDesktopNotificationService().notifyAttention(params),
      notifyTerminal: (params) => getDesktopNotificationService().notifyTerminal(params),
      notifyApproval: (params) => getDesktopNotificationService().notifyApproval(params),
      clearAttentionKey: (key) => getDesktopNotificationService().clearAttentionKey(key),
    },
    ui: {
      isWindowVisible: () => BrowserWindow.getAllWindows().some((window) =>
        !window.isDestroyed() && window.isVisible() && !window.isMinimized()),
      pickFiles: async (options, parent) => {
        const window = (parent as BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow();
        return window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      },
  explainLocalNetwork: async (hostname) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Federation local network access",
      message: "Federation may need local network access",
      detail: `Your configured gateway (${hostname}) resolves to an internal network address. `
        + "When PwrAgent connects, macOS may ask to allow local network access. Choose Allow so Federation can reach your gateway.\n\n"
        + "If access was denied previously, macOS will not ask again. Enable PwrAgent in System Settings → Privacy & Security → Local Network. "
        + "Private addresses reached through a router or VPN may not need this permission.",
      buttons: ["Continue", "Open System Settings"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork");
    }
  },
    },
    starMap: { sendCommand: sendStarMapCommand, readView: readStarMapView, readFocus: readOperatorFocus },
    updates: { check: (source) => checkForAppUpdatesNow(source), read: () => readAppUpdateStatus(), install: (options) => installDownloadedAppUpdate(options), requestQuit: (options) => requestQuit(options) },
    workers: {
      forkClaudeSessionReader: async (path, env) => {
        const child = utilityProcess.fork(path, [], { env, stdio: "ignore", serviceName: "PwrAgent Claude session reader" });
        return {
          postMessage: (message) => child.postMessage(message),
          on: (_event, listener) => child.on("message", listener),
          once: (_event, listener) => child.once("exit", listener),
          kill: () => child.kill(),
        };
      },
    },
    storageMaintenance: {
      createView: createStorageMaintenanceView,
      forkWorker: (path) => utilityProcess.fork(path, [], { stdio: "ignore", serviceName: "PwrAgent storage maintenance" }),
    },
    replayClients: createReplayClientsFromEnv,
  };
}
