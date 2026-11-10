import type { OwnerHostServices } from "../../owner-host";

/** Standalone owner tests explicitly supply the host their old Electron mocks represented. */
export async function installTestOwnerHost(): Promise<void> {
  const { installOwnerHostServices } = await import("../../owner-host");
  const electron = await import("electron");
  const windowChannels = await import("../window-channels");
  const { requestShowThread } = await import("../window-show-thread");
  const exported = <K extends keyof typeof electron>(key: K): (typeof electron)[K] | undefined =>
    Object.hasOwn(electron, key) ? electron[key] : undefined;
  const app = exported("app");
  const links = exported("shell");
  const secretStorage = exported("safeStorage");
  const image = exported("nativeImage");
  const windows = exported("BrowserWindow");
  const dialogs = exported("dialog");
  const unavailable = (): never => { throw new Error("The test must supply this owner host capability."); };
  const host: OwnerHostServices = {
    application: {
      getVersion: () => app?.getVersion?.() ?? "0.0.0",
      get isPackaged() { return app?.isPackaged ?? false; },
      getPath: (name) => app?.getPath(name) ?? unavailable(),
      relaunch: () => app?.relaunch(),
      quit: () => app?.quit(),
    },
    secrets: {
      isEncryptionAvailable: () => secretStorage?.isEncryptionAvailable?.() ?? false,
      getSelectedStorageBackend: () => secretStorage?.getSelectedStorageBackend?.() ?? "unavailable",
      encryptString: (value) => secretStorage?.encryptString(value) ?? unavailable(),
      decryptString: (value) => secretStorage?.decryptString(value) ?? unavailable(),
    },
    links: {
      openExternal: async (url) => { await links?.openExternal(url); },
      openPath: async (path) => await links?.openPath(path) ?? unavailable(),
      trashItem: async (path) => { await links?.trashItem(path); },
      showItemInFolder: (path) => links?.showItemInFolder(path),
    },
    images: { createFromBuffer: (buffer) => image?.createFromBuffer(buffer) ?? unavailable() },
    renderer: { subscribers: (channel) => windowChannels.subscribersForChannel(channel), agentEvent: () => {}, environmentSetupProgress: () => {}, inboundPreview: () => {}, managedRuntimeProgress: () => {}, managedGrokSignatureRejected: () => {} },
    appearance: { broadcast: () => {}, syncDock: () => {} },
    threads: { showThread: requestShowThread, openMaintenance: unavailable, openThread: unavailable },
    notifications: {
      notifyAttention: () => {},
      notifyTerminal: () => {},
      notifyApproval: () => {},
      clearAttentionKey: () => {},
    },
    ui: {
      isWindowVisible: () => windows?.getAllWindows?.().some((window) => !window.isDestroyed() && window.isVisible() && !window.isMinimized()) ?? false,
      pickFiles: async (options, parent) => {
        const window = parent as Electron.BrowserWindow | undefined ?? windows?.getFocusedWindow?.();
        if (!dialogs) return unavailable();
        return window ? await dialogs.showOpenDialog(window, options) : await dialogs.showOpenDialog(options);
      },
      explainLocalNetwork: async () => {},
    },
    starMap: { sendCommand: async () => undefined, readView: () => undefined, readFocus: () => undefined },
    updates: { check: unavailable, read: unavailable, install: unavailable, requestQuit: unavailable },
    workers: { forkClaudeSessionReader: unavailable },
    storageMaintenance: { createView: unavailable, forkWorker: unavailable },
    replayClients: () => undefined,
  };
  installOwnerHostServices(host);
}
