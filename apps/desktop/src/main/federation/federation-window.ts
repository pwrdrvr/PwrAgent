import type {
  FederationCapability,
  FederationRemoteTarget,
} from "@pwragent/shared";
import { getDesktopFederationRuntime } from "./federation-runtime";
import { createMainWindow } from "../window";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";
import {
  WINDOW_OPEN_NEW_THREAD_CHANNEL,
  WINDOW_SHOW_THREAD_CHANNEL,
} from "../../shared/ipc";

export type FederationWindowPeer = {
  target: FederationRemoteTarget;
  label: string;
  capabilities: readonly FederationCapability[];
};

type FederationWindowRequest = {
  initialLaunchpad?: boolean;
  initialThread?: WindowShowThreadRequest;
};

type FederationWindowEntry = {
  focusWhenReady: boolean;
  pendingRequest?: FederationWindowRequest;
  ready: boolean;
  window: Electron.BrowserWindow;
};

/** One remote viewer per owning federation instance in this app process. */
const federationWindows = new Map<string, FederationWindowEntry>();

function focusFederationWindow(window: Electron.BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function sendFederationWindowRequest(
  window: Electron.BrowserWindow,
  request: FederationWindowRequest,
): void {
  if (request.initialThread) {
    window.webContents.send(WINDOW_SHOW_THREAD_CHANNEL, request.initialThread);
  } else if (request.initialLaunchpad) {
    window.webContents.send(WINDOW_OPEN_NEW_THREAD_CHANNEL);
  }
}

function reuseFederationWindow(
  entry: FederationWindowEntry,
  request: FederationWindowRequest,
): Electron.BrowserWindow {
  if (!entry.ready) {
    entry.focusWhenReady = true;
    if (request.initialThread || request.initialLaunchpad) {
      entry.pendingRequest = request;
    }
    return entry.window;
  }

  focusFederationWindow(entry.window);
  sendFederationWindowRequest(entry.window, request);
  return entry.window;
}

export function createFederationWindow(options: {
  peer: FederationWindowPeer;
  initialLaunchpad?: boolean;
  initialThread?: WindowShowThreadRequest;
}): Electron.BrowserWindow {
  const { peer } = options;
  if (!peer.capabilities.includes("remote_window")) {
    throw new Error(
      "Federation peer does not allow remote windows (remote_window capability).",
    );
  }

  const instanceId = peer.target.instanceId;
  const existing = federationWindows.get(instanceId);
  if (existing && !existing.window.isDestroyed()) {
    return reuseFederationWindow(existing, options);
  }
  federationWindows.delete(instanceId);

  const window = createMainWindow({
    federationLabel: peer.label,
    federationTarget: peer.target,
    ...(options.initialLaunchpad ? { initialLaunchpad: true } : {}),
    initialThread: options.initialThread,
  });
  const entry: FederationWindowEntry = {
    focusWhenReady: false,
    // createMainWindow always starts hidden and shows only after the renderer
    // reaches ready-to-show, so the registry can safely attach synchronously.
    ready: false,
    window,
  };
  federationWindows.set(instanceId, entry);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) {
      return;
    }
    entry.ready = true;
    if (entry.focusWhenReady) {
      focusFederationWindow(window);
    }
    if (entry.pendingRequest) {
      sendFederationWindowRequest(window, entry.pendingRequest);
      entry.pendingRequest = undefined;
    }
  });
  const runtime = getDesktopFederationRuntime();
  const webContentsId = window.webContents.id;
  runtime.setRemoteWindowEventSubscription(
    webContentsId,
    peer.target.instanceId,
    peer.capabilities,
  );
  window.once("closed", () => {
    if (federationWindows.get(instanceId) === entry) {
      federationWindows.delete(instanceId);
    }
    runtime.clearRendererEventSubscriptions(webContentsId, "remote-window");
  });
  return window;
}
