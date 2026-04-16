import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { attachWindowFocusSync } from "./window-focus-sync";

const isDevelopment = process.env.NODE_ENV !== "production";

export function getPreloadPath(): string {
  return join(__dirname, "../preload/index.cjs");
}

export function getRendererEntry(): { kind: "url" | "file"; value: string } {
  if (process.env.ELECTRON_RENDERER_URL) {
    return { kind: "url", value: process.env.ELECTRON_RENDERER_URL };
  }

  return {
    kind: "file",
    value: join(__dirname, "../renderer/index.html")
  };
}

export function createMainWindow(): BrowserWindow {
  const preloadPath = getPreloadPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: "PwrAgnt",
    backgroundColor: "#10151f",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  if (isDevelopment) {
    console.info("[pwragnt:main] creating window", {
      preloadPath,
      rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null
    });
  }

  const rendererEntry = getRendererEntry();
  if (rendererEntry.kind === "url") {
    void window.loadURL(rendererEntry.value);
  } else {
    void window.loadFile(rendererEntry.value);
  }

  window.once("ready-to-show", () => {
    window.show();
  });

  const { webContents } = window;
  attachWindowFocusSync(window);

  if (typeof webContents.on === "function") {
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      console.error("[pwragnt:main] renderer load failed", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    webContents.on("render-process-gone", (_event, details) => {
      console.error("[pwragnt:main] renderer process gone", details);
    });
  }

  if (isDevelopment && typeof webContents.on === "function") {
    webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.info("[pwragnt:renderer:console]", {
        level,
        message,
        line,
        sourceId
      });
    });

    webContents.on("did-finish-load", () => {
      void webContents
        .executeJavaScript(
          `({
            hasPwragnt: typeof window.pwragnt !== "undefined",
            pwragntKeys: typeof window.pwragnt !== "undefined" ? Object.keys(window.pwragnt) : [],
            locationHref: window.location.href
          })`,
          true
        )
        .then((result) => {
          console.info("[pwragnt:main] renderer globals", result);
        })
        .catch((error: unknown) => {
          console.error("[pwragnt:main] failed to inspect renderer globals", error);
        });
    });
  }

  webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}
