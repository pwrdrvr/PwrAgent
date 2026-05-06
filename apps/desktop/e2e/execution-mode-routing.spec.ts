import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("routes turn to the correct backend instance after execution mode toggle", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/execution-mode-routing/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /Execution mode routing test/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Execution mode routing test",
      })
    ).toBeVisible();

    const accessMode = app.window.getByLabel("Access mode");
    await expect(accessMode).toHaveAttribute("data-value", "default");

    await app.window.getByLabel("Reply").fill("First turn on default mode");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect(
      app.window.getByRole("button", { name: "Stop" })
    ).toBeVisible();

    await expect
      .poll(
        async () => await app.getLastStartTurn({ executionMode: "default" })
      )
      .toMatchObject({ threadId: "thread-mode-route" });

    expect(
      await app.getLastStartTurn({ executionMode: "full-access" })
    ).toBeUndefined();

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-completed-1" });
    await app.advance({ stepId: "status-idle-1" });

    await accessMode.click();
    await app.window
      .getByRole("option", { name: "Full Access" })
      .click();
    await expect(accessMode).toHaveAttribute("data-value", "full-access");

    await app.window
      .getByLabel("Reply")
      .fill("Second turn must route to full-access instance");
    await expect(
      app.window.getByRole("button", { name: "Send" })
    ).toBeEnabled();
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(
        async () =>
          await app.getLastStartTurn({ executionMode: "full-access" })
      )
      .toMatchObject({ threadId: "thread-mode-route" });
  } finally {
    await app.close();
  }
});
