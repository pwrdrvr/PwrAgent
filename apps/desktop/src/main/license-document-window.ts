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

const log = getMainLogger("pwragent:license-document-window");
const THIRD_PARTY_NOTICES_HASH = "third-party-notices";

let thirdPartyNoticesWindow: BrowserWindow | undefined;

export function showThirdPartyNoticesWindow(): void {
  if (thirdPartyNoticesWindow && !thirdPartyNoticesWindow.isDestroyed()) {
    if (thirdPartyNoticesWindow.isMinimized()) {
      thirdPartyNoticesWindow.restore();
    }
    thirdPartyNoticesWindow.show();
    thirdPartyNoticesWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "Third-Party Notices - PwrAgent",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: "#000000",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  applyWindowSecurityHardening(window);
  registerWindowChannels(window, WINDOW_KIND_LICENSE_DOCUMENT, []);

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(`${rendererEntry.value}#${THIRD_PARTY_NOTICES_HASH}`);
  } else {
    void window.loadFile(rendererEntry.value, { hash: THIRD_PARTY_NOTICES_HASH });
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    thirdPartyNoticesWindow = undefined;
    log.debug("third-party notices window closed");
  });

  thirdPartyNoticesWindow = window;
  log.debug("third-party notices window created");
}
