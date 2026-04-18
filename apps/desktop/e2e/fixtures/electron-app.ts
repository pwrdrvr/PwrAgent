import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import electronBinary from "electron";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));

type LaunchResult = {
  electronApp: ElectronApplication;
  window: Page;
  advance: (params?: {
    stepId?: string;
    override?: Record<string, unknown>;
  }) => Promise<void>;
  getPendingRequest: () => Promise<unknown>;
  respondToPendingRequest: (requestId: string) => Promise<void>;
  close: () => Promise<void>;
};

export async function launchElectronApp(params: {
  fixturePath: string;
}): Promise<LaunchResult> {
  const electronApp = await electron.launch({
    executablePath: electronBinary,
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
    getPendingRequest: async () =>
      await electronApp.evaluate(() =>
        globalThis.__PWRAGNT_REPLAY_DRIVER__?.getPendingRequest()
      ),
    respondToPendingRequest: async (requestId: string) => {
      await electronApp.evaluate(async (_electron, value) => {
        await globalThis.__PWRAGNT_REPLAY_DRIVER__?.respondToPendingRequest(value);
      }, requestId);
    },
    close: async () => {
      await electronApp.close();
    },
  };
}
