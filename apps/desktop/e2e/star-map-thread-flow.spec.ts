// The Star Map's core triage loop, end to end in a real Electron launch:
// open the map, pick a card, read the thread without leaving the map,
// and escalate into the full thread view.
//
// The map lives in its own OS window ("Federation Star Map"). Opening it
// from the main window's header control spawns that window; opening it
// again focuses the existing one instead of spawning a second. Reading a
// thread floats a chat card OVER the map inside the map window, and the
// escalation on the card's expand control crosses windows: the MAIN
// window navigates to the thread while the map window stays up behind
// it. Nothing below the E2E level exercises that cross-window handoff.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

const THREAD_TITLE = "Star map attention thread";

/**
 * Poll `electronApp.windows()` for a window whose URL carries the map
 * hash. The BrowserWindow is created with `show: false`, so Playwright's
 * `window` event fires before the URL has loaded; polling sidesteps the
 * race (same pattern as `appearance-broadcast.spec.ts`).
 */
async function waitForStarMapWindow(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
): Promise<Page> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    for (const candidate of app.electronApp.windows()) {
      if (candidate.url().includes("#star-map")) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Star Map window did not open; current windows: ${app.electronApp
      .windows()
      .map((win) => win.url())
      .join(", ")}`,
  );
}

function countStarMapWindows(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
): number {
  return app.electronApp
    .windows()
    .filter((win) => win.url().includes("#star-map")).length;
}

test("opens a thread from the star map window in the main window", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/star-map/replay.fixture.json"),
  });

  try {
    await expect(
      app.window.getByRole("button", { name: new RegExp(THREAD_TITLE, "i") }).first(),
    ).toBeVisible();

    await app.window.getByRole("button", { name: "Open Star Map" }).click();
    const mapWindow = await waitForStarMapWindow(app);

    // `exact` matters here: role-name matching is substring by default,
    // and once a chat card opens its "Chat: Star map attention thread"
    // region matches "Star Map" too.
    const starMap = mapWindow.getByRole("region", {
      name: "Star Map",
      exact: true,
    });
    await expect(starMap).toBeVisible();

    // One instance on a single-machine E2E launch, and its label is the
    // runner's hostname — match the copy, not the machine.
    await expect(
      starMap.getByRole("button", { name: /^Open this instance / }),
    ).toBeVisible();

    // Singleton: the header control focuses the existing map window
    // rather than spawning a sibling. A second window would be created
    // asynchronously, so give it a moment to (not) appear before
    // counting.
    await app.window.getByRole("button", { name: "Open Star Map" }).click();
    await app.window.waitForTimeout(1_000);
    expect(countStarMapWindows(app)).toBe(1);

    const card = starMap.getByRole("button", {
      name: `Open thread: ${THREAD_TITLE}`,
    });
    await expect(card).toBeVisible();
    await card.click();

    // A chat card, not a navigation: the map is still up behind it.
    const chatCard = mapWindow.getByRole("region", {
      name: `Chat: ${THREAD_TITLE}`,
    });
    await expect(chatCard).toBeVisible();
    await expect(chatCard.getByText("The star map is live.")).toBeVisible();
    await expect(starMap).toBeVisible();

    await mapWindow
      .getByRole("button", {
        name: `Open ${THREAD_TITLE} in the full thread view`,
      })
      .click();

    // Cross-window escalation: the MAIN window shows the full thread
    // view; the map window keeps the map and the chat card.
    await expect(
      app.window.getByRole("heading", { level: 2, name: THREAD_TITLE }),
    ).toBeVisible();
    await expect(app.window.getByText("The star map is live.").first()).toBeVisible();
    await expect(starMap).toBeVisible();
    await expect(chatCard).toBeVisible();

    // The map carries no in-surface exit anymore — closing is the OS
    // window's job.
    await expect(
      starMap.getByRole("button", { name: "Close Star Map" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
