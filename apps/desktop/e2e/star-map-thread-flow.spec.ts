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
import { openStarMapWindow } from "./fixtures/star-map-window";

const specDir = path.dirname(fileURLToPath(import.meta.url));

const THREAD_TITLE = "Star map attention thread";

function countStarMapWindows(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
): number {
  return app.electronApp
    .windows()
    .filter((win) => win.url().includes("#star-map")).length;
}

/**
 * Resize the map's BrowserWindow and wait for the renderer to lay out at
 * the new width. Playwright's `setViewportSize` is unsupported on an
 * Electron page, so the OS window is the only handle.
 */
async function resizeStarMapWindow(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
  mapWindow: Page,
  size: { width: number; height: number },
): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, bounds) => {
    const target = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().includes("#star-map"),
    );
    if (!target) throw new Error("Expected the Star Map BrowserWindow");
    target.setSize(bounds.width, bounds.height);
  }, size);
  await expect
    .poll(() => mapWindow.evaluate(() => window.innerWidth))
    .toBeLessThanOrEqual(size.width);
}

/**
 * The band's three slots, in the order the grid lays them out. Named
 * rather than derived from the DOM so an accidentally-dropped slot fails
 * as a missing box below instead of silently narrowing the check.
 */
const TOP_BAND_SLOTS = [
  ".star-map__chrome",
  ".star-map__filters",
  ".star-map__actions",
] as const;

/**
 * The top band's slots must not overlap at any window width, and nothing
 * may sit on top of a filter chip.
 *
 * The rect check is the structural one: `.star-map__chrome` and
 * `.star-map__filters` used to be independently positioned islands, so
 * the chrome (the higher z-index) painted over the leading chip and ate
 * its clicks. It runs over every PAIR of occupied slots rather than that
 * one pair, because the point of the band is that controls get added to
 * it — a check that only knows about the two slots occupied today stops
 * gating the moment somebody uses the third.
 *
 * The hit test is the behavioural one, and it is wider — it catches ANY
 * element covering a chip, not just a sibling slot, which is the shape
 * axe reported as `target-size` ("partially obscured, smallest space is
 * 79.5px by 12px"). It is scoped to the chips INSIDE the filter strip:
 * the same chip primitive is shared with Find, View, and anything the
 * actions slot grows, and those are not what this measures.
 *
 * Both are cheaper than waiting for the a11y gate to notice, and they say
 * what actually broke.
 */
