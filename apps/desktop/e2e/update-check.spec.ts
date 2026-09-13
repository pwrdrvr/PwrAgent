// Help -> Check for Updates, end to end.
//
// The app under test is unpackaged, so the check runs the dev/QA fake
// (`simulateDevUpdateCheck`) rather than reaching GitHub — which is the point:
// the fake walks the same status machine a real check does, so the banner is
// driven here exactly as a real download would drive it.
//
// The fake is opted into with `PWRAGENT_DEV_FAKE_UPDATE`, and that opt-in is
// read inside the `!productionUpdatesEnabled()` branch, ahead of the Linux
// one. So this spec runs on every platform, including the Linux lane, where a
// packaged build answers `skipped` and offers no in-app download at all.

import { expect, test, type ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const FAKE_VERSION = "420.0.0";
/** Slow enough that the mid-download card is a target, not a race. Seven
 *  percent ticks at this pace give roughly six seconds to act. */
const UPDATE_STEP_MS = "800";

const FAKE_UPDATE_ENV = {
  PWRAGENT_DEV_FAKE_UPDATE: "1",
  PWRAGENT_DEV_FAKE_UPDATE_STEP_MS: UPDATE_STEP_MS,
};

async function checkForUpdates(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find(
        (candidate) => candidate.label === "Check for Updates",
      );
      if (item !== undefined) {
        item.click();
        return;
      }
    }
    throw new Error("Menu item not found: Check for Updates");
  });
}

test("a menu check reports itself live and ends on an actionable offer", async () => {
  const app = await launchElectronApp({
    env: FAKE_UPDATE_ENV,
    requiresReplayDriver: false,
  });

  try {
    const { window } = app;
    // Nothing before the ask: startup and periodic checks stay silent.
    await expect(window.locator(".app-update-banner")).toHaveCount(0);

    await checkForUpdates(app.electronApp);

    const card = window.locator(".app-update-banner--progress");
    await expect(card).toContainText("Checking for updates");
    // The card reports work in flight, so it carries a progress track and NOT
    // the countdown a transient notice would drain toward while the check is
    // still running.
    await expect(card.locator("[role='progressbar']")).toBeVisible();
    await expect(window.locator(".app-notice-toast__timer")).toHaveCount(0);

    await expect(card).toContainText("Downloading update", { timeout: 15_000 });
    await expect(card).toContainText(`PwrAgent v${FAKE_VERSION}`);
    await expect(card.locator(".app-update-banner__meter")).toContainText(
      "MB of",
    );
    await expect(card.locator("[role='progressbar']")).toHaveAttribute(
      "aria-valuenow",
      /\d+/,
    );

    // And it ends on the one thing there is to do about it.
    await expect(window.locator(".app-update-banner")).toContainText(
      `Restart to update to v${FAKE_VERSION}.`,
      { timeout: 30_000 },
    );
    await expect(
      window.getByRole("button", { name: "Restart" }),
    ).toBeVisible();
    await expect(window.locator(".app-update-banner--progress")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("Cancel stops the download and says so without crying failure", async () => {
  const app = await launchElectronApp({
    env: FAKE_UPDATE_ENV,
    requiresReplayDriver: false,
  });

  try {
    const { window } = app;
    await checkForUpdates(app.electronApp);

    const card = window.locator(".app-update-banner--progress");
    await expect(card).toContainText("Downloading update", { timeout: 15_000 });

    await card.getByRole("button", { name: "Cancel" }).click();

    const notice = window.locator(".app-notice-toast");
    await expect(notice).toContainText("Download canceled", { timeout: 15_000 });
    await expect(notice).toContainText(
      `PwrAgent v${FAKE_VERSION} is still available`,
    );
    // A cancel is not a failure: neutral tone, not the error one.
    await expect(notice).toHaveAttribute("data-tone", "neutral");
    // Now it IS a finished notice, so it goes on the ordinary countdown.
    await expect(notice.locator(".app-notice-toast__timer")).toBeVisible();
    // And the live card is gone — there is nothing left in flight to report.
    await expect(card).toHaveCount(0);

    // Nothing was downloaded, so nothing is offered to restart into.
    await expect(
      window.getByRole("button", { name: "Restart" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
