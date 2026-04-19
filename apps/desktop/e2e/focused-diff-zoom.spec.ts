import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const focusedDiffSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("eligible diffs fall back to deterministic zoomed-out context", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      focusedDiffSpecDir,
      "fixtures/focused-diff-zoom/replay.fixture.json"
    )
  });

  try {
    await app.window.getByRole("button", { name: /Focused diff zoom/i }).first().click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Focused diff zoom"
      })
    ).toBeVisible();

    const activityToggle = app.window.getByRole("button", { name: /Edited 1 file/i });
    await activityToggle.click();

    await expect(app.window.getByText("7 lines skipped")).toBeVisible();
    await expect(app.window.getByRole("button", { name: "Zoom in" })).toBeVisible();
    await expect(app.window.getByText("const keep3 = 3;")).toHaveCount(0);

    await app.window.getByRole("button", { name: "Zoom in" }).click();

    await expect(app.window.getByRole("button", { name: "Zoom out" })).toBeVisible();
    await expect(app.window.getByText("const keep3 = 3;")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("focused diff overrides can hide low-signal hunks end-to-end", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      focusedDiffSpecDir,
      "fixtures/focused-diff-zoom/replay.fixture.json"
    ),
    env: {
      PWRAGNT_FOCUSED_DIFF_TEST_RESPONSE: JSON.stringify({
        hiddenHunkIndices: [1],
        reason: "focused diff test override"
      })
    }
  });

  try {
    await app.window.getByRole("button", { name: /Focused diff zoom/i }).first().click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Focused diff zoom"
      })
    ).toBeVisible();

    await app.window.getByRole("button", { name: /Edited 1 file/i }).click();

    await expect(app.window.getByText("1 hunk hidden, 6 lines skipped")).toBeVisible();
    await expect(app.window.getByText("// refreshed comment")).toHaveCount(0);

    await app.window.getByRole("button", { name: "Zoom in" }).click();

    await expect(app.window.getByText("// refreshed comment")).toBeVisible();
  } finally {
    await app.close();
  }
});
