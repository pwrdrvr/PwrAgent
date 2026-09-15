import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { probeReport } from "./fixtures/probe-report";

const specDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * What the finding-title drag actually ran over, read after it missed.
 *
 * The drag is measured once and replayed as three raw mouse events, so its
 * coordinates describe the layout at `boundingBox()` time and nothing else.
 * Windows selected `"\nP2\n"` — the priority chip — from a drag whose
 * x-range starts to the RIGHT of that chip and is wider than it, which no
 * translation of a stable row can produce: `.transcript-review__finding-head`
 * is a `grid` of `auto minmax(0, 1fr) auto` (chip, title, copy button), so
 * the title cannot wrap under the chip and the two cannot swap places. Either
 * the row moved several hundred pixels, or the title was not in it any more.
 *
 * `elementFromPoint` at both ends answers that directly; the live boxes say
 * whether the row moved; and the counts say whether the review card was
 * rebuilt or duplicated underneath the measurement (`.last()` would then have
 * measured a card that no longer exists).
 *
 * Electron traces carry no DOM snapshots, so a failure that is not described
 * here is not described anywhere.
 */
async function describeDragTarget(
  page: Page,
  drag: { fromX: number; toX: number; y: number },
): Promise<string> {
  const observed = await page.evaluate((point) => {
    const describe = (element: Element | null): string => {
      if (!element) return "<nothing>";
      const className = typeof element.className === "string"
        ? element.className
        : "";
      const text = (element.textContent ?? "").trim().slice(0, 80);
      const classes = className.split(/\s+/).filter(Boolean);
      return `${element.tagName.toLowerCase()}${
        classes.length > 0 ? `.${classes.join(".")}` : ""
      } ${JSON.stringify(text)}`;
    };
    const box = (selector: string): string => {
      const element = document.querySelector(selector);
      if (!element) return "<absent>";
      const rect = element.getBoundingClientRect();
      return JSON.stringify({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };
    const scroller = document.querySelector<HTMLElement>(
      "[aria-label='Transcript']",
    );
    return {
      atFrom: describe(document.elementFromPoint(point.fromX, point.y)),
      atTo: describe(document.elementFromPoint(point.toX, point.y)),
      headBox: box(".transcript-review__finding-head"),
      priorityBox: box(".transcript-review__priority"),
      titleBox: box(".transcript-review__finding-title"),
      counts: {
        cards: document.querySelectorAll(
          "[role='group'][aria-label='Code review']",
        ).length,
        findings: document.querySelectorAll(".transcript-review__finding").length,
        titles: document.querySelectorAll(
          ".transcript-review__finding-title",
        ).length,
      },
      scrollTop: scroller?.scrollTop ?? -1,
      viewport: { height: globalThis.innerHeight, width: globalThis.innerWidth },
      selection: window.getSelection()?.toString() ?? "",
    };
  }, drag);

  return [
    `  element at the drag start: ${observed.atFrom}`,
    `  element at the drag end:   ${observed.atTo}`,
    `  live boxes: head=${observed.headBox} priority=${observed.priorityBox}`
    + ` title=${observed.titleBox}`,
    `  counts: ${JSON.stringify(observed.counts)}`
    + ` transcript scrollTop=${observed.scrollTop}`
    + ` viewport=${JSON.stringify(observed.viewport)}`,
    `  selection now: ${JSON.stringify(observed.selection)}`,
  ].join("\n");
}

test("renders captured Codex review findings once in the review card", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/review-output-rendering/replay.fixture.json"
    ),
    // The finding-title text-selection drag below needs the full-width
    // review card; unpin the (default pinned-open) context rail so the
    // title isn't reflowed/narrowed under the rail.
    contextRailPinned: false,
  });

  try {
    await app.window
      .getByRole("button", { name: /Composer image paste reset E2E/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Composer image paste reset E2E",
      })
    ).toBeVisible();

    await app.window.getByLabel("Reply").fill("/review main");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(async () => await app.getLastStartReview())
      .toMatchObject({
        threadId: "019dd682-56d6-7601-8634-fc3a49e67554",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await app.advance({ stepId: "review-entered-started-1" });
    await app.advance({ stepId: "review-entered-completed-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "review-exited-started-1" });
    await app.advance({ stepId: "review-exited-completed-1" });
    await app.advance({ stepId: "review-assistant-started-1" });
    await app.advance({ stepId: "review-assistant-completed-1" });
    await app.advance({ stepId: "turn-completed-1" });

    const reviewCard = transcript.getByRole("group", { name: "Code review" }).last();
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).toContainText(
      "The thread draft preservation path fixes the covered scenario"
    );
    await expect(reviewCard.getByText("P2")).toBeVisible();
    await expect(reviewCard).toContainText(
      "Preserve async pasted images for launchpad scopes"
    );
    await expect(reviewCard).toContainText("features/composer/Composer.tsx");
    await expect(reviewCard).not.toContainText(
      "/Users/fixture-user/github/PwrAgent/.worktrees/launchpad-pwragent-main-moja6ucz"
    );
    await expect(reviewCard).toContainText("Lines 971-979");
    await expect(app.window.getByTestId("composer-stop-turn")).toBeHidden();

    // Replay advancement acknowledges main-process events, not renderer commits.
    // Wait for the finished review above, then observe visibility and geometry
    // together: a separate toBeVisible()/boundingBox() can straddle replacement
    // of the time element and return null even after visibility passed.
    const reviewTime = reviewCard.locator("time").first();
    await expect(async () => {
      const layout = await reviewTime.evaluate((time) => {
        const rect = time.getBoundingClientRect();
        return {
          visible: time.checkVisibility({ checkVisibilityCSS: true }),
          width: rect.width,
          height: rect.height,
        };
      });
      expect(layout.visible).toBe(true);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBeGreaterThan(0);
      expect(layout.height).toBeLessThanOrEqual(18);
    }).toPass({ timeout: 5_000 });

    const findingTitle = reviewCard.getByText(
      "Preserve async pasted images for launchpad scopes"
    );
    const findingTitleBox = await findingTitle.boundingBox();
    expect(findingTitleBox).not.toBeNull();
    const dragY = findingTitleBox!.y + findingTitleBox!.height / 2;
    const dragFromX = findingTitleBox!.x + 4;
    const dragToX = findingTitleBox!.x + findingTitleBox!.width - 4;
    await app.window.mouse.move(dragFromX, dragY);
    await app.window.mouse.down();
    await app.window.mouse.move(dragToX, dragY, { steps: 12 });
    await app.window.mouse.up();
    await expect
      .poll(async () =>
        app.window.evaluate(() => window.getSelection()?.toString() ?? "")
      )
      .toContain("Preserve async pasted images")
      .catch(async (error: unknown) => {
        throw new Error(
          [
            "The finding-title drag selected something else.",
            `  dragged (${dragFromX}, ${dragY}) -> (${dragToX}, ${dragY}),`
            + ` measured from a title box of ${JSON.stringify(findingTitleBox)}`,
            await probeReport(async () =>
              await describeDragTarget(app.window, {
                fromX: dragFromX,
                toX: dragToX,
                y: dragY,
              })),
          ].join("\n"),
          { cause: error },
        );
      });

    await expect(
      transcript.getByText("Preserve async pasted images for launchpad scopes")
    ).toHaveCount(1);
    await expect(
      transcript.getByText("The thread draft preservation path fixes the covered scenario")
    ).toHaveCount(1);
    await expect(transcript.getByText("Review changes against main")).toHaveCount(1);
    await expect(transcript.getByText("changes against 'main'")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("wraps unstripped long review paths and strips paths inside the thread directory", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/review-path-wrapping/replay.fixture.json"
    ),
    windowSize: {
      width: 900,
      height: 720,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: /Review path wrapping/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Review path wrapping",
      })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const reviewCard = transcript.getByRole("group", { name: "Code review" }).last();
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).toContainText(
      "apps/desktop/src/renderer/src/features/composer/Composer.tsx"
    );
    await expect(reviewCard).not.toContainText(
      "/Users/fixture-user/work/PwrAgent/apps/desktop"
    );

    const outsidePathLink = reviewCard.getByRole("link", {
      name: /OutsideRepositoryPathWithAnExcessivelyLongSingleFilenameSegment/,
    });
    await expect(outsidePathLink).toBeVisible();
    await expect(outsidePathLink).toHaveAttribute(
      "href",
      /\/Volumes\/ExternalReviewArchive\//
    );

    // Both rects in one evaluate. Read as two `boundingBox()` round trips
    // they can straddle a reflow, and then "does the link overflow its
    // card" compares a link in one layout against a card in another — which
    // is what this assertion did, failing under shard load with the link
    // ~2px past a card bound that itself moved between runs (650.7, 652.0).
    // The 1px tolerance is for subpixel text metrics, not for that.
    const overflow = await outsidePathLink.evaluate((link, cardSelector) => {
      const card = link.closest<HTMLElement>(cardSelector);
      const linkRect = link.getBoundingClientRect();
      const cardRect = card?.getBoundingClientRect();
      return {
        cardRight: cardRect ? cardRect.x + cardRect.width : undefined,
        linkHeight: linkRect.height,
        linkRight: linkRect.x + linkRect.width,
      };
    }, "[role='group'][aria-label='Code review']");
    expect(overflow.cardRight).toBeDefined();
    expect(overflow.linkHeight).toBeGreaterThan(24);
    expect(overflow.linkRight).toBeLessThanOrEqual(overflow.cardRight! + 1);
  } finally {
    await app.close();
  }
});
