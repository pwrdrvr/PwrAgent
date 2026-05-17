import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "../fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  specDir,
  "../fixtures/smoke/replay.fixture.json",
);

test("fresh profile opens onboarding once", async () => {
  const firstApp = await launchElectronApp({
    fixturePath,
    onboardingCompleted: false,
  });
  const homeRoot = firstApp.homeRoot;

  await expect(
    firstApp.window.getByRole("dialog", {
      name: /Thread Presentation/,
    }),
  ).toBeVisible();
  await firstApp.window.getByRole("button", { name: "Skip onboarding" }).click();
  await expect(
    firstApp.window.getByRole("dialog", { name: /Thread Presentation/ }),
  ).toHaveCount(0);
  await firstApp.electronApp.close();

  const secondApp = await launchElectronApp({ fixturePath, homeRoot });
  try {
    await expect(
      secondApp.window.getByRole("dialog", { name: /Thread Presentation/ }),
    ).toHaveCount(0);
  } finally {
    await secondApp.close();
  }
});

test("Help menu can replay onboarding without clearing completion", async () => {
  const app = await launchElectronApp({
    fixturePath,
    preLaunchHook: async (homeRoot) => {
      const profileDir = path.join(homeRoot, ".pwragent/profiles/default");
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        path.join(profileDir, "config.toml"),
        "[onboarding]\ncompleted = true\n",
        "utf8",
      );
    },
  });

  try {
    await expect(
      app.window.getByRole("dialog", { name: /Thread Presentation/ }),
    ).toHaveCount(0);
    await app.electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "replay-onboarding-wizard",
      );
      if (!item) {
        throw new Error("Replay onboarding wizard menu item was not registered.");
      }
      (item.click as unknown as () => void)();
    });
    await expect(
      app.window.getByRole("dialog", {
        name: /Thread Presentation/,
      }),
    ).toBeVisible();
    await app.window.getByRole("button", { name: "Skip onboarding" }).click();
    await expect
      .poll(async () =>
        await app.window.evaluate(async () => {
          const api = (
            window as Window & {
              pwragent?: {
                readSettings?: (request: Record<string, never>) => Promise<{
                  snapshot: { onboarding: { completed: boolean } };
                }>;
              };
            }
          ).pwragent;
          const response = await api?.readSettings?.({});
          return response?.snapshot.onboarding.completed;
        }),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});