async function expectTopBandLaidOut(mapWindow: Page, at: string): Promise<void> {
  const boxes = await Promise.all(
    TOP_BAND_SLOTS.map(async (selector) => ({
      // An unoccupied slot renders no element at all; `count()` keeps that
      // apart from a slot that is present but failed to lay out, which is
      // a real failure and must not be skipped.
      box: (await mapWindow.locator(selector).count())
        ? await mapWindow.locator(selector).boundingBox()
        : undefined,
      selector,
    })),
  );
  const present = boxes.filter((slot) => slot.box !== undefined);
  if (present.length < 2) {
    throw new Error(
      `Expected at least two top-band slots to be laid out ${at};`
        + ` got ${JSON.stringify(boxes)}`,
    );
  }

  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      const a = present[i]!;
      const b = present[j]!;
      const boxA = a.box!;
      const boxB = b.box!;
      const overlaps =
        boxA.x < boxB.x + boxB.width
        && boxB.x < boxA.x + boxA.width
        && boxA.y < boxB.y + boxB.height
        && boxB.y < boxA.y + boxA.height;
      expect(
        overlaps,
        `top band slots overlap ${at}: ${a.selector} ${JSON.stringify(boxA)},`
          + ` ${b.selector} ${JSON.stringify(boxB)}`,
      ).toBe(false);
    }
  }

  const covered = await mapWindow.evaluate(() =>
    [...document.querySelectorAll(".star-map__filters .star-map__filter-chip")]
      // The slot keeps both renderings of the filters mounted, and the
      // dropped chips keep their natural width so the fit stays
      // measurable — so "not showing" here is `visibility: hidden` with a
      // real box, or a zero box, depending on which. Neither is a chip
      // the operator can click, and testing one anyway is how this check
      // reported the band as broken at 1280px when it was not.
      .filter((chip) => {
        const box = chip.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        return getComputedStyle(chip).visibility !== "hidden";
      })
      .map((chip) => {
        const box = chip.getBoundingClientRect();
        const top = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        if (top?.closest(".star-map__filters")) return undefined;
        // `className` is an SVGAnimatedString on SVG elements, and the map
        // paints several full-bleed SVG layers — describe the element in a
        // way that survives whichever kind covered the chip.
        const culprit = top
          ? `${top.tagName.toLowerCase()}${top.getAttribute("class") ? `.${top.getAttribute("class")}` : ""}`
          : "nothing";
        return `${chip.textContent} covered by ${culprit}`;
      })
      .filter((entry): entry is string => entry !== undefined),
  );
  expect(covered, `filter chips obscured ${at}`).toEqual([]);

  // One row, at every width. The first version of this band let the chip
  // strip wrap instead of collapsing, which put a second row of chips over
  // the star field and doubled the band's height — the rect and hit-test
  // checks above both stayed green through it, because wrapped chips
  // overlap nothing. Measure the band against its tallest slot: equal
  // means the slots sit side by side, taller means something wrapped.
  //
  // The band also reserves `--chrome-band-h`, so its row centres on the
  // same line the window's stoplights sit on. That floor is the OTHER
  // legitimate reason for the band to exceed its tallest slot, so read it
  // off the element rather than pinning a number here — the check is still
  // exact, and a stacked second row clears the floor on its own (two 25px
  // slots plus the 12px gap is 62 against a 40px reservation).
  const rowHeight = await mapWindow.evaluate(() => {
    const band = document.querySelector(".star-map__top-band");
    if (!band) return undefined;
    const slots = [...band.children].map((slot) => slot.getBoundingClientRect().height);
    const style = getComputedStyle(band);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return {
      band: Math.round(band.getBoundingClientRect().height - padding),
      tallestSlot: Math.round(Math.max(...slots)),
      reserved: Math.round((parseFloat(style.minHeight) || 0) - padding),
    };
  });
  expect(
    rowHeight,
    `top band is taller than one row ${at}: ${JSON.stringify(rowHeight)}`,
  ).toEqual({
    band: Math.max(rowHeight?.tallestSlot ?? 0, rowHeight?.reserved ?? 0),
    tallestSlot: rowHeight?.tallestSlot,
    reserved: rowHeight?.reserved,
  });

  // Which of the two filter renderings shows is a property of the data —
  // how many chips carry a count, how wide those counts are — so a spec
  // cannot assert a state at a width without pinning the fixture's
  // numbers. What it CAN assert is the invariant: exactly one of them is
  // ever on screen, and whatever is on screen fits inside the window.
  const slots = await mapWindow.evaluate(() => {
    const showing = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return (
        box.width > 0
        && box.height > 0
        && getComputedStyle(el).visibility !== "hidden"
      );
    };
    const band = document.querySelector(".star-map__top-band");
    // Only what is on screen. The hidden rendering is parked at the band's
    // corner at its full natural width so the fit stays measurable, and
    // counting it would fail this for a row nobody can see.
    const onScreen = band
      ? [...band.querySelectorAll("button")].filter(
          (el) =>
            el.getBoundingClientRect().width > 0
            && getComputedStyle(el).visibility !== "hidden",
        )
      : [];
    const right = onScreen.length
      ? Math.max(...onScreen.map((el) => el.getBoundingClientRect().right))
      : 0;
    return {
      menu: showing(".star-map__filter-menu"),
      overflowsBy: Math.round(right - document.documentElement.clientWidth),
      strip: showing(".star-map__filter-strip"),
    };
  });
  expect(
    slots.strip !== slots.menu,
    `expected exactly one filter rendering ${at}: ${JSON.stringify(slots)}`,
  ).toBe(true);
  // The other way a row that does not fit fails: rather than a chip
  // leaving, every chip narrows until the labels wrap, or the row runs
  // straight off the right edge of the window. Both were real before the
  // chips were pinned to their natural width.
  expect(
    slots.overflowsBy,
    `top band runs past the window edge ${at}`,
  ).toBeLessThanOrEqual(0);
}

test("opens a thread from the star map window in the main window", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/star-map/replay.fixture.json"),
  });

  try {
    await expect(
      app.window.getByRole("button", { name: new RegExp(THREAD_TITLE, "i") }).first(),
    ).toBeVisible();

    const mapWindow = await openStarMapWindow(app);

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

// The map's controls all live over the top of the sky, in the same band,
// and for a long time they were three separately positioned islands with
// nothing reserving space between them. On a 1280px window the chrome
// already reached the leading filter chip; a third chrome control covered
// it, and narrow windows overlapped outright. `.star-map__top-band` makes
// them one grid row so the collision cannot happen — this is the gate on
// that, at the default width and at the window's 800px minimum, where the
// old layout was already broken.
test("keeps the star map's top band from overlapping itself", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/star-map/replay.fixture.json"),
  });

  try {
    const mapWindow = await openStarMapWindow(app);
    const starMap = mapWindow.getByRole("region", {
      name: "Star Map",
      exact: true,
    });
    await expect(starMap).toBeVisible();
    await expect(
      starMap.getByRole("group", { name: "Thread filters" }),
    ).toBeVisible();

    await expectTopBandLaidOut(mapWindow, "at the default window width");

    // `minWidth` in star-map-window.ts. Below roughly 1100px the old
    // centred strip walked left into the chrome, so this is the width
    // that would have failed first.
    await resizeStarMapWindow(app, mapWindow, { width: 800, height: 720 });
    await expectTopBandLaidOut(mapWindow, "at the minimum window width");
    // Whichever rendering the fixture's counts land on at this width, the
    // filters have to still be reachable. A degradation that ends with no
    // way to filter would satisfy every geometric check above.
    const strip = starMap.getByRole("group", { name: "Thread filters" });
    const menu = starMap.getByRole("button", { name: /^Thread filters/ });
    if (await strip.isVisible()) {
      await expect(strip.getByRole("button").first()).toBeVisible();
    } else {
      await expect(menu).toBeVisible();
      await menu.click();
      await expect(
        mapWindow.getByRole("dialog", { name: "Thread filters" }),
      ).toBeVisible();
    }
  } finally {
    await app.close();
  }
});
