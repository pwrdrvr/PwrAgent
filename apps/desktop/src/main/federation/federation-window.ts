import type {
  FederationCapability,
  FederationRemoteTarget,
} from "@pwragent/shared";
import { getDesktopFederationRuntime } from "./federation-runtime";
import { createMainWindow } from "../window";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";

export type FederationWindowPeer = {
  target: FederationRemoteTarget;
  label: string;
  capabilities: readonly FederationCapability[];
};

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

  const window = createMainWindow({
    federationLabel: peer.label,
    federationTarget: peer.target,
    ...(options.initialLaunchpad ? { initialLaunchpad: true } : {}),
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
