import { expect, test } from "@playwright/test";
import { createWorktreeHandoffFixture } from "./fixtures/workspace-handoff-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

test("centers the worktree-to-local handoff dialog in the window", async () => {
  const fixture = await createWorktreeHandoffFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: {
      height: 900,
      width: 1440,
    },
  });

  try {
    await app.window
      .getByRole("button", { name: "Worktree handoff thread" })
      .click();

    await app.window.getByLabel("Workspace mode").click();
    await app.window.getByRole("menuitem", { name: "Handoff to Local" }).click();

    const dialog = app.window.getByRole("dialog", { name: "Handoff to Local" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("feature/handoff");

    const geometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        dialogCenterX: rect.left + rect.width / 2,
        viewportCenterX: window.innerWidth / 2,
        parentTagName: element.parentElement?.parentElement?.tagName,
      };
    });

    expect(geometry.parentTagName).toBe("BODY");
    expect(Math.abs(geometry.dialogCenterX - geometry.viewportCenterX)).toBeLessThanOrEqual(
      1,
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
