import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import {
  assertUnreachableProfileBootDecision,
  bootstrapProfileExists,
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_AUTO_CREATE_ENV,
  PWRAGENT_PROFILE_ENV,
  resolveActiveProfileName,
  resolveProfileBootDecision,
  resolveProfileDir,
  type ProfileBootDecision,
} from "../../src/main/profile";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
} from "../../src/main/settings/desktop-config";
import {
  E2E_MEMORY_SECRET_STORAGE_ENV,
  SECRET_STORAGE_DISABLED_ENV,
} from "../../src/main/settings/desktop-secret-store";
import {
  E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV,
  E2E_SHUTDOWN_LAUNCH_ID_ENV,
  readE2eShutdownPhaseEvents,
} from "../../src/main/e2e-shutdown-diagnostics";
import {
  appendElectronShutdownSummary,
  assertElectronShutdownCircuitClosed,
  buildElectronShutdownSummary,
  classifyElectronClose,
  E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV,
  E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV,
  ElectronShutdownCircuitOpenError,
  executeElectronClose,
  finalizeElectronFixtureTeardown,
  memoizeElectronClose,
  observedOverallShutdownDuration,
  recordElectronShutdownCircuit,
  type ElectronCloseExecution,
  type ElectronShutdownSummary,
} from "./electron-shutdown-policy";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The built main-process entry every E2E launch runs. Exported so callers
 * that need to check for a build (the pre-flight canary) cannot drift from
 * the path the harness actually launches — a stale copy would silently turn
 * such a check into a no-op that reports success.
 */
export const DESKTOP_MAIN_ENTRY = path.resolve(
  fixtureDir,
  "../../out/main/index.js",
);
/**
 * Round-trip budget for asking the app to quit. This only has to reach the
 * main process and call `app.quit()`; a healthy app usually drops the
 * Playwright connection before the evaluate even resolves, so the wait that
 * matters is the close below, not this one.
 */
const ELECTRON_EVALUATE_QUIT_TIMEOUT_MS = 1_000;
/**
 * How long the app gets to shut down on its own before the process tree is
 * force-killed.
 *
 * Was 1s, which is shorter than the app's own shutdown: `app.quit()` runs
 * `disposeMainProcessResources`, whose before-quit phases are budgeted at 12s
 * globally in `main/index.ts` (app-server alone may take 7.5s). A one-second
 * window meant a loaded runner SIGKILLed apps that were draining correctly,
 * which is how profile processes and their open handles leak past teardown and
 * turn the subsequent `rm` into EBUSY on Windows.
 *
 * 6s does not cover that 12s worst case, and deliberately so: `close()` spends
 * the test's own 30s budget (see ELECTRON_TEARDOWN_TIMEOUT_MS), so the ceiling
 * here is what fits beside the other teardown steps, not what the main process
 * is theoretically allowed. It covers every shutdown observed in practice —
 * the E2E app runs with no real messaging or federation adapters — while
 * leaving the force-kill as a genuine last resort rather than a routine step.
 */
const ELECTRON_CLOSE_TIMEOUT_MS = 6_000;
/** After SIGKILL the exit is immediate; this only absorbs reaping latency. */
const ELECTRON_FORCE_EXIT_TIMEOUT_MS = 1_000;
/**
 * Hard ceiling on everything `close()` does.
 *
 * Specs call `close()` from their own `try`/`finally`, so it spends the
 * test's budget, not a fixture's: an unbounded stall shows up as the
 * test timing out at 30s, which replaces whatever the test actually
 * found with a timeout that names nothing. (Playwright's separate 30s
 * *worker* teardown timeout is what collects an Electron process no one
 * closed at all — see the catch in `launchElectronApp`.) The ceiling leaves
 * room for every step while still failing inside one test.
 *
 * Derivation, worst case: 1s evaluate + 6s graceful close + 1s force-kill +
 * 1s post-kill close + 5s leftover-profile wait + `rm`. Raised 15s → 20s when
 * the graceful close went 1s → 6s; both halves of that trade have to move
 * together or the ceiling starts cutting off the wait it is meant to contain.
 */
const ELECTRON_TEARDOWN_TIMEOUT_MS = 20_000;
/**
 * How long teardown waits for a leftover profile process to exit after
 * SIGTERM before giving up and letting the rm report the leak. Sits inside
 * ELECTRON_TEARDOWN_TIMEOUT_MS alongside the Electron close budget.
 */
const PROFILE_PROCESS_EXIT_TIMEOUT_MS = 5_000;
/** Liveness re-check interval while waiting out PROFILE_PROCESS_EXIT_TIMEOUT_MS. */
const PROFILE_PROCESS_EXIT_POLL_MS = 100;

/**
 * Root element of the first-run wizard overlay (`OnboardingWizard.tsx`).
 * It is also `role="dialog"` / `aria-label="First-run setup"`, but the
 * class is the element the component itself roots on and does not move
 * when the accessible name is reworded.
 */
const ONBOARDING_WIZARD_SELECTOR = ".onboarding-wizard-overlay";

