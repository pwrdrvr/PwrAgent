import { mkdtemp, rm } from "node:fs/promises";
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
  fixturePath: string;
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
      // intercept clicks in every spec. Tests that explicitly want to
      // exercise the wizard can override this in their preLaunchHook.
      onboarding: { completed: true },
    },
  );
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
    PWRAGENT_REPLAY_FIXTURE_PATH: params.fixturePath,
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

  await expect
    .poll(async () =>
      await electronApp.evaluate(() =>
        Boolean(globalThis.__PWRAGENT_REPLAY_DRIVER__)
      )
    )
    .toBe(true);

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
      await rm(homeRoot, { recursive: true, force: true });
    },
  };
}
