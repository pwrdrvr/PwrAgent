import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import {
  applyWindowSecurityHardening,
  getPreloadPath,
  getRendererEntry,
} from "./window";
import {
  WINDOW_KIND_LICENSE_DOCUMENT,
  registerWindowChannels,
} from "./window-channels";
import { APPEARANCE_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
  themedWindowBackgroundColor,
} from "./settings/appearance-bootstrap";
import {
  auxiliaryWindowChromeOptions,
  hideAuxiliaryWindowMenuBar,
  registerAuxiliaryWindowTitle,
  showAndFocusAuxiliaryWindow,
  showAuxiliaryWindowWhenReady,
} from "./auxiliary-window-chrome";
import {
  auxiliaryWindowPlacementOptions,
  positionAuxiliaryWindowOnSourceDisplay,
} from "./auxiliary-window-placement";

const log = getMainLogger("pwragent:license-document-window");
const LICENSE_HASH = "license";
const THIRD_PARTY_NOTICES_HASH = "third-party-notices";
const LICENSE_DOCUMENT_WINDOW_WIDTH = 920;
const LICENSE_DOCUMENT_WINDOW_HEIGHT = 760;

let licenseWindow: BrowserWindow | undefined;
let thirdPartyNoticesWindow: BrowserWindow | undefined;

export function showLicenseWindow(): void {
  showLicenseDocumentWindow({
    hash: LICENSE_HASH,
    title: "License",
    windowRef: () => licenseWindow,
    setWindowRef: (window) => {
      licenseWindow = window;
    },
  });
}

export function showThirdPartyNoticesWindow(): void {
  showLicenseDocumentWindow({
    hash: THIRD_PARTY_NOTICES_HASH,
    title: "Third-Party Notices",
    windowRef: () => thirdPartyNoticesWindow,
    setWindowRef: (window) => {
      thirdPartyNoticesWindow = window;
    },
  });
}

function showLicenseDocumentWindow(options: {
  hash: string;
  title: string;
  windowRef: () => BrowserWindow | undefined;
  setWindowRef: (window: BrowserWindow | undefined) => void;
}): void {
  const existingWindow = options.windowRef();
  if (existingWindow && !existingWindow.isDestroyed()) {
    positionAuxiliaryWindowOnSourceDisplay(existingWindow);
    showAndFocusAuxiliaryWindow(existingWindow);
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    ...auxiliaryWindowPlacementOptions(
      LICENSE_DOCUMENT_WINDOW_WIDTH,
      LICENSE_DOCUMENT_WINDOW_HEIGHT,
    ),
    width: LICENSE_DOCUMENT_WINDOW_WIDTH,
    height: LICENSE_DOCUMENT_WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: options.title,
    ...auxiliaryWindowChromeOptions(),
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });
  registerAuxiliaryWindowTitle(window, options.title);
  hideAuxiliaryWindowMenuBar(window);

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_LICENSE_DOCUMENT, [
    APPEARANCE_CHANGED_EVENT_CHANNEL,
  ]);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${options.hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: options.hash });
  }

  showAuxiliaryWindowWhenReady(window);

  window.on("closed", () => {
    options.setWindowRef(undefined);
    log.debug("license document window closed", { hash: options.hash });
  });

  options.setWindowRef(window);
  log.debug("license document window created", { hash: options.hash });
}
