import { startOwnerServices, disposeOwnerServices, disposeOwnerServicesSync, prepareOwnerShutdown, releaseOwnerFederationLeaseSync } from "../owner-services";

import { createDesktopOwnerHostServices } from "./owner-host-services";
import { nativeVoiceMediaRules, registerNativeVoiceIpcHandlers } from "./ipc/native-voice";
import { installPermissionPolicy } from "./permission-policy";

import { configureBundledGit } from "../bundled-git";
import {
  applyRememberedLinuxPasswordStore,
  relaunchForLinuxSecretStore,
} from "./linux-password-store";
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, session, shell } from "electron";
import { performance } from "node:perf_hooks";















import { disposeAgentIpcHandlers, registerAgentIpcHandlers } from "./ipc/agent-ipc";
import {
  disposeScheduledActionIpcHandlers,
  registerScheduledActionIpcHandlers,
} from "./ipc/scheduled-actions-ipc";
import { registerThreadTodoIpcHandlers } from "./ipc/thread-todos-ipc";
import { registerCodexEnvironmentEditorIpcHandlers } from "./ipc/codex-environment-editor-ipc";
import { registerOperatorRequestIpcHandlers } from "./ipc/operator-requests-ipc";

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
  PWRAGENT_DEV_FAKE_UPDATE_ENV,
  PWRAGENT_DEV_FAKE_UPDATE_STEP_MS_ENV,
  registerAppUpdateIpcHandlers,
} from "./auto-updater";
import { showAppLogWindow } from "./app-log-window";
import { showChangelogWindow } from "./changelog-window";
import { showUsageActivityWindow } from "./usage-activity-window";
import {
  showLicenseWindow,
  showThirdPartyNoticesWindow,
} from "./license-document-window";
import {
  PWRAGENT_DOCUMENTATION_URL,
  PWRAGENT_HOMEPAGE_URL,
} from "../../shared/app-metadata";
import { WINDOW_OPEN_SETTINGS_CHANNEL } from "../../shared/ipc";
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
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import {
  createFederationWindow,
  refreshFederationWindowTitles,
} from "./federation/federation-window";

import {
  disposeIntegratedTerminalIpcHandlers,
  registerIntegratedTerminalIpcHandlers,
} from "./ipc/integrated-terminal";

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

import {
  disposePreloadLogIpcHandlers,
  registerPreloadLogIpcHandlers,
} from "./ipc/preload-log";
import {
  disposeAppIconDragIpcHandlers,
  registerAppIconDragIpcHandlers,
} from "./ipc/app-icon-drag";
import {
  disposeBootInfoIpcHandlers,
  registerBootInfoIpcHandlers,
} from "./ipc/boot-info";
import {
  disposeQuitBlockerIpcHandlers,
  registerQuitBlockerIpcHandlers,
} from "./ipc/quit-blockers";
import {
  disposeRestartGateIpcHandlers,
  registerRestartGateIpcHandlers,
} from "./ipc/restart-gate";
import {
  disposeProfilesIpcHandlers,
  listDesktopPwrAgentProfiles,
  openDesktopPwrAgentProfile,
  registerProfilesIpcHandlers,
} from "./ipc/profiles";
import { buildDockProfileMenuTemplate } from "./dock-menu";
import { disposeRendererErrorIpcHandlers, registerRendererErrorIpcHandlers } from "./ipc/renderer-error";
import {
  disposeLaunchpadAccessNoticeIpcHandlers,
  registerLaunchpadAccessNoticeIpcHandlers,
} from "./ipc/launchpad-access-notice";
import {
  disposeRuntimeIdentityIpcHandlers,
  registerRuntimeIdentityIpcHandlers,
} from "./ipc/runtime-identity";
import {
  disposeSettingsIpcHandlers,
  registerSettingsIpcHandlers,
} from "./ipc/settings";
import {
  disposeKeybindingsIpcHandlers,
  getKeybindingsSnapshot,
  onKeybindingsChanged,
  registerKeybindingsIpcHandlers,
} from "./ipc/keybindings";
import {
  disposeWindowPointerIpcHandlers,
  registerWindowPointerIpcHandlers,
} from "./ipc/window-pointer";
import {
  getMainLogFilePath,
  getMainLogger,
  initializeMainLogger,
  resolveMainLogProfileName,
} from "../log";
import { StartupCpuProfiler } from "./diagnostics/startup-cpu-profiler";
import { isRenderingDiagnosticsWindow, stopRenderingDiagnostics } from "./diagnostics/rendering-capture";
import { recordStartupProfileEvent } from "../diagnostics/startup-profile-events";






