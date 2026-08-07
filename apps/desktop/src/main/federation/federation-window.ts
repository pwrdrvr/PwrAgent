import type {
  AppServerBackendKind,
  FederationCapability,
  FederationRemoteTarget,
} from "@pwragent/shared";
import { getDesktopFederationRuntime } from "./federation-runtime";
import { createMainWindow } from "../window";

export type FederationWindowPeer = {
  target: FederationRemoteTarget;
  label: string;
  capabilities: readonly FederationCapability[];
};

export function createFederationWindow(options: {
  peer: FederationWindowPeer;
  initialThread?: {
    backend: AppServerBackendKind;
    threadId: string;
  };
}): Electron.BrowserWindow {
  const { peer } = options;
  if (!peer.capabilities.includes("remote_window")) {
    throw new Error(
      "Federation peer does not allow remote windows (remote_window capability).",
    );
  }

  const window = createMainWindow({
    federationLabel: peer.label,
    federationTarget: peer.target,
    initialThread: options.initialThread,
  });
  const runtime = getDesktopFederationRuntime();
  const webContentsId = window.webContents.id;
  runtime.setRemoteWindowEventSubscription(
    webContentsId,
    peer.target.instanceId,
    peer.capabilities,
  );
  window.once("closed", () => {
    runtime.clearRendererEventSubscriptions(webContentsId, "remote-window");
  });
  return window;
}
