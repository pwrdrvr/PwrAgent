import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const requestUserInputSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openRequestUserInputReplay() {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      requestUserInputSpecDir,
      "fixtures/request-user-input/replay.fixture.json"
    )
  });

  await app.window
    .getByRole("button", { name: /Request user input replay/i })
    .first()
    .click();

  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: "Request user input replay"
    })
  ).toBeVisible();

  await app.window
    .getByLabel("Reply")
    .fill("Ask the plan questionnaire.");
  await app.window.getByLabel("Plan mode").check();
  await app.window.getByRole("button", { name: "Send" }).click();

  await app.advance({ stepId: "status-active-1" });
  await app.advance({ stepId: "turn-started-1" });
  await app.advance({ stepId: "request-user-input-1" });

  await expect(app.window.getByRole("group", { name: "Pending input" })).toBeVisible();
  await expect(app.window.getByText("Question 1 of 2")).toBeVisible();
  await expect(app.window.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(app.window.getByRole("button", { name: "Decline" })).toHaveCount(0);

  return app;
}

test("answers request_user_input questionnaires with back and next navigation", async () => {
  const app = await openRequestUserInputReplay();

  try {
    const pendingInput = app.window.getByRole("group", { name: "Pending input" });

    await pendingInput.getByRole("button", { name: /Large refactor/ }).click();
    await pendingInput.getByRole("button", { name: "Next" }).click();
    await expect(pendingInput.getByText("Question 2 of 2")).toBeVisible();

    await pendingInput.getByRole("button", { name: /Unit only/ }).click();
    await pendingInput.getByRole("button", { name: "Back" }).click();
    await expect(pendingInput.getByText("Question 1 of 2")).toBeVisible();
    await expect(
      pendingInput.getByRole("button", { name: /Large refactor/ })
    ).toHaveAttribute("aria-pressed", "true");

    await pendingInput.getByRole("button", { name: "Next" }).click();
    await pendingInput.getByRole("button", { name: "Submit" }).click();

    await expect(app.window.getByRole("group", { name: "Pending input" })).toHaveCount(0);
    await expect(app.window.getByRole("status")).toContainText("Thinking");
    await expect
      .poll(async () => await app.getPendingRequest())
      .toBeUndefined();
  } finally {
    await app.close();
  }
});
