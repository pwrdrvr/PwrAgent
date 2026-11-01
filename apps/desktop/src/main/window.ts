import { readRendererListingDiagnostics } from "./diagnostics/renderer-listing-diagnostics";
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  shell,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebPreferences,
} from "electron";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FederationRemoteTarget,
} from "@pwragent/shared";
import {
  DESKTOP_HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
} from "@pwragent/shared";
import type { WindowShowThreadRequest } from "../shared/window-show-thread";
import {
  HTML_PREVIEW_FRAME_NAME,
  HTML_PREVIEW_NAVIGATION_CHANNEL,
  type HtmlPreviewNavigationEvent,
} from "../shared/html-preview";
import { resolveHeapMonitorConfig } from "./diagnostics/heap-monitor-config";
import { createHeapSession } from "./diagnostics/heap-session";
import { resolveHotCpuProfileConfig } from "./diagnostics/hot-cpu-profile-config";
import { createHotCpuProfileSession } from "./diagnostics/hot-cpu-profile-session";
import { MainProcessHeapMonitor } from "./diagnostics/main-process-heap-monitor";
import { RendererHeapMonitor } from "./diagnostics/renderer-heap-monitor";
import { createMainProcessHotCpuTarget } from "./diagnostics/main-process-hot-cpu-target";
import { SharedHotCpuProfiler } from "./diagnostics/shared-hot-cpu-profiler";
import { HotCpuProfiler } from "./diagnostics/hot-cpu-profiler";
import { resolveAppBuildMetadata } from "./app-build-metadata";
import { isSafeExternalOpenUrl } from "./external-url-policy";
import { isAppRendererUrl, type RendererEntry } from "./renderer-entry-url";
import { getMainLogger } from "./log";
import { mainWindowChromeOptions } from "./main-window-chrome";
import { lockMainWindowTitle, mainWindowTitle } from "./main-window-title";
import { attachRendererProcessRecovery } from "./renderer-process-recovery";
import { recordStartupProfileEvent } from "./diagnostics/startup-profile-events";
import { resolveActiveProfilePath } from "./profile";
import {
  getDesktopConfigStore,
  getDesktopSettingsService,
} from "./settings/desktop-settings-singleton";
import { attachWindowFocusSync } from "./window-focus-sync";
import { attachWindowFullscreenSync } from "./window-fullscreen-sync";
import {
  WINDOW_KIND_MAIN,
  registerWindowChannels,
  subscribersForChannel,
} from "./window-channels";
import {
  HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL,
  WINDOW_OPEN_NEW_THREAD_CHANNEL,
  WINDOW_SHOW_THREAD_CHANNEL,
} from "../shared/ipc";
import { mainWindowEventChannels } from "./main-window-channels";
import { watchMainWindowStartup } from "./main-window-startup-watchdog";
import {
  readBootstrapAppearance,
  themedWindowAdditionalArguments,
} from "./settings/appearance-bootstrap";
import {
  installWindowsTitleBarAppearanceSync,
  themedWindowBackgroundColor,
} from "./native-appearance";
import {
  navigationPreferencesAdditionalArguments,
  readBootstrapNavigationPreferences,
} from "./navigation-browse-mode-bootstrap";
import {
  layoutPreferencesAdditionalArguments,
  readBootstrapLayoutPreferences,
} from "./layout-prefs-bootstrap";
import { boundsForCursorDisplay } from "./window-placement";
import { federationWindowTargetAdditionalArguments } from "../shared/federation-window";

export { isSafeExternalOpenUrl } from "./external-url-policy";

/**
 * WebContents of windows created with a federationTarget. Remote windows
 * share the main-window channel registrations, but local-only pushes
 * (open Settings, replay onboarding) must never land in them — a remote
 * window rendering LOCAL settings reads as the peer's settings.
 */
const federationWindowWebContentsIds = new Set<number>();
const federationWindowTargetsByWebContentsId = new Map<
  number,
  FederationRemoteTarget
>();

export function isFederationWindowWebContents(
  webContents: Electron.WebContents | undefined,
): boolean {
  // Tolerate absent senders (unit-test harness events, destroyed frames):
  // an unidentifiable sender is treated as a normal local window.
  return webContents ? federationWindowWebContentsIds.has(webContents.id) : false;
}

