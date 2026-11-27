import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { accessTrigger, allowFullAccess, chooseAccessStop } from "./fixtures/access-picker";

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

    const accessMode = accessTrigger(app.window);
    await expect(accessMode).toHaveAttribute("data-value", "default");

    await app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("First turn on default mode");
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect(
      app.window.getByTestId("composer-stop-turn")
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

    // The Full Access stop asks inline; the level holds until Allow, and
    // a click outside the picker drops the unconfirmed stop.
    const picker = await chooseAccessStop(app.window, "full-access");
    await expect(picker).toContainText("network and almost every file");
    await expect(picker.getByRole("button", { name: "Allow Full Access" })).toBeVisible();
    await expect(
      app.window.getByRole("dialog", { name: "Enable Full Access?" }),
    ).toHaveCount(0);
    await app.window.mouse.click(20, 20);
    await expect(picker).toBeHidden();
    await expect(accessMode).toHaveAttribute("data-value", "default");
    await allowFullAccess(app.window);
    await expect(accessMode).toHaveAttribute("data-value", "full-access");

    await app.window
      .getByRole("textbox", { name: "Reply", exact: true })
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