import { getDesktopConfigStore } from "../settings/desktop-settings-singleton";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import { disposeAppState, recordBootDecision } from "../storage/desktop-state-lifecycle";
import type { AutoVacuumConversion } from "../storage/desktop-state-lifecycle";
import {
  createMainWindow,
  getRendererEntry,
  isFederationWindowWebContents,
  stopWindowDiagnostics,
} from "./window";
import { subscribersForChannel } from "./window-channels";
import { requestOpenMainView } from "./window-open-main-view";
import { requestOpenNewThread } from "./window-open-new-thread";
import { requestOpenThreadMaintenance } from "./window-open-thread-maintenance";
import { requestOpenSettings } from "./window-open-settings";
import { PROFILES_SETTINGS_CREATE_SUBSECTION } from "../../shared/settings-routes";
import { requestReplayOnboarding } from "./window-replay-onboarding";
import { requestCopyLocalDiagnosticsInfo } from "./window-copy-local-diagnostics-info";
import {
  ACTIVE_PROFILE_MENU_ITEM_ID,
  buildApplicationMenuTemplate,
  type ApplicationMenuFederationPeer,
} from "./menu";
import { selectWindowForProfileFocus } from "./window-profile-focus";
import { wireAppMenuBridge } from "./app-menu-bridge";
import { wireWindowControlsBridge } from "./window-controls-bridge";
import { installWindowFrameSync } from "./window-frame-sync";
import {
  appQuitManager,
  requestQuit,
  type QuitRequestSource,
} from "./quit-manager";
import { retryQuitAfterDispatch } from "./quit-retry";
import { watchSystemShutdown } from "./system-shutdown";
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
  resolvePwragentRoot,
  startProfileFocusRequestWatcher,
  writeDockProfileSnapshot,
  type ProfileBootDecision,
  type ProfileFocusRequestWatcher,
} from "../profile";
import {
  isSecretStorageDisabledByEnv,
  SECRET_STORAGE_DISABLED_ENV,
} from "../settings/desktop-secret-store";
import {
  SQLITE_WRITE_METRICS_ENV,
  SQLITE_WRITE_METRICS_FILE_ENV,
} from "../storage/desktop-state-lifecycle";
import {
  isUpdateInstallInProgress,
  isUpdateInstallUpdaterQuitReady,
  setUpdateInstallPreparationHandler,
} from "./update-install-state";
import { createShutdownBarrier } from "../shutdown-barrier";
import { developmentDockIconPath } from "./themed-dock-icon";
import {
  createE2eShutdownDiagnosticsRecorder,
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
  E2E_SHUTDOWN_LAUNCH_ID_ENV,
  type E2eShutdownPhase,
} from "../e2e-shutdown-diagnostics";
import {
  E2E_CHILD_PROCESS_DIAGNOSTICS_FILE_ENV,
  installE2eChildProcessDiagnostics,
} from "../e2e-child-process-diagnostics";

configureBundledGit(app.isPackaged ? process.resourcesPath : undefined);

const APP_NAME = "PwrAgent";
const PWRAGENT_SOURCE_URL = "https://github.com/pwrdrvr/PwrAgent";
const PWRAGENT_ISSUE_REPORTER_URL = `${PWRAGENT_SOURCE_URL}/issues/new`;
// GitHub private vulnerability reporting, per SECURITY.md: never a public issue.
const PWRAGENT_SECURITY_REPORTER_URL =
  `${PWRAGENT_SOURCE_URL}/security/advisories/new`;