/**
 * Upper bound on how long the wizard watcher stays armed. It only has to
 * outlive a slow boot; expiring means the wizard never appeared, so the
 * watcher goes quiet rather than failing.
 */
const ONBOARDING_WIZARD_WATCH_TIMEOUT_MS = 120_000;

/**
 * Env vars that redirect which PwrAgent root and profile the launched
 * app opens into. The harness inherits the full ambient environment
 * (below), so any of these left exported in the runner's shell — the
 * `pwragent-dev-profile` skill exports `PWRAGENT_PROFILE`, for one —
 * would silently point Electron at a different profile than the one the
 * harness seeds `onboarding.completed = true` into. The wizard then
 * fires over every spec. Strip them from the inherited copy BEFORE
 * per-spec `params.env` is applied, so a spec that deliberately sets one
 * (see `onboarding-wizard.spec.ts`) still gets it.
 */
const PROFILE_RESOLUTION_ENV_VARS = [
  PWRAGENT_HOME_ENV,
  PWRAGENT_PROFILE_ENV,
  PWRAGENT_PROFILE_AUTO_CREATE_ENV,
] as const;

type ElectronChildProcess = ReturnType<ElectronApplication["process"]>;
type CloseResult = "closed" | "rejected" | "timeout";
type RendererViewport = {
  innerHeight: number;
  innerWidth: number;
};
type NativeContentSize = {
  height: number;
  width: number;
};

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
  closeApplication: () => Promise<void>;
  close: () => Promise<void>;
};

type ElectronCloseOptions = {
  circuitEnabled?: boolean;
  circuitStateFile?: string;
  diagnosticsFile?: string;
  launchId?: string;
};

type LaunchElectronAppParams = {
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
   *
   * `default` is right for every caller today, but it is hardcoded here
   * while the onboarding seed resolves its profile from the launch env
   * (see `resolveSeedConfigPath`). A spec that also passed
   * `env.PWRAGENT_PROFILE` would have its hook and the seed writing to
   * two different profiles — resolve the name the same way if you ever
   * need that combination.
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
   * Secret-store presentation for the launched E2E app. The default reports
   * storage as unavailable while preventing native keychain access. `memory`
   * keeps storage writable without safeStorage for production-facing captures.
   */
  secretStorage?: "disabled" | "memory";
  /**
   * Whether to seed `onboarding.completed = true` into the config.toml
   * of the profile this launch will actually open — resolved from the
   * launch environment by `resolveSeedConfigPath`, not assumed to be
   * `default`. Defaults to `true` so the wizard doesn't intercept
   * clicks in most specs, and the seed is verified before launch (see
   * `assertOnboardingSeedTook`).
   *
   * Wizard specs pass `false` to let the wizard fire — combined
   * with NOT pre-creating any profile dir (skip the appearance
   * seed and any preLaunchHook profile-creation), this lets the
   * boot decision return `no-profile-configured`. Passing `false`
   * also disables every onboarding assertion, pre- and post-launch.
   */
  suppressOnboarding?: boolean;
  /**
   * Whether to wait for `globalThis.__PWRAGENT_REPLAY_DRIVER__` to
   * be installed before returning. Defaults to `true` for specs
   * that use thread replay. Wizard specs pass `false` (and omit
   * `fixturePath`) — the replay driver isn't needed pre-thread.
   */
  requiresReplayDriver?: boolean;
};

