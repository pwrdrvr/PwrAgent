import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const staleThinkingSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("clears the thread-list thinking indicator after completed retained activity", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      staleThinkingSpecDir,
      "fixtures/stale-thinking-indicator/replay.fixture.json"
    ),
  });

  try {
    const threadButton = app.window
      .getByRole("button", { name: /Stale thinking replay/i })
      .first();
    const thinkingIndicator = threadButton.locator(
      '[data-thread-status="thinking"]'
    );

    await expect(threadButton).toBeVisible();
    await expect(thinkingIndicator).toHaveCount(0);

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "item-started-1" });
    await expect(thinkingIndicator).toBeVisible();

    await app.advance({ stepId: "status-idle-before-completion" });
    await expect(thinkingIndicator).toBeVisible();

    await app.advance({ stepId: "item-completed-1" });
    await app.advance({ stepId: "turn-completed-captured" });
    await expect(thinkingIndicator).toHaveCount(0);

    await threadButton.click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Stale thinking replay",
      })
    ).toBeVisible();
    await expect(app.window.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(app.window.getByRole("status")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
