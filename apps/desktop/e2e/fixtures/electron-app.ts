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

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

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

  const electronApp = await electron.launch({
    args: [path.resolve(fixtureDir, "../../out/main/index.js")],
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
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already dead — that's fine.
    }
  }
  // Give the killed processes a moment to release their open file
  // handles before we attempt the rm. SIGTERM is async; without
  // this sleep we still race against the OS.
  if (pids.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
