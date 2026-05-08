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

test("stops the active turn after a queued access-mode change", async () => {
  const app = await openApprovalPendingReplay();

  try {
    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-approval-pending",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });

    const accessMode = app.window.getByLabel("Access mode");
    await expect(accessMode).toHaveAttribute("data-value", "default");
    await accessMode.click();
    await app.window.getByRole("option", { name: "Full Access" }).click();

    // Toggling access mode mid-turn queues the change at the resume
    // boundary instead of flipping immediately. The applied executionMode
    // (and dropdown value) stays at "default" until the queue flushes.
    await expect(accessMode).toHaveAttribute("data-value", "default");

    await app.window.getByRole("button", { name: "Stop" }).click();

    await expect
      .poll(async () => await app.getInterruptTurnCalls())
      .toEqual([
        {
          threadId: "thread-approval-pending",
          turnId: "turn-approval-2",
        },
      ]);
  } finally {
    await app.close();
  }
});
