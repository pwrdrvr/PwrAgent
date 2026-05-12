import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("applies the correct per-turn permission policy after execution mode toggle", async () => {
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
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-mode-route",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-completed-1" });
    await app.advance({ stepId: "status-idle-1" });

    await accessMode.click();
    await app.window
      .getByRole("option", { name: "Full Access" })
      .click();
    const fullAccessWarning = app.window.getByRole("dialog", {
      name: "Enable Full Access?",
    });
    await expect(fullAccessWarning).toContainText("network access");
    await expect(fullAccessWarning).toContainText("read/write access");
    const [viewportSize, dialogBox] = await Promise.all([
      app.window.evaluate(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      })),
      fullAccessWarning.boundingBox(),
    ]);
    expect(dialogBox).not.toBeNull();
    expect(
      Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewportSize.width / 2),
    ).toBeLessThan(2);
    await app.window.mouse.click(20, 20);
    await expect(fullAccessWarning).toBeVisible();
    await expect(accessMode).toHaveAttribute("data-value", "default");
    await fullAccessWarning
      .getByRole("button", { name: "I Understand and Accept the Risks" })
      .click();
    await expect(accessMode).toHaveAttribute("data-value", "full-access");

    await app.window
      .getByLabel("Reply")
      .fill("Second turn must use full-access policy");
    await expect(
      app.window.getByRole("button", { name: "Send" })
    ).toBeEnabled();
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-mode-route",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
  } finally {
    await app.close();
  }
});
