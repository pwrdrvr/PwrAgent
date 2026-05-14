import { expect, test } from "@playwright/test";
import { createLocalHandoffFixture } from "./fixtures/workspace-handoff-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

test.skip(
  process.env.PWRAGENT_E2E_INSPECT !== "1",
  "Set PWRAGENT_E2E_INSPECT=1 through the package script to run this manual inspector.",
);

test("opens the local-to-worktree handoff dialog until Electron is closed manually", async () => {
  test.setTimeout(0);

  const fixture = await createLocalHandoffFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: {
      height: 900,
      width: 1440,
    },
  });

  try {
    await app.window.getByRole("button", { name: "Local handoff thread" }).click();

    const workspaceMode = app.window.getByLabel("Workspace mode");
    await workspaceMode.click();
    await app.window.getByRole("menuitem", { name: "Handoff to New Worktree" }).click();

    const dialog = app.window.getByRole("dialog", { name: "Handoff to New Worktree" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Handoff to Detached HEAD");
    await expect(dialog).toContainText("main");
    await dialog.getByRole("radio", { name: /Handoff Current Branch/ }).click();
    await expect(dialog.getByLabel("Leave current checkout on")).toHaveValue("HEAD");
    await expect(dialog).toContainText("Ignored files are not moved by handoff.");

    console.log(
      [
        "",
        "Local-to-Worktree handoff inspection is ready.",
        "Take screenshots from the Electron window now.",
        "Close the Electron window or quit the app to finish this command.",
        "",
      ].join("\n"),
    );

    await Promise.race([
      app.window.waitForEvent("close", { timeout: 0 }).then(() => undefined),
      app.electronApp.waitForEvent("close", { timeout: 0 }).then(() => undefined),
    ]);
  } finally {
    await app.close().catch(() => undefined);
    await fixture.cleanup();
  }
});
