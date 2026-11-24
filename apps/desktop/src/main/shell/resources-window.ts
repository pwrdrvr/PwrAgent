import { BrowserWindow } from "electron";
import type { ResourceCheckoutsWindowFocus } from "@pwragent/shared/contracts/resource-checkouts";
import { APPEARANCE_CHANGED_EVENT_CHANNEL, RESOURCE_CHECKOUTS_CHANGED_CHANNEL, RESOURCE_CHECKOUTS_FOCUS_CHANNEL } from "../../shared/ipc";
import { readBootstrapAppearance, themedWindowAdditionalArguments } from "../settings/appearance-bootstrap";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar,
  registerAuxiliaryWindowTitle,
  showAndFocusAuxiliaryWindow,
  showAuxiliaryWindowWhenReady,
} from "./auxiliary-window-chrome";
import { themedWindowBackgroundColor } from "./native-appearance";
import { applyWindowSecurityHardening, getRendererEntry, rendererPreloadWebPreferences } from "./window";
import { registerWindowChannels, WINDOW_KIND_RESOURCES } from "./window-channels";
import { placementForSourceDisplay, positionWindowForSourceDisplay, type WindowPlacementSource } from "./window-placement";

let resourcesWindow: BrowserWindow | undefined;

/** The hash `main.tsx` routes to the Resources window, with the resource to select. */
export function resourcesWindowHash(focus?: ResourceCheckoutsWindowFocus): string {
  return focus ? `resources/${encodeURIComponent(focus.resourceId)}` : "resources";
}

/**
 * Opens the Resources window, or brings it forward. With `focus`, the window
 * selects that resource: a new window reads it from its hash, an open one
 * from the focus channel. A window still loading has not subscribed to the
 * channel yet, so it is pointed at the new hash instead.
 */
export function showResourcesWindow(source: WindowPlacementSource, focus?: ResourceCheckoutsWindowFocus): void {
  if (resourcesWindow && !resourcesWindow.isDestroyed()) {
    positionWindowForSourceDisplay(resourcesWindow, source);
    showAndFocusAuxiliaryWindow(resourcesWindow);
    if (focus && resourcesWindow.webContents.isLoading()) loadResourcesRoute(resourcesWindow, focus);
    else if (focus) resourcesWindow.webContents.send(RESOURCE_CHECKOUTS_FOCUS_CHANNEL, focus);
    return;
  }

  const width = 1_140;
  const height = 760;
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(width, height, source),
    width,
    height,
    minWidth: 650,
    minHeight: 480,
    title: "Resources",
    show: false,
    ...auxiliaryWindowChromeOptions(),
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      ...rendererPreloadWebPreferences(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [...themedWindowAdditionalArguments(appearance), "--pwragent-resource-checkouts"],
    },
  });

  resourcesWindow = window;
  window.once("closed", () => { resourcesWindow = undefined; });
  registerAuxiliaryWindowTitle(window, "Resources");
  hideAuxiliaryWindowMenuBar(window);
  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_RESOURCES, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
    RESOURCE_CHECKOUTS_CHANGED_CHANNEL,
    RESOURCE_CHECKOUTS_FOCUS_CHANNEL,
  ]);

  loadResourcesRoute(window, focus);
  showAuxiliaryWindowWhenReady(window);
}

function loadResourcesRoute(window: BrowserWindow, focus?: ResourceCheckoutsWindowFocus): void {
  const entry = getRendererEntry();
  if (entry.kind === "url") {
    void window.loadURL(`${entry.value}#${resourcesWindowHash(focus)}`);
  } else {
    void window.loadFile(entry.value, { hash: resourcesWindowHash(focus) });
  }
}