/**
 * The remote instance a federation window fronts. Main-process IPC branches
 * (remote PTY routing) key off this instead of trusting anything the
 * renderer sends — the target was fixed when the window was created.
 */
export function federationWindowTargetForWebContents(
  webContents: Electron.WebContents | undefined,
): FederationRemoteTarget | undefined {
  return webContents
    ? federationWindowTargetsByWebContentsId.get(webContents.id)
    : undefined;
}

const isDevelopment = process.env.NODE_ENV !== "production";
const isMac = process.platform === "darwin";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const MAIN_WINDOW_WIDTH = 1440;
const MAIN_WINDOW_HEIGHT = 960;
const MAIN_WINDOW_MIN_WIDTH = 960;
const MAIN_WINDOW_MIN_HEIGHT = 640;
const mainLog = getMainLogger("pwragent:main");
const heapLog = getMainLogger("pwragent:heap");
const sharedMainHotCpuProfiler = new SharedHotCpuProfiler();
type HotCpuProfilerLifecycle = Pick<HotCpuProfiler, "start" | "stop">;

const hotCpuLog = getMainLogger("pwragent:hot-cpu");
const rendererConsoleLog = getMainLogger("pwragent:renderer:console");
const windowDiagnosticsStopHandlers = new Map<number, (reason: string) => Promise<void>>();

