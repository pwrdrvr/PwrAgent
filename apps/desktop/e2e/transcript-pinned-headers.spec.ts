import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Geometry oracle for open work in the transcript. jsdom does no layout, so
 * these rules can only be checked in the real renderer:
 *
 * 1. Fit: an open command card is never taller than the transcript
 *    scrollport, so reading it never needs the transcript's scroll and the
 *    card's own scroll together.
 * 2. Reach: wherever the transcript is scrolled inside an open card, the
 *    control that closes it is inside the scrollport.
 * 3. Stillness: a disclosure the operator clicks is at the same place after
 *    the click, whether it was pinned or was the last row of a transcript
 *    following its bottom.
 */
const SCROLLER = ".transcript-list__items";
const screenshotDir = process.env.PWRAGENT_TRANSCRIPT_PIN_SCREENSHOTS;

async function geometry(page: Page, target: Locator) {
  return target.evaluate((element, scrollerSelector) => {
    const scroller = element.closest(scrollerSelector);
    if (!scroller) {
      throw new Error("not inside the transcript scroller");
    }
    const port = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      bottom: box.bottom - port.top,
      height: box.height,
      portHeight: scroller.clientHeight,
      top: box.top - port.top,
    };
  }, SCROLLER);
}

async function screenshot(page: Page, name: string) {
  if (!screenshotDir) {
    return;
  }
  await page.screenshot({ path: path.resolve(screenshotDir, `${name}.png`) });
}

test("open transcript work fits the pane and stays one click from closed", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/transcript-pinned-headers/replay.fixture.json",
    ),
    windowSize: { width: 1280, height: 860 },
  });

  try {
    const page = app.window;
    await page
      .getByRole("button", { name: /Transcript pinned headers/i })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Transcript pinned headers" }),
    ).toBeVisible();

    const transcript = page.getByRole("region", { name: "Transcript" });
    const groupToggle = transcript.getByRole("button", { name: /^(Worked for|Previous work)/ });
    await groupToggle.click();
    const commandToggle = transcript.getByRole("button", { name: /python3 - <<'EOF'/ });
    await commandToggle.click();
    const card = transcript.locator(".transcript-command");
    await expect(card).toHaveCount(1);
    await screenshot(page, "01-open-card");

    // Fit: the whole card is inside the scrollport with its header above
    // it, and the long command scrolls inside the card.
    const cardBox = await geometry(page, card);
    expect(cardBox.height).toBeLessThanOrEqual(cardBox.portHeight);
    expect(await card.locator(".transcript-command__block").evaluate(
      (pane) => pane.scrollHeight > pane.clientHeight + 1,
    )).toBe(true);

    // The output preview opens into the same card, still inside the pane.
    await card.getByRole("button", { name: /Show \d+ more lines/ }).click();
    await expect(card.getByRole("button", { name: "Show less" })).toBeVisible();
    const openBox = await geometry(page, card);
    expect(openBox.height).toBeLessThanOrEqual(openBox.portHeight);
    expect(await card.locator(".transcript-command__output").evaluate(
      (pane) => pane.scrollHeight > pane.clientHeight + 1,
    )).toBe(true);

    // Scrolled until the card's header has only just pinned, the whole
    // open card is in view under it.
    await card.evaluate((element, scrollerSelector) => {
      const port = element.closest(scrollerSelector);
      if (!port) {
        throw new Error("not inside the transcript scroller");
      }
      port.scrollTop += element.getBoundingClientRect().top
        - port.getBoundingClientRect().top - 80;
    }, SCROLLER);
    const underHeader = await geometry(page, card);
    expect((await geometry(page, commandToggle)).bottom).toBeLessThanOrEqual(underHeader.top + 1);
    expect(underHeader.bottom).toBeLessThanOrEqual(underHeader.portHeight);
    await screenshot(page, "01b-card-under-pinned-header");

    // Reach and stillness, from three depths inside the card. Past these
    // the row's own end pushes its header out, as a pinned header leaves.
    for (const depth of [0.2, 0.5, 0.75]) {
      await card.evaluate((element, [scrollerSelector, fraction]) => {
        const port = element.closest(scrollerSelector as string);
        if (!port) {
          throw new Error("not inside the transcript scroller");
        }
        const box = element.getBoundingClientRect();
        port.scrollTop += box.top - port.getBoundingClientRect().top
          + box.height * (fraction as number);
      }, [SCROLLER, depth] as const);

      const pinned = await geometry(page, commandToggle);
      expect(pinned.top).toBeGreaterThanOrEqual(0);
      expect(pinned.bottom).toBeLessThan(96);
      const group = await geometry(page, groupToggle);
      expect(group.top).toBeGreaterThanOrEqual(0);
      expect(group.bottom).toBeLessThanOrEqual(pinned.top + 1);
      if (depth === 0.5) {
        await screenshot(page, "02-pinned-mid-card");
      }

      await commandToggle.click();
      await expect(card).toHaveCount(0);
      await expect
        .poll(async () => (await geometry(page, commandToggle)).top)
        .toBeCloseTo(pinned.top, 0);
      if (depth === 0.5) {
        await screenshot(page, "03-collapsed-in-place");
      }

      const closed = await geometry(page, commandToggle);
      await commandToggle.click();
      await expect(card).toHaveCount(1);
      await expect
        .poll(async () => (await geometry(page, commandToggle)).top)
        .toBeCloseTo(closed.top, 0);
      await card.getByRole("button", { name: /Show \d+ more lines/ }).click();
    }

    // The group's own toggle closes the whole group from inside it and
    // stays where it was clicked.
    const groupPinned = await geometry(page, groupToggle);
    await groupToggle.click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => (await geometry(page, groupToggle)).top)
      .toBeCloseTo(groupPinned.top, 0);
    await groupToggle.click();

    // Stillness at the bottom: a short transcript rests at its end, which
    // the list reads as following new output. Opening its last row of work
    // must not be followed as if it were output.
    await page
      .getByRole("button", { name: /Transcript bottom follow/i })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Transcript bottom follow" }),
    ).toBeVisible();
    await transcript.getByRole("button", { name: /^(Worked for|Previous work)/ }).click();
    const lastToggle = transcript.getByRole("button", { name: /pnpm test:atlas-routes/ });
    await expect(lastToggle).toBeVisible();
    const atBottom = await geometry(page, lastToggle);
    await lastToggle.click();
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: /Show \d+ more lines/ }).click();
    await expect(card.getByRole("button", { name: "Show less" })).toBeVisible();
    await expect
      .poll(async () => (await geometry(page, lastToggle)).top)
      .toBeCloseTo(atBottom.top, 0);
    await screenshot(page, "04-opened-at-bottom");
  } finally {
    await app.close();
  }
});
