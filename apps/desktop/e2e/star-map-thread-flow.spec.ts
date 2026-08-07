// The Star Map's core triage loop, end to end in a real Electron launch:
// open the map, pick a card, read the thread without leaving the map,
// escalate into the full thread view, and come back.
//
// The escalation step is the one worth pinning. Clicking a card used to
// navigate away to the thread shell; it now floats a chat card OVER the
// map, and the trip to the full view moved onto the card's own expand
// control. "Back to map" then un-floats without closing the map. Three
// separate pieces of state (map open, card open, thread floating) have to
// agree, and nothing below this level catches them disagreeing.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

const THREAD_TITLE = "Star map attention thread";

test("opens a thread from the star map and returns to the map", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/star-map/replay.fixture.json"),
  });

  try {
    await expect(
      app.window.getByRole("button", { name: new RegExp(THREAD_TITLE, "i") }).first(),
    ).toBeVisible();

    // The map layer covers the app chrome, so the header toggle that
    // opens it is not the same control that closes it — the layer brings
    // its own "Close map". Both carry the "Close Star Map" name, hence
    // the scoping on every locator below.
    await app.window.getByRole("button", { name: "Open Star Map" }).click();
    // `exact` matters here: role-name matching is substring by default,
    // and once a chat card opens its "Chat: Star map attention thread"
    // region matches "Star Map" too.
    const starMap = app.window.getByRole("region", {
      name: "Star Map",
      exact: true,
    });
    await expect(starMap).toBeVisible();

    // One instance on a single-machine E2E launch, and its label is the
    // runner's hostname — match the copy, not the machine.
    await expect(
      starMap.getByRole("button", { name: /^Open this instance / }),
    ).toBeVisible();

    const card = starMap.getByRole("button", {
      name: `Open thread: ${THREAD_TITLE}`,
    });
    await expect(card).toBeVisible();
    await card.click();

    // A chat card, not a navigation: the map is still up behind it.
    const chatCard = app.window.getByRole("region", {
      name: `Chat: ${THREAD_TITLE}`,
    });
    await expect(chatCard).toBeVisible();
    await expect(chatCard.getByText("The star map is live.")).toBeVisible();
    await expect(starMap).toBeVisible();

    await app.window
      .getByRole("button", {
        name: `Open ${THREAD_TITLE} in the full thread view`,
      })
      .click();

    // Full thread view, floated over the map rather than replacing it.
    await expect(
      app.window.getByRole("heading", { level: 2, name: THREAD_TITLE }),
    ).toBeVisible();
    await expect(app.window.getByText("The star map is live.").first()).toBeVisible();
    const backToMap = app.window.getByRole("button", { name: "Back to map" });
    await expect(backToMap).toBeVisible();
    await expect(app.window.locator("main.app-main--star-map-float")).toHaveCount(1);

    await backToMap.click();

    // Un-floats without closing the map: the float chrome goes, the map
    // stays, and the thread is still reachable as a card.
    await expect(backToMap).toHaveCount(0);
    await expect(app.window.locator("main.app-main--star-map-float")).toHaveCount(0);
    await expect(starMap).toBeVisible();
    await expect(card).toBeVisible();

    // And the map's own exit lands back on the thread shell.
    await starMap.getByRole("button", { name: "Close Star Map" }).click();
    await expect(starMap).toHaveCount(0);
    await expect(
      app.window.getByRole("button", { name: "Open Star Map" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
