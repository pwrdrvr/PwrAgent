import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { applyDesktopSettingsPatch } from "../../src/main/settings/desktop-config";
import { SECRET_STORAGE_DISABLED_ENV } from "../../src/main/settings/desktop-secret-store";
import {
  isPidAlive,
  listDescendantPids,
  waitForPidsToExit,
} from "./process-exit";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * How long teardown waits for a leftover profile process to exit after
 * SIGTERM before giving up and letting the rm report the leak.
 */
const PROFILE_PROCESS_EXIT_TIMEOUT_MS = 5_000;
/** Liveness re-check interval while waiting out PROFILE_PROCESS_EXIT_TIMEOUT_MS. */
const PROFILE_PROCESS_EXIT_POLL_MS = 100;

type LaunchResult = {
  electronApp: ElectronApplication;
  homeRoot: string;
  window: Page;
  advance: (params?: {
    executionMode?: ThreadExecutionMode;
    stepId?: string;
    override?: Record<string, unknown>;
  }) => Promise<void>;
  getPendingRequest: (params?: {
    executionMode?: ThreadExecutionMode;
  }) => Promise<unknown>;
  getLastStartTurn: (params?: {
    executionMode?: ThreadExecutionMode;
  }) => Promise<unknown>;
  getLastStartReview: (params?: {
    executionMode?: ThreadExecutionMode;
  }) => Promise<unknown>;
  getLastRenameThread: (params?: {
    executionMode?: ThreadExecutionMode;
  }) => Promise<unknown>;
  getInterruptTurnCalls: (params?: {
    executionMode?: ThreadExecutionMode;
  }) => Promise<unknown>;
  respondToPendingRequest: (params: {
    executionMode?: ThreadExecutionMode;
    requestId: string;
  }) => Promise<void>;
  close: () => Promise<void>;
};

