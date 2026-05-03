import { app, BrowserWindow, shell } from "electron";
import { join, resolve } from "node:path";
import { resolveHeapMonitorConfig } from "./diagnostics/heap-monitor-config";
import { createHeapSession } from "./diagnostics/heap-session";
import { MainProcessHeapMonitor } from "./diagnostics/main-process-heap-monitor";
import { RendererHeapMonitor } from "./diagnostics/renderer-heap-monitor";
import { getMainLogger } from "./log";
import { attachWindowFocusSync } from "./window-focus-sync";

const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragnt:main");
const heapLog = getMainLogger("pwragnt:heap");
const rendererConsoleLog = getMainLogger("pwragnt:renderer:console");

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

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

export function isSafeExternalOpenUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (
    parsed.protocol === "https:" ||
    parsed.protocol === "mailto:" ||
    parsed.protocol === "file:"
  ) {
    return true;
  }

  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function resolveRepoRoot(): string {
  return resolve(app.getAppPath(), "../..");
}

export function createMainWindow(options?: {
  startupCpuProfiler?: {
    attachWindow: (window: BrowserWindow) => void;
  };
}): BrowserWindow {
  const preloadPath = getPreloadPath();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: "PwrAgnt",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: "#10151f",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  if (isDevelopment) {
    mainLog.info("creating window", {
      preloadPath,
      rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null
    });
  }

  options?.startupCpuProfiler?.attachWindow(window);

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
      heapLog.error("failed to initialize heap diagnostics", {
        message: created.message,
      });
      return null;
    }

    heapLog.info("session directory", {
      sessionDirectory: created.session.directoryPath,
    });

    const mainMonitor = new MainProcessHeapMonitor({
      session: created.session,
      config: heapConfig,
    });
    await mainMonitor.start();

    const rendererMonitor = new RendererHeapMonitor({
      target: webContents,
      session: created.session,
      config: heapConfig,
    });

    return {
      mainMonitor,
      rendererMonitor,
    };
  })();

  const stopHeapMonitor = (reason: string) => {
    void heapMonitorPromise
      .then(async (monitors) => {
        if (!monitors) {
          return;
        }

        await Promise.all([
          monitors.rendererMonitor.stop(reason),
          monitors.mainMonitor.stop(reason),
        ]);
      })
      .catch((error: unknown) => {
        heapLog.warn("failed to stop heap diagnostics", {
          reason,
          error: serializeError(error),
        });
      });
  };

  if (typeof webContents.on === "function") {
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      mainLog.error("renderer load failed", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    webContents.on("render-process-gone", (_event, details) => {
      stopHeapMonitor("render-process-gone");
      mainLog.error("renderer process gone", details);
    });

    if (typeof webContents.once === "function") {
      webContents.once("did-finish-load", () => {
        void heapMonitorPromise.then((monitors) => monitors?.rendererMonitor.start());
      });
    }
  }

  if (isDevelopment && typeof webContents.on === "function") {
    webContents.on("console-message", (_event, level, message, line, sourceId) => {
      rendererConsoleLog.info("message", {
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
          mainLog.info("renderer globals", result);
        })
        .catch((error: unknown) => {
          mainLog.error("failed to inspect renderer globals", error);
        });
    });
  }

  webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalOpenUrl(url)) {
      void shell.openExternal(url);
    } else {
      mainLog.warn("blocked renderer external URL open");
    }

    return { action: "deny" };
  });

  window.on("closed", () => {
    stopHeapMonitor("window-closed");
  });

  return window;
}
