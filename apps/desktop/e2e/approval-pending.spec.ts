import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const approvalPendingSpecDir = path.dirname(fileURLToPath(import.meta.url));
const approvalCommand =
  "Get-ChildItem -Force | Select-Object Name,Mode; Get-ChildItem -Recurse -Filter AGENTS.md -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName";
const powershell =
  "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.4.0_x64__8wekyb3d8bbwe\\pwsh.exe";
const approvalPrefix = `${powershell} -Command ${approvalCommand}`;

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

  await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
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
  ).toHaveText(approvalCommand);
  await expect(
    app.window.getByText("Waiting for approval before this turn can continue.")
  ).toBeVisible();
  await expect(
    app.window.getByRole("button", { name: "Approve Once" })
  ).toBeVisible();
  const allowPrefix = app.window.getByRole("button", {
    name: `Always Allow Prefix: ${approvalPrefix}`,
  });
  await expect(allowPrefix).toBeVisible();
  await expect(allowPrefix).toHaveClass(/button--ghost/);
  await expect(allowPrefix).toHaveClass(/transcript-request__action--detailed/);
  await expect(allowPrefix).toHaveAttribute(
    "title",
    `Always Allow Prefix: ${approvalPrefix}`
  );
  const detail = allowPrefix.locator(".transcript-request__action-detail");
  await expect(detail).toHaveText(approvalCommand);
  await expect(detail).not.toContainText("PowerShell");
  const prefixLayout = await allowPrefix.evaluate((element) => {
    const actions = element.closest(".transcript-request__actions");
    const detail = element.querySelector("code");
    const actionRect = element.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const style = detail ? window.getComputedStyle(detail) : undefined;
    return {
      actionHeight: actionRect.height,
      actionScrollWidth: element.scrollWidth,
      actionClientWidth: element.clientWidth,
      fitsActions:
        Boolean(actionsRect)
        && actionRect.left >= actionsRect!.left
        && actionRect.right <= actionsRect!.right,
      overflow: style?.overflow,
      textOverflow: style?.textOverflow,
      whiteSpace: style?.whiteSpace,
    };
  });
  expect(prefixLayout).toMatchObject({
    fitsActions: true,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  expect(prefixLayout.actionScrollWidth).toBeLessThanOrEqual(
    prefixLayout.actionClientWidth
  );
  expect(prefixLayout.actionHeight).toBeLessThan(60);
  await expect(
    app.window.getByRole("button", { name: "Cancel Turn" })
  ).toBeVisible();

  return app;
}

test("dismisses the pending approval UI after approval", async () => {
  const app = await openApprovalPendingReplay();

  try {
    await app.window.getByRole("button", { name: "Approve Once" }).click();

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
      app.window.getByTestId("composer-stop-turn")
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
    const fullAccessWarning = app.window.getByRole("dialog", {
      name: "Enable Full Access?",
    });
    await expect(fullAccessWarning).toContainText("network access");
    await fullAccessWarning
      .getByRole("button", { name: "I Understand and Accept the Risks" })
      .click();

    // Toggling access mode mid-turn queues the change at the resume
    // boundary instead of flipping immediately. The applied executionMode
    // (and dropdown value) stays at "default" until the queue flushes.
    await expect(accessMode).toHaveAttribute("data-value", "default");

    await app.window.getByTestId("composer-stop-turn").click();

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