export async function launchElectronApp(
  params: LaunchElectronAppParams,
): Promise<LaunchResult> {
  const circuitEnabled =
    process.env[E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV] === "1";
  const circuitStateFile =
    process.env[E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV];
  assertElectronShutdownCircuitClosed({
    enabled: circuitEnabled,
    stateFile: circuitStateFile,
  });
  const diagnosticsFile =
    process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV];
  const launchId = randomUUID();
  const homeRoot =
    params.homeRoot ??
    await mkdtemp(path.join(os.tmpdir(), "pwragent-desktop-e2e-home-"));
  if (params.preLaunchHook) {
    await params.preLaunchHook(homeRoot);
  }
  // Build the launch environment BEFORE seeding config.toml. The seed
  // has to land in the profile directory the launched process will
  // actually open, and that is a function of the final environment
  // (`PWRAGENT_HOME`, `PWRAGENT_PROFILE`, `HOME`), not of `homeRoot`
  // alone — see `resolveSeedConfigPath` below.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of PROFILE_RESOLUTION_ENV_VARS) {
    delete env[key];
  }
  Object.assign(env, {
    HOME: homeRoot,
    NODE_ENV: "production",
    PWRAGENT_E2E: "1",
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
  env[E2E_SHUTDOWN_LAUNCH_ID_ENV] = launchId;
  if (diagnosticsFile) {
    env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV] = diagnosticsFile;
  } else {
    delete env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV];
  }
  // Every desktop E2E runs an unsigned development Electron binary. On
  // macOS, allowing that binary to reach safeStorage can open a native
  // "Keychain Not Found" modal that Playwright cannot observe or dismiss.
  // Apply the documented dev-only escape hatch after per-spec overrides so
  // no E2E can accidentally re-enable OS keychain UI. Profile instances
  // spawned during onboarding graduation inherit this environment through
  // openDesktopPwrAgentProfile(), covering both Electron processes.
  configureElectronE2eSecretStorageEnv(env, params.secretStorage);

  // Seed `[general.appearance]` AFTER the preLaunchHook so hooks that
  // write the whole config.toml don't clobber the appearance keys. The
  // patch path edits the file in place, preserving anything the hook
  // wrote, and creates the file if the hook didn't write one. Defaults
  // to dark so color-assertion tests don't pick up the runner's OS
  // theme through `theme: "system"`.
  const seedConfigPath = resolveSeedConfigPath(env);
  const suppressOnboarding = params.suppressOnboarding ?? true;
  if (suppressOnboarding) {
    applyDesktopSettingsPatch(seedConfigPath, {
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
    });
    // Prove the seed took before paying for an Electron boot. Both
    // checks reuse the production resolvers/parser, so they cannot
    // drift from what the launched process does with the same env.
    assertOnboardingSeedTook({ env, seedConfigPath });
  }

  const electronApp = await electron.launch({
    args: [
      DESKTOP_MAIN_ENTRY,
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
  // Everything from here on can throw on a sick guest — `firstWindow()` is
  // the observed one: it never returns when the window layer is wedged. The
  // launched process is ours the moment `electron.launch()` resolves, so a
  // failure past this point has to close it rather than leave an orphan for
  // the next job on a persistent runner to inherit. That now includes the
  // onboarding-wizard check inside `finishElectronLaunch`, which throws by
  // design.
  try {
    return await finishElectronLaunch({
      circuitEnabled,
      circuitStateFile,
      diagnosticsFile,
      electronApp,
      env,
      homeRoot,
      launchId,
      params,
      seedConfigPath,
      suppressOnboarding,
    });
  } catch (error) {
    await closeElectronApplication(electronApp, {
      circuitEnabled,
      circuitStateFile,
      diagnosticsFile,
      launchId,
    }).catch(() => undefined);
    await killSpawnedProfileProcessesUnder(homeRoot).catch(() => undefined);
    // Deliberately NOT removing `homeRoot`: on a launch failure the
    // seeded config.toml and whatever profile state exists are the
    // evidence, and the dir sits under the OS tmpdir either way.
    throw error;
  }
}

async function finishElectronLaunch(args: {
  circuitEnabled: boolean;
  circuitStateFile?: string;
  diagnosticsFile?: string;
  electronApp: ElectronApplication;
  env: Record<string, string>;
  homeRoot: string;
  launchId: string;
  params: LaunchElectronAppParams;
  seedConfigPath: string;
  suppressOnboarding: boolean;
}): Promise<LaunchResult> {
  const {
    circuitEnabled,
    circuitStateFile,
    diagnosticsFile,
    electronApp,
    env,
    homeRoot,
    launchId,
    params,
    seedConfigPath,
    suppressOnboarding,
  } = args;
  const closeApplicationOnce = memoizeElectronClose(async () =>
    await closeElectronApplication(electronApp, {
      circuitEnabled,
      circuitStateFile,
      diagnosticsFile,
      launchId,
    }),
  );
  const window = await electronApp.firstWindow();

  await waitForRendererReady({
    electronApp,
    env,
    requiresReplayDriver: params.requiresReplayDriver ?? true,
    seedConfigPath,
    suppressOnboarding,
    window,
  });

  if (params.windowSize) {
    await applyRendererViewport({
      electronApp,
      target: params.windowSize,
      window,
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
    closeApplication: async () => {
      const summary = await closeApplicationOnce();
      if (summary.circuit.tripped) {
        throw new ElectronShutdownCircuitOpenError();
      }
    },
    close: async () => {
      // Bound the whole teardown. `closeElectronApplication` is already
      // internally bounded, but the profile-process sweep and the `rm`
      // both touch the filesystem, and on a degraded shared runner either
      // can stall. Specs call this from their own `finally`, so an
      // unbounded stall burns the rest of the 30s test budget and reports
      // as the test timing out — which buries whatever the test actually
      // found. Warning and moving on keeps that result legible.
      //
      // ONLY the timeout is swallowed. A teardown that *fails* — an `rm`
      // hitting ENOTEMPTY because a spawned profile survived the sweep,
      // say — still rejects, because that is a real leak and a warning is
      // not enough to get it noticed.
      const running = teardown();
      if (await raceTeardownTimeout(running, ELECTRON_TEARDOWN_TIMEOUT_MS)) {
        // Still in flight, and now unobserved: keep a late rejection from
        // surfacing as an unhandled promise rejection mid-suite.
        running.catch(() => undefined);
        console.warn(
          `[pwragent-e2e-teardown] teardown exceeded ${ELECTRON_TEARDOWN_TIMEOUT_MS}ms`,
        );
      }
    },
  };

  async function teardown(): Promise<void> {
    await finalizeElectronFixtureTeardown({
      closeApplication: closeApplicationOnce,
      // The wizard's graduation path can spawn a detached child Electron
      // process for the operator's chosen profile. Sweep it only after the
      // Playwright-owned tree has completed its bounded graceful/forced close.
      cleanupProfileProcesses: async () => {
        await killSpawnedProfileProcessesUnder(homeRoot);
      },
      removeHomeRoot: async () => {
        await rm(homeRoot, { recursive: true, force: true });
      },
    });
  }
}

/**
 * Path of the `config.toml` the launched process will read, resolved
 * through the SAME production resolvers the app uses at boot rather than
 * a hand-built `<home>/.pwragent/profiles/default/` string.
 *
 * That distinction is the whole point. The app's root is
 * `PWRAGENT_HOME` when set and `<HOME>/.pwragent` otherwise, and its
 * profile is `PWRAGENT_PROFILE` → `profiles.toml::default_profile` →
 * `default`. A hardcoded path silently seeds the wrong directory the
 * moment a spec (or the ambient environment) moves either one, and the
 * only symptom is the first-run wizard taking over every surface.
 *
 * Following the resolvers means inheriting their production fallback:
 * with no `PWRAGENT_HOME` and no `HOME`, `resolvePwragentRoot` lands on
 * `os.homedir()` — the operator's REAL `~/.pwragent`, which the seed
 * would then rewrite. Right for the app, catastrophic for a test
 * fixture, so an absent `HOME` is refused rather than resolved.
 */
export function resolveSeedConfigPath(env: Record<string, string>): string {
  const homeDir = env.HOME;
  if (!homeDir) {
    throw new Error(
      [
        "PwrAgent E2E launch environment has no HOME.",
        "  The profile resolvers would fall back to os.homedir(), so the",
        "  onboarding seed would be written into the operator's real",
        "  ~/.pwragent profile. Pass `homeRoot`, or an explicit `env.HOME`,",
        "  rather than deleting HOME from the launch environment.",
      ].join("\n"),
    );
  }
  const resolverOptions = { argv: [], env, homeDir } as const;
  const profileName = resolveActiveProfileName(resolverOptions);
  return path.join(
    resolveProfileDir(profileName, resolverOptions),
    "config.toml",
  );
}

/**
 * Fail before paying for an Electron boot if the onboarding seed will
 * not actually suppress the wizard.
 *
 * There are exactly two ways the wizard fires, and this covers both:
 *
 *  1. The boot decision is not `open` — no profile dir where the app
 *     looks, or a named/registry profile that doesn't exist. The app
 *     drops into bootstrap mode and runs the wizard before committing to
 *     a profile (see `resolveProfileBootDecision`).
 *  2. The profile opens, but `onboarding.completed` doesn't read back as
 *     `true`. `App.tsx` auto-opens the wizard on the first snapshot
 *     where it is `false`. (A malformed `config.toml` does NOT quietly
 *     fall back to defaults here — `parseDesktopSettingsToml` is strict
 *     and throws — but that throw says "Invalid TOML" and nothing about
 *     onboarding, so it gets the same context attached below.)
 *
 * Both are checked with production code (`resolveProfileBootDecision`,
 * `readDesktopSettingsConfig`) so the harness cannot drift from the app.
 */
export function assertOnboardingSeedTook(params: {
  env: Record<string, string>;
  seedConfigPath: string;
}): void {
  const decision = resolveProfileBootDecision({
    argv: [],
    env: params.env,
    homeDir: params.env.HOME,
  });
  if (decision.kind !== "open") {
    throw new Error(
      [
        "PwrAgent E2E launch would open the first-run onboarding wizard:",
        `  boot decision:    ${describeBootDecision(decision)}`,
        "  The app boots into bootstrap mode and the wizard's modal scrim",
        "  intercepts every click, so no spec assertion can run.",
        describeProfileEnvironment(params),
      ].join("\n"),
    );
  }

  let completed: boolean | undefined;
  try {
    completed = readDesktopSettingsConfig(params.seedConfigPath)
      .onboarding?.completed;
  } catch (error) {
    throw new Error(
      [
        "PwrAgent E2E onboarding seed did not take: the seeded config.toml",
        `  is unreadable — ${error instanceof Error ? error.message : String(error)}`,
        describeProfileEnvironment(params),
      ].join("\n"),
      { cause: error },
    );
  }
  if (completed !== true) {
    throw new Error(
      [
        "PwrAgent E2E onboarding seed did not take:",
        `  onboarding.completed read back as ${JSON.stringify(completed)},`,
        "  expected true. The wizard auto-opens on the first settings",
        "  snapshot where it is not true, and its scrim intercepts every",
        "  click, so no spec assertion can run.",
        describeProfileEnvironment(params),
      ].join("\n"),
    );
  }
}

/**
 * Wait for the launched app to be driveable, failing fast and by name if
 * the first-run wizard takes the window instead.
 *
 * The wizard is worth catching by name because of how badly it presents
 * otherwise. Its overlay is a SIBLING of the app shell, so the sidebar
 * and its rows stay in the DOM: a spec either fails
 * `expect(row).toBeVisible()` with a bare "element(s) not found", or
 * watches a `.click()` retry against the scrim until the 30s Playwright
 * test timeout. Neither mentions onboarding.
 *
 * Two checks, in order of certainty:
 *
 *  - `bootstrapProfileExists` is the deterministic one.
 *    `initializeAppState("bootstrap")` materializes `<root>/.bootstrap/`
 *    during `app.whenReady()`, before any BrowserWindow exists, so by
 *    the time `firstWindow()` has resolved the directory is either there
 *    or the app is not in bootstrap mode. No polling, no race.
 *  - The overlay racer is a net for a wizard that opens some other way
 *    (`onboarding.completed` flipping to false under a live profile).
 *    It can lose — the replay driver installs from the `BackendRegistry`
 *    constructor, which runs in bootstrap mode too, so readiness can
 *    resolve before the renderer has mounted the overlay — which is why
 *    it is not the thing being relied on.
 */
export async function waitForRendererReady(params: {
  electronApp: ElectronApplication;
  env: Record<string, string>;
  requiresReplayDriver: boolean;
  seedConfigPath: string;
  suppressOnboarding: boolean;
  window: Page;
}): Promise<void> {
  if (
    params.suppressOnboarding
    && bootstrapProfileExists({
      env: params.env,
      homeDir: params.env.HOME,
    })
  ) {
    throw onboardingWizardError({
      ...params,
      detail: "the app booted into bootstrap mode (`.bootstrap/` exists)",
    });
  }

  const wizardWatch = params.suppressOnboarding
    ? watchForOnboardingWizard(params.window, params)
    : undefined;
  try {
    const ready = params.requiresReplayDriver
      ? expect
        .poll(async () =>
          await params.electronApp.evaluate(() =>
            Boolean(globalThis.__PWRAGENT_REPLAY_DRIVER__)
          )
        )
        .toBe(true)
      // Wizard specs: just wait for the renderer to mount. We don't
      // care about the replay driver — there's no thread to replay.
      : params.window.waitForLoadState("domcontentloaded");
    await Promise.race(wizardWatch ? [ready, wizardWatch.detected] : [ready]);
    if (wizardWatch) {
      await wizardWatch.assertAbsent();
    }
  } finally {
    wizardWatch?.disarm();
  }
}

function watchForOnboardingWizard(
  window: Page,
  context: { env: Record<string, string>; seedConfigPath: string },
): {
  detected: Promise<never>;
  assertAbsent: () => Promise<void>;
  disarm: () => void;
} {
  let disarmed = false;
  const overlay = window.locator(ONBOARDING_WIZARD_SELECTOR);
  const never = new Promise<never>(() => undefined);
  const detected = overlay
    .waitFor({
      state: "attached",
      timeout: ONBOARDING_WIZARD_WATCH_TIMEOUT_MS,
    })
    .then(
      () => (disarmed ? never : Promise.reject(onboardingWizardError(context))),
      // Timed out, or the page went away because the launch failed for
      // an unrelated reason. Either way this racer has nothing to say —
      // never settle, and let the real result win the race.
      () => never,
    );
  detected.catch(() => undefined);
  return {
    detected,
    assertAbsent: async () => {
      if (await overlay.count() > 0) {
        throw onboardingWizardError(context);
      }
    },
    disarm: () => {
      disarmed = true;
    },
  };
}

function onboardingWizardError(context: {
  detail?: string;
  env: Record<string, string>;
  seedConfigPath: string;
}): Error {
  return new Error(
    [
      "PwrAgent first-run onboarding wizard is showing, but this app was",
      "launched with suppressOnboarding: true. Its modal scrim intercepts",
      "every click, so no assertion in this spec can run.",
      ...(context.detail ? [`Detected because ${context.detail}.`] : []),
      "",
      `The \`onboarding.completed = true\` seed at ${context.seedConfigPath}`,
      "did not take effect for the profile this Electron process opened.",
      describeProfileEnvironment(context),
    ].join("\n"),
  );
}

function describeProfileEnvironment(context: {
  env: Record<string, string>;
  seedConfigPath: string;
}): string {
  const show = (key: string): string => context.env[key] ?? "(unset)";
  return [
    `  seeded config:    ${context.seedConfigPath}`,
    `  HOME:             ${show("HOME")}`,
    `  ${PWRAGENT_HOME_ENV}:    ${show(PWRAGENT_HOME_ENV)}`,
    `  ${PWRAGENT_PROFILE_ENV}: ${show(PWRAGENT_PROFILE_ENV)}`,
  ].join("\n");
}

function describeBootDecision(decision: ProfileBootDecision): string {
  switch (decision.kind) {
    case "open":
      return `open (${decision.profileName} via ${decision.source})`;
    case "missing-named-profile":
      return `missing-named-profile (${decision.requestedName} via ${decision.source})`;
    case "missing-default-profile":
      return `missing-default-profile (${decision.configuredName})`;
    case "no-profile-configured":
      return "no-profile-configured (fresh PWRAGENT_HOME, nothing to open)";
    default:
      // A new `ProfileBootDecision` variant should be a compile error
      // here, not a decision this harness silently describes by name.
      assertUnreachableProfileBootDecision(decision);
  }
}

async function applyRendererViewport(params: {
  electronApp: ElectronApplication;
  target: NativeContentSize;
  window: Page;
}): Promise<void> {
  const { electronApp, target: targetSize, window } = params;
  const windowId = await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("Expected an Electron BrowserWindow for replay E2E sizing");
      }

      window.setMinimumSize(0, 0);
      window.setContentSize(size.width, size.height);
      return window.id;
    },
    targetSize
  );

  let attempt = 0;
  let previousRequest: NativeContentSize | null = null;
  await expect
    .poll(async () => {
      const observed = await window.evaluate(() => ({
        innerHeight: globalThis.innerHeight,
        innerWidth: globalThis.innerWidth,
      }));
      if (
        observed.innerHeight === targetSize.height
        && observed.innerWidth === targetSize.width
      ) {
        return observed;
      }

      const request = nextRendererViewportRequest({
        attempt,
        observed,
        previousRequest,
        target: targetSize,
      });
      previousRequest = request;
      attempt += 1;

      await electronApp.evaluate(
        ({ BrowserWindow }, resize) => {
          const window = BrowserWindow.fromId(resize.windowId);
          if (!window || window.isDestroyed()) {
            throw new Error(
              "Expected the replay E2E BrowserWindow to remain live while resizing",
            );
          }
          window.setContentSize(resize.request.width, resize.request.height);
        },
        { request, windowId },
      );

      return await window.evaluate(() => ({
        innerHeight: globalThis.innerHeight,
        innerWidth: globalThis.innerWidth,
      }));
    })
    .toMatchObject({
      innerHeight: targetSize.height,
      innerWidth: targetSize.width,
    });
}

/**
 * Keep exact renderer layout contracts while compensating the native content
 * request that produces them. Under platform scaling, Electron can turn a
 * 1440x900 setContentSize request into a 1439x901 Chromium viewport. Feeding a
 * small observed error back into the next native request reaches the exact
 * renderer dimensions without weakening layout assertions. Far-from-target
 * observations get only a 1px height nudge so a stale/coalesced native resize
 * cannot cause an unbounded correction.
 */
export function nextRendererViewportRequest(params: {
  attempt: number;
  observed: RendererViewport;
  previousRequest: NativeContentSize | null;
  target: NativeContentSize;
}): NativeContentSize {
  const widthError = params.target.width - params.observed.innerWidth;
  const heightError = params.target.height - params.observed.innerHeight;
  const nearTarget = (error: number): boolean => Math.abs(error) <= 2;
  const request = {
    width:
      params.target.width
      + (nearTarget(widthError) ? widthError : 0),
    height:
      params.target.height
      + (nearTarget(heightError) ? heightError : params.attempt % 2),
  };

  if (
    params.previousRequest !== null
    && request.width === params.previousRequest.width
    && request.height === params.previousRequest.height
  ) {
    request.height += params.attempt % 2 === 0 ? 1 : -1;
  }
  return request;
}

/**
 * The `.thread-row` card that carries the named open-thread button.
 *
 * The open-thread control is an EMPTY overlay button whose SIBLINGS
 * (title line, status indicator, chip flow) carry the row's visible
 * content, so status/chip assertions must scope to the card, not the
 * button. Anchor on `.thread-row` + `has:` rather than a bare
 * `.locator("..")` hop: the hop encodes "the button's direct parent is
 * the card", which the next DOM restructure silently breaks — and a
 * `toHaveCount(0)` against a mis-resolved parent passes vacuously
 * forever. (`federation-remote-window.spec.ts` established the idiom.)
 */
export function threadRowCard(
  scope: Page | Locator,
  name: string | RegExp,
): Locator {
  // The `has:` locator is evaluated RELATIVE to each `.thread-row`
  // candidate, so it must carry no scoping prefix of its own: a
  // scope-rooted inner locator (`scope.getByRole(...)`) would look for
  // the scope element INSIDE each row and match nothing, and every
  // assertion against the card would time out (or a `toHaveCount(0)`
  // would pass vacuously). Root it at the page, whose selector chain
  // is just the role engine.
  const page =
    typeof (scope as Locator).page === "function"
      ? (scope as Locator).page()
      : (scope as Page);
  return scope
    .locator(".thread-row")
    .filter({ has: page.getByRole("button", { name }) });
}

/**
 * Right-click a thread row to open its context menu.
 *
 * Do NOT right-click the open-thread button for this: on a PINNED row
 * the in-title unpin button can sit exactly at the open button's
 * center-x — it depends on title width, AND on hover state: the
 * `--pinned` heading reserve re-truncates a long title the moment the
 * approach hover lands, shifting the pin left of where rest-state
 * geometry puts it. Since the pin is a SIBLING of the open button,
 * Playwright's hit-target check reports "subtree intercepts pointer
 * events" and times out — while the real app is fine, because
 * contextmenu bubbles from any row element to the shell's
 * onContextMenu. Clicking the CARD instead always passes the
 * hit-target check (everything at the point is a card descendant).
 * The fixed position keeps the point in the title band, above the chip
 * flow, so a PR chip's own context menu can never swallow it.
 */
export async function rightClickThreadRow(
  scope: Page | Locator,
  name: string | RegExp,
  options?: { exact?: boolean },
): Promise<void> {
  const page =
    typeof (scope as Locator).page === "function"
      ? (scope as Locator).page()
      : (scope as Page);
  const card = scope
    .locator(".thread-row")
    .filter({ has: page.getByRole("button", { name, exact: options?.exact }) });
  await card.click({
    button: "right",
    position: { x: 40, y: 10 },
  });
}

export function configureElectronE2eSecretStorageEnv(
  env: Record<string, string>,
  mode: "disabled" | "memory" = "disabled",
): void {
  env[SECRET_STORAGE_DISABLED_ENV] = "1";
  if (mode === "memory") {
    env[E2E_MEMORY_SECRET_STORAGE_ENV] = "1";
  } else {
    // Do not inherit a screenshot process's memory mode into normal E2Es.
    delete env[E2E_MEMORY_SECRET_STORAGE_ENV];
  }
}

/**
 * Close a Playwright-owned Electron app without letting a degraded persistent
 * runner turn one teardown into a 15-second tax. The normal path still asks
 * Electron to exit first. If the main event loop or Playwright connection is
 * wedged, the fallback snapshots and kills the complete process tree so helper
 * processes cannot accumulate across jobs in the shared macOS VM.
 */
export async function closeElectronApplication(
  electronApp: ElectronApplication,
  options: ElectronCloseOptions = {},
): Promise<ElectronShutdownSummary> {
  let child: ElectronChildProcess | undefined;
  try {
    child = electronApp.process();
  } catch {
    // A graduation flow can quit the Playwright-owned bootstrap process
    // before the test reaches finally. Once Playwright has disposed its
    // Electron connection, process() throws while resolving the remote
    // object; there is no remaining process tree for this helper to close.
    return recordElectronCloseSummary(
      alreadyExitedCloseExecution(),
      options,
    );
  }
  if (!child) {
    // Depending on the Playwright client version and disposal timing,
    // `process()` can return undefined rather than throw after the channel is
    // released. That has the same no-process-left-to-clean-up meaning.
    return recordElectronCloseSummary(
      alreadyExitedCloseExecution(),
      options,
    );
  }
  const execution = await executeElectronClose({
    now: performance.now.bind(performance),
    requestQuit: async () => {
      await withTimeout(
        electronApp.evaluate(({ app }) => {
          app.quit();
        }),
        ELECTRON_EVALUATE_QUIT_TIMEOUT_MS,
        "Electron quit evaluation timed out",
      );
    },
    startClose: () => {
      const closePromise = electronApp.close();
      closePromise.catch(() => undefined);
      return closePromise;
    },
    waitForGracefulClose: async (closePromise) => await waitForClose(
      closePromise,
      ELECTRON_CLOSE_TIMEOUT_MS,
    ),
    hasExited: () => hasExited(child),
    forceKillTree: async () => {
      await killProcessTree(child);
    },
    waitForForcedExit: async () => await waitForProcessExit(
      child,
      ELECTRON_FORCE_EXIT_TIMEOUT_MS,
    ),
    waitForPostKillClose: async (closePromise) => {
      await waitForClose(closePromise, ELECTRON_FORCE_EXIT_TIMEOUT_MS);
    },
  });
  return recordElectronCloseSummary(execution, options);
}

function alreadyExitedCloseExecution(): ElectronCloseExecution {
  return {
    elapsedMs: 0,
    forceExitOutcome: "not-needed",
    forced: false,
    gracefulCloseOutcome: "closed",
    quitRequestOutcome: "completed",
  };
}

function recordElectronCloseSummary(
  execution: ElectronCloseExecution,
  options: ElectronCloseOptions,
): ElectronShutdownSummary {
  const diagnosticsFile = options.diagnosticsFile
    ?? process.env[E2E_SHUTDOWN_DIAGNOSTICS_FILE_ENV];
  const launchId = options.launchId ?? "untracked";
  const events = readE2eShutdownPhaseEvents(diagnosticsFile, launchId);
  const classification = classifyElectronClose({
    ...execution,
    shutdownElapsedMs: observedOverallShutdownDuration(events),
  });
  const circuit = recordElectronShutdownCircuit({
    classification,
    enabled: options.circuitEnabled
      ?? process.env[E2E_SHUTDOWN_CIRCUIT_BREAKER_ENV] === "1",
    stateFile: options.circuitStateFile
      ?? process.env[E2E_SHUTDOWN_CIRCUIT_STATE_FILE_ENV],
  });
  const summary = buildElectronShutdownSummary({
    circuit,
    classification,
    events,
    execution,
    launchId,
  });
  appendElectronShutdownSummary(diagnosticsFile, summary);
  console.log(`[pwragent-e2e-shutdown] ${JSON.stringify(summary)}`);
  return summary;
}

/**
 * Resolve `true` when `running` is still pending after `timeoutMs`.
 *
 * Deliberately not `withTimeout`: that collapses "timed out" and "the
 * work rejected" into one rejection, and teardown needs to tell them
 * apart — one is a degraded runner to warn about, the other is a real
 * cleanup failure that must fail the test. A rejection before the
 * deadline propagates to the caller here.
 */
export async function raceTeardownTimeout(
  running: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<boolean>([
      running.then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  promise.catch(() => undefined);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function waitForClose(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<CloseResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<CloseResult>([
      promise.then(
        () => "closed",
        () => "rejected",
      ),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function hasExited(child: ElectronChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessExit(
  child: ElectronChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) {
    return true;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<boolean>([
      new Promise<true>((resolve) => {
        child.once("exit", () => resolve(true));
      }),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function killProcessTree(child: ElectronChildProcess): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  const pid = child.pid;
  if (pid === undefined) {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { timeout: 5_000 },
        (error) => {
          if (error && !child.killed) {
            child.kill("SIGKILL");
          }
          resolve();
        },
      );
    });
    return;
  }

  // Snapshot descendants before the root exits and they reparent to launchd.
  const descendants = await listDescendantPids(pid);
  if (!child.killed) {
    child.kill("SIGKILL");
  }
  for (const descendant of descendants) {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {
      // The descendant already exited between the ps snapshot and this kill.
    }
  }
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid="],
      { timeout: 5_000 },
      (_error, output) => resolve(output ?? ""),
    );
  });
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid);
    if (children) {
      children.push(childPid);
    } else {
      childrenByParent.set(parentPid, [childPid]);
    }
  }

  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (parentPid === undefined) {
      break;
    }
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      descendants.push(childPid);
      queue.push(childPid);
    }
  }
  return descendants;
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
  // the rm is about to remove — waiting only for the marker pid would declare
  // victory while its children still had the directory open.
  //
  // They are watched, not signalled: on POSIX the main process takes its
  // helpers down as it exits, so this is a wait, not a second kill, and the
  // force-kill stays `closeElectronApplication`'s alone. `listDescendantPids`
  // shells out to `ps`, so on Windows it yields nothing and the watch set
  // stays the marker pids — no worse than before, but not the fix there.
  const watched = new Set(livePids);
  for (const pid of livePids) {
    for (const descendant of await listDescendantPids(pid)) {
      watched.add(descendant);
    }
  }

  for (const pid of livePids) {
    try {
      // NB: on Windows there is no SIGTERM. Node maps it to TerminateProcess,
      // so this is an abrupt kill with no chance to flush — the wait below is
      // then for the OS to finish tearing the process down and release its
      // handles, not for a graceful drain. Nothing here can make Windows
      // graceful; a real quit would need an IPC path rather than a signal.
      process.kill(pid, "SIGTERM");
    } catch {
      // Exited between the liveness check and the signal.
    }
  }

  // Wait for the processes to actually exit rather than sleeping a fixed
  // interval and hoping. These children are mid-write to `<homeRoot>`, and the
  // rm below races their open handles — ENOTEMPTY on POSIX, EBUSY/EPERM on
  // Windows.
  //
  // The budget is generous on purpose. This path only runs when a runtime
  // marker OUTLIVED its process's own cleanup (`stop()` in `main/profile.ts`
  // removes the marker on a clean exit), so reaching here already means
  // something abnormal — exactly when patience beats a deadline. In the
  // ordinary teardown there are no live pids and this returns immediately,
  // which is faster than the fixed 500ms sleep it replaces.
  const deadline = Date.now() + PROFILE_PROCESS_EXIT_TIMEOUT_MS;
  let remaining = [...watched].filter(isPidAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, PROFILE_PROCESS_EXIT_POLL_MS),
    );
    remaining = remaining.filter(isPidAlive);
  }

  if (remaining.length > 0) {
    // Deliberately no SIGKILL here. Process-tree force-kill is the last-resort
    // hammer that `closeElectronApplication` owns; a survivor at this point is
    // a real leak, and letting the rm below fail reports it instead of hiding
    // it behind a kill.
    console.warn(
      `[pwragent-e2e-teardown] profile processes still alive ${PROFILE_PROCESS_EXIT_TIMEOUT_MS}ms after SIGTERM: ${remaining.join(", ")}`,
    );
  }
}

/**
 * Whether `pid` is still running.
 *
 * `EPERM` means the process exists but is not ours to signal, so it counts as
 * alive — treating it as gone would race the rm against a live writer, the
 * exact failure this check exists to prevent.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