const isMac = process.platform === "darwin";
const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");
const mainProcessStartedAt = Date.now();
const RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS = 12_000;
const e2eShutdownDiagnostics = createE2eShutdownDiagnosticsRecorder({
  enabled: process.env.PWRAGENT_E2E === "1" && !app.isPackaged,
  filePath: process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV],
  launchId: process.env[E2E_SHUTDOWN_LAUNCH_ID_ENV],
});
const childProcessDiagnostics = installE2eChildProcessDiagnostics({
  enabled: process.env.PWRAGENT_E2E === "1" && !app.isPackaged,
  filePath: process.env[E2E_CHILD_PROCESS_DIAGNOSTICS_FILE_ENV],
  launchId: process.env[E2E_SHUTDOWN_LAUNCH_ID_ENV],
});
process.once("exit", () => {
  childProcessDiagnostics.snapshot("process-exit");
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
let mainProcessShutdownComplete = false;
let mainProcessShutdownPromise: Promise<void> | undefined;
let integratedTerminalShutdownPromise: Promise<void> | undefined;
let rendererWindowShutdownPromise: Promise<void> | undefined;
let finalQuitPromise: Promise<void> | undefined;
let quitInProgress = false;
let startupWindowCreated = false;
let profileFocusRequestWatcher: ProfileFocusRequestWatcher | null = null;
let startupCpuProfilerForNewWindows: StartupCpuProfiler | undefined;

// --- Boot failure surfacing -------------------------------------------------
// A rejected startup must never leave the app "running but unusable" with no
// explanation. We track whether the main window ever became visible so an
// actual startup error can be surfaced before first paint. Do not infer failure
// from elapsed time: macOS can defer window visibility while the login session
// is locked even though startup succeeded and the window will appear later.
let mainWindowEverShown = false;
let bootFailureSurfaced = false;
let lastBootError: unknown;

function markMainWindowBooted(): void {
  mainWindowEverShown = true;
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
  const detail = error ?? lastBootError;
  const logFilePath = getMainLogFilePath();
  mainLog.error("startup failed before the main window appeared", {
    reason,
    error: detail instanceof Error ? detail.message : detail,
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
  // This handler gives specific reporting for the common async-rejection case
  // and ensures stray rejections are always logged (previously they produced no
  // log line at all).
  process.on("unhandledRejection", (reason) => {
    mainLog.error("unhandled promise rejection", {
      bootCompleted: mainWindowEverShown,
      error: reason instanceof Error ? reason.message : reason,
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
    releaseOwnerFederationLeaseSync();
  }
  if (mainProcessResourcesDisposed) {
    if (releaseFederationLease) {
      disposeOwnerServicesSync({ releaseFederationLease: true });
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
  disposeRendererErrorIpcHandlers();
  disposeFederationIpcHandlers();
  disposeStarMapIpcHandlers();
  disposeImageNormalizationIpcHandlers();
  integratedTerminalShutdownPromise ??= Promise.resolve(
    disposeIntegratedTerminalIpcHandlers(),
  );
  disposeMcpConnectionIpcHandlers();
  disposePreloadLogIpcHandlers();
  disposeBootInfoIpcHandlers();
  disposeQuitBlockerIpcHandlers();
  disposeRestartGateIpcHandlers();
  disposeProfilesIpcHandlers();
  disposeSettingsIpcHandlers();
  disposeKeybindingsIpcHandlers();
  disposeAppIconDragIpcHandlers();
  disposeWindowPointerIpcHandlers();
  disposeLaunchpadAccessNoticeIpcHandlers();
  if (isDevelopment) {
    disposeRuntimeIdentityIpcHandlers();
  }
  disposeOwnerServicesSync({ releaseFederationLease });
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

const flushDiagnostics = createShutdownBarrier({
  globalTimeoutMs: 10_000,
  logger: mainLog,
  phases: [{
    name: "diagnostics",
    timeoutMs: 10_000,
    run: async () => {
      // Start both even if one throws, and wait for every capture's final writes.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => startupCpuProfilerForNewWindows?.stop("app-quit")),
        Promise.resolve().then(() => stopWindowDiagnostics("app-quit")),
        Promise.resolve().then(() => stopRenderingDiagnostics("shutdown")),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  }],
});

async function disposeMainProcessResources(source: string): Promise<void> {
  mainProcessShutdownPromise ??= (async () => {
    prepareOwnerShutdown();
    // Diagnostics consumes the existing 2s window + 12s resource allowance;
    // it must not add another serial 10s wait to application shutdown.
    const deadline = performance.now()
      + RENDERER_WINDOW_SHUTDOWN_TIMEOUT_MS + MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS;
    e2eShutdownDiagnostics.beginOverall();
    childProcessDiagnostics.snapshot("shutdown-started");
    try {
      await flushDiagnostics(source);
      // Electron emits before-quit while renderer windows are still live. Close
      // them first so in-flight renderer work cannot cross the boundary where
      // IPC handlers and their backing stores are disposed.
      await closeRendererWindowsBeforeResourceShutdown(source);
      disposeMainProcessResourcesSync({ releaseFederationLease: false });
      await disposeOwnerServices(source, deadline - performance.now(), async () => {
        await disposeMessagingStatusIpcHandlers();
        await disposeAppServerIpcHandlers();
      });
      // The barrier bounds waiting; it does not cancel timed-out work. Keep
      // SQLite alive for late socket callbacks and the final lease release.
      // Only the process exit hook closes it, after synchronous cleanup.
      mainProcessShutdownComplete = true;
      e2eShutdownDiagnostics.finishOverall("completed");
      childProcessDiagnostics.snapshot("shutdown-completed");
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
      // Never from this chain. When shutdown waited on no task (it failed
      // early, or had no window to close), the chain settles inside the
      // native before-quit dispatch that started it, and Electron overwrites
      // the nested pass's quit; see quit-retry.ts.
      retryQuitAfterDispatch(() => {
        // An accepted update may take ownership while this normal quit waits.
        if (!isUpdateInstallInProgress()) {
          appQuitManager.allowImmediateQuit();
          app.quit();
        }
      });
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
function beginQuitWithRelease(
  source: QuitRequestSource,
  performQuit?: () => void,
): void {
  beginQuitInProgress(source);
  void requestQuit(performQuit ? { performQuit, source } : { source })
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
  // Renderer termination is recovered by the window's recovery handler. It
  // does not close the BrowserWindow or end main-owned turns and connections.
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
    try {
      childProcessDiagnostics.snapshot("synchronous-cleanup-started");
      disposeMainProcessResourcesSync();
      childProcessDiagnostics.snapshot("app-state-close-started");
      disposeAppState();
      childProcessDiagnostics.snapshot("app-state-close-completed");
    } finally {
      childProcessDiagnostics.dispose();
    }
  });
}

function installDevelopmentDockIcon(): void {
  if (!isMac || !isDevelopment) {
    return;
  }

  const iconPath = developmentDockIconPath(app.getAppPath());
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    mainLog.warn("failed to load development dock icon", { iconPath });
    return;
  }

  app.dock?.setIcon(icon);
}

let lastFocusedWindow: BrowserWindow | undefined;
let applicationMenu: Electron.Menu | undefined;
// On macOS isVisible() also becomes false when another app covers a window.
const shownWindows = new WeakSet<BrowserWindow>();

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

  const window = selectWindowForProfileFocus(
    BrowserWindow.getAllWindows(),
    BrowserWindow.getFocusedWindow(),
    lastFocusedWindow,
    windows[0]!,
    (candidate) => shownWindows.has(candidate),
  );
  app.focus({ steal: true });
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
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
  const developerMode =
    getDesktopConfigStore().read("general").settings.developerMode
    ?? !app.isPackaged;
  const profiles = listDesktopPwrAgentProfiles().profiles;
  // The Profiles check marks the focused window's profile. A remote
  // instance's window runs a profile that is not one of these rows.
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const focusedRemoteWindow = Boolean(
    focusedWindow
    && !focusedWindow.isDestroyed()
    && isFederationWindowWebContents(focusedWindow.webContents),
  );
  const windows = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && !isRenderingDiagnosticsWindow(window))
    .map((window) => ({
      focused: window.isFocused(),
      id: window.id,
      title: getAuxiliaryWindowMenuTitle(window),
    }));
  // Peer lookup touches the profile state db; during early boot (or a
  // torn-down app state in tests) just render the menu without peers.
  let federationPeers: ApplicationMenuFederationPeer[];
  try {
    federationPeers = getDesktopFederationRuntime()
      .connectedPeerTargets()
      .filter((peer) => peer.capabilities.includes("remote_window"))
      .map((peer) => ({
        instanceId: peer.target.instanceId,
        label: peer.label,
        ...(peer.shortLabel ? { shortLabel: peer.shortLabel } : {}),
      }));
  } catch {
    federationPeers = [];
  }
  const template = buildApplicationMenuTemplate({
    appName: APP_NAME,
    developerMode,
    isMac,
    federationPeers,
    focusedRemoteWindow,
    keybindings: getKeybindingsSnapshot().overrides,
    profiles,
    windows,
    actions: {
      checkForUpdates: () => {
        void checkForAppUpdatesNow("menu");
      },
      copyLocalDiagnosticsInfo: requestCopyLocalDiagnosticsInfo,
      focusWindow: (windowId) => {
        const window = BrowserWindow.fromId(windowId);
        if (!window || window.isDestroyed() || isRenderingDiagnosticsWindow(window)) {
          installApplicationMenu();
          return;
        }
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
      },
      openAutomations: () => {
        requestOpenMainView("automations");
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
      openNewProfile: () => {
        requestOpenSettings("profiles", PROFILES_SETTINGS_CREATE_SUBSECTION);
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
      openSecurityReporter: async () => {
        await shell.openExternal(PWRAGENT_SECURITY_REPORTER_URL);
      },
      openSettings: () => {
        requestOpenSettings();
      },
      openSource: async () => {
        await shell.openExternal(PWRAGENT_SOURCE_URL);
      },
      openThreadMaintenance: () => {
        requestOpenThreadMaintenance();
      },
      openThreadSearch: () => {
        requestOpenMainView("search");
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
      // The app's own About page on every platform: the native panel shows a
      // name and a version, and on Linux a bare GTK dialog.
      showAbout: () => {
        requestOpenSettings("about");
      },
      showChangelogWindow,
      showLicenseWindow,
      showLogsWindow: showAppLogWindow,
      showThirdPartyNoticesWindow,
      showUsageActivityWindow: () => {
        showUsageActivityWindow({ sourceWindow: BrowserWindow.getFocusedWindow() ?? undefined });
      },
    },
  });

  applicationMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(applicationMenu);
  reapplyAuxiliaryWindowMenuBars();
}

function installWindowMenuRefreshHandlers(): void {
  app.on("browser-window-created", (_event, window) => {
    const refresh = (): void => {
      if (!isMac) {
        installApplicationMenu();
      }
    };

    window.on("focus", () => {
      lastFocusedWindow = window;
      if (isMac) {
        // AppKit owns the native Window menu and its window ordering. A focus
        // change only changes this check mark; keep the installed menu intact.
        const activeProfile = applicationMenu?.getMenuItemById(ACTIVE_PROFILE_MENU_ITEM_ID);
        if (activeProfile) {
          activeProfile.checked = !isFederationWindowWebContents(window.webContents);
        }
      }
      refresh();
    });
    window.on("show", () => {
      shownWindows.add(window);
    });
    window.on("hide", () => {
      shownWindows.delete(window);
      if (lastFocusedWindow === window) {
        lastFocusedWindow = undefined;
      }
    });
    window.on("closed", () => {
      if (lastFocusedWindow === window) {
        lastFocusedWindow = undefined;
      }
      refresh();
    });
    window.on("page-title-updated", refresh);
  });
  // Profiles → Remote Instances and remote window titles both draw peer
  // labels, which change with connectivity (a reconnect, or a sibling
  // profile that adds a "/ <profile>" suffix) and with short names.
  const refreshPeerLabels = (): void => {
    refreshFederationWindowTitles(
      getDesktopFederationRuntime().connectedPeerTargets(),
    );
    installApplicationMenu();
  };
  getDesktopFederationRuntime().onPeerStatusChanged(refreshPeerLabels);
  getDesktopFederationRuntime().onShortNamesChanged(refreshPeerLabels);
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
    PWRAGENT_DEV_FAKE_UPDATE_ENV,
    PWRAGENT_DEV_FAKE_UPDATE_STEP_MS_ENV,
    // The React DevTools / profiling vars below are read by
    // `electron.vite.config.ts` at build time, not by this process, so the
    // `delete` accomplishes nothing for them. They are listed anyway for the
    // error line: an operator who exports one and then launches a packaged
    // build is owed a loud "that did nothing" rather than a silent Profiler
    // tab that never connects. Names are literals because the canonical
    // declarations live in the Vite config, which main must not import.
    "PWRAGENT_DEV_REACT_DEVTOOLS",
    "PWRAGENT_DEV_REACT_DEVTOOLS_HOST",
    "PWRAGENT_DEV_REACT_DEVTOOLS_PORT",
    "PWRAGENT_DEV_REACT_PROFILING",
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

/**
 * Reports the one-time `auto_vacuum = INCREMENTAL` conversion `startGc` runs
 * on profiles created before that pragma was ordered correctly.
 *
 * A failure here is not fatal and is deliberately not thrown — VACUUM wants an
 * exclusive lock and profiles are shared between instances over WAL — but it
 * does have to be visible: the profile stays at `auto_vacuum=NONE`, where the
 * hourly `incremental_vacuum` reclaims nothing and every later launch retries
 * a full rewrite. Silence is what let the original pragma bug survive.
 */
function reportAutoVacuumConversion(
  conversion: AutoVacuumConversion | null,
): void {
  if (!conversion || conversion.status === "already-incremental") return;
  if (conversion.status === "failed") {
    mainLog.warn(
      "state.db auto_vacuum conversion failed; retrying on next launch",
      { error: conversion.error.message },
    );
    return;
  }
  const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  mainLog.info("state.db converted to incremental auto_vacuum", {
    elapsedMs: Math.round(conversion.elapsedMs),
    freedMb: toMb(conversion.bytesBefore - conversion.bytesAfter),
    fromMb: toMb(conversion.bytesBefore),
    toMb: toMb(conversion.bytesAfter),
  });
}

export function bootstrapApp(): void {
  setUpdateInstallPreparationHandler(prepareForUpdateInstallShutdown);
  rejectDevOnlyEnvVarsInProduction();
  app.setName(APP_NAME);
  const bootDecision = resolveProfileBootDecision();
  initializeMainLogger({
    profileName: resolveMainLogProfileName(bootDecision),
    logDirectory: app.getPath("logs"),
  });
  installProcessShutdownHandlers();
  installBootErrorHandlers();
  // Chromium reads --password-store in PostCreateMainMessageLoop, after this
  // function returns. An env override or a store remembered from an earlier
  // launch has to be appended here, still during the initial module evaluation.
  const linuxPasswordStoreRoot = process.platform === "linux"
    && !isSecretStorageDisabledByEnv()
    && process.env.PWRAGENT_E2E !== "1"
    ? resolvePwragentRoot()
    : undefined;
  const rememberedLinuxPasswordStore = linuxPasswordStoreRoot
    ? applyRememberedLinuxPasswordStore({
      platform: process.platform,
      argv: process.argv,
      env: process.env,
      pwragentRoot: linuxPasswordStoreRoot,
      appendSwitch: (backend) => {
        app.commandLine.appendSwitch("password-store", backend);
      },
    })
    : undefined;
  if (rememberedLinuxPasswordStore) {
    mainLog.info("linux secret store selected before ready", {
      backend: rememberedLinuxPasswordStore,
    });
  }

  app.whenReady().then(async () => {
    watchSystemShutdown(() => {
      beginQuitInProgress("system-shutdown");
      // Like a process signal, OS shutdown cannot wait for the interactive
      // running-thread confirmation. before-quit still drains resources.
      appQuitManager.allowImmediateQuit();
    });
    if (linuxPasswordStoreRoot && relaunchForLinuxSecretStore({
      platform: process.platform,
      argv: process.argv,
      env: process.env,
      pwragentRoot: linuxPasswordStoreRoot,
      selectedStore: rememberedLinuxPasswordStore,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend?.() ?? null,
      relaunch: (args) => {
        app.relaunch({ args });
      },
      exit: (code) => {
        app.exit(code);
      },
      info: (message, fields) => {
        mainLog.info(message, fields);
      },
      warn: (message, fields) => {
        mainLog.warn(message, fields);
      },
    })) {
      return;
    }
    if (mainProcessShutdownPromise) return;
    const startupCpuProfiler = new StartupCpuProfiler();
    startupCpuProfilerForNewWindows = startupCpuProfiler;
    await startupCpuProfiler.start();
    // A quit may have joined an in-flight profiler start. Do not resume boot
    // and create fresh windows or captures after diagnostics shutdown began.
    if (mainProcessShutdownPromise) return;
    recordStartupProfileEvent({ type: "app-when-ready" });
    // Every window shares the default session. Deny by default before any
    // window can ask.
    installPermissionPolicy(session.defaultSession, {
      rendererEntry: getRendererEntry(),
      media: nativeVoiceMediaRules,
    });
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
    // Every log file needs the build it came from. The preload records the
    // same versions per window, but that is debug detail; this line is the one
    // an operator reads at the top of a support log.
    mainLog.info("app starting", {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? "unknown",
      platform: process.platform,
      arch: process.arch,
    });
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
    const ownerServices = await startOwnerServices(createDesktopOwnerHostServices(), {
      bootMode,
      startedAt: mainProcessStartedAt,
      onStateInitialized: (state) => reportAutoVacuumConversion(state.autoVacuum),
      shutdown: {
        closeTerminal: async () => { await (integratedTerminalShutdownPromise ??= Promise.resolve(disposeIntegratedTerminalIpcHandlers())); },
        closeMessagingStatus: disposeMessagingStatusIpcHandlers,
        closeAppServerIpc: disposeAppServerIpcHandlers,
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
      },
    });
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
    // Windows and Linux: serve the painted title-bar menu bar from the live
    // application menu (idempotent; the renderer mounts the bar only where the
    // native title bar — and with it the native menu bar — is hidden).
    wireAppMenuBridge();
    installWindowMenuRefreshHandlers();
    // keybindings.toml is shared by every profile: a save from any window,
    // in this process or another, re-labels this process's menu.
    registerKeybindingsIpcHandlers();
    onKeybindingsChanged(() => {
      installApplicationMenu();
    });
    // Linux: back the caption buttons the renderer paints, and tell every
    // window's renderer when the window manager maximizes it.
    wireWindowControlsBridge();
    installWindowFrameSync(app);
    registerAppServerIpcHandlers();
    registerNativeVoiceIpcHandlers();
    registerAgentIpcHandlers();
    registerScheduledActionIpcHandlers();
    // A to-do's "Start thread on" runs through the same federation tools,
    // with the card's origin on the started thread's prompt.
    registerThreadTodoIpcHandlers(ownerServices.todoFederation);
    registerCodexEnvironmentEditorIpcHandlers();
    registerOperatorRequestIpcHandlers();
    registerApplicationIpcHandlers();
    registerAutomationIpcHandlers();
    registerAppMetadataIpcHandlers();
    registerClipboardIpcHandlers();
    registerAppUpdateIpcHandlers({
      requestQuit: async (performQuit, beforeQuit) =>
        await requestQuit({ performQuit, beforeQuit, source: "update-install" }),
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
    registerQuitBlockerIpcHandlers();
    registerRestartGateIpcHandlers();
    registerAppIconDragIpcHandlers();
    registerSettingsIpcHandlers(undefined, {
      onConfigPatchWritten: async (patch, previousProviderDefaults) => {
        await ownerServices.onConfigPatchWritten(patch, previousProviderDefaults);
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
        }
      },
    });
    registerWindowPointerIpcHandlers();
    registerLaunchpadAccessNoticeIpcHandlers();
    if (isDevelopment) {
      registerRuntimeIdentityIpcHandlers();
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
    startupWindowCreated = true;
    recordStartupProfileEvent({ type: "main-window-create:end" });
    recordStartupProfileEvent({ type: "startup-thread-list-prewarm:start" });
    ownerServices.prewarm(issueProviderDiscoveryPermit("startup"));
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
    // Closing/cancelling the preliminary storage window continues startup.
    if (!startupWindowCreated && !quitInProgress) return;
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
      // With nothing blocking, the quit manager allows the quit synchronously,
      // still inside this dispatch. Its app.quit() must wait for the dispatch
      // to return, or Electron overwrites that pass; see quit-retry.ts.
      beginQuitWithRelease("before-quit", () => {
        retryQuitAfterDispatch(() => app.quit());
      });
      return;
    }
    beginQuitInProgress("before-quit");
    if (!mainProcessShutdownComplete) {
      event?.preventDefault();
      quitAfterResourceShutdown("before-quit");
    }
  });

  app.on("will-quit", () => {
    childProcessDiagnostics.snapshot("will-quit");
    disposeMainProcessResourcesSync();
  });
}

bootstrapApp();
