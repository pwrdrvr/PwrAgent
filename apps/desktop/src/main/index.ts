import { app, BrowserWindow, dialog, Menu, nativeImage, shell } from "electron";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import { getDesktopOverlayStore } from "./app-server/desktop-overlay-store";
import { createPwrAgentAppManagementHandler } from "./agent-tools/pwragent-app-management-service";
import { createFederationAgentToolsHandler } from "./federation/federation-agent-tools-service";
import { createFederatedThreadInspectionHandler } from "./federation/federated-thread-inspection-service";
import { createFederatedThreadMutationHandler } from "./federation/federated-thread-mutation-service";
import {
  createFederatedThreadControlHandler,
  createFederatedThreadMessageHandler,
} from "./federation/federated-thread-message-service";
import { disposeAgentIpcHandlers, registerAgentIpcHandlers } from "./ipc/agent-ipc";
import {
  disposeScheduledActionIpcHandlers,
  registerScheduledActionIpcHandlers,
} from "./ipc/scheduled-actions-ipc";
import {
  disposeScheduledThreadActionService,
} from "./scheduled-actions/scheduled-thread-action-service";
import {
  disposeAppMetadataIpcHandlers,
  registerAppMetadataIpcHandlers,
} from "./ipc/app-metadata";
import {
  disposeClipboardIpcHandlers,
  registerClipboardIpcHandlers,
} from "./ipc/clipboard";
import {
  checkForAppUpdatesNow,
  disposeAppUpdateIpcHandlers,
  initAutoUpdater,
  registerAppUpdateIpcHandlers,
} from "./auto-updater";
import { showAppLogWindow } from "./app-log-window";
import { showChangelogWindow } from "./changelog-window";
import {
  showLicenseWindow,
  showThirdPartyNoticesWindow,
} from "./license-document-window";
import {
  PWRAGENT_DOCUMENTATION_URL,
  PWRAGENT_HOMEPAGE_URL,
} from "../shared/app-metadata";
import { WINDOW_OPEN_SETTINGS_CHANNEL } from "../shared/ipc";
import {
  disposeApplicationIpcHandlers,
  registerApplicationIpcHandlers,
} from "./ipc/applications";
import {
  disposeAutomationIpcHandlers,
  registerAutomationIpcHandlers,
} from "./ipc/automation-ipc";
import { disposeAppServerIpcHandlers, registerAppServerIpcHandlers } from "./ipc/app-server";
import {
  disposeImageNormalizationIpcHandlers,
  registerImageNormalizationIpcHandlers,
} from "./ipc/image-normalization";
import {
  disposeFederationIpcHandlers,
  registerFederationIpcHandlers,
} from "./ipc/federation";
import {
  disposeStarMapIpcHandlers,
  registerStarMapIpcHandlers,
} from "./ipc/star-map";
import {
  disposeDesktopFederationRuntime,
  getDesktopFederationRuntime,
} from "./federation/federation-runtime";
import { createFederationWindow } from "./federation/federation-window";
import {
  disposeIntegratedTerminalIpcHandlers,
  registerIntegratedTerminalIpcHandlers,
} from "./ipc/integrated-terminal";
import { stopAllCodexEnvironmentDetachedCommands } from "./app-server/codex-environment-runtime";
import {
  disposeDiagnosticsIpcHandlers,
  registerDiagnosticsIpcHandlers,
} from "./ipc/diagnostics";
import {
  disposeComposerDraftIpcHandlers,
  registerComposerDraftIpcHandlers,
} from "./ipc/composer-drafts";
import {
  disposeMessagingStatusIpcHandlers,
  registerMessagingStatusIpcHandlers,
} from "./ipc/messaging-status";
import { registerMessagingRbacIpcHandlers } from "./ipc/messaging-rbac";
import {
  disposeMcpConnectionIpcHandlers,
  registerMcpConnectionIpcHandlers,
} from "./ipc/mcp-connections";
import { getPwrSnapConnectionService } from "./mcp-connections/pwrsnap-connection-service";
import {
  disposePreloadLogIpcHandlers,
  registerPreloadLogIpcHandlers,
} from "./ipc/preload-log";
import {
  disposeBootInfoIpcHandlers,
  registerBootInfoIpcHandlers,
} from "./ipc/boot-info";
import {
  disposeProfilesIpcHandlers,
  listDesktopPwrAgentProfiles,
  openDesktopPwrAgentProfile,
  registerProfilesIpcHandlers,
} from "./ipc/profiles";
import { buildDockProfileMenuTemplate } from "./dock-menu";
import { registerRendererErrorIpcHandlers } from "./ipc/renderer-error";
import {
  disposeRuntimeIdentityIpcHandlers,
  registerRuntimeIdentityIpcHandlers,
} from "./ipc/runtime-identity";
import {
  disposeSettingsIpcHandlers,
  registerSettingsIpcHandlers,
} from "./ipc/settings";
import {
  disposeWindowPointerIpcHandlers,
  registerWindowPointerIpcHandlers,
} from "./ipc/window-pointer";
import {
  getMainLogFilePath,
  getMainLogger,
  initializeMainLogger,
  resolveMainLogProfileName,
} from "./log";
import { StartupCpuProfiler } from "./diagnostics/startup-cpu-profiler";
import { recordStartupProfileEvent } from "./diagnostics/startup-profile-events";
import {
  disposeDesktopMessagingRuntime,
  getDesktopMessagingRuntime,
} from "./messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "./messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "./runtime-flags";
import {
  getExistingRuntimeMessagingLeaseCoordinator,
  getRuntimeMessagingLeaseCoordinator,
} from "./runtime-messaging-lease";
import { getExistingRuntimeLeaseManager } from "./runtime-lease-manager";
import {
  getExistingRuntimeFederationLeaseCoordinator,
  getRuntimeFederationLeaseCoordinator,
} from "./runtime-federation-lease";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import {
  disposeAppState,
  initializeAppState,
  isAppStateInitialized,
  recordBootDecision,
} from "./state/app-state";
import { createMainWindow, syncHotCpuProfilersFromSettings } from "./window";
import { subscribersForChannel } from "./window-channels";
import { requestOpenNewThread } from "./window-open-new-thread";
import { requestOpenSettings } from "./window-open-settings";
import { requestReplayOnboarding } from "./window-replay-onboarding";
import { requestCopyLocalDiagnosticsInfo } from "./window-copy-local-diagnostics-info";
import { buildApplicationMenuTemplate } from "./menu";
import { wireAppMenuBridge } from "./app-menu-bridge";
import {
  appQuitManager,
  requestQuit,
  type QuitRequestSource,
} from "./quit-manager";
import {
  installTranscriptImageProtocol,
  registerTranscriptImageProtocolScheme,
} from "./transcript-image-protocol";
import {
  getAuxiliaryWindowMenuTitle,
  reapplyAuxiliaryWindowMenuBars,
} from "./auxiliary-window-chrome";
import {
  assertUnreachableProfileBootDecision,
  buildDockProfileSnapshot,
  cleanupBootstrapProfile,
  PWRAGENT_PROFILE_AUTO_CREATE_ENV,
  resolveActiveProfileName,
  resolveProfileBootDecision,
  startProfileFocusRequestWatcher,
  writeDockProfileSnapshot,
  type ProfileBootDecision,
  type ProfileFocusRequestWatcher,
} from "./profile";
import { SECRET_STORAGE_DISABLED_ENV } from "./settings/desktop-secret-store";
import {
  SQLITE_WRITE_METRICS_ENV,
  SQLITE_WRITE_METRICS_FILE_ENV,
} from "./state/sqlite-write-metrics";
import {
  isUpdateInstallInProgress,
  isUpdateInstallUpdaterQuitReady,
  setUpdateInstallPreparationHandler,
} from "./update-install-state";
import { createShutdownBarrier } from "./shutdown-barrier";
import {
  createE2eShutdownDiagnosticsRecorder,
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
  E2E_SHUTDOWN_LAUNCH_ID_ENV,
  type E2eShutdownPhase,
} from "./e2e-shutdown-diagnostics";

