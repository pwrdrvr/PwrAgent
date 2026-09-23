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

import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
} from "@playwright/test";
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

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const measured = await locator.boundingBox();
  if (measured === null) {
    throw new Error(`Expected a laid-out box for ${locator}`);
  }
  return measured;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height;
}

function contains(outer: Box, point: { x: number; y: number }): boolean {
  return point.x >= outer.x
    && point.x <= outer.x + outer.width
    && point.y >= outer.y
    && point.y <= outer.y + outer.height;
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
    await expect(card.locator("[role='progressbar']")).toBeVisible();
    const checkingWidth = (await box(card)).width;
    // The card reports work in flight, so it is its own surface and NOT a
    // notice in the stack, which would drain a 9-second countdown toward a
    // dismissal while the check it reports is still running.
    await expect(
      window.locator(".app-notice-toast", { hasText: "Checking for updates" }),
    ).toHaveCount(0);

    await expect(card).toContainText("Downloading update", { timeout: 15_000 });
    await expect(card).toContainText(`PwrAgent v${FAKE_VERSION}`);
    await expect(card.locator(".app-update-banner__meter")).toContainText(
      "MB of",
    );
    await expect(card.locator("[role='progressbar']")).toHaveAttribute(
      "aria-valuenow",
      /\d+/,
    );

    // The actions sit in a row under the bar. v1.1.0-beta.3 put them in a
    // column beside it, and at the 420px stack width Cancel landed on top of
    // both the bar and the message.
    const cancel = await box(card.getByRole("button", { name: "Cancel" }));
    const track = await box(card.locator("[role='progressbar']"));
    const message = await box(card.locator(".app-update-banner__message"));
    expect(track.width, "the bar has width to cover").toBeGreaterThan(0);
    expect(cancel.y, "Cancel starts below the bar").toBeGreaterThanOrEqual(
      track.y + track.height,
    );
    expect(overlaps(cancel, message), "Cancel clears the message").toBe(false);
    const downloadingWidth = (await box(card)).width;

    // And it ends on the one thing there is to do about it.
    const offer = window.locator(
      ".app-update-banner:not(.app-update-banner--progress)",
    );
    await expect(offer).toContainText(
      `Restart to update to v${FAKE_VERSION}.`,
      { timeout: 30_000 },
    );
    await expect(
      window.getByRole("button", { name: "Restart" }),
    ).toBeVisible();
    await expect(window.locator(".app-update-banner--progress")).toHaveCount(0);
    // Measured at rest: the offer rises 8px into place as it enters.
    await offer.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ).then(() => undefined)
    );

    // One check, one card width: the checking, downloading and offer cards
    // were 266px, 420px and 303px when each sized to its own content.
    const offerWidth = (await box(offer)).width;
    expect(Math.round(checkingWidth)).toBe(Math.round(downloadingWidth));
    expect(Math.round(offerWidth)).toBe(Math.round(downloadingWidth));

    // The stack is bottom-anchored, so the offer's action row covers the
    // live card's. A click aimed at Cancel as the download finishes must
    // land on Dismiss, which leaves the update uninstalled, never on Restart.
    const dismiss = await box(
      offer.getByRole("button", { name: "Dismiss update notification" }),
    );
    const restart = await box(offer.getByRole("button", { name: "Restart" }));
    const aim = {
      x: cancel.x + cancel.width / 2,
      y: cancel.y + cancel.height / 2,
    };
    expect(contains(dismiss, aim), "Cancel's centre lands on Dismiss").toBe(
      true,
    );
    expect(overlaps(restart, cancel), "Restart clears Cancel's slot").toBe(
      false,
    );
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

    // Addressed by id: the stack can hold other notices at the same time — a
    // runner with no agent installed carries a durable backend warning for
    // the whole run — and a bare `.app-notice-toast` matches all of them.
    const notice = window.locator(
      ".app-notice-toast[data-notice-id='app-update-check:canceled']",
    );
    await expect(notice).toContainText("Download canceled", { timeout: 15_000 });
    // Exactly one, so an ambiguous locator fails as a count rather than as a
    // strict-mode error somewhere further down.
    await expect(notice).toHaveCount(1);
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
