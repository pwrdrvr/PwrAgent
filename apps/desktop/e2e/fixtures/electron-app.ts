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
  respondToPendingRequest: (params: {
    executionMode?: ThreadExecutionMode;
    requestId: string;
  }) => Promise<void>;
  close: () => Promise<void>;
};

export async function launchElectronApp(params: {
  fixturePath: string;
}): Promise<LaunchResult> {
  const electronApp = await electron.launch({
    args: [path.resolve(fixtureDir, "../../out/main/index.js")],
    cwd: path.resolve(fixtureDir, "../.."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PWRAGNT_REPLAY_FIXTURE_PATH: params.fixturePath,
    },
  });
  const window = await electronApp.firstWindow();

  await expect
    .poll(async () =>
      await electronApp.evaluate(() =>
        Boolean(globalThis.__PWRAGNT_REPLAY_DRIVER__)
      )
    )
    .toBe(true);

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
    respondToPendingRequest: async (requestParams) => {
      await electronApp.evaluate(async (_electron, value) => {
        await globalThis.__PWRAGNT_REPLAY_DRIVER__?.respondToPendingRequest(value);
      }, requestParams);
    },
    close: async () => {
      await electronApp.close();
    },
  };
}
