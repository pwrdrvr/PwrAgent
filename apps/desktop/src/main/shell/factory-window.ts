import { BrowserWindow } from "electron";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../../shared/ipc";
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
import { registerWindowChannels, WINDOW_KIND_FACTORY } from "./window-channels";
import { placementForSourceDisplay, positionWindowForSourceDisplay, type WindowPlacementSource } from "./window-placement";

let factoryWindow: BrowserWindow | undefined;

export function showFactoryWindow(source: WindowPlacementSource): void {
  if (factoryWindow && !factoryWindow.isDestroyed()) {
    positionWindowForSourceDisplay(factoryWindow, source);
    showAndFocusAuxiliaryWindow(factoryWindow);
    return;
  }

  const width = 1_100;
  const height = 760;
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...placementForSourceDisplay(width, height, source),
    width,
    height,
    minWidth: 420,
    minHeight: 480,
    title: "Factory",
    show: false,
    ...auxiliaryWindowChromeOptions(),
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      ...rendererPreloadWebPreferences(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });

  factoryWindow = window;
  window.once("closed", () => { factoryWindow = undefined; });
  registerAuxiliaryWindowTitle(window, "Factory");
  hideAuxiliaryWindowMenuBar(window);
  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_FACTORY, [APPEARANCE_CHANGED_EVENT_CHANNEL]);

  const entry = getRendererEntry();
  if (entry.kind === "url") void window.loadURL(`${entry.value}#factory`);
  else void window.loadFile(entry.value, { hash: "factory" });
  showAuxiliaryWindowWhenReady(window);
}