const APP_NAME = "PwrAgent";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC.";
const PWRAGENT_ISSUE_REPORTER_URL =
  "https://github.com/pwrdrvr/PwrAgent/issues/new";
const isMac = process.platform === "darwin";
const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");
const mainProcessStartedAt = Date.now();
const RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS = 12_000;
const INTEGRATED_TERMINAL_SHUTDOWN_TIMEOUT_MS = 2_000;
const MESSAGING_SHUTDOWN_TIMEOUT_MS = 4_000;
const FEDERATION_SHUTDOWN_TIMEOUT_MS = 4_000;
const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 7_500;
const MCP_CONNECTION_SHUTDOWN_TIMEOUT_MS = 2_000;
const e2eShutdownDiagnostics = createE2eShutdownDiagnosticsRecorder({
  enabled: process.env.PWRAGENT_E2E === "1" && !app.isPackaged,
  filePath: process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV],
  launchId: process.env[E2E_SHUTDOWN_LAUNCH_ID_ENV],
});

// Tart's AppleParavirtGPU can reset under sustained Electron E2E load,
// delaying WindowServer paints or rebooting the guest. This must run before
// Electron is ready. It is opt-in for the macOS VM lane only; normal local
// development and host E2E continue to exercise the hardware GPU path.
if (process.env.PWRAGENT_E2E_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}

let mainProcessResourcesDisposed = false;
// Idempotent separately from mainProcessResourcesDisposed: if the graceful
// barrier's federation phase rejected or hung past its timeout, the sync
// dispose already ran (with the release skipped) by the time will-quit /
// process-exit fire, and this flag is what keeps their lease-release
// fallback reachable instead of stranding the lease for its full TTL.
let federationLeaseReleasedSync = false;
let mainProcessShutdownComplete = false;
let mainProcessShutdownPromise: Promise<void> | undefined;
let integratedTerminalShutdownPromise: Promise<void> | undefined;
let rendererWindowShutdownPromise: Promise<void> | undefined;
let finalQuitPromise: Promise<void> | undefined;
let quitInProgress = false;
let profileFocusRequestWatcher: ProfileFocusRequestWatcher | null = null;
let startupCpuProfilerForNewWindows:
  | NonNullable<Parameters<typeof createMainWindow>[0]>["startupCpuProfiler"]
  | undefined;

// --- Boot failure surfacing -------------------------------------------------
// A failed startup must never leave the app "running but unusable" with no
// explanation. We track whether the main window ever became visible; if boot
// rejects (a throw anywhere in the whenReady chain) or simply never produces a
// visible window within a grace period, we log it and put a native dialog in
// front of the user with the actual error and a one-click path to the log
// file. This is the backstop for the class of incident where an automation row
// written by a newer build threw during startup reconciliation, rejected the
// whenReady promise, and silently aborted the rest of boot — no window, no
// dialog, not even a log line.
// A packaged build loads a prebuilt renderer bundle, so 25s is a generous
// budget for "a window should exist by now". A development build loads the
// renderer from the Vite dev server, which transforms the whole app on the
// first request — on slow hardware that single step outlasts the entire
// packaged budget while boot is progressing perfectly normally. Measured on
// the Windows lab guest: watchdog fired at 25s, `ready-to-show` landed at
// ~75s, so a "PwrAgent failed to start" dialog sat in front of an app that
// went on to work. This widens only the unpackaged budget; production failure
// detection is unchanged.
const BOOT_WATCHDOG_PACKAGED_MS = 25_000;
const BOOT_WATCHDOG_DEV_MS = 180_000;
let mainWindowEverShown = false;
let bootFailureSurfaced = false;
let bootWatchdogTimer: NodeJS.Timeout | undefined;
let lastBootError: unknown;

function clearBootWatchdog(): void {
  if (bootWatchdogTimer) {
    clearTimeout(bootWatchdogTimer);
    bootWatchdogTimer = undefined;
  }
}

function resolveBootWatchdogMs(): number {
  return app.isPackaged ? BOOT_WATCHDOG_PACKAGED_MS : BOOT_WATCHDOG_DEV_MS;
}

