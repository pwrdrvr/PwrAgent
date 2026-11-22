import { BrowserWindow } from "electron";
import { APPEARANCE_CHANGED_EVENT_CHANNEL, RESOURCE_CHECKOUTS_CHANGED_CHANNEL } from "../../shared/ipc";
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

export function showResourcesWindow(source: WindowPlacementSource): void {
  if (resourcesWindow && !resourcesWindow.isDestroyed()) {
    positionWindowForSourceDisplay(resourcesWindow, source);
    showAndFocusAuxiliaryWindow(resourcesWindow);
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
  ]);

  const entry = getRendererEntry();
  if (entry.kind === "url") {
    void window.loadURL(`${entry.value}#resources`);
  } else {
    void window.loadFile(entry.value, { hash: "resources" });
  }
  showAuxiliaryWindowWhenReady(window);
}