export async function launchElectronApp(params: {
  /** Path to a replay-driver fixture JSON. Required for tests that
   *  exercise thread replay (most specs); omit it for tests that
   *  only need wizard / pre-thread UI (set `requiresReplayDriver:
   *  false` to skip the driver install wait too). */
  fixturePath?: string;
  env?: Record<string, string | undefined>;
  homeRoot?: string;
  windowSize?: {
    width: number;
    height: number;
  };
  /**
   * Runs after the tmp `homeRoot` is created but before Electron
   * launches. Use this to seed
   * `<homeRoot>/.pwragent/profiles/default/config.toml` or any other
   * on-disk state the app reads at startup. Everything underneath
   * `<homeRoot>/` is cleaned up on `close()`.
   */
  preLaunchHook?: (homeRoot: string) => void | Promise<void>;
  /**
   * Theme + density to seed into the per-test profile's `config.toml`
   * `[general.appearance]` block. Defaults to `{ theme: "dark" }` so
   * tests that assert specific colors are deterministic regardless of
   * the CI runner's `prefers-color-scheme` (which would otherwise let
   * `theme: "system"` resolve to light on most Linux runners and break
   * dark-theme color assertions). Pass `{ theme: "light" }` or
   * `{ theme: "system" }` from tests that need to validate other
   * appearance modes.
   */
  appearance?: {
    theme?: DesktopAppearanceTheme;
    density?: DesktopAppearanceDensity;
  };
  /**
   * Seed `ui.context_rail_pinned` into the per-test profile's
   * `config.toml` before launch. The rail defaults to pinned-open (for
   * discoverability), which narrows the transcript content area; specs
   * that assert on the full-width transcript layout pass `false` to run
   * against an unpinned (hover-reveal) rail. Left unset, the app default
   * (pinned-open) applies. Only seeded when `suppressOnboarding` is true
   * (every replay-backed spec).
   */
  contextRailPinned?: boolean;
  /**
   * Whether to seed `onboarding.completed = true` into the
   * `default` profile's config.toml before launch. Defaults to
   * `true` so the wizard doesn't intercept clicks in most specs.
   * Wizard specs pass `false` to let the wizard fire — combined
   * with NOT pre-creating any profile dir (skip the appearance
   * seed and any preLaunchHook profile-creation), this lets the
   * boot decision return `no-profile-configured`.
   */
  suppressOnboarding?: boolean;
  /**
   * Whether to wait for `globalThis.__PWRAGENT_REPLAY_DRIVER__` to
   * be installed before returning. Defaults to `true` for specs
   * that use thread replay. Wizard specs pass `false` (and omit
   * `fixturePath`) — the replay driver isn't needed pre-thread.
   */
  requiresReplayDriver?: boolean;
}): Promise<LaunchResult> {
  const homeRoot =
    params.homeRoot ??
    await mkdtemp(path.join(os.tmpdir(), "pwragent-desktop-e2e-home-"));
  if (params.preLaunchHook) {
    await params.preLaunchHook(homeRoot);
  }
  // Seed `[general.appearance]` AFTER the preLaunchHook so hooks that
  // write the whole config.toml don't clobber the appearance keys. The
  // patch path edits the file in place, preserving anything the hook
  // wrote, and creates the file if the hook didn't write one. Defaults
  // to dark so color-assertion tests don't pick up the runner's OS
  // theme through `theme: "system"`.
  //
  // The seed target follows whatever HOME the launched Electron process
  // will actually use: tests may pass `env.HOME = <their own tmp>` to
  // override the helper's `homeRoot`, in which case the appearance has
  // to land in THEIR tmp dir, not the helper's. If both are unset, fall
  // back to the helper's `homeRoot`.
  const seedHomeRoot = params.env?.HOME ?? homeRoot;
  const suppressOnboarding = params.suppressOnboarding ?? true;
  if (suppressOnboarding) {
    applyDesktopSettingsPatch(
      path.join(seedHomeRoot, ".pwragent/profiles/default/config.toml"),
      {
        general: {
          confirmQuitWithInProgressThreads: false,
          appearance: {
            theme: params.appearance?.theme ?? "dark",
            density: params.appearance?.density ?? "mission-control",
          },
        },
        // Suppress the first-run onboarding wizard for every replay-backed
        // test. The wizard's modal scrim auto-fires on profiles with
        // `onboarding.completed === false` (see App.tsx), and the per-test
        // home root is always fresh, so without this seed the wizard would
        // intercept clicks in every spec. Wizard specs explicitly pass
        // `suppressOnboarding: false` to let the wizard fire.
        onboarding: { completed: true },
        ...(params.contextRailPinned !== undefined
          ? { ui: { contextRailPinned: params.contextRailPinned } }
          : {}),
      },
    );
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: homeRoot,
    NODE_ENV: "production",
    PWRAGENT_CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS: "15000",
    ...(params.fixturePath
      ? { PWRAGENT_REPLAY_FIXTURE_PATH: params.fixturePath }
      : {}),
  });
  delete env.ELECTRON_RENDERER_URL;
  for (const [key, value] of Object.entries(params.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  // Every desktop E2E runs an unsigned development Electron binary. On
  // macOS, allowing that binary to reach safeStorage can open a native
  // "Keychain Not Found" modal that Playwright cannot observe or dismiss.
  // Apply the documented dev-only escape hatch after per-spec overrides so
  // no E2E can accidentally re-enable OS keychain UI. Profile instances
  // spawned during onboarding graduation inherit this environment through
  // openDesktopPwrAgentProfile(), covering both Electron processes.
  env[SECRET_STORAGE_DISABLED_ENV] = "1";

  const electronApp = await electron.launch({
    args: [
      path.resolve(fixtureDir, "../../out/main/index.js"),
      // Hardware video codecs leak kernel objects inside a
      // Virtualization.framework guest (the Tart macOS VMs): every
      // VideoToolbox init creates an
      // AppleVideoToolboxParavirtualizationUserClient that the vmapple
      // paravirt driver never frees, even at process death. Chromium
      // initializes them once per app launch, so a suite run leaks
      // roughly one per spec. Past ~1.1k live clients the driver's
      // IOService::newUserClient wedges, every new Electron helper
      // hangs at birth in-kernel, and app teardown blocks ~6s per spec
      // until the guest is rebooted. --disable-gpu and
      // disableHardwareAcceleration() do NOT cover media codecs, so
      // the codec switches have to be explicit. Harmless elsewhere:
      // no spec plays video.
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
    ],
    cwd: path.resolve(fixtureDir, "../.."),
    env,
  });
  const window = await electronApp.firstWindow();

  const requiresReplayDriver = params.requiresReplayDriver ?? true;
  if (requiresReplayDriver) {
    await expect
      .poll(async () =>
        await electronApp.evaluate(() =>
          Boolean(globalThis.__PWRAGENT_REPLAY_DRIVER__)
        )
      )
      .toBe(true);
  } else {
    // Wizard specs: just wait for the renderer to mount. We don't
    // care about the replay driver — there's no thread to replay.
    await window.waitForLoadState("domcontentloaded");
  }

  if (params.windowSize) {
    await electronApp.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) {
          throw new Error("Expected an Electron BrowserWindow for replay E2E sizing");
        }

        window.setMinimumSize(0, 0);
        window.setContentSize(size.width, size.height);
      },
      params.windowSize
    );

    await expect
      .poll(async () =>
        await window.evaluate(() => ({
          innerHeight: globalThis.innerHeight,
          innerWidth: globalThis.innerWidth,
        }))
      )
      .toMatchObject({
        innerHeight: params.windowSize.height,
        innerWidth: params.windowSize.width,
      });
  }

  return {
    electronApp,
    homeRoot,
    window,
    advance: async (advanceParams) => {
      await electronApp.evaluate(async (_electron, value) => {
        await globalThis.__PWRAGENT_REPLAY_DRIVER__?.advance(value);
      }, advanceParams);
    },
    getPendingRequest: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGENT_REPLAY_DRIVER__?.getPendingRequest(value),
        requestParams
      ),
    getLastStartTurn: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGENT_REPLAY_DRIVER__?.getLastStartTurn(value),
        requestParams
      ),
    getLastStartReview: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGENT_REPLAY_DRIVER__?.getLastStartReview(value),
        requestParams
      ),
    getLastRenameThread: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGENT_REPLAY_DRIVER__?.getLastRenameThread(value),
        requestParams
      ),
    getInterruptTurnCalls: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGENT_REPLAY_DRIVER__?.getInterruptTurnCalls(value),
        requestParams
      ),
    respondToPendingRequest: async (requestParams) => {
      await electronApp.evaluate(async (_electron, value) => {
        await globalThis.__PWRAGENT_REPLAY_DRIVER__?.respondToPendingRequest(value);
      }, requestParams);
    },
    close: async () => {
      await electronApp.close();
      // The wizard's graduation path can spawn a detached child
      // Electron process for the operator's chosen profile (see
      // `openPwrAgentProfile` in `ipc/profiles.ts`). That child
      // outlives the test's bootstrap Electron and keeps writing
      // to `<homeRoot>/.pwragent/profiles/<name>/` (state.db
      // heartbeats, Codex plugin clones, etc.). If we rm the
      // tmpdir while the child is mid-write, rm races and ENOTEMPTYs.
      //
      // Find any live PwrAgent instances under this tmpdir via
      // their runtime-instance heartbeat markers, kill them, then
      // proceed with cleanup. Each marker file is a JSON blob
      // containing the process's PID; the marker dir layout matches
      // `startProfileRuntimeHeartbeat` in `main/profile.ts`.
      await killSpawnedProfileProcessesUnder(homeRoot);
      await rm(homeRoot, { recursive: true, force: true });
    },
  };
}

