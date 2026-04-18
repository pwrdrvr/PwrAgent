import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const editedChangesSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("expanded edited changes stay in transcript order", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      editedChangesSpecDir,
      "fixtures/edited-changes-order/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Edited changes ordering/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Edited changes ordering"
      })
    ).toBeVisible();

    const activityToggle = app.window.getByRole("button", { name: /Edited 1 file/i });
    await activityToggle.click();
    await expect(app.window.getByText("2 unmodified lines skipped")).toBeVisible();
    await expect(app.window.getByText("const b = 2;")).toHaveCount(0);

    await app.window.getByRole("button", { name: "Zoom in" }).click();
    await expect(app.window.getByText("const b = 2;")).toBeVisible();

    const transcriptText = await app.window
      .getByRole("region", { name: "Transcript" })
      .innerText();
    expect(transcriptText.indexOf("Please expand the edited changes.")).toBeGreaterThan(-1);
    expect(transcriptText.indexOf("Edited 1 file")).toBeGreaterThan(
      transcriptText.indexOf("Please expand the edited changes.")
    );
    expect(transcriptText.indexOf("const b = 2;")).toBeGreaterThan(
      transcriptText.indexOf("Edited 1 file")
    );
    expect(transcriptText.indexOf("Done reviewing the changes.")).toBeGreaterThan(
      transcriptText.indexOf("const b = 2;")
    );
  } finally {
    await app.close();
  }
});
