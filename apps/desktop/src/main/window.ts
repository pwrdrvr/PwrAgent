import { app, BrowserWindow, shell } from "electron";
import { join, resolve } from "node:path";
import { resolveHeapMonitorConfig } from "./diagnostics/heap-monitor-config";
import { createHeapSession } from "./diagnostics/heap-session";
import { RendererHeapMonitor } from "./diagnostics/renderer-heap-monitor";
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

function resolveRepoRoot(): string {
  return resolve(app.getAppPath(), "../..");
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
  const heapMonitorPromise = (async () => {
    const heapConfig = resolveHeapMonitorConfig({
      repoRoot: resolveRepoRoot(),
    });

    if (!heapConfig.enabled) {
      return null;
    }

    const created = await createHeapSession({
      config: heapConfig,
      versions: {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown",
        chromeVersion: process.versions.chrome ?? "unknown",
        nodeVersion: process.versions.node,
      },
    });

    if (!created.ok) {
      console.error("[pwragnt:heap] failed to initialize heap diagnostics", {
        message: created.message,
      });
      return null;
    }

    console.info("[pwragnt:heap] session directory", {
      sessionDirectory: created.session.directoryPath,
    });

    return new RendererHeapMonitor({
      target: webContents,
      session: created.session,
      config: heapConfig,
    });
  })();

  const stopHeapMonitor = (reason: string) => {
    void heapMonitorPromise.then((monitor) => monitor?.stop(reason));
  };

  if (typeof webContents.on === "function") {
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      console.error("[pwragnt:main] renderer load failed", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    webContents.on("render-process-gone", (_event, details) => {
      stopHeapMonitor("render-process-gone");
      console.error("[pwragnt:main] renderer process gone", details);
    });

    if (typeof webContents.once === "function") {
      webContents.once("did-finish-load", () => {
        void heapMonitorPromise.then((monitor) => monitor?.start());
      });
    }
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

  window.on("closed", () => {
    stopHeapMonitor("window-closed");
  });

  return window;
}