export async function stopWindowDiagnostics(reason: string): Promise<void> {
  const results = await Promise.allSettled(
    [...windowDiagnosticsStopHandlers.values()].map((stop) =>
      Promise.resolve().then(() => stop(reason)),
    ),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

const hotCpuProfilerSyncHandlers = new Map<number, (reason: string) => void>();

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getPreloadPath(): string {
  return join(moduleDirectory, "../preload/index.cjs");
}

/**
 * The preload half of a renderer window's `webPreferences`. The preload runs
 * in the window's subframes too, still sandboxed and without Node, and removes
 * WebRTC there before the frame's first script (`preload/subframe-hardening.ts`).
 * HTML file previews depend on it: without the flag, a page with scripts on
 * can reach the network over WebRTC. The path is not exported on its own.
 */
export function rendererPreloadWebPreferences(): Pick<
  WebPreferences,
  "preload" | "nodeIntegrationInSubFrames"
> {
  return {
    preload: getPreloadPath(),
    nodeIntegrationInSubFrames: true,
  };
}

export function getRendererEntry(): RendererEntry {
  if (process.env.ELECTRON_RENDERER_URL) {
    return { kind: "url", value: process.env.ELECTRON_RENDERER_URL };
  }

  return {
    kind: "file",
    value: join(moduleDirectory, "../renderer/index.html")
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
 *   away — only the bundled index.html and the dev server origin are
 *   allowed (the app's own entry / hot-reload), everything else is blocked.
 * - Subframes cannot navigate away from their initial document. Interactive
 *   SVGs and HTML previews run in an opaque-origin iframe and must not use
 *   navigation to send local data to an external site. A blocked link in an
 *   HTML preview goes back to its window, which asks before opening it.
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

  window.webContents.on("will-frame-navigate", (event) => {
    // A fragment link inside a srcdoc frame scrolls its own document.
    if (
      event.isMainFrame
      || event.url === "about:srcdoc"
      || event.url.startsWith("about:srcdoc#")
    ) {
      return;
    }
    event.preventDefault();
    if (frameName(event) === HTML_PREVIEW_FRAME_NAME) {
      const payload: HtmlPreviewNavigationEvent = { url: event.url };
      window.webContents.send(HTML_PREVIEW_NAVIGATION_CHANNEL, payload);
      return;
    }
    log.warn("blocked renderer subframe navigation");
  });

  window.webContents.on("context-menu", (_event, params) => {
    const template = buildNativeContextMenuTemplate(window, params);
    if (template.length === 0) {
      return;
    }

    const menu = Menu.buildFromTemplate(template);

    menu.popup({
      window,
      x: params.x,
      y: params.y,
    });
  });
}

function buildNativeContextMenuTemplate(
  window: BrowserWindow,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const dictionarySuggestions = params.dictionarySuggestions ?? [];

  for (const suggestion of dictionarySuggestions) {
    template.push({
      label: suggestion,
      click: () => {
        window.webContents.replaceMisspelling(suggestion);
      },
    });
  }

  if (params.misspelledWord) {
    if (dictionarySuggestions.length > 0) {
      template.push({ type: "separator" });
    }
    template.push({
      label: `Add "${params.misspelledWord}" to Dictionary`,
      click: () => {
        window.webContents.session.addWordToSpellCheckerDictionary(
          params.misspelledWord,
        );
      },
    });
  }

  if (params.mediaType === "image" && params.hasImageContents) {
    appendSeparator(template);
    template.push({
      label: "Copy Image",
      click: () => {
        window.webContents.copyImageAt(params.x, params.y);
      },
    });
  }

  if (params.linkURL) {
    appendSeparator(template);
    template.push({
      label: "Copy Link",
      click: () => {
        clipboard.writeText(params.linkURL).catch((error: unknown) => {
          mainLog.warn("copy link failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });
  }

  if (params.isEditable) {
    appendSeparator(template);
    appendEditableMenuItems(template, params);
  } else if (params.selectionText) {
    appendSeparator(template);
    template.push({ role: "copy" });
  }

  return template;
}

function appendEditableMenuItems(
  template: MenuItemConstructorOptions[],
  params: ContextMenuParams,
): void {
  template.push(
    editableRole("undo", params, "canUndo"),
    editableRole("redo", params, "canRedo"),
    { type: "separator" },
    editableRole("cut", params, "canCut"),
    editableRole("copy", params, "canCopy"),
    editableRole("paste", params, "canPaste"),
    editableRole("delete", params, "canDelete"),
    { type: "separator" },
    editableRole("selectAll", params, "canSelectAll"),
  );
}

function editableRole(
  role: NonNullable<MenuItemConstructorOptions["role"]>,
  params: ContextMenuParams,
  flag: keyof ContextMenuParams["editFlags"],
): MenuItemConstructorOptions {
  return {
    role,
    enabled: params.editFlags?.[flag] ?? true,
  };
}

function appendSeparator(template: MenuItemConstructorOptions[]): void {
  if (template.length === 0) {
    return;
  }

  const last = template[template.length - 1];
  if (last?.type !== "separator") {
    template.push({ type: "separator" });
  }
}

/**
 * Renderer navigations are only allowed back to the loaded entry: the exact
 * bundled index.html in production, the dev server origin in development.
 * Any other `file:` document would load with the preload API exposed.
 * Hash-only navigation (e.g. `#messaging-activity` set by the spawn
 * code) is allowed because the path matches.
 */
function frameName(event: { frame?: { name?: string } | null }): string | undefined {
  try {
    return event.frame?.name;
  } catch {
    // A frame that has gone away throws on access.
    return undefined;
  }
}

function isSafeRendererNavigation(targetUrl: string): boolean {
  return isAppRendererUrl(targetUrl, getRendererEntry());
}


function resolveRepoRoot(): string {
  return resolve(app.getAppPath(), "../..");
}

function resolveHotCpuProfileOutputRoot(): string {
  return resolveActiveProfilePath(join("state", "diagnostics"));
}

export function syncHotCpuProfilersFromSettings(
  reason = "settings-changed",
): void {
  for (const sync of hotCpuProfilerSyncHandlers.values()) {
    sync(reason);
  }
}

export function createMainWindow(options?: {
  onShown?: () => void;
  /** The peer's full display label; the renderer and diagnostics read it. */
  federationLabel?: string;
  /** The peer's short display label for the window title, when it has one. */
  federationTitleLabel?: string;
  federationTarget?: FederationRemoteTarget;
  initialLaunchpad?: boolean;
  initialThread?: WindowShowThreadRequest;
  startupCpuProfiler?: {
    attachWindow: (window: BrowserWindow) => void;
  };
}): BrowserWindow {
  installWindowsTitleBarAppearanceSync();
  const preloadPreferences = rendererPreloadWebPreferences();
  const windowTitle = mainWindowTitle(
    options?.federationTitleLabel ?? options?.federationLabel,
  );
  const appearance = readBootstrapAppearance();
  const navigationPreferences = readBootstrapNavigationPreferences();
  const initialBounds = boundsForCursorDisplay(
    MAIN_WINDOW_WIDTH,
    MAIN_WINDOW_HEIGHT,
  );
  const windowChrome = mainWindowChromeOptions(appearance);
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: Math.min(MAIN_WINDOW_MIN_WIDTH, initialBounds.width),
    minHeight: Math.min(MAIN_WINDOW_MIN_HEIGHT, initialBounds.height),
    show: false,
    title: windowTitle,
    ...windowChrome,
    // Replay E2E sizes this window to exact layouts such as 1280x900. macOS
    // otherwise caps a window at the screen's visible height, and a
    // GitHub-hosted macOS runner's 1024x768 display leaves 677px. Linux and
    // Windows already allow a larger-than-screen window. Unpackaged E2E only.
    enableLargerThanScreen: process.env.PWRAGENT_E2E === "1" && !app.isPackaged,
    // Pre-tinted so the OS window fill matches the renderer's first
    // paint and we don't flash dark before a light renderer mounts.
    //
    // Note on stoplight contrast: an earlier iteration set
    // `vibrancy: "titlebar"` here hoping macOS would push the title-bar
    // backdrop toward something darker than pure white when unfocused.
    // That doesn't work for us — vibrancy requires the renderer to be
    // transparent at the zone, and `visualEffectState` defaults to
    // "followWindow" which DISABLES vibrancy on unfocus (the exact
    // case we care about). The stoplight-contrast fix lives in
    // app.css instead: light theme darkens `.activity-titlebar` and
    // `.sidebar__masthead` to a warm tan so gray stoplights stand out.
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      ...preloadPreferences,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Surfaces theme + density to the preload script via process.argv
      // so the inline bootstrap in index.html can apply data-*
      // attributes before any React code runs (avoids flash-of-wrong-
      // theme). The renderer's writeSettingsConfig IPC keeps the TOML
      // in sync; the next launch reads the updated value back via this
      // same path.
      additionalArguments: [
        ...themedWindowAdditionalArguments(appearance),
        ...navigationPreferencesAdditionalArguments(navigationPreferences),
        // The rail/sidebar must be right at first paint, like the lens above:
        // correcting them from the settings snapshot reflows the transcript by
        // the rail's 428px reserve after the app is already on screen.
        ...layoutPreferencesAdditionalArguments(readBootstrapLayoutPreferences()),
        // Surface the OS home directory so the renderer can collapse long
        // absolute paths to `~` (the sandboxed preload can't read it itself).
        `--pwragent-home-dir=${JSON.stringify(homedir())}`,
        ...federationWindowTargetAdditionalArguments(
          options?.federationTarget,
          options?.federationLabel,
        ),
      ],
    }
  });

  // The renderer's <title> (index.html) otherwise replaces the
  // BrowserWindow title on load, which both collapses every window to
  // the same entry in the macOS Window menu and lets a stale literal in
  // the HTML outrank the product name. The main process owns the title
  // for every shell window: "PwrAgent" locally, "PwrAgent - <machine>"
  // for a remote peer.
  lockMainWindowTitle(window, windowTitle);

  if (options?.federationTarget) {
    const webContentsId = window.webContents.id;
    federationWindowWebContentsIds.add(webContentsId);
    federationWindowTargetsByWebContentsId.set(
      webContentsId,
      options.federationTarget,
    );
    window.once("closed", () => {
      federationWindowWebContentsIds.delete(webContentsId);
      federationWindowTargetsByWebContentsId.delete(webContentsId);
    });
  }

  // Register before renderer navigation can reach ready-to-show and call
  // window.show(). The initial boot watchdog depends on this signal, and
  // attaching its listener after createMainWindow returns can miss Electron's
  // synchronous "show" event.
  if (options?.onShown) {
    window.once("show", options.onShown);
  }

  if (isDevelopment) {
    mainLog.info("creating window", {
      preloadPath: preloadPreferences.preload,
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

  let windowShown = false;
  const windowCreatedAt = Date.now();
  const showWindow = (reason: "ready-to-show" | "fallback" | "watchdog"): void => {
    if (windowShown || window.isDestroyed?.()) {
      return;
    }
    windowShown = true;
    // Once per window, in every build: a slow or stalled first paint is
    // otherwise invisible in an operator's log.
    mainLog.info("showing main window", {
      reason,
      elapsedMs: Date.now() - windowCreatedAt,
    });
    recordStartupProfileEvent({
      type: "window-show",
      detail: {
        reason,
      },
    });
    window.show();
  };
  let initialRequestSent = false;
  const sendInitialRequest = (): void => {
    if (initialRequestSent || window.isDestroyed?.()) {
      return;
    }
    initialRequestSent = true;
    if (options?.initialThread) {
      window.webContents.send(
        WINDOW_SHOW_THREAD_CHANNEL,
        options.initialThread,
      );
    } else if (options?.initialLaunchpad) {
      window.webContents.send(WINDOW_OPEN_NEW_THREAD_CHANNEL);
    }
  };
  window.once("ready-to-show", () => {
    recordStartupProfileEvent({ type: "window-ready-to-show" });
    showWindow("ready-to-show");
    sendInitialRequest();
  });
  if (typeof window.webContents.on === "function") {
    watchMainWindowStartup(window, {
      // A window the watchdog shows, or one already on screen, gets no
      // ready-to-show, so the initial thread rides along here instead.
      show: () => {
        showWindow("watchdog");
        sendInitialRequest();
      },
    });
  }
  if (!isMac) {
    window.webContents.once("did-finish-load", () => {
      recordStartupProfileEvent({ type: "window-did-finish-load-fallback-arm" });
      setTimeout(() => showWindow("fallback"), 500);
    });
  }

  const { webContents } = window;
  attachWindowFocusSync(window);
  attachWindowFullscreenSync(window);
  let rendererLoaded = false;
  let diagnosticsStopping = false;
  let hotCpuProfilerConfigKey: string | null = null;
  let hotCpuProfilerPromise: Promise<HotCpuProfilerLifecycle | null> | null = null;
  let hotCpuProfilerGeneration = 0;
  let hotCpuProfilerSyncQueue: Promise<void> = Promise.resolve();

  const createTargetHotCpuProfiler = async (
    hotCpuConfig: Extract<ReturnType<typeof resolveHotCpuProfileConfig>, { enabled: true }>,
    target: "main" | "renderer",
  ): Promise<HotCpuProfilerLifecycle | null> => {
    const appBuildMetadata = await resolveAppBuildMetadata();
    const created = await createHotCpuProfileSession({
      config: hotCpuConfig,
      target,
      versions: {
        appVersion: appBuildMetadata.applicationVersion,
        electronVersion: process.versions.electron ?? "unknown",
        chromeVersion: process.versions.chrome ?? "unknown",
        nodeVersion: process.versions.node,
      },
    });

    if (!created.ok) {
      hotCpuLog.error("failed to initialize hot CPU diagnostics", {
        message: created.message,
      });
      return null;
    }

    hotCpuLog.info("session directory", {
      target,
      sessionDirectory: created.session.directoryPath,
    });

    return new HotCpuProfiler({
      config: hotCpuConfig,
      getAppMetrics: () => app.getAppMetrics(),
      onHeapSnapshotLimitReached: async () => {
        await getDesktopSettingsService().writeConfigPatchTargeted({
          general: { hotCpuProfilingCaptureHeapSnapshot: false },
        });
      },
      onProfileWritten: (event) => {
        for (const subscriber of subscribersForChannel(
          HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL,
        )) {
          subscriber.send(HOT_CPU_PROFILE_CAPTURED_EVENT_CHANNEL, {
            ...event,
            sourceHostname: hostname(),
            appBuildMetadata,
          });
        }
      },
      session: created.session,
      target: target === "main" ? createMainProcessHotCpuTarget() : {
        debugger: webContents.debugger,
        getOSProcessId: () => webContents.getOSProcessId(),
        isDestroyed: () => webContents.isDestroyed(),
        isDevToolsOpened: () => webContents.isDevToolsOpened(),
        takeHeapSnapshot: (filePath) => webContents.takeHeapSnapshot(filePath),
        readDiagnostics: () => readRendererListingDiagnostics(webContents),
      },
    });
  };

  const createHotCpuProfiler = async (
    config: Extract<ReturnType<typeof resolveHotCpuProfileConfig>, { enabled: true }>,
  ): Promise<HotCpuProfilerLifecycle | null> => {
    const renderer = await createTargetHotCpuProfiler(config, "renderer");
    const owner = Symbol("main-hot-cpu-window");
    let stopped = false;
    return {
      start: async () => {
        if (stopped) return;
        await renderer?.start();
        if (stopped) return;
        await sharedMainHotCpuProfiler.acquire(owner, {
          key: hotCpuConfigKey(config),
          create: () => createTargetHotCpuProfiler(
            { ...config, captureHeapSnapshot: false }, "main",
          ),
        });
      },
      stop: async (reason = "stopped") => {
        stopped = true;
        const results = await Promise.allSettled([
          renderer?.stop(reason),
          sharedMainHotCpuProfiler.release(owner, reason),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      },
    };
  };

  const stopHotCpuProfiler = async (reason: string): Promise<void> => {
    hotCpuProfilerGeneration += 1;
    const profilerPromise = hotCpuProfilerPromise;
    hotCpuProfilerConfigKey = null;
    hotCpuProfilerPromise = null;
    if (!profilerPromise) {
      return;
    }

    try {
      const profiler = await profilerPromise;
      await profiler?.stop(reason);
    } catch (error: unknown) {
      hotCpuLog.warn("failed to stop hot CPU diagnostics", {
        reason,
        error: serializeError(error),
      });
    }
  };

  const hotCpuConfigKey = (
    hotCpuConfig: Extract<ReturnType<typeof resolveHotCpuProfileConfig>, { enabled: true }>,
  ): string => {
    return JSON.stringify({
      startDelayMs: hotCpuConfig.startDelayMs,
      triggerMode: hotCpuConfig.triggerMode,
      intervalMs: hotCpuConfig.intervalMs,
      thresholdPercent: hotCpuConfig.thresholdPercent,
      slowburnThresholdPercent: hotCpuConfig.slowburnThresholdPercent,
      consecutiveSamples: hotCpuConfig.consecutiveSamples,
      profileDurationMs: hotCpuConfig.profileDurationMs,
      cooldownMs: hotCpuConfig.cooldownMs,
      maxProfiles: hotCpuConfig.maxProfiles,
      captureHeapSnapshot: hotCpuConfig.captureHeapSnapshot,
      heapSnapshotLimit: hotCpuConfig.heapSnapshotLimit,
    });
  };

  const runHotCpuProfilerSync = async (reason: string): Promise<void> => {
    try {
      if (diagnosticsStopping || !rendererLoaded || window.isDestroyed?.() || webContents.isDestroyed?.()) {
        return;
      }

      const settings = getDesktopConfigStore().read("general").settings;
      const captureHeapSnapshot =
        settings.hotCpuProfilingCaptureHeapSnapshot ?? false;
      const hotCpuConfig = resolveHotCpuProfileConfig({
        captureHeapSnapshot,
        enabled:
          (settings.hotCpuProfilingEnabled ?? false) ||
          captureHeapSnapshot,
        heapSnapshotLimit: Math.min(
          3,
          Math.max(
            2,
            Math.round(settings.hotCpuProfilingHeapSnapshotLimit ?? 2),
          ),
        ),
        outputRoot: resolveHotCpuProfileOutputRoot(),
        repoRoot: resolveRepoRoot(),
        slowburnThresholdPercent: Math.min(
          100,
          Math.max(
            1,
            Math.round(
              settings.hotCpuProfilingSlowburnThresholdPercent
              ?? DESKTOP_HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
            ),
          ),
        ),
        startDelayMs:
          settings.hotCpuProfilingStartDelayMs
          ?? DESKTOP_HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
        triggerMode:
          settings.hotCpuProfilingTriggerMode
          ?? DESKTOP_HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
      });

      if (!hotCpuConfig.enabled) {
        await stopHotCpuProfiler(reason);
        return;
      }

      const nextConfigKey = hotCpuConfigKey(hotCpuConfig);
      if (hotCpuProfilerPromise) {
        if (hotCpuProfilerConfigKey === nextConfigKey) {
          return;
        }
        await stopHotCpuProfiler(reason);
      }

      const generation = hotCpuProfilerGeneration;
      hotCpuProfilerConfigKey = nextConfigKey;
      hotCpuProfilerPromise = createHotCpuProfiler(hotCpuConfig);
      const profiler = await hotCpuProfilerPromise;
      if (generation !== hotCpuProfilerGeneration) {
        await profiler?.stop("settings-changed");
        return;
      }

      if (!profiler) {
        hotCpuProfilerPromise = null;
        hotCpuProfilerConfigKey = null;
        return;
      }

      await profiler.start();
    } catch (error: unknown) {
      hotCpuLog.warn("failed to sync hot CPU diagnostics", {
        reason,
        error: serializeError(error),
      });
    }
  };

  const syncHotCpuProfiler = (reason: string) => {
    hotCpuProfilerSyncQueue = hotCpuProfilerSyncQueue.then(
      () => runHotCpuProfilerSync(reason),
      () => runHotCpuProfilerSync(reason),
    );
    void hotCpuProfilerSyncQueue;
  };
  hotCpuProfilerSyncHandlers.set(window.id, syncHotCpuProfiler);
  const unsubscribeHotCpuSettings = getDesktopConfigStore().subscribe(
    ["general"],
    () => syncHotCpuProfiler("settings-changed"),
  );

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

  const stopHeapMonitor = (reason: string): Promise<void> => {
    return heapMonitorPromise
      .then(async (monitors) => {
        if (!monitors) {
          return;
        }

        const results = await Promise.allSettled([
          monitors.rendererMonitor.stop(reason),
          monitors.mainMonitor.stop(reason),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })
      .catch((error: unknown) => {
        heapLog.warn("failed to stop heap diagnostics", {
          reason,
          error: serializeError(error),
        });
      });
  };

  let diagnosticsStopPromise: Promise<void> | undefined;
  const stopDiagnostics = (reason: string): Promise<void> => {
    diagnosticsStopping = true;
    diagnosticsStopPromise ??= (async () => {
      // A settings sync may still be creating or replacing a profiler. Drain
      // that queue before stopping its final instance; queued syncs are disabled.
      await Promise.allSettled([
        hotCpuProfilerSyncQueue.then(() => stopHotCpuProfiler(reason)),
        stopHeapMonitor(reason),
      ]);
    })().finally(() => windowDiagnosticsStopHandlers.delete(window.id));
    return diagnosticsStopPromise;
  };
  // Keep closed windows registered until their pending writes finish too.
  windowDiagnosticsStopHandlers.set(window.id, stopDiagnostics);

  if (typeof webContents.on === "function") {
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      mainLog.error("renderer load failed", {
        errorCode,
        errorDescription,
        validatedUrl
      });
    });

    webContents.on("render-process-gone", (_event, details) => {
      void stopDiagnostics("render-process-gone");
      mainLog.error("renderer process gone", details);
    });

    if (typeof webContents.once === "function") {
      webContents.once("did-finish-load", () => {
        rendererLoaded = true;
        void heapMonitorPromise.then((monitors) => {
          if (!diagnosticsStopping) return monitors?.rendererMonitor.start();
        });
        syncHotCpuProfiler("did-finish-load");
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
  attachRendererProcessRecovery(window);
  // Secondary windows register a narrower set (or none) so broadcasters
  // only deliver to what they actually consume.
  registerWindowChannels(
    window,
    WINDOW_KIND_MAIN,
    mainWindowEventChannels(options?.federationTarget),
    options?.federationTarget,
  );

  window.on("closed", () => {
    hotCpuProfilerSyncHandlers.delete(window.id);
    unsubscribeHotCpuSettings();
    void stopDiagnostics("window-closed");
  });

  return window;
}
