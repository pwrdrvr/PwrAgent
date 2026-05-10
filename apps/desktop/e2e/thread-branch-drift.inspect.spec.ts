import { expect, test } from "@playwright/test";
import { createBranchDriftFixture } from "./fixtures/branch-drift-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

test.skip(
  process.env.PWRAGENT_E2E_INSPECT !== "1",
  "Set PWRAGENT_E2E_INSPECT=1 through the package script to run this manual inspector.",
);

test("opens the branch drift dialog until Electron is closed manually", async () => {
  test.setTimeout(0);

  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
    windowSize: {
      height: 900,
      width: 1440,
    },
  });

  try {
    const dialog = app.window.getByRole("dialog", {
      name: "Thread branch changed",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("codex/expected-branch");
    await expect(dialog).toContainText("codex/current-branch");

    console.log(
      [
        "",
        "Branch drift inspection is ready.",
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
