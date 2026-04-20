import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const turnLifecycleSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("keeps transient turn UI through metadata and premature idle notifications", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      turnLifecycleSpecDir,
      "fixtures/turn-lifecycle/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Turn lifecycle replay/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Turn lifecycle replay"
      })
    ).toBeVisible();
    await expect(
      app.window.getByText("lifecycle baseline ready", { exact: true })
    ).toBeVisible();

    await app.window
      .getByLabel("Reply")
      .fill(
        "Create /tmp/pwragnt-turn-lifecycle.txt with exactly the text lifecycle second turn."
      );
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "token-usage-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "rate-limits-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "command-output-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "status-idle-midturn" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "assistant-delta-1" });
    await app.advance({ stepId: "assistant-delta-2" });

    await expect(
      app.window.getByText(/I'll create the file now\.\s*Verifying the exact bytes next\./)
    ).toBeVisible();

    await app.advance({ stepId: "status-idle-1" });

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "turn-completed-1" });

    await expect(
      app.window.getByRole("button", { name: "Stop" })
    ).toHaveCount(0);
    await expect(
      app.window.getByText("Thinking")
    ).toHaveCount(0);
    await expect(
      app.window.getByText(/I'll create the file now\.\s*Verifying the exact bytes next\./)
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("region", { name: "Transcript" })
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
