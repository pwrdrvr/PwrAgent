import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const approvalPendingSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function openApprovalPendingReplay() {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      approvalPendingSpecDir,
      "fixtures/approval-pending/replay.fixture.json"
    )
  });

  await app.window
    .getByRole("button", { name: /Approval pending replay/i })
    .first()
    .click();

  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: "Approval pending replay"
    })
  ).toBeVisible();

  await app.window
    .getByLabel("Reply")
    .fill("Read /etc/hosts and tell me the first three lines.");
  await app.window.getByRole("button", { name: "Send" }).click();

  await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(
    app.window
      .getByRole("region", { name: "Transcript" })
      .getByText("Read /etc/hosts and tell me the first three lines.")
  ).toBeVisible();

  await app.advance({ stepId: "status-active-1" });
  await app.advance({ stepId: "turn-started-1" });
  await app.advance({ stepId: "request-approval-1" });

  await expect(
    app.window.getByRole("group", { name: "Pending approval" })
  ).toBeVisible();
  await expect(app.window.getByText("Approval needed")).toBeVisible();
  const pendingApproval = app.window.getByRole("group", { name: "Pending approval" });
  await expect(pendingApproval.getByText("Command:")).toBeVisible();
  await expect(
    pendingApproval.locator("pre code")
  ).toHaveText("npm view dive");
  await expect(app.window.getByText(/\/bin\/zsh -lc/)).toHaveCount(0);
  await expect(
    app.window.getByText("Waiting for approval before this turn can continue.")
  ).toBeVisible();
  await expect(
    app.window.getByRole("button", { name: "Approve" })
  ).toBeVisible();

  return app;
}

test("shows pending approval UI without duplicating the turn elsewhere", async () => {
  const app = await openApprovalPendingReplay();

  try {
    await expect(
      app.window.getByRole("group", { name: "Pending approval" })
    ).toBeVisible();
    await expect(app.window.getByText("Approval needed")).toBeVisible();
    const pendingApproval = app.window.getByRole("group", { name: "Pending approval" });
    await expect(pendingApproval.getByText("Command:")).toBeVisible();
    await expect(
      pendingApproval.locator("pre code")
    ).toHaveText("npm view dive");
    await expect(app.window.getByText(/\/bin\/zsh -lc/)).toHaveCount(0);
    await expect(
      app.window.getByText("Waiting for approval before this turn can continue.")
    ).toBeVisible();
    await expect(
      app.window.getByRole("button", { name: "Approve" })
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("dismisses the pending approval UI after approval", async () => {
  const app = await openApprovalPendingReplay();

  try {
    await app.window.getByRole("button", { name: "Approve" }).click();

    await expect(
      app.window.getByRole("group", { name: "Pending approval" })
    ).toHaveCount(0);
    await expect(
      app.window.getByText("Waiting for approval before this turn can continue.")
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("button", { name: "Decline" })
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("button", { name: "Cancel turn" })
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("button", { name: "Stop" })
    ).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");
  } finally {
    await app.close();
  }
});

test("stops the active turn on its original execution mode after access mode changes", async () => {
  const app = await openApprovalPendingReplay();

  try {
    await expect
      .poll(async () => await app.getLastStartTurn({ executionMode: "default" }))
      .toMatchObject({
        threadId: "thread-approval-pending",
      });
    expect(await app.getLastStartTurn({ executionMode: "full-access" })).toBeUndefined();

    const accessMode = app.window.getByLabel("Access mode");
    await expect(accessMode).toHaveAttribute("data-value", "default");
    await accessMode.click();
    await app.window.getByRole("option", { name: "Full Access" }).click();
    await expect(accessMode).toHaveAttribute("data-value", "full-access");

    await app.window.getByRole("button", { name: "Stop" }).click();

    await expect
      .poll(async () => await app.getInterruptTurnCalls({ executionMode: "default" }))
      .toEqual([
        {
          threadId: "thread-approval-pending",
          turnId: "turn-approval-2",
        },
      ]);
    await expect
      .poll(async () => await app.getInterruptTurnCalls({ executionMode: "full-access" }))
      .toEqual([]);
  } finally {
    await app.close();
  }
});
