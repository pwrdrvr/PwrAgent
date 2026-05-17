import { app, BrowserWindow, clipboard, Menu, shell } from "electron";
import { join, resolve } from "node:path";
import { resolveHeapMonitorConfig } from "./diagnostics/heap-monitor-config";
import { createHeapSession } from "./diagnostics/heap-session";
import { MainProcessHeapMonitor } from "./diagnostics/main-process-heap-monitor";
import { RendererHeapMonitor } from "./diagnostics/renderer-heap-monitor";
import { getMainLogger } from "./log";
import { attachWindowFocusSync } from "./window-focus-sync";
import {
  WINDOW_KIND_MAIN,
  registerWindowChannels,
} from "./window-channels";
import {
  AGENT_EVENT_CHANNEL,
  MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
  MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  WINDOW_OPEN_SETTINGS_CHANNEL,
} from "../shared/ipc";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
  themedWindowBackgroundColor,
} from "./settings/appearance-bootstrap";

const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");
const heapLog = getMainLogger("pwragent:heap");
const rendererConsoleLog = getMainLogger("pwragent:renderer:console");

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

/**
 * Defense-in-depth window guards applied to every BrowserWindow we
 * create. Both the main window and the Messaging Activity window
 * route through this helper so the second window can never silently
 * inherit weaker defaults than the first.
 *
 * - `setWindowOpenHandler` denies renderer-driven new-window creation.
 *   Safelisted external URLs (https / mailto / file / loopback http)
 *   open in the user's default browser via `shell.openExternal`.
 * - `will-navigate` prevents the existing window from being navigated
 *   away — only file:// and the dev server origin are allowed (the
 *   bundle's own assets / hot-reload), everything else is blocked.
 */
export function applyWindowSecurityHardening(window: BrowserWindow): void {
  const log = getMainLogger("pwragent:window-guards");
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalOpenUrl(url)) {
      void shell.openExternal(url);
    } else {
      log.warn("blocked renderer external URL open");
    }

    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (isSafeRendererNavigation(targetUrl)) {
      return;
    }
    event.preventDefault();
    log.warn("blocked renderer navigation", { targetUrl });
  });

  window.webContents.on("context-menu", (_event, params) => {
    if (!params.linkURL) {
      return;
    }

    const menu = Menu.buildFromTemplate([
      {
        label: "Copy Link",
        click: () => {
          clipboard.writeText(params.linkURL);
        },
      },
    ]);

    menu.popup({
      window,
      x: params.x,
      y: params.y,
    });
  });
}

/**
 * Renderer navigations are only allowed back to the loaded entry
 * (file:// in production, the dev server origin in development).
 * Hash-only navigation (e.g. `#messaging-activity` set by the spawn
 * code) is allowed because the URL origin/path matches.
 */
function isSafeRendererNavigation(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") {
    return true;
  }
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!devUrl) {
    return false;
  }
  try {
    const dev = new URL(devUrl);
    return parsed.origin === dev.origin;
  } catch {
    return false;
  }
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
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: "PwrAgent",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    // Pre-tinted so the OS window fill matches the renderer's first
    // paint and we don't flash dark before a light renderer mounts.
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Surfaces theme + density to the preload script via process.argv
      // so the inline bootstrap in index.html can apply data-*
      // attributes before any React code runs (avoids flash-of-wrong-
      // theme). The renderer's writeSettingsConfig IPC keeps the TOML
      // in sync; the next launch reads the updated value back via this
      // same path.
      additionalArguments: themedWindowAdditionalArguments(appearance),
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
            hasPwragent: typeof window.pwragent !== "undefined",
            pwragentKeys: typeof window.pwragent !== "undefined" ? Object.keys(window.pwragent) : [],
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

  applyWindowSecurityHardening(window);
  // The main window subscribes to every push-event channel — it
  // hosts the full app shell. Secondary windows register a narrower
  // set (or none) so broadcasters only deliver to what they actually
  // consume. See `apps/desktop/src/main/window-channels.ts`.
  registerWindowChannels(window, WINDOW_KIND_MAIN, [
    AGENT_EVENT_CHANNEL,
    MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
    MESSAGING_PAIRING_CHANGED_EVENT_CHANNEL,
    MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
    WINDOW_OPEN_SETTINGS_CHANNEL,
  ]);

  window.on("closed", () => {
    stopHeapMonitor("window-closed");
  });

  return window;
}
