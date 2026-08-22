import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test.skip(
  !process.env.PWRAGENT_RAIL_INSPECT,
  "Set PWRAGENT_RAIL_INSPECT=1 through the package script to capture the screenshot.",
);

test("screenshots the rail with a long diff scrolled into the middle", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-sticky-gap/replay.fixture.json",
    ),
    windowSize: { width: 1280, height: 720 },
  });

  try {
    await app.window
      .getByRole("button", { name: /LiveWorkRail sticky-gap replay/i })
      .first()
      .click();
    await app.window
      .getByLabel("Reply")
      .fill("Drop in a long changelog entry to force rail-body scroll.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-diff-updated-1" });

    const rail = app.window.getByRole("complementary", {
      name: /Edited 1 file/i,
    });
    await rail.getByRole("button", { name: /Update CHANGELOG\.md/i }).click();
    const railBody = rail.locator("css=.live-work-rail__body");
    await railBody.evaluate((element) => {
      element.scrollTop = 200;
    });

    await app.window.screenshot({
      path: path.resolve(
        specDir,
        "../test-results/live-work-rail-sticky-gap.png",
      ),
    });
  } finally {
    await app.close();
  }
});
