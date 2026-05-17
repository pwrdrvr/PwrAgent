import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { APP_UPDATE_STATUS_EVENT_CHANNEL } from "../src/shared/ipc";
import type { AppUpdateStatus } from "../src/shared/app-metadata";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test.skip(
  process.env.PWRAGENT_E2E_INSPECT !== "1",
  "Set PWRAGENT_E2E_INSPECT=1 through the package script to run this manual inspector.",
);

test("opens the update restart banner until Electron is closed manually", async () => {
  test.setTimeout(0);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/smoke/replay.fixture.json",
    ),
    windowSize: {
      height: 900,
      width: 1440,
    },
  });

  try {
    await app.window.getByRole("button", { name: "Replay smoke thread" }).click();

    const downloadedStatus: AppUpdateStatus = {
      status: "downloaded",
      version: "1.0.0-beta.7",
    };
    await app.electronApp.evaluate(
      ({ BrowserWindow }, params) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) {
          throw new Error("Expected an Electron BrowserWindow for update banner inspection");
        }
        window.webContents.send(params.channel, params.status);
      },
      {
        channel: APP_UPDATE_STATUS_EVENT_CHANNEL,
        status: downloadedStatus,
      },
    );

    const banner = app.window.locator(".app-update-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Update ready");
    await expect(banner).toContainText("Restart to update to v1.0.0-beta.7.");
    await expect(banner.getByRole("button", { name: "Restart" })).toBeVisible();
    await expect(
      banner.getByRole("button", { name: "Dismiss update notification" }),
    ).toBeVisible();

    console.log(
      [
        "",
        "Update banner inspection is ready.",
        "The banner is driven by a synthetic downloaded-update IPC event.",
        "Close the Electron window or quit the app to finish this command.",
        "",
      ].join("\n"),
    );

    if (process.env.PWRAGENT_E2E_INSPECT_AUTO_CLOSE === "1") {
      return;
    }

    await Promise.race([
      app.window.waitForEvent("close", { timeout: 0 }).then(() => undefined),
      app.electronApp.waitForEvent("close", { timeout: 0 }).then(() => undefined),
    ]);
  } finally {
    await app.close().catch(() => undefined);
  }
});
