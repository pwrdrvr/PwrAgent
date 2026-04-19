import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const approvalPendingSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("shows pending approval UI without duplicating the turn elsewhere", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      approvalPendingSpecDir,
      "fixtures/approval-pending/replay.fixture.json"
    )
  });

  try {
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
    await expect(
      app.window
        .getByRole("group", { name: "Pending approval" })
        .getByText("Read /etc/hosts and tell me the first three lines.")
    ).toBeVisible();
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
