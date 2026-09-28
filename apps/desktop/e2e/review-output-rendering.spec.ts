import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("renders captured Codex review findings once in the review card", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/review-output-rendering/replay.fixture.json"
    ),
    // Keep the finding title on one line for native text selection.
    // Unpin the default context rail to give the review card its full width.
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
    // A raw mouse drag can use stale coordinates while the completed review
    // settles (Windows observed a 68px shift into the summary). A locator
    // action waits for a stable, visible target and resolves its position.
    // Triple-click exercises Chromium's native text selection without storing
    // a viewport coordinate across renderer updates.
    await findingTitle.click({ clickCount: 3 });
    await expect
      .poll(async () =>
        app.window.evaluate(() => window.getSelection()?.toString() ?? "")
      )
      .toContain("Preserve async pasted images");

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
