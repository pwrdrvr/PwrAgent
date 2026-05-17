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
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
  themedWindowBackgroundColor,
} from "./settings/appearance-bootstrap";

const log = getMainLogger("pwragent:license-document-window");
const LICENSE_HASH = "license";
const THIRD_PARTY_NOTICES_HASH = "third-party-notices";

let licenseWindow: BrowserWindow | undefined;
let thirdPartyNoticesWindow: BrowserWindow | undefined;

export function showLicenseWindow(): void {
  showLicenseDocumentWindow({
    hash: LICENSE_HASH,
    title: "MIT License - PwrAgent",
    windowRef: () => licenseWindow,
    setWindowRef: (window) => {
      licenseWindow = window;
    },
  });
}

export function showThirdPartyNoticesWindow(): void {
  showLicenseDocumentWindow({
    hash: THIRD_PARTY_NOTICES_HASH,
    title: "Third-Party Notices - PwrAgent",
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
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    return;
  }

  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: options.title,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_LICENSE_DOCUMENT, []);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${options.hash}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: options.hash });
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    options.setWindowRef(undefined);
    log.debug("license document window closed", { hash: options.hash });
  });

  options.setWindowRef(window);
  log.debug("license document window created", { hash: options.hash });
}
