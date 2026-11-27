import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { accessTrigger, allowFullAccess } from "./fixtures/access-picker";
import { openStarMapWindow } from "./fixtures/star-map-window";

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
    .getByRole("textbox", { name: "Reply", exact: true })
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
    app.window
      .locator(".thread-header")
      .getByText("Waiting for approval", { exact: true })
  ).toBeVisible();
  await expect(
    app.window.getByText("Waiting for approval before this turn can continue.")
  ).toHaveCount(0);
  await expect(
    app.window.getByRole("button", { name: "Approve once" })
  ).toBeVisible();
  const allowPrefix = app.window.getByRole("button", {
    name: `Always allow prefix: ${approvalPrefix}`,
  });
  await expect(allowPrefix).toBeVisible();
  await expect(allowPrefix).toHaveClass(/button--ghost/);
  await expect(allowPrefix).toHaveClass(/transcript-request__action--detailed/);
  await expect(allowPrefix).toHaveAttribute(
    "title",
    `Always allow prefix: ${approvalPrefix}`
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
    app.window.getByRole("button", { name: "Cancel turn" })
  ).toBeVisible();

  return app;
}

test("dismisses the pending approval UI after approval", async () => {
  const app = await openApprovalPendingReplay();

  try {
    await app.window.getByRole("button", { name: "Approve once" }).click();

    await expect(
      app.window.getByRole("group", { name: "Pending approval" })
    ).toHaveCount(0);
    await expect(
      app.window
        .locator(".thread-header")
        .getByText("Waiting for approval", { exact: true })
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

test("answers the thread's pending approval from its Star Map chat card", async () => {
  const app = await openApprovalPendingReplay();

  try {
    const mapWindow = await openStarMapWindow(app);
    const starMap = mapWindow.getByRole("region", { name: "Star Map", exact: true });
    await starMap.getByRole("button", {
      name: "Open thread: Approval pending replay",
      exact: true,
    }).click();

    const chatCard = mapWindow.getByRole("region", {
      name: "Chat: Approval pending replay",
      exact: true,
    });
    const approval = chatCard.getByRole("group", { name: "Pending approval" });
    await approval.getByRole("button", { name: "Approve once", exact: true }).click();

    // The main window has a separate renderer and only clears its approval
    // when the owner resolves the request. Hiding the card's UI alone cannot pass.
    await expect(app.window.getByRole("group", { name: "Pending approval" })).toHaveCount(0);
    await expect(approval).toHaveCount(0);
    await expect(chatCard).toBeVisible();
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

    const accessMode = accessTrigger(app.window);
    await expect(accessMode).toHaveAttribute("data-value", "default");
    await allowFullAccess(app.window);

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