async function killSpawnedProfileProcessesUnder(homeRoot: string): Promise<void> {
  const profilesDir = path.join(homeRoot, ".pwragent", "profiles");
  let profileEntries: string[];
  try {
    profileEntries = await readdir(profilesDir);
  } catch {
    return; // No profiles ever created; nothing to clean up.
  }
  const pids = new Set<number>();
  for (const profile of profileEntries) {
    const markerDir = path.join(
      profilesDir,
      profile,
      "state",
      "runtime-instances",
    );
    let markers: string[];
    try {
      markers = await readdir(markerDir);
    } catch {
      continue;
    }
    for (const marker of markers) {
      try {
        const raw = await readFile(path.join(markerDir, marker), "utf8");
        const parsed = JSON.parse(raw) as { processId?: number };
        if (typeof parsed.processId === "number" && parsed.processId > 0) {
          pids.add(parsed.processId);
        }
      } catch {
        // Markers can be mid-write (atomic rename in progress) or
        // already removed; skip.
      }
    }
  }
  // Only signal what is actually still running. A marker can outlive its
  // process (crash, force-kill, an interrupted run), and signalling a dead pid
  // would otherwise make us wait on nothing.
  const livePids = [...pids].filter(isPidAlive);
  if (livePids.length === 0) {
    return;
  }

  // Snapshot the helper processes before signalling, while the parent is still
  // around to be walked. `HOME` is `homeRoot` for these runs, so an Electron
  // instance's renderer and GPU helpers hold cache handles under the very tree
  // the rm is about to remove. They are watched, not signalled: on POSIX the
  // main process takes its helpers down as it exits. `listDescendantPids`
  // shells out to `ps`, so on Windows it yields nothing and the watch set stays
  // the marker pids.
  const watched = new Set(livePids);
  for (const pid of livePids) {
    for (const descendant of await listDescendantPids(pid)) {
      watched.add(descendant);
    }
  }

  for (const pid of livePids) {
    try {
      // Node maps SIGTERM to TerminateProcess on Windows, so the wait below is
      // for the OS to release handles there rather than for a graceful drain.
      process.kill(pid, "SIGTERM");
    } catch {
      // Exited between the liveness check and the signal.
    }
  }

  // Wait for the processes to actually exit rather than sleeping a fixed
  // interval and hoping. These children are mid-write to `<homeRoot>`, and the
  // rm below races their open handles — ENOTEMPTY on POSIX, EBUSY/EPERM on
  // Windows. This path only runs when a runtime marker outlived its process's
  // own cleanup, so a generous ceiling has no cost in the ordinary path.
  const remaining = await waitForPidsToExit(
    watched,
    PROFILE_PROCESS_EXIT_TIMEOUT_MS,
    PROFILE_PROCESS_EXIT_POLL_MS,
  );
  if (remaining.length > 0) {
    // Deliberately no SIGKILL here. A survivor is a real leak, and letting the
    // rm below fail reports it instead of hiding it behind a kill.
    console.warn(
      `[pwragent-e2e-teardown] profile processes still alive ${PROFILE_PROCESS_EXIT_TIMEOUT_MS}ms after SIGTERM: ${remaining.join(", ")}`,
    );
  }
}
