import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadExecutionMode } from "@pwragnt/shared";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

type LaunchResult = {
  electronApp: ElectronApplication;
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
  respondToPendingRequest: (params: {
    executionMode?: ThreadExecutionMode;
    requestId: string;
  }) => Promise<void>;
  close: () => Promise<void>;
};

export async function launchElectronApp(params: {
  fixturePath: string;
  env?: Record<string, string | undefined>;
  windowSize?: {
    width: number;
    height: number;
  };
}): Promise<LaunchResult> {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "pwragnt-desktop-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    NODE_ENV: "production",
    PWRAGNT_REPLAY_FIXTURE_PATH: params.fixturePath,
    PWRAGNT_STATE_ROOT: stateRoot,
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
        Boolean(globalThis.__PWRAGNT_REPLAY_DRIVER__)
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
    window,
    advance: async (advanceParams) => {
      await electronApp.evaluate(async (_electron, value) => {
        await globalThis.__PWRAGNT_REPLAY_DRIVER__?.advance(value);
      }, advanceParams);
    },
    getPendingRequest: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGNT_REPLAY_DRIVER__?.getPendingRequest(value),
        requestParams
      ),
    getLastStartTurn: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGNT_REPLAY_DRIVER__?.getLastStartTurn(value),
        requestParams
      ),
    getLastStartReview: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGNT_REPLAY_DRIVER__?.getLastStartReview(value),
        requestParams
      ),
    getLastRenameThread: async (requestParams) =>
      await electronApp.evaluate(
        (_electron, value) =>
          globalThis.__PWRAGNT_REPLAY_DRIVER__?.getLastRenameThread(value),
        requestParams
      ),
    respondToPendingRequest: async (requestParams) => {
      await electronApp.evaluate(async (_electron, value) => {
        await globalThis.__PWRAGNT_REPLAY_DRIVER__?.respondToPendingRequest(value);
      }, requestParams);
    },
    close: async () => {
      await electronApp.close();
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
}