function startBootWatchdog(): void {
  clearBootWatchdog();
  bootWatchdogTimer = setTimeout(() => {
    surfaceBootFailure("watchdog-timeout");
  }, resolveBootWatchdogMs());
  // Never let the watchdog itself keep the process alive.
  bootWatchdogTimer.unref?.();
}

function markMainWindowBooted(): void {
  mainWindowEverShown = true;
  clearBootWatchdog();
}

function formatBootError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (error === undefined) {
    return "PwrAgent started but its main window never appeared.";
  }
  return String(error);
}

function surfaceBootFailure(reason: string, error?: unknown): void {
  if (mainWindowEverShown || bootFailureSurfaced || quitInProgress) {
    return;
  }
  bootFailureSurfaced = true;
  clearBootWatchdog();
  const detail = error ?? lastBootError;
  const logFilePath = getMainLogFilePath();
  mainLog.error("startup failed before the main window appeared", {
    reason,
    error: detail instanceof Error ? (detail.stack ?? detail.message) : detail,
    logFilePath,
  });
  const detailText = [
    formatBootError(detail),
    logFilePath ? `\n\nLog file:\n${logFilePath}` : "",
  ]
    .join("")
    .trim();
  const buttons = logFilePath
    ? ["Open Log File", "Reveal in Finder", "Quit"]
    : ["Quit"];
  let choice = buttons.length - 1;
  try {
    choice = dialog.showMessageBoxSync({
      type: "error",
      title: "PwrAgent failed to start",
      message:
        "PwrAgent ran into a problem during startup and the main window could not open.",
      detail: detailText,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
  } catch (dialogError) {
    mainLog.error("failed to show boot-failure dialog", {
      error:
        dialogError instanceof Error
          ? dialogError.message
          : String(dialogError),
    });
  }
  if (logFilePath && choice === 0) {
    void shell.openPath(logFilePath);
  } else if (logFilePath && choice === 1) {
    shell.showItemInFolder(logFilePath);
  } else {
    app.quit();
  }
}

let bootErrorHandlersInstalled = false;

function installBootErrorHandlers(): void {
  // Idempotent: bootstrapApp may run more than once across a process (notably
  // in unit tests), and we must not stack a new process listener each time.
  if (bootErrorHandlersInstalled) {
    return;
  }
  bootErrorHandlersInstalled = true;
  // We deliberately do NOT register an uncaughtException handler here: doing so
  // would change Node/Electron's crash semantics for *post*-boot exceptions.
  // The watchdog above is the catch-all for "the window never appeared" no
  // matter how boot failed; this handler just gives faster, more specific
  // reporting for the common async-rejection case and ensures stray rejections
  // are always logged (previously they produced no log line at all).
  process.on("unhandledRejection", (reason) => {
    mainLog.error("unhandled promise rejection", {
      bootCompleted: mainWindowEverShown,
      error: reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    });
    if (!mainWindowEverShown) {
      lastBootError = reason;
      surfaceBootFailure("unhandledRejection", reason);
    }
  });
}

registerTranscriptImageProtocolScheme();

function logBootDecision(decision: ProfileBootDecision): void {
  // Single structured log line on every boot so troubleshooting
  // "why did the wizard fire / not fire" stays trivial. Production
  // builds still log this (it's an INFO line, no sensitive data).
  switch (decision.kind) {
    case "open":
      mainLog.info("boot decision: open", {
        profileName: decision.profileName,
        source: decision.source,
      });
      return;
    case "missing-named-profile":
      mainLog.info("boot decision: missing-named-profile — bootstrap mode", {
        requestedName: decision.requestedName,
        source: decision.source,
      });
      return;
    case "missing-default-profile":
      mainLog.info("boot decision: missing-default-profile — bootstrap mode", {
        configuredName: decision.configuredName,
      });
      return;
    case "no-profile-configured":
      mainLog.info("boot decision: no-profile-configured — bootstrap mode");
      return;
    default:
      // Adding a new ProfileBootDecision variant without handling it
      // here is a compile error. Replace this throw with an info()
      // log + the right decision behavior in the boot pipeline.
      assertUnreachableProfileBootDecision(decision);
  }
}

function prewarmInitialThreadList(): void {
  if (getDesktopSettingsService().isCodexBootstrapDeferred()) {
    mainLog.info("startup thread list prewarm deferred until onboarding completes");
    recordStartupProfileEvent({
      type: "startup-thread-list-prewarm:deferred",
    });
    return;
  }
  const startedAt = Date.now();
  void getDesktopBackendRegistry()
    .listThreads({
      callerReason: "startup-prewarm",
    })
    .then((threads) => {
      recordStartupProfileEvent({
        type: "startup-thread-list-prewarm:completed",
        detail: {
          count: threads.length,
          durationMs: Date.now() - startedAt,
        },
      });
      if (!isDevelopment) {
        return;
      }
      mainLog.info("startup thread list prewarm completed", {
        count: threads.length,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((error) => {
      recordStartupProfileEvent({
        type: "startup-thread-list-prewarm:failed",
        detail: {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (!isDevelopment) {
        return;
      }
      mainLog.warn("startup thread list prewarm failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function releaseFederationLeaseSync(): void {
  if (federationLeaseReleasedSync) {
    return;
  }
  federationLeaseReleasedSync = true;
  const runtimeFederationLeaseCoordinator =
    getExistingRuntimeFederationLeaseCoordinator()
    ?? (isAppStateInitialized() ? getRuntimeFederationLeaseCoordinator() : null);
  runtimeFederationLeaseCoordinator?.shutdownSync();
}

function disposeMainProcessResourcesSync(options?: {
  releaseFederationLease?: boolean;
}): void {
  // On the graceful path the federation lease is released by the shutdown
  // barrier AFTER the runtime stops (that call passes
  // releaseFederationLease: false), so a replacement instance cannot
  // acquire it while the old listener is still bound. Every other call
  // releases now — process termination is imminent — and this attempt sits
  // ahead of the mainProcessResourcesDisposed early-return so the
  // will-quit/process-exit fallback still fires when the barrier's
  // federation phase rejected or timed out before its own release.
  const releaseFederationLease = options?.releaseFederationLease ?? true;
  if (releaseFederationLease) {
    releaseFederationLeaseSync();
  }
  if (mainProcessResourcesDisposed) {
    if (releaseFederationLease) {
      getExistingRuntimeLeaseManager()?.markExited();
    }
    return;
  }
  mainProcessResourcesDisposed = true;
  profileFocusRequestWatcher?.stop();
  profileFocusRequestWatcher = null;
  startupCpuProfilerForNewWindows = undefined;
  disposeAgentIpcHandlers();
  disposeScheduledActionIpcHandlers();
  disposeApplicationIpcHandlers();
  disposeAutomationIpcHandlers();
  disposeAppMetadataIpcHandlers();
  disposeClipboardIpcHandlers();
  disposeAppUpdateIpcHandlers();
  disposeComposerDraftIpcHandlers();
  disposeDiagnosticsIpcHandlers();
  disposeFederationIpcHandlers();
  disposeStarMapIpcHandlers();
  disposeImageNormalizationIpcHandlers();
  integratedTerminalShutdownPromise ??= Promise.resolve(
    disposeIntegratedTerminalIpcHandlers(),
  );
  disposeMcpConnectionIpcHandlers();
  // Detached env-action trees (`pnpm dev` and friends) were previously just
  // abandoned here. They keep their stdio pipes, so they *usually* died of
  // SIGPIPE once we went away — but a quiet one could outlive the app and hold
  // its port. The quit dialog promises they get stopped, so stop them.
  const stoppedDetachedCommands = stopAllCodexEnvironmentDetachedCommands();
  if (stoppedDetachedCommands > 0) {
    mainLog.info("stopped detached environment actions on shutdown", {
      count: stoppedDetachedCommands,
    });
  }
  disposePreloadLogIpcHandlers();
  disposeBootInfoIpcHandlers();
  disposeProfilesIpcHandlers();
  disposeSettingsIpcHandlers();
  disposeWindowPointerIpcHandlers();
  if (isDevelopment) {
    disposeRuntimeIdentityIpcHandlers();
  }
  const runtimeMessagingLeaseCoordinator =
    getExistingRuntimeMessagingLeaseCoordinator() ??
    (isAppStateInitialized() ? getRuntimeMessagingLeaseCoordinator() : null);
  runtimeMessagingLeaseCoordinator?.shutdownSync();
  if (releaseFederationLease) {
    getExistingRuntimeLeaseManager()?.markExited();
  }
}

async function closeRendererWindowsBeforeResourceShutdown(
  source: string,
): Promise<void> {
  rendererWindowShutdownPromise ??= (async () => {
    const startedAt = performance.now();
    e2eShutdownDiagnostics.beginPhase("renderer-window");
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed(),
    );
    if (windows.length === 0) {
      e2eShutdownDiagnostics.finishPhase(
        "renderer-window",
        "completed",
        performance.now() - startedAt,
      );
      return;
    }

    mainLog.info("closing renderer windows before resource shutdown", {
      source,
      windowCount: windows.length,
    });
    const pendingWindows = new Set(windows);
    const allWindowsClosed = Promise.all(
      windows.map(
        (window) =>
          new Promise<void>((resolve) => {
            const settle = (): void => {
              pendingWindows.delete(window);
              resolve();
            };
            if (window.isDestroyed()) {
              settle();
              return;
            }
            try {
              window.once("closed", settle);
              window.close();
            } catch (error) {
              mainLog.warn("failed to close renderer window during shutdown", {
                source,
                windowId: window.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            if (window.isDestroyed()) {
              settle();
            }
          }),
      ),
    );
    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      allWindowsClosed.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(
          () => resolve("timed-out"),
          RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome === "timed-out") {
      mainLog.warn("renderer window close timed out during shutdown", {
        source,
        remainingWindowCount: pendingWindows.size,
        timeoutMs: RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS,
      });
      for (const window of pendingWindows) {
        if (!window.isDestroyed()) {
          try {
            window.destroy();
          } catch (error) {
            mainLog.warn(
              "failed to force destroy renderer window during shutdown",
              {
                source,
                windowId: window.id,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      }
    }
    mainLog.info("renderer windows closed before resource shutdown", {
      source,
      durationLimitMs: RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS,
      outcome,
    });
    e2eShutdownDiagnostics.finishPhase(
      "renderer-window",
      outcome === "closed" ? "completed" : "timed-out",
      performance.now() - startedAt,
    );
  })();
  await rendererWindowShutdownPromise;
}

const runMainProcessShutdownBarrier = createShutdownBarrier({
  globalTimeoutMs: MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS,
  logger: mainLog,
  observer: {
    phaseStarted: (phase) => {
      const diagnosticPhase = toE2eShutdownPhase(phase);
      if (diagnosticPhase) {
        e2eShutdownDiagnostics.beginPhase(diagnosticPhase);
      }
    },
    phaseFinished: (outcome) => {
      const diagnosticPhase = toE2eShutdownPhase(outcome.name);
      if (diagnosticPhase) {
        e2eShutdownDiagnostics.finishPhase(
          diagnosticPhase,
          outcome.outcome,
          outcome.durationMs,
        );
      }
    },
  },
  phases: [
    {
      name: "integrated-terminal",
      timeoutMs: INTEGRATED_TERMINAL_SHUTDOWN_TIMEOUT_MS,
      run: async () => {
        await (integratedTerminalShutdownPromise ??= Promise.resolve(
          disposeIntegratedTerminalIpcHandlers(),
        ));
      },
    },
    {
      name: "messaging",
      timeoutMs: MESSAGING_SHUTDOWN_TIMEOUT_MS,
      run: async () => {
        await disposeMessagingStatusIpcHandlers();
        await disposeDesktopMessagingRuntime();
      },
    },
    {
      name: "federation",
      timeoutMs: FEDERATION_SHUTDOWN_TIMEOUT_MS,
      run: async () => {
        await disposeDesktopFederationRuntime();
        // Release the profile lease only after the listener is down: a
        // replacement that acquired while the old socket was still bound
        // would hit EADDRINUSE, keep the lease, and stay degraded even
        // after this process exits. If this phase rejects or times out,
        // the will-quit/process-exit sync dispose releases instead.
        releaseFederationLeaseSync();
      },
    },
    {
      name: "app-server",
      timeoutMs: APP_SERVER_SHUTDOWN_TIMEOUT_MS,
      run: disposeAppServerIpcHandlers,
    },
    {
      name: "mcp-connections",
      timeoutMs: MCP_CONNECTION_SHUTDOWN_TIMEOUT_MS,
      run: async () => await getPwrSnapConnectionService().close(),
    },
  ],
});

async function disposeMainProcessResources(source: string): Promise<void> {
  mainProcessShutdownPromise ??= (async () => {
    e2eShutdownDiagnostics.beginOverall();
    try {
      // Electron emits before-quit while renderer windows are still live. Close
      // them first so in-flight renderer work cannot cross the boundary where
      // IPC handlers and their backing stores are disposed.
      await closeRendererWindowsBeforeResourceShutdown(source);
      disposeMainProcessResourcesSync({ releaseFederationLease: false });
      await runMainProcessShutdownBarrier(source);
      // Keep the scheduler subscribed until the app-server registry is closed.
      // A queued registry entry can otherwise start after its durable lease was
      // released, leaving the next process free to dispatch the same action.
      disposeScheduledThreadActionService();
      getExistingRuntimeLeaseManager()?.markExited();
      disposeAppState();
      mainProcessShutdownComplete = true;
      e2eShutdownDiagnostics.finishOverall("completed");
    } catch (error) {
      e2eShutdownDiagnostics.finishOverall("failed");
      throw error;
    }
  })();
  await mainProcessShutdownPromise;
}

function toE2eShutdownPhase(
  phase: string,
): Exclude<E2eShutdownPhase, "overall" | "renderer-window"> | undefined {
  switch (phase) {
    case "integrated-terminal":
    case "messaging":
    case "federation":
    case "app-server":
    case "mcp-connections":
      return phase;
    default:
      return undefined;
  }
}

async function prepareForUpdateInstallShutdown(): Promise<void> {
  beginQuitInProgress("update-install");
  await disposeMainProcessResources("update-install");
}

function quitAfterResourceShutdown(source: string): void {
  finalQuitPromise ??= disposeMainProcessResources(source)
    .catch((error: unknown) => {
      mainLog.warn("main process shutdown barrier failed", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      mainProcessShutdownComplete = true;
      appQuitManager.allowImmediateQuit();
      app.quit();
    });
}

function beginQuitInProgress(source: string): void {
  if (quitInProgress) {
    return;
  }
  quitInProgress = true;
  mainLog.info("quit in progress", { source });
}

function cancelQuitInProgress(source: string): void {
  if (!quitInProgress) {
    return;
  }
  quitInProgress = false;
  mainLog.info("quit cancelled", { source });
}

/**
 * Begin an app-wide quit for `source`, then release the hold if it doesn't
 * take. Shared by every entry point that holds a window/quit open while the
 * quit manager confirms (main-window close, window-all-closed, before-quit):
 * mark the quit in progress, ask the manager to confirm, and clear
 * `quitInProgress` again if the user declines the in-progress-thread prompt
 * (`didQuit === false`) — or if the request rejects unexpectedly. Without that
 * release the app wedges: the window stays held open (preventDefault) and
 * window creation stays blocked, with no path back.
 */
function beginQuitWithRelease(source: QuitRequestSource): void {
  beginQuitInProgress(source);
  void requestQuit({ source })
    .then((didQuit) => {
      if (!didQuit) {
        cancelQuitInProgress(source);
      }
    })
    .catch((error: unknown) => {
      mainLog.error("quit request failed; releasing quit hold", {
        error,
        source,
      });
      cancelQuitInProgress(source);
    });
}

function isWindowCreationBlocked(): boolean {
  // An update install closes every window as it hands off to the updater but
  // deliberately does NOT flip quitInProgress (see the window-all-closed
  // handler). Block window creation here too, so a dock activate or
  // profile-focus request in the teardown window can't boot a fresh window
  // while Squirrel is swapping the bundle.
  return (
    quitInProgress || mainProcessResourcesDisposed || isUpdateInstallInProgress()
  );
}

/**
 * Closing the primary window quits the whole app. PwrAgent has no tray and no
 * dock/reopen path we want to support, so once the main window is gone there's
 * no way back to it — and any still-open aux windows (Changelog / Logs /
 * License / Messaging Activity) must not keep a headless, unreachable app
 * alive. Mirror the before-quit / window-all-closed flow: hold the window open
 * until an in-progress-thread quit is confirmed, then let app.quit() tear
 * everything (incl. aux windows) down. Once a quit is allowed/underway,
 * isQuitAllowed() is true and we let the close proceed — that also covers
 * app.quit() re-closing this window during teardown, so there's no loop.
 */
function quitAppOnMainWindowClose(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (appQuitManager.isQuitAllowed()) {
      return;
    }
    event.preventDefault();
    beginQuitWithRelease("main-window-closed");
  });
}

function installProcessShutdownHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    mainLog.info("main process shutdown signal received", { signal });
    beginQuitInProgress(signal);
    appQuitManager.allowImmediateQuit();
    quitAfterResourceShutdown(signal);
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
  process.once("exit", () => {
    disposeMainProcessResourcesSync();
    disposeAppState();
  });
}

function installDevelopmentDockIcon(): void {
  if (!isMac || !isDevelopment) {
    return;
  }

  const iconPath = join(app.getAppPath(), "build/icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    mainLog.warn("failed to load development dock icon", { iconPath });
    return;
  }

  app.dock?.setIcon(icon);
}

function focusPwrAgentWindows(): void {
  if (isWindowCreationBlocked()) {
    mainLog.info("ignoring focus request during shutdown");
    return;
  }

  const windows = subscribersForChannel(WINDOW_OPEN_SETTINGS_CHANNEL)
    .map((webContents) => BrowserWindow.fromWebContents(webContents))
    .filter((window): window is BrowserWindow =>
      Boolean(window && !window.isDestroyed()),
  );
  if (windows.length === 0) {
    quitAppOnMainWindowClose(
      createMainWindow(
        startupCpuProfilerForNewWindows
          ? { startupCpuProfiler: startupCpuProfilerForNewWindows }
          : undefined,
      ),
    );
    app.focus({ steal: true });
    return;
  }

  for (const window of windows) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
  app.focus({ steal: true });
}

function installProfileFocusRequestWatcher(): void {
  profileFocusRequestWatcher?.stop();
  profileFocusRequestWatcher = startProfileFocusRequestWatcher(
    resolveActiveProfileName(),
    {
      onFocus: focusPwrAgentWindows,
    },
  );
}

function openProfileFromMenu(profile: string): Promise<void> {
  return Promise.resolve(openDesktopPwrAgentProfile({ profile }))
    .then(() => undefined)
    .finally(refreshProfileMenus);
}

function installDockMenu(): void {
  if (!isMac) return;
  const snapshot = buildDockProfileSnapshot();
  const materializedProfiles = new Set(
    snapshot.profiles.map((profile) => profile.name),
  );
  const profiles = listDesktopPwrAgentProfiles().profiles
    .filter((profile) => materializedProfiles.has(profile.name));
  // Refresh this on every macOS run so an upgraded installation gets a Dock
  // menu even when its existing profiles registry did not otherwise change.
  try {
    writeDockProfileSnapshot(snapshot);
  } catch (error) {
    mainLog.warn("failed to refresh Dock profile snapshot", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const template = buildDockProfileMenuTemplate(
    profiles,
    openProfileFromMenu,
  );
  app.dock?.setMenu(Menu.buildFromTemplate(template));
}

function refreshProfileMenus(): void {
  installApplicationMenu();
  installDockMenu();
}

function installApplicationMenu(): void {
  const developerMode = getDesktopSettingsService().resolveDeveloperMode();
  const profiles = listDesktopPwrAgentProfiles().profiles;
  const windows = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => ({
      focused: window.isFocused(),
      id: window.id,
      title: getAuxiliaryWindowMenuTitle(window),
    }));
  // Peer lookup touches the profile state db; during early boot (or a
  // torn-down app state in tests) just render the menu without peers.
  let federationPeers: Array<{ instanceId: string; label: string }>;
  try {
    federationPeers = getDesktopFederationRuntime()
      .connectedPeerTargets()
      .filter((peer) => peer.capabilities.includes("remote_window"))
      .map((peer) => ({
        instanceId: peer.target.instanceId,
        label: peer.label,
      }));
  } catch {
    federationPeers = [];
  }
  const template = buildApplicationMenuTemplate({
    appName: APP_NAME,
    developerMode,
    isMac,
    federationPeers,
    profiles,
    windows,
    actions: {
      checkForUpdates: () => {
        void checkForAppUpdatesNow("menu");
      },
      copyLocalDiagnosticsInfo: requestCopyLocalDiagnosticsInfo,
      focusWindow: (windowId) => {
        const window = BrowserWindow.fromId(windowId);
        if (!window || window.isDestroyed()) {
          installApplicationMenu();
          return;
        }
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
      },
      openDocumentation: async () => {
        await shell.openExternal(PWRAGENT_DOCUMENTATION_URL);
      },
      openFederationWindow: (peer) => {
        const connectedPeer = getDesktopFederationRuntime()
          .connectedPeerTargets()
          .find((candidate) => candidate.target.instanceId === peer.instanceId);
        if (!connectedPeer) {
          installApplicationMenu();
          return;
        }
        createFederationWindow({ peer: connectedPeer });
      },
      openIssueReporter: async () => {
        await shell.openExternal(PWRAGENT_ISSUE_REPORTER_URL);
      },
      openNewThread: () => {
        requestOpenNewThread();
      },
      openProfile: (profile) => {
        void openProfileFromMenu(profile);
      },
      openProfilesSettings: () => {
        requestOpenSettings("profiles");
      },
      openSettings: () => {
        requestOpenSettings();
      },
      openWebsite: async () => {
        await shell.openExternal(PWRAGENT_HOMEPAGE_URL);
      },
      quit: () => {
        void requestQuit({ source: "menu" });
      },
      replayOnboarding: () => {
        requestReplayOnboarding();
      },
      showAboutPanel: () => {
        app.showAboutPanel();
      },
      showChangelogWindow,
      showLicenseWindow,
      showLogsWindow: showAppLogWindow,
      showThirdPartyNoticesWindow,
    },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  reapplyAuxiliaryWindowMenuBars();
}

function installWindowMenuRefreshHandlers(): void {
  app.on("browser-window-created", (_event, window) => {
    const refresh = (): void => {
      installApplicationMenu();
    };

    window.on("focus", refresh);
    window.on("closed", refresh);
    window.on("page-title-updated", refresh);
  });
  // Keep Profiles → Remote Instances in sync with peer connectivity.
  getDesktopFederationRuntime().onPeerStatusChanged(() => {
    installApplicationMenu();
  });
}

/**
 * In packaged builds, refuse to honor dev-only env vars even if the
 * operator has set them in their shell. These vars have privacy /
 * security implications (silent profile creation, dropped secrets)
 * that are acceptable in dev but never in production.
 *
 * The trick is `delete process.env.X` — any subsequent reader will
 * see undefined and behave as if it was never set. Logging at error
 * level surfaces the misuse loudly in the app log (which the
 * support flow already collects). Called once at process start,
 * before `initializeMainLogger` so the log file the operator picks
 * up records the rejection.
 */
function rejectDevOnlyEnvVarsInProduction(): void {
  if (!app.isPackaged) return;
  const devOnlyVars = [
    PWRAGENT_PROFILE_AUTO_CREATE_ENV,
    SECRET_STORAGE_DISABLED_ENV,
    SQLITE_WRITE_METRICS_ENV,
    SQLITE_WRITE_METRICS_FILE_ENV,
  ];
  for (const name of devOnlyVars) {
    if (process.env[name] !== undefined) {
       
      console.error(
        `[pwragent] Refusing to honor dev-only env var ${name} in a packaged build. Unsetting.`,
      );
      delete process.env[name];
    }
  }
}

export function bootstrapApp(): void {
  setUpdateInstallPreparationHandler(prepareForUpdateInstallShutdown);
  rejectDevOnlyEnvVarsInProduction();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: APP_COPYRIGHT,
  });
  const bootDecision = resolveProfileBootDecision();
  initializeMainLogger({
    profileName: resolveMainLogProfileName(bootDecision),
  });
  installProcessShutdownHandlers();
  installBootErrorHandlers();

  app.whenReady().then(async () => {
    startBootWatchdog();
    const startupCpuProfiler = new StartupCpuProfiler();
    startupCpuProfilerForNewWindows = startupCpuProfiler;
    await startupCpuProfiler.start();
    recordStartupProfileEvent({ type: "app-when-ready" });
    installDevelopmentDockIcon();
    // Boot decision — resolves which profile (if any) this Electron
    // instance should open into. When the decision is `open` we run
    // the today-style flow into an existing profile dir. Anything
    // else (no profile configured, env/CLI named a missing profile,
    // registry pointer is dangling) means the onboarding wizard
    // needs to run BEFORE we commit to a profile, so app state goes
    // into "bootstrap" mode against the throwaway .bootstrap/ dir.
    // Wizard Finish graduates the bootstrap state into a real
    // profile and opens a new window for it (see Task E).
    // Reduce the 4-variant decision to a 2-variant app-state mode.
    // The explicit switch (vs. a bare `kind === "open" ? … : …`)
    // forces a compile error if a future variant is added — the
    // missing case will fall through to `assertUnreachable…` and
    // fail typecheck rather than silently fall into bootstrap mode.
    const bootMode: "active-profile" | "bootstrap" = (() => {
      switch (bootDecision.kind) {
        case "open":
          return "active-profile";
        case "missing-named-profile":
        case "missing-default-profile":
        case "no-profile-configured":
          return "bootstrap";
        default:
          assertUnreachableProfileBootDecision(bootDecision);
      }
    })();
    logBootDecision(bootDecision);
    // Stash the boot decision so the renderer can read it via
    // `getBootInfo` IPC once the wizard mounts. Specifically the
    // missing-named-profile case needs the requested name to
    // pre-populate the confirmation step's "set up `foo`?" prompt.
    recordBootDecision(bootDecision);
    // Clean up any stale .bootstrap/ from a prior abandoned wizard
    // session BEFORE deciding to init in bootstrap mode for the
    // current run. Doing this here (vs. lazily) means a crashed
    // wizard doesn't accumulate stale state.db handles across
    // multiple boot attempts.
    if (bootMode === "active-profile") {
      cleanupBootstrapProfile();
    }
    recordStartupProfileEvent({
      type: "boot-mode-resolved",
      detail: {
        bootMode,
      },
    });
    initializeAppState(bootMode);
    // Skip the focus-request watcher in bootstrap mode. The watcher
    // mkdirs `<root>/profiles/<active>/state/focus-requests/` to
    // catch "focus existing window" requests from sibling PwrAgent
    // instances — but in bootstrap mode there's no sibling and the
    // active profile resolver falls back to literal "default",
    // materializing a `default/` directory that #524 specifically
    // promised would never appear silently.
    if (bootMode === "active-profile") {
      installProfileFocusRequestWatcher();
    }
    refreshProfileMenus();
    getDesktopBackendRegistry().setPwrAgentAppManagementHandler(
      createPwrAgentAppManagementHandler({
        startedAt: mainProcessStartedAt,
        version: () => app.getVersion(),
      }),
    );
    // Injected rather than owned by the registry: the federation runtime
    // already imports the registry, so the reverse import would be a cycle.
    getDesktopBackendRegistry().setPwrAgentFederationHandler(
      createFederationAgentToolsHandler({
        targetStore: getDesktopOverlayStore(),
        onRemoteChildMounted: async ({ backend, instanceId, threadId }) => {
          await getDesktopBackendRegistry().publishLocalEvent({
            backend,
            notification: {
              method: "navigation/remoteThreadPins/changed",
              params: { instanceId, threadId, pinned: true },
            },
          });
        },
      }),
    );
    getDesktopBackendRegistry().setFederatedThreadMessageHandler(
      createFederatedThreadMessageHandler({
        targetStore: getDesktopOverlayStore(),
      }),
    );
    getDesktopBackendRegistry().setFederatedThreadInspectionHandler(
      createFederatedThreadInspectionHandler({
        targetStore: getDesktopOverlayStore(),
      }),
    );
    getDesktopBackendRegistry().setFederatedThreadMutationHandler(
      createFederatedThreadMutationHandler({
        targetStore: getDesktopOverlayStore(),
      }),
    );
    getDesktopBackendRegistry().setFederatedThreadControlHandler(
      createFederatedThreadControlHandler({
        targetStore: getDesktopOverlayStore(),
      }),
    );
    // Windows: serve the painted title-bar menu bar from the live application
    // menu (idempotent; the renderer mounts the bar only on win32).
    wireAppMenuBridge();
    installWindowMenuRefreshHandlers();
    registerAppServerIpcHandlers();
    registerAgentIpcHandlers();
    registerScheduledActionIpcHandlers();
    registerApplicationIpcHandlers();
    registerAutomationIpcHandlers();
    registerAppMetadataIpcHandlers();
    registerClipboardIpcHandlers();
    registerAppUpdateIpcHandlers({
      requestQuit: async (performQuit) =>
        await requestQuit({ performQuit, source: "update-install" }),
    });
    registerComposerDraftIpcHandlers();
    registerDiagnosticsIpcHandlers();
    registerFederationIpcHandlers();
    registerStarMapIpcHandlers();
    registerImageNormalizationIpcHandlers();
    registerIntegratedTerminalIpcHandlers();
    registerMcpConnectionIpcHandlers();
    installTranscriptImageProtocol({
      resolveFederatedImage: async ({ instanceId, url }) =>
        await getDesktopFederationRuntime()
          .remoteBackend({ scope: "remote", instanceId })
          .readTranscriptImage({ url }),
    });
    registerPreloadLogIpcHandlers();
    registerProfilesIpcHandlers({ onProfilesChanged: refreshProfileMenus });
    registerRendererErrorIpcHandlers();
    registerBootInfoIpcHandlers({
      requestQuit: async () => {
        await requestQuit({ source: "ipc" });
      },
    });
    registerSettingsIpcHandlers(undefined, {
      onConfigPatchWritten: async (patch) => {
        if (patch.federation !== undefined) {
          await getDesktopFederationRuntime().restart();
        }
        if (
          patch.general?.developerMode !== undefined ||
          patch.general?.hotCpuProfilingEnabled !== undefined ||
          patch.general?.hotCpuProfilingStartDelayMs !== undefined ||
          patch.general?.hotCpuProfilingTriggerMode !== undefined ||
          patch.general?.hotCpuProfilingSlowburnThresholdPercent !== undefined ||
          patch.general?.hotCpuProfilingCaptureHeapSnapshot !== undefined ||
          patch.general?.hotCpuProfilingHeapSnapshotLimit !== undefined
        ) {
          installApplicationMenu();
          syncHotCpuProfilersFromSettings("settings-changed");
        }
      },
    });
    registerWindowPointerIpcHandlers();
    if (isDevelopment) {
      registerRuntimeIdentityIpcHandlers();
    }
    void getDesktopFederationRuntime().restart().catch((error) => {
      mainLog.error("federation runtime failed during startup", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const messagingRuntime = getDesktopMessagingRuntime((options) =>
      loadDesktopMessagingConfigFromSettings(
        getDesktopSettingsService(),
        process.env,
        options,
      ),
    );
    getDesktopBackendRegistry().setMessagingArchiveCleaner({
      requestBindingRevokeAllForThread: (request) =>
        messagingRuntime.requestBindingRevokeAllForThread(request),
    });
    getDesktopBackendRegistry().setMessagingAgentToolService(messagingRuntime);
    const messagingOverride = resolveRuntimeMessagingOverride();
    if (messagingOverride.disabled) {
      mainLog.info("messaging runtime disabled for this app instance", {
        reason: messagingOverride.reason,
      });
      void getRuntimeMessagingLeaseCoordinator()
        .start(messagingRuntime, (options) =>
          loadDesktopMessagingConfigFromSettings(
            getDesktopSettingsService(),
            process.env,
            options,
          ),
        )
        .catch((error) => {
          mainLog.error("messaging runtime lease recording failed during startup", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    } else {
      void getRuntimeMessagingLeaseCoordinator()
        .start(messagingRuntime, (options) =>
          loadDesktopMessagingConfigFromSettings(
            getDesktopSettingsService(),
            process.env,
            options,
          ),
        )
        .catch((error) => {
          mainLog.error("messaging runtime failed during background startup", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    // Register status IPC after the runtime is constructed so the
    // initial subscriber attaches before the renderer asks for the
    // current snapshot. When messaging is disabled the runtime singleton
    // still exists (default config); status returns []  / never emits.
    registerMessagingStatusIpcHandlers();
    registerMessagingRbacIpcHandlers();
    recordStartupProfileEvent({ type: "main-window-create:start" });
    const mainWindow = createMainWindow({
      onShown: markMainWindowBooted,
      startupCpuProfiler,
    });
    quitAppOnMainWindowClose(mainWindow);
    recordStartupProfileEvent({ type: "main-window-create:end" });
    recordStartupProfileEvent({ type: "startup-thread-list-prewarm:start" });
    prewarmInitialThreadList();
    recordStartupProfileEvent({ type: "startup-thread-list-prewarm:scheduled" });

    // Wire up auto-update *after* the window is created so a slow update
    // check does not delay first paint. Skips automatically in dev.
    initAutoUpdater();

    app.on("activate", () => {
      if (isWindowCreationBlocked()) {
        mainLog.info("ignoring activate during shutdown");
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        quitAppOnMainWindowClose(
          createMainWindow({
            startupCpuProfiler,
          }),
        );
      }
    });
  }).catch((error: unknown) => {
    // A throw anywhere in the startup chain above rejects this promise. Without
    // this handler the rejection was silent and the rest of boot just stopped,
    // leaving a windowless, unusable process. Surface it instead.
    surfaceBootFailure("whenReady", error);
  });

  app.on("window-all-closed", () => {
    if (isUpdateInstallInProgress()) {
      // The auto updater's quitAndInstall() closes every window as the first
      // step of staging the Squirrel.Mac relaunch, then calls app.quit()
      // itself once ShipIt is armed. Do NOT quit here — a competing app.quit()
      // races that teardown and strands the app on the old version (it exits,
      // or relaunches un-updated). Let the updater drive the quit + relaunch.
      mainLog.info(
        "window-all-closed during update install; letting the updater relaunch",
      );
      return;
    }
    if (quitInProgress) {
      if (appQuitManager.isQuitAllowed()) {
        if (!mainProcessShutdownComplete) {
          mainLog.info("starting resource shutdown after windows closed");
          quitAfterResourceShutdown("window-all-closed");
          return;
        }
        mainLog.info("quitting after windows closed during shutdown");
        app.quit();
        return;
      }
      mainLog.info("ignoring window-all-closed during shutdown");
      return;
    }
    beginQuitWithRelease("window-all-closed");
  });

  app.on("before-quit", (event) => {
    if (isUpdateInstallInProgress()) {
      beginQuitInProgress("update-install");
      if (!isUpdateInstallUpdaterQuitReady()) {
        event?.preventDefault();
      }
      if (!mainProcessShutdownComplete) {
        // Defensive fallback for a native/direct updater invocation that did
        // not pass through installDownloadedAppUpdate. Never issue app.quit()
        // here; preparation or Squirrel owns the next transition.
        void prepareForUpdateInstallShutdown().catch((error: unknown) => {
          mainLog.warn("update-install shutdown preparation failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return;
    }
    if (!appQuitManager.isQuitAllowed()) {
      event?.preventDefault();
      beginQuitWithRelease("before-quit");
      return;
    }
    beginQuitInProgress("before-quit");
    if (!mainProcessShutdownComplete) {
      event?.preventDefault();
      quitAfterResourceShutdown("before-quit");
    }
  });

  app.on("will-quit", () => {
    disposeMainProcessResourcesSync();
    disposeAppState();
  });
}

bootstrapApp();
